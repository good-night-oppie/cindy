/**
 * Host-side path guard for agy task folders (good-night-oppie/cindy#1: QQ 6924350879 items 4 and 5,
 * wording JJ 6924543498).
 *
 * agy runs in a sandbox, but the Cindy host does not. agy can leave a symlink in the task folder
 * (r12: `link-to-config -> /srv/agy-b/workdata/config`); it dangles inside the sandbox but is a real
 * path on the host. Any host code that reads, lists or uploads something in an agy task folder must
 * therefore go through `checkAgyTaskPath` first: take the real path, refuse when it is no longer
 * inside the task folder, and tell the user why. Opening re-checks the opened handle, and listing /
 * walking never follow links.
 *
 * Scope: only folders agy has run in. AgyAgent records each one in a registry kept on disk (it outlives
 * the session and a restart, and recognises a renamed or moved folder by its inode); host entries look
 * the folder up there from the path they were asked for. On a computer where agy never ran the check
 * returns null and nothing changes for other engines; if the registry exists but cannot be read, the
 * check fails closed.
 *
 * The write side (`agyWriteOutsideTask`) uses the same real-path resolution: a write-type tool call
 * whose target is outside the task folder, or reaches outside through a link inside it, gets JJ's
 * first sentence beside the reply. It is a notice, not a block.
 */
