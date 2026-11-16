/**
 * agy（Antigravity CLI）系统级文件隔离 —— 后备方案 B（good-night-oppie/cindy#1）。
 *
 * agy 的「只碰工作目录」只是它自己守规则，系统层面不拦。本模块用 bubblewrap
 * 把 agy 进程树关进一个新的挂载命名空间：只有当前任务目录（以及调用方显式给出的
 * 可写目录，例如 agy 自己的状态目录）可写，运行必需的系统目录只读，家目录是空的，
 * 宿主进程不可见。网络放在单独的网络命名空间里，由 pasta 只放外网：宿主的本机回环
 * （Cindy 的 MCP 端口、Review Inbox）和 X11 等抽象 Unix 套接字都连不上（cindy#1 6909268027）；
 * 云元数据、内网、宿主其他网卡和 tailnet 地址也连不上（cindy#3 QQ 复审，见 agyNetGuardCommand）。
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
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, opendir, lstat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type AgySandboxUnavailableReason =
  | 'unsupported-platform'
  | 'bwrap-missing'
  | 'bwrap-blocked'
  | 'network-isolation-missing'
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
  /** pasta (passt project): gives the sandbox its own network namespace with outbound-only access. */
  pastaPath: string;
  /** iproute2 `ip`, run inside pasta's namespace to install the private-range rules. */
  ipPath: string;
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
  pastaCandidates?: readonly string[];
  ipCandidates?: readonly string[];
  exists?: (p: string) => boolean;
  run?: (cmd: string, args: readonly string[]) => { status: number | null; stdout: string; stderr: string };
}

const DEFAULT_BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', '/usr/local/bin/bwrap'];
const DEFAULT_PASTA_CANDIDATES = ['/usr/bin/pasta', '/usr/local/bin/pasta', '/bin/pasta'];
const DEFAULT_IP_CANDIDATES = ['/usr/sbin/ip', '/sbin/ip', '/usr/bin/ip', '/bin/ip'];

/**
 * pasta options: own network namespace with a tap device for outbound traffic
 * only. --no-map-gw stops the gateway address from reaching the host; the four
 * `none` port specs disable every forward in both directions, including the
 * default ns-loopback -> host-loopback splice that would expose Cindy's local
 * MCP ports. DNS goes to a fixed in-sandbox address forwarded to one upstream.
 */
export const AGY_SANDBOX_DNS_ADDR = '169.254.1.53';
export function pastaNetArgs(dnsHost: string | null): string[] {
  const a = ['--config-net', '--quiet', '--no-map-gw', '-t', 'none', '-u', 'none', '-T', 'none', '-U', 'none'];
  if (dnsHost) a.push('--dns-forward', AGY_SANDBOX_DNS_ADDR, '--dns-host', dnsHost);
  return a;
}

/**
 * pasta relays the sandbox's outbound traffic through ordinary host sockets, so
 * without more rules the sandbox could reach anything the host can: the cloud
 * metadata service (169.254.169.254 hands out instance credentials), services
 * bound to 0.0.0.0 on the host's other interfaces (docker bridge, tailnet IP),
 * the LAN / VPC and the tailnet (cindy#3, QQ review).
 *
 * These ranges are closed with `ip rule ... prohibit` inside pasta's namespace
 * before bwrap starts. Policy rules are checked before any route, so the on-link
 * route pasta copies from the host (e.g. 172.26.0.0/20) cannot win over them by
 * being more specific, as it would over a blackhole route; `prohibit` also fails
 * fast (EACCES) instead of hanging. Only the in-sandbox DNS address is let
 * through, by a higher-priority rule. The rules belong to pasta's user
 * namespace; bwrap drops every capability and any namespace agy creates is a
 * child of it, so agy cannot remove them. Any failing step aborts the launch.
 */
