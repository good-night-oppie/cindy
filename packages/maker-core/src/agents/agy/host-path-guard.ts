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
 * Scope: only folders of agy tasks. Host entries without a session look the folder up in a small
 * process-wide registry that AgyAgent fills while a session is open; with no agy session the check
 * returns null and nothing changes for other engines.
 *
 * The write side (`agyWriteOutsideTask`) uses the same real-path resolution: a write-type tool call
 * whose target is outside the task folder, or reaches outside through a link inside it, gets JJ's
 * first sentence beside the reply. It is a notice, not a block.
 */
import { constants, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { open, opendir, readlink, stat, type FileHandle } from 'node:fs/promises';
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
// Registry of open agy task folders (host process wide)
// ---------------------------------------------------------------------------

interface TaskDirEntry { lexical: string; real: string }
const registered = new Map<symbol, TaskDirEntry>();

/** AgyAgent calls this when a session starts; the returned function releases it when the session closes. */
export function registerAgyTaskDir(dir: string): () => void {
  const lexical = path.resolve(dir);
  const key = Symbol(lexical);
  registered.set(key, { lexical, real: realpathOr(lexical) });
  return () => { registered.delete(key); };
}

export function registeredAgyTaskDirs(): string[] {
  return [...new Set([...registered.values()].map(entry => entry.lexical))];
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

export function isInsideDir(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The single check every host entry uses before reading, listing or uploading something that may lie
 * in an agy task folder. Returns null when the path is not in any agy task folder (nothing to check).
 * Throws AgyLinkOutsideTaskError when the path is in the task folder but its real path is not —
 * a link to the outside, several links whose last hop leaves, a link to a missing target, or a loop.
 * A relative path is taken relative to `taskDir`.
 */
export function checkAgyTaskPath(target: string, options: AgyTaskPathOptions = {}): AgyTaskPathCheck | null {
  const candidates: TaskDirEntry[] = options.taskDir !== undefined
    ? [{ lexical: path.resolve(options.taskDir), real: realpathOr(path.resolve(options.taskDir)) }]
    : [...registered.values()];
  if (!candidates.length) return null;
  // Without a task folder to anchor it, a relative string (URL, name) is not a task-folder path.
  if (options.taskDir === undefined && !path.isAbsolute(target)) return null;
  const requested = path.resolve(options.taskDir ?? '', target);
  for (const dir of candidates) {
    if (!isInsideDir(requested, dir.lexical) && !isInsideDir(requested, dir.real)) continue;
    const real = resolveRealPath(requested);
    if (!real.ok || !isInsideDir(real.path, dir.real)) {
      throw new AgyLinkOutsideTaskError(requested, real.ok ? real.path : real.reason, dir.lexical, options.locale);
    }
    return { taskDir: dir.lexical, realTaskDir: dir.real, requestedPath: requested, realPath: real.path };
  }
  return null;
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
const ALL_OPERANDS = new Set(['rm', 'rmdir', 'unlink', 'mv', 'touch', 'tee', 'truncate', 'shred']);
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

/** Write targets of one shell line (redirections and file-changing commands). */
function shellWriteTargets(line: string): string[] {
  const out: string[] = [];
  for (const words of shellCommands(line)) {
    const rest: string[] = [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i]!;
      if (w === '>' || w === '>>' || w === '&>') {
        const target = words[i + 1];
        // `2>` leaves a stray "2" in rest; `>&2` is a fd, not a file.
        if (rest.length && /^\d$/.test(rest[rest.length - 1]!)) rest.pop();
        if (target !== undefined && target !== '>&' && !/^&?\d$/.test(target)) out.push(target);
        i++; continue;
      }
      if (w === '>&') { i++; continue; }
      if (w === '<') { i++; continue; }
      rest.push(w);
    }
    let start = 0;
    while (start < rest.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[start]!) || ['sudo', 'env', 'command', 'nohup', 'time'].includes(rest[start]!))) start++;
    const name = path.basename(rest[start] ?? '');
    const args = rest.slice(start + 1);
    const operands = args.filter(a => !a.startsWith('-'));
    if (ALL_OPERANDS.has(name)) out.push(...operands);
    else if (LAST_OPERAND.has(name) && operands.length) {
      // `ln -s target` (one operand) makes the link in the current folder.
      if (!(name === 'ln' && operands.length === 1)) out.push(operands[operands.length - 1]!);
    } else if (name === 'sed' && args.some(a => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      out.push(...operands.slice(1));
    } else if (name === 'dd') {
      for (const a of args) if (a.startsWith('of=')) out.push(a.slice(3));
    }
  }
  return out;
}

/** Target paths of a write-type agy tool call, as written by the call. Empty for anything else. */
export function agyWriteTargets(tool: AcpRecord): { paths: string[]; cwd?: string } {
  const input = { ...record(tool.args), ...record(tool.rawInput) };
  const cwd = [input.Cwd, input.cwd].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (tool.kind === 'execute') {
    const command = [input.CommandLine, input.command, input.cmd].find((v): v is string => typeof v === 'string');
    return { paths: command ? shellWriteTargets(command) : [], cwd };
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
  const { paths, cwd } = agyWriteTargets(tool);
  const base = cwd ? path.resolve(taskDir, expandHome(cwd, homeDir)) : taskDir;
  for (const raw of paths) {
    const target = path.resolve(base, expandHome(raw, homeDir));
    if (PSEUDO_TARGETS.has(target) || target.startsWith('/dev/fd/') || target.startsWith('/proc/self/fd/')) continue;
    if (inScopeDirs.some(dir => isInsideDir(target, path.resolve(dir)))) continue;
    try {
      if (checkAgyTaskPath(target, { taskDir }) === null) return target; // not in the task folder at all
    } catch (error) {
      if (isAgyLinkOutsideTaskError(error)) return target; // in the folder, but leads outside
      throw error;
    }
  }
  return null;
}