import {
  constants, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, writeFileSync,
} from 'node:fs';
import { open, opendir, readlink, stat, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { record, type AcpRecord } from './models.js';

// ---------------------------------------------------------------------------
// User copy — JJ 6924543498, final. Do not edit the wording here; ask JJ.
// ---------------------------------------------------------------------------

export const AGY_HOST_PATH_USER_COPY = {
  /** Item 4: a write-type step aimed outside the task folder (completed or failed, either way). */
  writeOutside: {
    'zh-CN': '这一步写的位置在任务文件夹外面，只在 Cindy 给 Antigravity 划出来的那个范围里生效了，你电脑上的文件没有变。要改外面的文件，先把它复制到任务文件夹里再改。',
    en: 'This step wrote to a place outside the task folder. It only happened inside the space Cindy sets aside for Antigravity, so nothing on your computer has changed. To change a file outside, copy it into the task folder first.',
  },
  /** Item 5: something in the task folder is a link that leads outside; the host refused to open it. */
  linkOutside: {
    'zh-CN': '这个文件本身只是个链接，指向任务文件夹外面，所以 Cindy 没有打开它。任务文件夹以外的文件，Cindy 不会替 Antigravity 打开。要用的话，把这个文件复制进任务文件夹，再试一次。',
    en: 'This file is just a link pointing outside the task folder, so Cindy did not open it. Cindy does not open files outside the task folder for Antigravity. If you need it, copy the file into the task folder and try again.',
  },
  /**
   * JJ on cindy#15: entries without a text channel of their own (xdt-file / xdt-audio, the
   * dangerous-attachment stage), where the refusal is not necessarily about a link.
   */
  notInTaskFolder: {
    'zh-CN': '这个文件不在任务文件夹里，Cindy 没有打开它。要用的话，把它复制进任务文件夹，再试一次。',
    en: 'This file is not in the task folder, so Cindy did not open it. If you need it, copy it into the task folder and try again.',
  },
} as const;

export type AgyCopyLocale = 'zh-CN' | 'en';

/** JJ wrote zh-CN and en; any Chinese UI gets zh-CN, everything else en. */
export function agyCopyLocale(locale?: string | null): AgyCopyLocale {
  return /^zh\b/i.test(locale ?? '') ? 'zh-CN' : 'en';
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AgyLinkOutsideTaskError extends Error {
  readonly code = 'agy_link_outside_task' as const;
  constructor(
    /** What the caller asked for (absolute). */
    readonly requestedPath: string,
    /** Where it really leads on this computer, or a short reason when that cannot be settled. */
    readonly realPath: string,
    readonly taskDir: string,
    locale?: string | null,
  ) {
    super(AGY_HOST_PATH_USER_COPY.linkOutside[agyCopyLocale(locale)]);
    this.name = 'AgyLinkOutsideTaskError';
  }

  userMessage(locale?: string | null): string {
    return AGY_HOST_PATH_USER_COPY.linkOutside[agyCopyLocale(locale)];
  }
}

export function isAgyLinkOutsideTaskError(error: unknown): error is AgyLinkOutsideTaskError {
  return error instanceof AgyLinkOutsideTaskError
    || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'agy_link_outside_task');
}

// ---------------------------------------------------------------------------
// Registry of agy task folders: in memory for open sessions, and on disk for good (QQ B2 on #15)
// ---------------------------------------------------------------------------
//
// Links agy leaves in a task folder stay on disk after the session ends and after Cindy restarts, so
// "this folder is an agy task folder" must outlive the process. Every folder agy ever ran in is kept in
// a small file outside the sandbox (the sandbox home is an empty tmpfs, so agy cannot see or edit it):
// its path, real path and device/inode. The inode is what recognises a folder that was renamed or moved.
// If the file exists but cannot be read, the check fails closed (see checkAgyTaskPath).

interface TaskDirEntry { lexical: string; real: string }
interface StoredTaskDir { path: string; real: string; dev: string; ino: string }
const registered = new Map<symbol, TaskDirEntry>();
const MAX_STORED_TASK_DIRS = 5000;

let storeOverride: string | null = null;
let storeCache: { file: string; key: string; dirs: StoredTaskDir[]; broken: boolean } | null = null;

/** Where the registry lives: ~/.cindy/agy-sandbox/task-dirs.json, next to agy's private state. */
export function agyTaskDirStoreFile(): string {
  return storeOverride ?? (process.env.CINDY_AGY_TASK_DIR_STORE
    || path.join(os.homedir(), '.cindy', 'agy-sandbox', 'task-dirs.json'));
}

/** Tests (and a host with another layout) point the registry somewhere else; null restores the default. */
export function setAgyTaskDirStoreFile(file: string | null): void {
  storeOverride = file;
  storeCache = null;
  registered.clear();
}

function loadStore(): { dirs: StoredTaskDir[]; broken: boolean } {
  const file = agyTaskDirStoreFile();
  let info: { ino: bigint; mtimeNs: bigint; size: bigint } | undefined;
  try { info = statSync(file, { bigint: true }); } catch (error) {
    // Never written: agy never ran on this computer. Any other filesystem error: we cannot tell, fail
    // closed. An error without an errno code is not about the file (host test suites that replace
    // node:fs with a partial mock); it says nothing about the registry, so it does not switch the check.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { dirs: [], broken: typeof code === 'string' && code !== 'ENOENT' };
  }
  if (!info) return { dirs: [], broken: true };
  const key = `${info.ino}:${info.mtimeNs}:${info.size}`;
  if (storeCache && storeCache.file === file && storeCache.key === key) return storeCache;
  let dirs: StoredTaskDir[] = [];
  let broken = false;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { dirs?: unknown };
    if (!Array.isArray(parsed.dirs)) throw new Error('no dirs');
    dirs = parsed.dirs.map(raw => {
      const d = record(raw);
      if (typeof d.path !== 'string' || typeof d.real !== 'string' || typeof d.dev !== 'string' || typeof d.ino !== 'string') throw new Error('bad entry');
      return { path: d.path, real: d.real, dev: d.dev, ino: d.ino };
    });
  } catch { dirs = []; broken = true; }
  storeCache = { file, key, dirs, broken };
  return storeCache;
}

function persistTaskDir(lexical: string, real: string): void {
  const file = agyTaskDirStoreFile();
  const current = loadStore();
  if (current.broken) {
    throw new Error(`agy task folder registry cannot be read (${file}); refusing to start agy until it is fixed or removed`);
  }
  let id: { dev: string; ino: string } = { dev: '', ino: '' };
  try { const s = statSync(real, { bigint: true }); id = { dev: String(s.dev), ino: String(s.ino) }; } catch { /* path only */ }
  const entry: StoredTaskDir = { path: lexical, real, ...id };
  const same = (d: StoredTaskDir) => d.path === entry.path && d.real === entry.real && d.dev === entry.dev && d.ino === entry.ino;
  if (current.dirs.some(same)) return;
  const dirs = [...current.dirs, entry].slice(-MAX_STORED_TASK_DIRS);
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, dirs }), { mode: 0o600 });
  renameSync(tmp, file);
  storeCache = null;
}