export const AGY_SANDBOX_BLOCKED_V4 = ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10'] as const;
export const AGY_SANDBOX_BLOCKED_V6 = ['fc00::/7', 'fe80::/10', 'fd00:ec2::254/128'] as const;
export function agyNetGuardCommand(ipPath: string): string[] {
  const script = [
    'set -eu',
    'ip=$1; shift',
    `"$ip" rule add pref 100 to ${AGY_SANDBOX_DNS_ADDR}/32 lookup main`,
    ...AGY_SANDBOX_BLOCKED_V4.map(n => `"$ip" rule add pref 200 to ${n} prohibit`),
    // IPv6 disabled in the kernel: no IPv6 traffic at all, nothing to block.
    'if [ -e /proc/net/if_inet6 ]; then',
    ...AGY_SANDBOX_BLOCKED_V6.map(n => `  "$ip" -6 rule add pref 200 to ${n} prohibit`),
    'fi',
    'exec "$@"',
  ].join('\n');
  return ['/bin/sh', '-c', script, 'agy-net-guard', ipPath];
}

/**
 * First upstream nameserver, preferring non-loopback ones (systemd-resolved's real list first).
 * If the host only lists a loopback resolver (e.g. just 127.0.0.53), that one is used on purpose:
 * pasta then sends the sandbox's DNS queries to port 53 on the host loopback. Only DNS to that one
 * address is forwarded; every other host-loopback port stays closed (cindy#3 review, item 5).
 */
export function pickUpstreamDns(resolvTexts: readonly (string | null | undefined)[]): string | null {
  const all: string[] = [];
  for (const t of resolvTexts) {
    for (const m of (t ?? '').matchAll(/^\s*nameserver\s+(\S+)/gm)) all.push(m[1]!);
  }
  return all.find(a => !/^(127\.|::1$)/.test(a)) ?? all[0] ?? null;
}

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
  const pastaPath = (deps.pastaCandidates ?? DEFAULT_PASTA_CANDIDATES).find(p => exists(p));
  if (!pastaPath) return { ok: false, reason: 'network-isolation-missing', detail: 'pasta (passt) not installed' };
  const ipPath = (deps.ipCandidates ?? DEFAULT_IP_CANDIDATES).find(p => exists(p));
  if (!ipPath) return { ok: false, reason: 'network-isolation-missing', detail: 'iproute2 (ip) not installed' };
  const netTrial = run(pastaPath, [...pastaNetArgs(null), '--', ...agyNetGuardCommand(ipPath), '/bin/true']);
  if (netTrial.status !== 0) {
    return { ok: false, reason: 'network-isolation-missing', detail: netTrial.stderr.trim() || `pasta exit ${netTrial.status}` };
  }
  const [maj, min] = parsed;
  return { ok: true, bwrapPath, pastaPath, ipPath, version: parsed.join('.'), supportsDisableUserns: maj > 0 || min >= 8 };
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

/**
 * Extra mounts must not hand agy the real home or anything in it (cindy#3 review,
 * item 3). Sources (already realpath'd) that are /, are or contain the home dir,
 * or lie inside the home dir are refused; the only exception is a path inside
 * agy's private state root. The state root itself must not be, contain or lie
 * inside the real ~/.gemini or ~/.config/antigravity, and must not contain home.
 */
