/**
 * agy（Antigravity CLI）系统级文件隔离 —— 后备方案 B（good-night-oppie/cindy#1）。
 *
 * agy 的「只碰工作目录」只是它自己守规则，系统层面不拦。本模块用 bubblewrap
 * 把 agy 进程树关进一个新的挂载命名空间：只有当前任务目录（以及调用方显式给出的
 * 可写目录，例如 agy 自己的状态目录）可写，运行必需的系统目录只读，家目录是空的，
 * 宿主进程不可见。网络照常共享（agy 要访问模型，与其他引擎一致；不在本层范围）。
 *
 * 失败策略：fail closed。探测不到可用的 bubblewrap、或任务目录不安全时抛
 * `AgySandboxUnavailableError`，调用方不得退回无隔离启动。
 *
 * 本模块不改 agy 自己的设置文件（那是方案 A 的范围），也不决定 agy 何时启动；
 * 接入只需在「起 agy 子进程」那一处把 { binaryPath, args, env } 换成
 * `prepareAgySandboxedLaunch` 的返回值。
 *
 * 被拦下的读写不会有专门的内核通知：agy 看到的只是 ENOENT / EACCES / EROFS。
 * `detectAgySandboxDenial` 用失败工具调用的路径和错误文本判断「这是隔离拦的」，
 * 供 translator 在工具结果后追加宿主标注、并给用户白话提示（文案待 JJ 定稿）。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { opendir, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AgySandboxUnavailableReason =
  | 'unsupported-platform'
  | 'bwrap-missing'
  | 'bwrap-blocked'
  | 'task-dir-unsafe';

export class AgySandboxUnavailableError extends Error {
  readonly reason: AgySandboxUnavailableReason;
  readonly detail: string;
  constructor(reason: AgySandboxUnavailableReason, detail: string) {
    super(`agy file isolation unavailable (${reason}): ${detail}`);
    this.name = 'AgySandboxUnavailableError';
    this.reason = reason;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface AgySandboxProbeOk {
  ok: true;
  bwrapPath: string;
  version: string;
  /** bubblewrap >= 0.8 supports --disable-userns (blocks nested user namespaces). */
  supportsDisableUserns: boolean;
}
export interface AgySandboxProbeFailed {
  ok: false;
  reason: Exclude<AgySandboxUnavailableReason, 'task-dir-unsafe'>;
  detail: string;
}
export type AgySandboxProbe = AgySandboxProbeOk | AgySandboxProbeFailed;

export interface AgySandboxProbeDeps {
  platform?: NodeJS.Platform;
  bwrapCandidates?: readonly string[];
  exists?: (p: string) => boolean;
  run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
}

const DEFAULT_BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];