/**
 * AgyAgent calls this when a session starts. The folder is also written to the on-disk registry and
 * stays an agy task folder after the session ends; the returned function only ends the in-memory entry.
 * Throws when the registry cannot be written or read, so agy does not run in a folder the host would forget.
 */
export function registerAgyTaskDir(dir: string): () => void {
  const lexical = path.resolve(dir);
  const real = realpathOr(lexical);
  persistTaskDir(lexical, real);
  const key = Symbol(lexical);
  registered.set(key, { lexical, real });
  return () => { registered.delete(key); };
}

export function registeredAgyTaskDirs(): string[] {
  return [...new Set([...[...registered.values()].map(entry => entry.lexical), ...loadStore().dirs.map(d => d.path)])];
}

/**
 * The agy task folder `requested` lies in, if any: by path (as registered, or its real path), or by the
 * device/inode of one of its folders (a task folder that was renamed or moved since).
 */
function findTaskDir(requested: string, stored: StoredTaskDir[]): TaskDirEntry | null {
  for (const entry of registered.values()) {
    if (isInsideDir(requested, entry.lexical) || isInsideDir(requested, entry.real)) return entry;
  }
  for (const d of stored) {
    if (isInsideDir(requested, d.path) || isInsideDir(requested, d.real)) {
      const lexical = isInsideDir(requested, d.path) ? d.path : d.real;
      return { lexical, real: realpathOr(lexical) };
    }
  }
  const ids = new Set(stored.filter(d => d.ino).map(d => `${d.dev}:${d.ino}`));
  if (!ids.size) return null;
  for (let p = requested; ; p = path.dirname(p)) {
    const s = statSync(p, { bigint: true, throwIfNoEntry: false });
    if (s?.isDirectory() && ids.has(`${s.dev}:${s.ino}`)) return { lexical: p, real: realpathOr(p) };
    if (path.dirname(p) === p) return null;
  }
}

// ---------------------------------------------------------------------------
// The one check
// ---------------------------------------------------------------------------

export interface AgyTaskPathOptions {
  /** The task folder, when the caller knows it. Without it, the registered agy task folders apply. */
  taskDir?: string;
  /** UI locale for the refusal text. */
  locale?: string | null;
}

export interface AgyTaskPathCheck {
  /** Task folder as registered / given. */
  taskDir: string;
  /** Its real path. */
  realTaskDir: string;
  /** The requested path, absolute. */
  requestedPath: string;
  /** Real path of the requested path (missing tail components joined onto the deepest real ancestor). */
  realPath: string;
}

const MAX_LINK_HOPS = 40;

/** Compared by path segment: `task/..config` is inside `task`, `task/../x` is not (QQ B1 on #15). */
export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/**
 * The single check every host entry uses before reading, listing or uploading something that may lie
 * in an agy task folder. Returns null when the path is not in any agy task folder (nothing to check).
 * Throws AgyLinkOutsideTaskError when the path is in the task folder but its real path is not —
 * a link to the outside, several links whose last hop leaves, a link to a missing target, or a loop.
 * A relative path is taken relative to `taskDir`.
 */
export function checkAgyTaskPath(target: string, options: AgyTaskPathOptions = {}): AgyTaskPathCheck | null {
  let dir: TaskDirEntry | null;
  const requested = path.resolve(options.taskDir ?? '', target);
  if (options.taskDir !== undefined) {
    const lexical = path.resolve(options.taskDir);
    const given = { lexical, real: realpathOr(lexical) };
    dir = isInsideDir(requested, given.lexical) || isInsideDir(requested, given.real) ? given : null;
  } else {
    // Without a task folder to anchor it, a relative string (URL, name) is not a task-folder path.
    if (!path.isAbsolute(target)) return null;
    const store = loadStore();
    if (!store.broken && !registered.size && !store.dirs.length) return null;
    dir = findTaskDir(requested, store.dirs);
    if (!dir && store.broken) {
      // Fail closed: which folders are agy's is unknown, so nothing reached through a link is opened.
      const real = resolveRealPath(requested);
      if (!real.ok || real.path !== requested) {
        throw new AgyLinkOutsideTaskError(requested, real.ok ? real.path : real.reason, '', options.locale);
      }
      return null;
    }
  }
  if (!dir) return null;
  const real = resolveRealPath(requested);
  if (!real.ok || !isInsideDir(real.path, dir.real)) {
    throw new AgyLinkOutsideTaskError(requested, real.ok ? real.path : real.reason, dir.lexical, options.locale);
  }
  return { taskDir: dir.lexical, realTaskDir: dir.real, requestedPath: requested, realPath: real.path };
}