export function assertAgyMountSources(sources: readonly string[], homeDir: string, stateRoot: string | null): void {
  const refuse = (detail: string) => { throw new AgySandboxUnavailableError('task-dir-unsafe', detail); };
  if (stateRoot !== null) {
    if (isInside(homeDir, stateRoot)) refuse(`agy state root must not be or contain the home directory: ${stateRoot}`);
    for (const d of AGY_PRIVATE_STATE_DIRS) {
      const real = path.join(homeDir, d.homeRelative);
      if (isInside(real, stateRoot) || isInside(stateRoot, real)) {
        refuse(`agy state root must not be the real ~/${d.homeRelative}, its parent or inside it: ${stateRoot}`);
      }
    }
  }
  for (const s of sources) {
    if (s === '/' || isInside(homeDir, s)) refuse(`mount source is or contains the home directory: ${s}`);
    if (isInside(s, homeDir) && !(stateRoot !== null && isInside(s, stateRoot))) {
      refuse(`mount source is inside the home directory: ${s}`);
    }
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
  pastaPath: string;
  /** iproute2 `ip` (see agyNetGuardCommand). */
  ipPath: string;
  /** Upstream DNS server pasta forwards to (see pickUpstreamDns); null = no DNS. */
  dnsHost: string | null;
  /** File mounted as the sandbox's /etc/resolv.conf (points at AGY_SANDBOX_DNS_ADDR). */
  resolvConfPath?: string;
  /** Ids agy runs as inside the sandbox; default: the caller's. */
  uid?: number;
  gid?: number;
  binaryPath: string;
  args: readonly string[];
  /** Absolute task dir; bound read-write at the same path and used as cwd. */
  taskDir: string;
  homeDir: string;
  /** Extra read-write dirs (e.g. agy's own state dir). `target` defaults to `source`. */
  writableDirs?: readonly { source: string; target?: string }[];
  /** Extra read-only paths bound at the same path (e.g. agy install resources). Never in the home dir. */
  readOnlyPaths?: readonly string[];
  /** agy's private state root; writable dirs inside the home dir are allowed only inside it. */
  stateRoot?: string;
  /** Environment of the would-be agy process; filtered before entering the sandbox. */
  env: NodeJS.ProcessEnv;
  /** Env keys that must pass through (e.g. the keys returned by the auth env provider). */
  passEnvKeys?: readonly string[];
  /** How agy logs in inside the sandbox; see `AgySandboxLogin`. Defaults to private state. */
  login?: AgySandboxLogin;
  fs?: AgySandboxFsView;
}

export interface AgySandboxLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

const ETC_ENTRIES = ['hosts', 'host.conf', 'nsswitch.conf', 'gai.conf', 'passwd', 'group', 'localtime',
  'ld.so.cache', 'ld.so.conf', 'ld.so.conf.d', 'ssl', 'ca-certificates', 'pki', 'crypto-policies',
  'protocols', 'services', 'mime.types', 'alternatives', 'gitconfig'];
const ROOT_LIB_DIRS = ['bin', 'sbin', 'lib', 'lib64', 'lib32', 'libx32'];
const ENV_ALLOW = new Set(['LANG', 'LANGUAGE', 'TERM', 'COLORTERM', 'TZ', 'NO_COLOR', 'FORCE_COLOR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS']);
const ENV_ALLOW_PREFIX = ['LC_', 'AGY_', 'ANTIGRAVITY_'];
/**
 * Never enter the sandbox, even if a caller lists them in passEnvKeys: the
 * session bus would hand agy the whole system keyring, the agent sockets
 * would hand it SSH/GPG keys, and display variables point at the desktop.
 */
const ENV_DENY = new Set(['DBUS_SESSION_BUS_ADDRESS', 'DBUS_SYSTEM_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
  'SSH_AUTH_SOCK', 'SSH_AGENT_PID', 'GPG_AGENT_INFO', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY']);
const SANDBOX_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export function filterAgySandboxEnv(env: NodeJS.ProcessEnv, homeDir: string, taskDir: string,
  passEnvKeys: readonly string[] = []): NodeJS.ProcessEnv {
  const pass = new Set(passEnvKeys);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || ENV_DENY.has(k)) continue;
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
  assertAgyTaskDirPaths(taskDir, homeDir, writable.flatMap(w => [w.source, w.target]));
  const readOnly = (input.readOnlyPaths ?? []).filter(p => fs.exists(p)).map(p => fs.realpath(p));
  assertAgyMountSources([...writable.map(w => w.source), ...readOnly], homeDir,
    input.stateRoot ? fs.realpath(input.stateRoot) : null);

  // --share-net shares pasta's isolated namespace (the outer process), never the host's.
  const a: string[] = ['--unshare-all', '--share-net', '--die-with-parent', '--new-session',
    '--cap-drop', 'ALL', '--hostname', 'agy-sandbox'];
  // pasta maps the caller to root in its user namespace; map back to the real ids.
  a.push('--uid', String(input.uid ?? process.getuid?.() ?? 1000), '--gid', String(input.gid ?? process.getgid?.() ?? 1000));
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
  if (input.resolvConfPath) a.push('--ro-bind', input.resolvConfPath, '/etc/resolv.conf');

  // Empty home: hide every user's files, then add back only what was asked for.
  a.push('--tmpfs', '/home');
  if (!isInside(homeDir, '/home')) a.push('--tmpfs', path.dirname(homeDir));
  a.push('--dir', homeDir);
  for (const w of writable) a.push('--bind', w.source, w.target);
  if (!isInside(binary, '/usr')) a.push('--ro-bind', binary, binary);
  for (const r of readOnly) {
    if (isInside(taskDir, r)) continue; // never re-cover the writable task dir
    a.push('--ro-bind', r, r);
  }
  a.push('--bind', taskDir, taskDir, '--chdir', taskDir);
  a.push('--', binary, ...input.args);

  const login = input.login ?? { kind: 'private-state' };
  const loginEnv = login.kind === 'api-key' ? login.env : {};
  return {
    command: input.pastaPath,
    args: [...pastaNetArgs(input.dnsHost), '--', ...agyNetGuardCommand(input.ipPath), input.bwrapPath, ...a],
    env: filterAgySandboxEnv({ ...input.env, ...loginEnv }, homeDir, taskDir,
      [...(input.passEnvKeys ?? []), ...Object.keys(loginEnv)]),
  };
}

// ---------------------------------------------------------------------------
// agy private state & login (cindy#1 6908586833 / 6908683429)
// ---------------------------------------------------------------------------

/**
 * How agy logs in inside the sandbox. The D-Bus session bus is deliberately
 * NOT an option: exposing it would give agy every secret in the system keyring.
 * - 'private-state' (option b): the owner logs in once inside the sandbox;
 *   with no session bus agy falls back to file-based token storage in its app
 *   data dir, which lives in the private state root and survives relaunches.
 * - 'api-key' (option c, needs the owner's approval): Cindy passes the key via
 *   the environment on every launch; agy does not persist it.
 */
export type AgySandboxLogin =
  | { kind: 'private-state' }
  | { kind: 'api-key'; env: Readonly<Record<string, string>> };

/**
 * agy writes outside its app data dir too: plugin config under ~/.gemini/config
 * and plugin secrets under ~/.config/antigravity. Both are mapped from one
 * private state root so nothing lands in (or is read from) the real home.
 */
export const AGY_PRIVATE_STATE_DIRS = [
  { name: 'gemini', homeRelative: '.gemini' },
  { name: 'config-antigravity', homeRelative: path.join('.config', 'antigravity') },
] as const;

export function agyPrivateStateMounts(stateRoot: string, homeDir: string): { source: string; target: string }[] {
  return AGY_PRIVATE_STATE_DIRS.map(d => ({ source: path.join(stateRoot, d.name), target: path.join(homeDir, d.homeRelative) }));
}

/** Create the private state root (0700) and its sub-dirs; returns the mounts. */
export async function ensureAgyPrivateState(stateRoot: string, homeDir: string): Promise<{ source: string; target: string }[]> {
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const st = await lstat(stateRoot);
  const uid = process.getuid?.();
  if (!st.isDirectory() || (uid !== undefined && st.uid !== uid)) {
    throw new AgySandboxUnavailableError('task-dir-unsafe', `agy state root is not a directory owned by this user: ${stateRoot}`);
  }
  await chmod(stateRoot, 0o700);
  const mounts = agyPrivateStateMounts(stateRoot, homeDir);
  for (const m of mounts) await mkdir(m.source, { recursive: true, mode: 0o700 });
  return mounts;
}

function readText(p: string): string | null {
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}

/** The sandbox's resolv.conf: a single nameserver, the in-sandbox address pasta forwards. */
async function writeSandboxResolvConf(): Promise<string> {
  const dir = path.join(os.tmpdir(), `cindy-agy-sandbox-${process.getuid?.() ?? 'u'}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'resolv.conf');
  await writeFile(file, `nameserver ${AGY_SANDBOX_DNS_ADDR}\n`, { mode: 0o644 });
  return file;
}

/**
 * One call at the agy spawn site: probe, check the task dir, build the wrapped
 * command. Throws `AgySandboxUnavailableError` instead of returning an
 * unconfined launch.
 */
export async function prepareAgySandboxedLaunch(
  input: Omit<AgySandboxLaunchInput, 'bwrapPath' | 'supportsDisableUserns' | 'pastaPath' | 'dnsHost' | 'resolvConfPath'> & {
    probe?: AgySandboxProbe;
    /** agy's private state root (outside the task dir); mapped to ~/.gemini and ~/.config/antigravity. */
    stateRoot?: string;
  },
): Promise<AgySandboxLaunch & { hardlinkScan: HardlinkScanResult }> {
  const probe = input.probe ?? probeAgySystemSandbox();
  if (!probe.ok) throw new AgySandboxUnavailableError(probe.reason, probe.detail);
  const hardlinkScan = await scanTaskDirForHardlinks(input.taskDir);
  if (hardlinkScan.hardlinked) {
    throw new AgySandboxUnavailableError('task-dir-unsafe', `hard-linked file in task dir: ${hardlinkScan.hardlinked}`);
  }
  if (input.stateRoot && isInside(path.resolve(input.stateRoot), path.resolve(input.taskDir))) {
    throw new AgySandboxUnavailableError('task-dir-unsafe', 'agy state root must not be inside the task dir');
  }
  const stateMounts = input.stateRoot ? await ensureAgyPrivateState(input.stateRoot, input.homeDir) : [];
  const dnsHost = pickUpstreamDns([readText('/run/systemd/resolve/resolv.conf'), readText('/etc/resolv.conf')]);
  const resolvConfPath = dnsHost ? await writeSandboxResolvConf() : undefined;
  const launch = buildAgySandboxLaunch({ ...input, writableDirs: [...stateMounts, ...(input.writableDirs ?? [])],
    bwrapPath: probe.bwrapPath, pastaPath: probe.pastaPath, supportsDisableUserns: probe.supportsDisableUserns,
    dnsHost, resolvConfPath });
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
    'zh-CN': '这台电脑上开不了 Antigravity 的文件隔离（{reason}）。为了不让它碰到任务文件夹以外的文件，这次没有启动 Antigravity。可以换用其他引擎，或请管理员安装并允许 bubblewrap 和 pasta 后再试。',
    en: 'Cindy could not turn on file isolation for Antigravity on this computer ({reason}). To keep it away from files outside the task folder, Antigravity was not started. Use another engine, or ask an administrator to install and allow bubblewrap and pasta, then try again.',
    reason: {
      'unsupported-platform': { 'zh-CN': '这个系统暂不支持', en: 'not supported on this system yet' },
      'bwrap-missing': { 'zh-CN': '没有安装 bubblewrap', en: 'bubblewrap is not installed' },
      'bwrap-blocked': { 'zh-CN': '系统不允许创建隔离环境', en: 'the system does not allow creating the isolated environment' },
      'network-isolation-missing': { 'zh-CN': '没有安装 pasta，无法隔离网络', en: 'pasta is not installed, so the network cannot be isolated' },
      'task-dir-unsafe': { 'zh-CN': '任务文件夹不能被安全隔离', en: 'the task folder cannot be isolated safely' },
    },
  },
} as const;