function defaultRun(cmd: string, args: readonly string[]) {
  const r = spawnSync(cmd, args as string[], { encoding: 'utf8', timeout: 5000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? String(r.error ?? '') };
}

export function parseBwrapVersion(text: string): [number, number, number] | null {
  const m = /bubblewrap\s+(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/**
 * Checks that bubblewrap exists and can actually create an unprivileged
 * sandbox on this host (Ubuntu 24.04+ AppArmor or container hosts may block it).
 */
export function probeAgySystemSandbox(deps: AgySandboxProbeDeps = {}): AgySandboxProbe {
  const platform = deps.platform ?? process.platform;
  if (platform !== 'linux') {
    return { ok: false, reason: 'unsupported-platform', detail: `platform ${platform}` };
  }
  const exists = deps.exists ?? existsSync;
  const run = deps.run ?? defaultRun;
  const bwrapPath = (deps.bwrapCandidates ?? DEFAULT_BWRAP_CANDIDATES).find(p => exists(p));
  if (!bwrapPath) return { ok: false, reason: 'bwrap-missing', detail: 'bubblewrap not installed' };

  const v = run(bwrapPath, ['--version']);
  const parsed = parseBwrapVersion(v.stdout + v.stderr);
  if (v.status !== 0 || !parsed) {
    return { ok: false, reason: 'bwrap-missing', detail: (v.stderr || v.stdout).trim() || 'bwrap --version failed' };
  }
  const trial = run(bwrapPath, ['--unshare-all', '--share-net', '--die-with-parent',
    '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev', '--', '/bin/true']);
  if (trial.status !== 0) {
    return { ok: false, reason: 'bwrap-blocked', detail: trial.stderr.trim() || `exit ${trial.status}` };
  }
  const [maj, min] = parsed;
  return { ok: true, bwrapPath, version: parsed.join('.'), supportsDisableUserns: maj > 0 || min >= 8 };
}

// ---------------------------------------------------------------------------
// Task dir safety
// ---------------------------------------------------------------------------

const REFUSED_EXACT = new Set(['/', '/home', '/root', '/tmp', '/var', '/opt', '/srv', '/mnt', '/media']);
const REFUSED_PREFIX = ['/etc', '/usr', '/proc', '/sys', '/dev', '/run', '/boot', '/bin', '/sbin', '/lib'];

export function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** Synchronous path checks (no filesystem walk). Throws on unsafe input. */
export function assertAgyTaskDirPaths(taskDir: string, homeDir: string, writableDirs: readonly string[]): void {
  const refuse = (detail: string) => { throw new AgySandboxUnavailableError('task-dir-unsafe', detail); };
  if (!path.isAbsolute(taskDir)) refuse(`task dir is not absolute: ${taskDir}`);
  if (REFUSED_EXACT.has(taskDir) || REFUSED_PREFIX.some(p => isInside(taskDir, p))) {
    refuse(`system path cannot be a task dir: ${taskDir}`);
  }
  if (taskDir === homeDir || isInside(homeDir, taskDir)) refuse('task dir must not be or contain the home directory');
  for (const w of writableDirs) {
    if (isInside(w, taskDir) || isInside(taskDir, w)) refuse(`task dir overlaps writable dir: ${w}`);
  }
}

export interface HardlinkScanResult { hardlinked: string | null; scanned: number; truncated: boolean }

/**
 * A hard link inside the task dir shares its inode with a file outside it, so a
 * write through it changes the outside file. Walk the task dir (same device,
 * no symlink follow) and report the first multiply-linked regular file.
 */
export async function scanTaskDirForHardlinks(taskDir: string, limit = 200_000): Promise<HardlinkScanResult> {
  const root = await lstat(taskDir);
  const stack = [taskDir];
  let scanned = 0;
  while (stack.length) {
    const dir = stack.pop()!;
    let handle;
    try { handle = await opendir(dir); } catch { continue; }
    for await (const entry of handle) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const st = await lstat(p).catch(() => null);
        if (st && st.dev === root.dev) stack.push(p);
      } else if (entry.isFile()) {
        if (++scanned > limit) return { hardlinked: null, scanned: scanned - 1, truncated: true };
        const st = await lstat(p).catch(() => null);
        if (st && st.nlink > 1) return { hardlinked: p, scanned, truncated: false };
      }
    }
  }
  return { hardlinked: null, scanned, truncated: false };
}

// ---------------------------------------------------------------------------
// Launch builder (pure, given an fs view)
// ---------------------------------------------------------------------------

export interface AgySandboxFsView {
  exists(p: string): boolean;
  /** Returns the link target if p is a symlink, else null. */
  readSymlink(p: string): string | null;
  realpath(p: string): string;
}

const realFs: AgySandboxFsView = {
  exists: existsSync,
  readSymlink: p => { try { return lstatSync(p).isSymbolicLink() ? readlinkSync(p) : null; } catch { return null; } },
  realpath: p => realpathSync(p),
};

export interface AgySandboxLaunchInput {
  bwrapPath: string;
  supportsDisableUserns: boolean;
  binaryPath: string;
  args: readonly string[];
  /** Absolute task dir; bound read-write at the same path and used as cwd. */
  taskDir: string;
  homeDir: string;
  /** Extra read-write dirs (e.g. agy's own state dir). `target` defaults to `source`. */
  writableDirs?: readonly { source: string; target?: string }[];
  /** Extra read-only paths bound at the same path (e.g. agy install resources). */
  readOnlyPaths?: readonly string[];
  /** Environment of the would-be agy process; filtered before entering the sandbox. */
  env: NodeJS.ProcessEnv;
  /** Env keys that must pass through (e.g. the keys returned by the auth env provider). */
  passEnvKeys?: readonly string[];
  fs?: AgySandboxFsView;
}

export interface AgySandboxLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const ETC_ENTRIES = ['hosts', 'host.conf', 'nsswitch.conf', 'gai.conf', 'passwd', 'group', 'localtime',
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'ssl', 'ca-certificates', 'pki', 'crypto-policies',
  'protocols', 'services', 'mime.types', 'alternatives', 'resolv.conf', 'gitconfig'];
const ROOT_LIB_DIRS = ['bin', 'sbin', 'lib', 'lib64', 'lib32', 'libx32'];
const ENV_ALLOW = new Set(['LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
const ENV_ALLOW_PREFIX = ['LC_', 'AGY_', 'ANTIGRAVITY_'];
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function filterAgySandboxEnv(env: NodeJS.ProcessEnv, homeDir: string, taskDir: string,
  passEnvKeys: readonly string[] = []): NodeJS.ProcessEnv {
  const pass = new Set(passEnvKeys);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (pass.has(k) || ENV_ALLOW.has(k) || ENV_ALLOW_PREFIX.some(p => k.startsWith(p))) out[k] = v;
  }
  const user = env.USER ?? env.LOGNAME ?? (() => { try { return os.userInfo().username; } catch { return 'user'; } })();
  Object.assign(out, {
    HOME: homeDir, USER: user, LOGNAME: user, PATH: SANDBOX_PATH, TMPDIR: '/tmp',
    CINDY_AGY_SANDBOX: '1', CINDY_AGY_SANDBOX_TASK_DIR: taskDir,
  });
  return out;
}

export function buildAgySandboxLaunch(input: AgySandboxLaunchInput): AgySandboxLaunch {
  const fs = input.fs ?? realFs;
  const taskDir = fs.realpath(input.taskDir);
  const homeDir = fs.realpath(input.homeDir);
  const binary = fs.realpath(input.binaryPath);
  const writable = (input.writableDirs ?? []).map(w => ({ source: fs.realpath(w.source), target: w.target ?? fs.realpath(w.source) }));
  assertAgyTaskDirPaths(taskDir, homeDir, writable.map(w => w.target));

  const a: string[] = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--hostname', 'agy-sandbox'];
  if (input.supportsDisableUserns) a.push('--disable-userns');

  a.push('--ro-bind', '/usr', '/usr', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp', '--tmpfs', '/run');
  for (const d of ROOT_LIB_DIRS) {
    const p = `/${d}`;
    const link = fs.readSymlink(p);
    if (link !== null) a.push('--symlink', link, p);
    else if (fs.exists(p)) a.push('--ro-bind', p, p);
  }
  for (const e of ETC_ENTRIES) {
    const p = `/etc/${e}`;
    if (fs.exists(p)) a.push('--ro-bind', fs.realpath(p), p);
  }

  // Empty home: hide every user's files, then add back only what was asked for.
  a.push('--tmpfs', '/home');
  if (!isInside(homeDir, '/home')) a.push('--tmpfs', path.dirname(homeDir));
  a.push('--dir', homeDir);
  for (const w of writable) a.push('--bind', w.source, w.target);
  if (!isInside(binary, '/usr')) a.push('--ro-bind', binary, binary);
  for (const p of input.readOnlyPaths ?? []) {
    if (!fs.exists(p)) continue;
    const r = fs.realpath(p);
    if (isInside(taskDir, r)) continue; // never re-cover the writable task dir
    a.push('--ro-bind', r, r);
  }
  a.push('--bind', taskDir, taskDir, '--chdir', taskDir);
  a.push('--', binary, ...input.args);

  return {
    command: input.bwrapPath,
    args: a,
    env: filterAgySandboxEnv(input.env, homeDir, taskDir, input.passEnvKeys),
  };
}

/**
 * One call at the agy spawn site: probe, check the task dir, build the wrapped
 * command. Throws `AgySandboxUnavailableError` instead of returning an
 * unconfined launch.
 */
export async function prepareAgySandboxedLaunch(
  input: Omit<AgySandboxLaunchInput, 'bwrapPath' | 'supportsDisableUserns'> & { probe?: AgySandboxProbe },
): Promise<AgySandboxLaunch & { hardlinkScan: HardlinkScanResult }> {
  const probe = input.probe ?? probeAgySystemSandbox();
  if (!probe.ok) throw new AgySandboxUnavailableError(probe.reason, probe.detail);
  const hardlinkScan = await scanTaskDirForHardlinks(input.taskDir);
  if (hardlinkScan.hardlinked) {
    throw new AgySandboxUnavailableError('task-dir-unsafe', `hard-linked file in task dir: ${hardlinkScan.hardlinked}`);
  }
  const launch = buildAgySandboxLaunch({ ...input, bwrapPath: probe.bwrapPath, supportsDisableUserns: probe.supportsDisableUserns });
  return { ...launch, hardlinkScan };
}

// ---------------------------------------------------------------------------
// Denial attribution
// ---------------------------------------------------------------------------

export type AgySandboxDenialKind = 'read' | 'write' | 'unknown';
export interface AgySandboxDenial { path: string; kind: AgySandboxDenialKind }

const DENIAL_ERROR_RE = /\b(ENOENT|EACCES|EPERM|EROFS)\b|No such file or directory|Permission denied|Read-only file system|Operation not permitted|cannot (open|create|access)/i;

/**
 * Decide whether a failed tool call was most likely stopped by the isolation
 * layer: it failed with a not-found / permission error and at least one of its
 * absolute paths lies outside the task dir and the extra writable dirs.
 * Paths under /usr and /tmp are visible inside the sandbox, so failures there
 * are not attributed to the isolation.
 */
export function detectAgySandboxDenial(input: {
  paths: readonly (string | null | undefined)[];
  errorText: string | null | undefined;
  taskDir: string;
  /** Other dirs mapped into the sandbox (writable dirs, read-only paths). */
  visibleDirs?: readonly string[];
  kind?: AgySandboxDenialKind;
}): AgySandboxDenial | null {
  if (!input.errorText || !DENIAL_ERROR_RE.test(input.errorText)) return null;
  const allowed = [input.taskDir, ...(input.visibleDirs ?? []), '/usr', '/tmp', '/proc', '/dev'];
  for (const raw of input.paths) {
    if (!raw) continue;
    const p = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(input.taskDir, raw);
    if (!allowed.some(dir => isInside(p, dir))) return { path: p, kind: input.kind ?? 'unknown' };
  }
  return null;
}

/** Host annotation appended to the tool result (model-facing, English like other host notes). */
export function agySandboxDenialModelNote(denial: AgySandboxDenial): string {
  return `[Cindy] ${denial.path} is outside this task's folder. Antigravity runs inside Cindy's file isolation ` +
    'and can only read and write files in the task folder, so Cindy blocked this access; the file may well exist. ' +
    'Do not retry or look for workarounds. If the file is needed, ask the user to copy it into the task folder.';
}

/**
 * User-facing plain-language copy. DRAFT — pending JJ's final wording
 * (good-night-oppie/cindy#1); not wired into i18n until approved.
 */
export const AGY_SANDBOX_USER_COPY_DRAFT = {
  blocked: {
    'zh-CN': 'Antigravity 想{action}任务文件夹外的「{path}」，Cindy 已拦下。Antigravity 只能用这个任务文件夹里的文件。如果需要这个文件，请把它复制到任务文件夹里，再让 Antigravity 继续。',
    en: 'Antigravity tried to {action} "{path}", which is outside this task\'s folder. Cindy blocked it. Antigravity can only use files in the task folder. If it needs this file, copy it into the task folder and ask Antigravity to continue.',
    action: { read: { 'zh-CN': '读取', en: 'read' }, write: { 'zh-CN': '修改', en: 'change' }, unknown: { 'zh-CN': '使用', en: 'use' } },
  },
  unavailable: {
    'zh-CN': '这台电脑上开不了 Antigravity 的文件隔离（{reason}）。为了不让它碰到任务文件夹以外的文件，这次没有启动 Antigravity。可以换用其他引擎，或请管理员安装并允许 bubblewrap 后再试。',
    en: 'Cindy could not turn on file isolation for Antigravity on this computer ({reason}). To keep it away from files outside the task folder, Antigravity was not started. Use another engine, or ask an administrator to install and allow bubblewrap, then try again.',
    reason: {
      'unsupported-platform': { 'zh-CN': '这个系统暂不支持', en: 'not supported on this system yet' },
      'bwrap-missing': { 'zh-CN': '没有安装 bubblewrap', en: 'bubblewrap is not installed' },
      'bwrap-blocked': { 'zh-CN': '系统不允许创建隔离环境', en: 'the system does not allow creating the isolated environment' },
      'task-dir-unsafe': { 'zh-CN': '任务文件夹不能被安全隔离', en: 'the task folder cannot be isolated safely' },
    },
  },
} as const;