/**
 * Real path of p. Missing tail components are joined onto the real path of the deepest existing
 * ancestor (a file about to be created). A link whose target is missing on this computer or that
 * loops cannot be settled and is reported as not ok.
 */
export function resolveRealPath(p: string): { ok: true; path: string } | { ok: false; reason: string } {
  try { return { ok: true, path: realpathSync(p) }; } catch { /* resolve step by step below */ }
  let hops = 0;
  const walk = (current: string): string => {
    try { return realpathSync(current); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return current;
    const joined = path.join(walk(parent), path.basename(current));
    let isLink = false;
    try { isLink = lstatSync(joined).isSymbolicLink(); } catch { return joined; /* does not exist yet */ }
    if (!isLink) return joined;
    if (++hops > MAX_LINK_HOPS) throw new Error('link loop');
    const resolvedTarget = path.resolve(path.dirname(joined), readlinkSync(joined));
    const next = walk(resolvedTarget);
    // A link to something that does not exist here: its real target cannot be confirmed.
    try { lstatSync(next); } catch { throw new Error(`link target missing: ${next}`); }
    return next;
  };
  try { return { ok: true, path: walk(path.resolve(p)) }; } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function realpathOr(p: string): string {
  try { return realpathSync(p); } catch { return p; }
}

// ---------------------------------------------------------------------------
// Opening and reading: check, open without following the last link, check the handle again
// ---------------------------------------------------------------------------

export interface AgyTaskOpenOptions extends AgyTaskPathOptions {
  /** Test seam: runs between the check and the open, to simulate a swap. */
  beforeOpenForTest?: () => Promise<void> | void;
}

// Read lazily: some host test suites replace node:fs with a partial mock.
const noFollowReadFlags = () => (constants?.O_RDONLY ?? 0) | (constants?.O_NOFOLLOW ?? 0);
const noFollowDirFlags = () => noFollowReadFlags() | (constants?.O_DIRECTORY ?? 0);

/** Real path of an open handle (Linux /proc), or null where the platform has no such view. */
async function handleRealPath(handle: FileHandle): Promise<string | null> {
  if (process.platform !== 'linux') return null;
  try { return await readlink(`/proc/self/fd/${handle.fd}`); } catch { return null; }
}

/** After open: the handle itself must still be inside the task folder. */
async function verifyHandle(handle: FileHandle, check: AgyTaskPathCheck, locale?: string | null): Promise<void> {
  const refuse = (where: string) => { throw new AgyLinkOutsideTaskError(check.requestedPath, where, check.taskDir, locale); };
  const real = await handleRealPath(handle);
  if (real !== null) {
    if (!isInsideDir(real, check.realTaskDir)) refuse(real);
    return;
  }
  // No /proc: the opened object must be the very file the check resolved, and that path must still check out.
  const [opened, current] = await Promise.all([handle.stat(), stat(check.realPath).catch(() => null)]);
  if (!current || opened.dev !== current.dev || opened.ino !== current.ino) refuse('changed between check and open');
  const again = resolveRealPath(check.requestedPath);
  if (!again.ok || again.path !== check.realPath) refuse(again.ok ? again.path : again.reason);
}

/**
 * Open a file for reading. Inside an agy task folder: check, open the checked real path without
 * following a link in the last component, then check the open handle. Outside: a plain open.
 */
export async function openAgyTaskFile(target: string, options: AgyTaskOpenOptions = {}): Promise<{ handle: FileHandle; check: AgyTaskPathCheck | null }> {
  const check = checkAgyTaskPath(target, options);
  if (!check) return { handle: await open(path.resolve(options.taskDir ?? '', target), 'r'), check: null };
  await options.beforeOpenForTest?.();
  let handle: FileHandle;
  try { handle = await open(check.realPath, noFollowReadFlags()); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      throw new AgyLinkOutsideTaskError(check.requestedPath, 'replaced by a link', check.taskDir, options.locale);
    }
    throw error;
  }
  try { await verifyHandle(handle, check, options.locale); } catch (error) { await handle.close().catch(() => {}); throw error; }
  return { handle, check };
}

/**
 * For entries that open with their own flags: after the open, if `target` is in an agy task folder,
 * the open handle must still be inside it. Throws AgyLinkOutsideTaskError (caller closes the handle).
 */
export async function verifyAgyTaskHandle(handle: FileHandle, target: string, options: AgyTaskPathOptions = {}): Promise<void> {
  const check = checkAgyTaskPath(target, options);
  if (check) await verifyHandle(handle, check, options.locale);
}

/** Read a whole file through openAgyTaskFile. */
export async function readAgyTaskFile(target: string, options: AgyTaskOpenOptions & { maxBytes?: number } = {}): Promise<Buffer> {
  const { handle } = await openAgyTaskFile(target, options);
  try {
    if (options.maxBytes !== undefined) {
      const info = await handle.stat();
      if (info.size > options.maxBytes) throw new Error(`file is larger than ${options.maxBytes} bytes`);
    }
    return await handle.readFile();
  } finally { await handle.close().catch(() => {}); }
}

// ---------------------------------------------------------------------------
// Listing and walking: never follow links
// ---------------------------------------------------------------------------

export type AgyTaskEntryType = 'file' | 'directory' | 'symlink' | 'other';
export interface AgyTaskEntry { name: string; path: string; type: AgyTaskEntryType }

/** List one directory. Inside an agy task folder the directory is checked and pinned by handle first. */
export async function listAgyTaskDir(target: string, options: AgyTaskOpenOptions = {}): Promise<AgyTaskEntry[]> {
  const check = checkAgyTaskPath(target, options);
  const dirPath = check?.realPath ?? path.resolve(options.taskDir ?? '', target);
  let readFrom = dirPath;
  let handle: FileHandle | undefined;
  if (check) {
    await options.beforeOpenForTest?.();
    if (process.platform === 'linux') {
      handle = await open(dirPath, noFollowDirFlags()).catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new AgyLinkOutsideTaskError(check.requestedPath, 'replaced by a link', check.taskDir, options.locale);
        throw error;
      });
      try { await verifyHandle(handle, check, options.locale); } catch (error) { await handle.close().catch(() => {}); throw error; }
      readFrom = `/proc/self/fd/${handle.fd}`;
    } else {
      const again = resolveRealPath(check.requestedPath);
      if (!again.ok || again.path !== check.realPath) {
        throw new AgyLinkOutsideTaskError(check.requestedPath, again.ok ? again.path : again.reason, check.taskDir, options.locale);
      }
    }
  }
  try {
    const dir = await opendir(readFrom);
    const out: AgyTaskEntry[] = [];
    for await (const entry of dir) {
      const type: AgyTaskEntryType = entry.isSymbolicLink() ? 'symlink'
        : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      // Report under the requested (lexical) folder: callers keep working with task-relative paths.
      out.push({ name: entry.name, path: path.join(check?.requestedPath ?? dirPath, entry.name), type });
    }
    return out;
  } finally { await handle?.close().catch(() => {}); }
}

/** Walk a tree without following links: links are reported, never descended. */
export async function walkAgyTaskDir(
  root: string, options: AgyTaskPathOptions, visit: (entry: AgyTaskEntry) => void | Promise<void>, limit = 200_000,
): Promise<{ visited: number; truncated: boolean }> {
  const stack = [path.resolve(options.taskDir ?? '', root)];
  let visited = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of await listAgyTaskDir(dir, options)) {
      if (++visited > limit) return { visited: visited - 1, truncated: true };
      await visit(entry);
      if (entry.type === 'directory') stack.push(entry.path);
    }
  }
  return { visited, truncated: false };
}

// ---------------------------------------------------------------------------
// Write side (item 4): which path a write-type tool call aims at
// ---------------------------------------------------------------------------

const WRITE_KINDS = new Set(['edit', 'delete', 'move']);
const WRITE_NAME_RE = /write|edit|replace|append|delete|remove|move|rename|touch|symlink|create_?file|save/i;
/** Path-valued input keys (TargetFile, AbsolutePath, DestinationPath, file_path, …), not content keys like TargetContent. */
const PATH_KEY_RE = /(path|file|dir|directory)$|^(target|dest|destination|source|from|to)$/i;
/** Shell commands that change files: every operand is a target. */
const ALL_OPERANDS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'touch', 'tee', 'truncate', 'shred', 'mkdir']);
/** Shell commands whose last operand is the target. */
const LAST_OPERAND = new Set(['cp', 'ln', 'install', 'rsync']);
/** Not files: writing there is not a file change. */
const PSEUDO_TARGETS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr', '/dev/tty']);

function expandHome(p: string, homeDir: string): string {
  return p === '~' ? homeDir : p.startsWith('~/') ? homeDir + p.slice(1) : p;
}

/** Split a shell line into simple commands and words. Quotes are honored; this is a classifier, not a shell. */
function shellCommands(line: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote: '"' | '\'' | null = null;
  let has = false;
  const push = () => { if (has) words.push(word); word = ''; has = false; };
  const end = () => { push(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = null; else word += c; continue; }
    if (c === '"' || c === '\'') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { word += line[++i]; has = true; continue; }
    if (c === ';' || c === '\n' || c === '|' || c === '&' || c === '(' || c === ')') {
      // `>&2`, `&>file`, `>|file` are redirections, not separators.
      if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) { push(); words.push(line[i + 1] === '>' ? '&>' : '>&'); if (line[i + 1] === '>') i++; continue; }
      if (c === '|' && line[i - 1] === '>') continue;
      end(); continue;
    }
    if (c === '>' || c === '<') {
      push();
      let op = c;
      if (line[i + 1] === '>') { op += '>'; i++; }
      words.push(op); continue;
    }
    if (/\s/.test(c)) { push(); continue; }
    word += c; has = true;
  }
  end();
  return commands;
}

const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Prefixes that run the next word as the command. */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'nice', 'exec', 'builtin', 'stdbuf', 'ionice']);
/** cp / mv / ln / install: `-t DIR` / `--target-directory=DIR` names the destination folder. */
const TARGET_DIR_COMMANDS = new Set(['cp', 'mv', 'ln', 'install']);
const XARGS_VALUE_OPTIONS = new Set(['-I', '-i', '-n', '-P', '-d', '-L', '-l', '-s', '-E', '-e', '-a']);
const FIND_WRITE_ACTIONS = new Set(['-delete', '-fprint', '-fprint0', '-fprintf', '-fls']);
const FIND_EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const MAX_SHELL_NESTING = 4;

interface ShellScan {
  /** Absolute write targets. */
  targets: string[];
  /** A write whose target could not be worked out (variables, command substitution, xargs, …). */
  uncertain: boolean;
}

/** Whether a command (by name) changes files. */
function isWriteCommand(name: string): boolean {
  return ALL_OPERANDS.has(name) || LAST_OPERAND.has(name) || name === 'sed' || name === 'dd' || name === 'find'
    || SHELLS.has(name) || name === 'eval' || name === 'xargs' || name === 'perl';
}

/**
 * Write targets of one shell line, resolved against `base` (null: the current folder is unknown).
 * `cd` moves the base for the commands after it; bash -c / sh -c / eval are read too. A write whose
 * target is not literal (a variable other than $HOME / $PWD, a command substitution, xargs reading
 * names from input) is reported as uncertain, so the caller gives the notice rather than miss it
 * (QQ W1 / W2 on #15). This is a classifier, not a shell.
 */
function scanShell(line: string, startBase: string | null, homeDir: string, depth = 0): ShellScan {
  const out: ShellScan = { targets: [], uncertain: false };
  let base = startBase;
  const resolveWord = (word: string): string | null => {
    let w = word;
    if (w === '~' || w.startsWith('~/')) w = homeDir + w.slice(1);
    w = w.replace(/^\$\{HOME\}|^\$HOME(?![A-Za-z0-9_])/, homeDir);
    if (/^\$\{PWD\}|^\$PWD(?![A-Za-z0-9_])/.test(w)) {
      if (base === null) return null;
      w = w.replace(/^\$\{PWD\}|^\$PWD(?![A-Za-z0-9_])/, base);
    }
    if (w.includes('$') || w.includes('`')) return null;
    if (path.isAbsolute(w)) return path.resolve(w);
    return base === null ? null : path.resolve(base, w);
  };
  const addTarget = (word: string) => {
    const resolved = resolveWord(word);
    if (resolved === null) out.uncertain = true; else out.targets.push(resolved);
  };
  const nested = (script: string) => {
    if (depth >= MAX_SHELL_NESTING) { out.uncertain = true; return; }
    const inner = scanShell(script, base, homeDir, depth + 1);
    out.targets.push(...inner.targets);
    if (inner.uncertain) out.uncertain = true;
  };

  for (const words of shellCommands(line)) {
    const rest: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === '>' || w === '>>' || w === '&>') {
        const target = words[i + 1];
        // `2>` leaves a stray "2" in rest; `>&2` is a fd, not a file.
        if (rest.length && /^\d$/.test(rest[rest.length - 1]!)) rest.pop();
        if (target !== undefined && target !== '>&' && !/^&?\d$/.test(target)) addTarget(target);
        i++; continue;
      }
      if (w === '>&') { i++; continue; }
      if (w === '<') { i++; continue; }
      rest.push(w);
    }
    let start = 0;
    for (;;) {
      const w = rest[start];
      if (w === undefined) break;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || WRAPPERS.has(path.basename(w))) { start++; continue; }
      // Options of a wrapper (`sudo -u x`, `env -i`): skip dashed words right after one.
      if (start > 0 && w.startsWith('-') && WRAPPERS.has(path.basename(rest[start - 1] ?? ''))) { start++; continue; }
      if (w === 'timeout') { start += 2; continue; }
      break;
    }
    const name = path.basename(rest[start] ?? '');
    const args = rest.slice(start + 1);
    const operands = args.filter(a => !a.startsWith('-'));

    if (name === 'cd' || name === 'pushd') {
      const to = operands[0];
      base = to === undefined ? homeDir : to === '-' ? null : resolveWord(to);
      continue;
    }
    if (name === 'popd') { base = null; continue; }
    if (SHELLS.has(name)) {
      const flag = args.findIndex(a => /^-[A-Za-z]*c[A-Za-z]*$/.test(a));
      if (flag >= 0) {
        const script = args.slice(flag + 1).find(a => !a.startsWith('-'));
        if (script !== undefined) nested(script);
      }
      continue;
    }
    if (name === 'eval') { nested(args.join(' ')); continue; }
    if (name === 'xargs') {
      let i = 0;
      while (i < args.length && args[i]!.startsWith('-')) i += XARGS_VALUE_OPTIONS.has(args[i]!) ? 2 : 1;
      const command = args[i];
      // The names come from input: if the command writes, its targets are unknown.
      if (command !== undefined && isWriteCommand(path.basename(command))) out.uncertain = true;
      continue;
    }
    if (name === 'find') {
      const firstExpr = args.findIndex(a => a.startsWith('-') || a === '(' || a === '!');
      const roots = firstExpr < 0 ? args : args.slice(0, firstExpr);
      let writes = args.some(a => FIND_WRITE_ACTIONS.has(a));
      args.forEach((a, i) => {
        if (FIND_EXEC_ACTIONS.has(a) && isWriteCommand(path.basename(args[i + 1] ?? ''))) writes = true;
      });
      if (writes) (roots.length ? roots : ['.']).forEach(addTarget);
      continue;
    }
    if (TARGET_DIR_COMMANDS.has(name)) {
      let targetDir: string | undefined;
      const plain: string[] = [];
      for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === '-t' || a === '--target-directory') { targetDir = args[++i]; continue; }
        if (a.startsWith('--target-directory=')) { targetDir = a.slice('--target-directory='.length); continue; }
        if (/^-t./.test(a)) { targetDir = a.slice(2); continue; }
        if (!a.startsWith('-')) plain.push(a);
      }
      if (name === 'mv') plain.forEach(addTarget); // the sources go away too
      if (targetDir !== undefined) addTarget(targetDir);
      // `ln -s target` (one operand) makes the link in the current folder.
      else if (plain.length && !(name === 'ln' && plain.length === 1) && name !== 'mv') addTarget(plain[plain.length - 1]!);
      continue;
    }
    if (ALL_OPERANDS.has(name)) operands.forEach(addTarget);
    else if (LAST_OPERAND.has(name) && operands.length) addTarget(operands[operands.length - 1]!);
    else if ((name === 'sed' || name === 'perl') && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      operands.slice(1).forEach(addTarget);
    } else if (name === 'dd') {
      for (const a of args) if (a.startsWith('of=')) addTarget(a.slice(3));
    }
  }
  return out;
}

/** Target paths of a write-type agy tool call, as written by the call. Empty for anything else. */
export function agyWriteTargets(tool: AcpRecord): { paths: string[]; cwd?: string; command?: string } {
  const input = { ...record(tool.args), ...record(tool.rawInput) };
  const cwd = [input.Cwd, input.cwd].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (tool.kind === 'execute') {
    const command = [input.CommandLine, input.command, input.cmd].find((v): v is string => typeof v === 'string');
    return { paths: [], cwd, command };
  }
  const name = typeof tool.name === 'string' ? tool.name : '';
  const isWrite = WRITE_KINDS.has(String(tool.kind)) || (tool.kind !== 'read' && tool.kind !== 'search' && tool.kind !== 'fetch' && WRITE_NAME_RE.test(name));
  if (!isWrite) return { paths: [] };
  const paths: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string' && value && PATH_KEY_RE.test(key)) paths.push(value);
  }
  if (Array.isArray(tool.locations)) {
    for (const location of tool.locations) {
      const p = record(location).path;
      if (typeof p === 'string' && p) paths.push(p);
    }
  }
  return { paths, cwd };
}

/**
 * First target of a write-type tool call that is outside the task folder — written outside, or
 * reaching outside through a link inside the task folder (same real-path check as the read side).
 * Null when every target stays inside or the call is not a write. Only the call's own target paths
 * decide; agy's completed / failed status does not.
 *
 * `inScopeDirs` are sandbox paths that are Cindy's own space for agy, not "outside": the private state
 * dirs (seen as ~/.gemini and ~/.config/antigravity inside the sandbox). Writing there is expected and
 * lands in Cindy's agy state, not in the user's files, so it gets no notice (JJ on cindy#15).
 */
export function agyWriteOutsideTask(tool: AcpRecord, taskDir: string, homeDir: string,
  inScopeDirs: readonly string[] = []): string | null {
  const { paths, cwd, command } = agyWriteTargets(tool);
  const base = cwd ? path.resolve(taskDir, expandHome(cwd, homeDir)) : taskDir;
  const scan: ShellScan = command !== undefined
    ? scanShell(command, base, homeDir)
    : { targets: paths.map(raw => path.resolve(base, expandHome(raw, homeDir))), uncertain: false };
  for (const target of scan.targets) {
    if (PSEUDO_TARGETS.has(target) || target.startsWith('/dev/fd/') || target.startsWith('/proc/self/fd/')) continue;
    if (inScopeDirs.some(dir => isInsideDir(target, path.resolve(dir)))) continue;
    try {
      if (checkAgyTaskPath(target, { taskDir }) === null) return target; // not in the task folder at all
    } catch (error) {
      if (isAgyLinkOutsideTaskError(error)) return target; // in the folder, but leads outside
      throw error;
    }
  }
  // A write whose target could not be worked out: give the notice rather than miss one (QQ W1).
  if (scan.uncertain && command !== undefined) return `shell: ${command}`;
  return null;
}
