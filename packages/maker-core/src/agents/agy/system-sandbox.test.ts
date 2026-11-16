import { spawnSync } from 'node:child_process';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGY_SANDBOX_BLOCKED_V4,
  AGY_SANDBOX_BLOCKED_V6,
  AgySandboxUnavailableError,
  agyNetGuardCommand,
  agyPrivateStateMounts,
  agySandboxDenialModelNote,
  assertAgyTaskDirPaths,
  pickUpstreamDns,
  buildAgySandboxLaunch,
  detectAgySandboxDenial,
  filterAgySandboxEnv,
  parseBwrapVersion,
  prepareAgySandboxedLaunch,
  probeAgySystemSandbox,
  scanTaskDirForHardlinks,
  type AgySandboxFsView,
} from './system-sandbox.js';

const fakeFs = (opts: { symlinks?: Record<string, string>; existing?: string[] } = {}): AgySandboxFsView => ({
  exists: p => (opts.existing ?? ['/etc/hosts', '/etc/ssl', '/etc/resolv.conf', '/lib64']).includes(p) || p in (opts.symlinks ?? {}),
  readSymlink: p => (opts.symlinks ?? { '/bin': 'usr/bin', '/lib': 'usr/lib' })[p] ?? null,
  realpath: p => (p === '/etc/resolv.conf' ? '/run/systemd/resolve/stub-resolv.conf' : p),
});

const base = {
  bwrapPath: '/usr/bin/bwrap',
  supportsDisableUserns: false,
  pastaPath: '/usr/bin/pasta',
  ipPath: '/usr/sbin/ip',
  dnsHost: '172.26.0.2',
  resolvConfPath: '/tmp/cindy-agy-sandbox-1000/resolv.conf',
  uid: 1000,
  gid: 1000,
  binaryPath: '/home/u/.local/bin/agy',
  args: ['--acp'],
  taskDir: '/home/u/work/task-1',
  homeDir: '/home/u',
  env: { PATH: '/home/u/bin:/usr/bin', HOME: '/home/u', USER: 'u', GITHUB_TOKEN: 'secret', OPENAI_API_KEY: 'k', LANG: 'C.UTF-8', AGY_FOO: '1', AUTH_X: 'tok' },
  passEnvKeys: ['AUTH_X'],
  fs: fakeFs(),
};

function pairs(args: string[], flag: string): string[][] {
  const out: string[][] = [];
  args.forEach((a, i) => { if (a === flag) out.push(args.slice(i + 1, i + 3)); });
  return out;
}

describe('buildAgySandboxLaunch', () => {
  it('runs bwrap inside pasta with every host-loopback path closed', () => {
    const l = buildAgySandboxLaunch(base);
    expect(l.command).toBe('/usr/bin/pasta');
    const sep = l.args.indexOf('--');
    const pasta = l.args.slice(0, sep);
    expect(pasta).toEqual(expect.arrayContaining(['--config-net', '--no-map-gw']));
    for (const f of ['-t', '-u', '-T', '-U']) expect(pasta[pasta.indexOf(f) + 1]).toBe('none');
    expect(pasta.slice(pasta.indexOf('--dns-forward'), pasta.indexOf('--dns-forward') + 4))
      .toEqual(['--dns-forward', '169.254.1.53', '--dns-host', '172.26.0.2']);
    expect(l.args.slice(sep + 1, sep + 7)).toEqual([...agyNetGuardCommand('/usr/sbin/ip'), '/usr/bin/bwrap']);
    expect(pairs(l.args, '--ro-bind')).toContainEqual(['/tmp/cindy-agy-sandbox-1000/resolv.conf', '/etc/resolv.conf']);
    expect(l.args.slice(l.args.indexOf('--uid'), l.args.indexOf('--uid') + 4)).toEqual(['--uid', '1000', '--gid', '1000']);
  });

  it('never binds the host resolv.conf (it points at host loopback)', () => {
    const l = buildAgySandboxLaunch({ ...base, dnsHost: null, resolvConfPath: undefined });
    expect(pairs(l.args, '--ro-bind').some(([, dst]) => dst === '/etc/resolv.conf')).toBe(false);
    expect(l.args).not.toContain('--dns-forward');
  });

  it('wraps agy in bwrap with only the task dir writable at the same path', () => {
    const l = buildAgySandboxLaunch(base);
    expect(pairs(l.args, '--bind')).toEqual([['/home/u/work/task-1', '/home/u/work/task-1']]);
    expect(l.args.slice(l.args.indexOf('--chdir'), l.args.indexOf('--chdir') + 2)).toEqual(['--chdir', '/home/u/work/task-1']);
    expect(l.args.slice(l.args.lastIndexOf('--'))).toEqual(['--', '/home/u/.local/bin/agy', '--acp']);
  });

  it('hides home: tmpfs over /home, never binds the home dir itself', () => {
    const l = buildAgySandboxLaunch(base);
    expect(pairs(l.args, '--tmpfs').map(p => p[0])).toEqual(expect.arrayContaining(['/home', '/tmp', '/run']));
    const binds = [...pairs(l.args, '--bind'), ...pairs(l.args, '--ro-bind')];
    expect(binds.some(([src]) => src === '/home/u' || src === '/home' || src === '/')).toBe(false);
  });

  it('mounts the task dir after the home tmpfs so it stays visible', () => {
    const l = buildAgySandboxLaunch(base);
    expect(l.args.lastIndexOf('/home')).toBeLessThan(l.args.indexOf('/home/u/work/task-1'));
  });

  it('binds system dirs read-only and follows merged-usr symlinks', () => {
    const l = buildAgySandboxLaunch(base);
    expect(pairs(l.args, '--ro-bind')).toEqual(expect.arrayContaining([['/usr', '/usr'], ['/lib64', '/lib64'],
      ['/home/u/.local/bin/agy', '/home/u/.local/bin/agy']]));
    expect(pairs(l.args, '--symlink')).toEqual(expect.arrayContaining([['usr/bin', '/bin'], ['usr/lib', '/lib']]));
  });

  it('adds writable state dirs and read-only paths only when asked', () => {
    const l = buildAgySandboxLaunch({ ...base, stateRoot: '/home/u/.cindy/agy-state',
      writableDirs: [{ source: '/home/u/.cindy/agy-state/gemini', target: '/home/u/.gemini' }],
      readOnlyPaths: ['/etc/hosts'] });
    expect(pairs(l.args, '--bind')).toContainEqual(['/home/u/.cindy/agy-state/gemini', '/home/u/.gemini']);
    expect(pairs(l.args, '--ro-bind')).toContainEqual(['/etc/hosts', '/etc/hosts']);
  });

  it('uses --disable-userns when bubblewrap supports it', () => {
    expect(buildAgySandboxLaunch(base).args).not.toContain('--disable-userns');
    expect(buildAgySandboxLaunch({ ...base, supportsDisableUserns: true }).args).toContain('--disable-userns');
  });

  it('drops secrets from the environment but keeps auth keys and allow-listed vars', () => {
    const env = buildAgySandboxLaunch(base).env;
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env).toMatchObject({ AUTH_X: 'tok', LANG: 'C.UTF-8', AGY_FOO: '1', HOME: '/home/u', TMPDIR: '/tmp', CINDY_AGY_SANDBOX: '1' });
    expect(env.PATH).not.toContain('/home/u');
  });

  it('refuses unsafe task dirs', () => {
    for (const taskDir of ['/', '/home', '/home/u', '/etc/x', '/usr/local/src', '/tmp']) {
      expect(() => buildAgySandboxLaunch({ ...base, taskDir })).toThrow(AgySandboxUnavailableError);
    }
    expect(() => buildAgySandboxLaunch({ ...base, writableDirs: [{ source: '/home/u/work/task-1/.state' }] })).toThrow(/overlaps/);
  });
});

describe('login and private state', () => {
  it('never passes the session bus, agent sockets or display, even when asked', () => {
    const env = buildAgySandboxLaunch({ ...base,
      env: { ...base.env, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus', XDG_RUNTIME_DIR: '/run/user/1000', SSH_AUTH_SOCK: '/tmp/s', DISPLAY: ':1' },
      passEnvKeys: ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'DISPLAY'] }).env;
    for (const k of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'SSH_AUTH_SOCK', 'DISPLAY']) expect(env[k]).toBeUndefined();
  });
  it('passes an API key only when the api-key login is chosen', () => {
    expect(buildAgySandboxLaunch(base).env.GEMINI_API_KEY).toBeUndefined();
    const env = buildAgySandboxLaunch({ ...base, login: { kind: 'api-key', env: { GEMINI_API_KEY: 'k1' } } }).env;
    expect(env.GEMINI_API_KEY).toBe('k1');
  });
  it('maps one private state root to ~/.gemini and ~/.config/antigravity', () => {
    expect(agyPrivateStateMounts('/home/u/.cindy/agy/state', '/home/u')).toEqual([
      { source: '/home/u/.cindy/agy/state/gemini', target: '/home/u/.gemini' },
      { source: '/home/u/.cindy/agy/state/config-antigravity', target: '/home/u/.config/antigravity' },
    ]);
  });
  it('refuses a writable dir whose source is inside the task dir', () => {
    expect(() => buildAgySandboxLaunch({ ...base, writableDirs: [{ source: '/home/u/work/task-1/state', target: '/home/u/.gemini' }] }))
      .toThrow(/overlaps/);
  });
});

describe('private network ranges (cindy#3 review item 1)', () => {
  const script = agyNetGuardCommand('/usr/sbin/ip')[2]!;
  it('prohibits metadata, LAN, tailnet and IPv6 private ranges before bwrap starts', () => {
    expect(agyNetGuardCommand('/usr/sbin/ip').slice(0, 2)).toEqual(['/bin/sh', '-c']);
    expect(agyNetGuardCommand('/usr/sbin/ip').slice(3)).toEqual(['agy-net-guard', '/usr/sbin/ip']);
    expect(script.split('\n')[0]).toBe('set -eu');
    expect(script.trimEnd().endsWith('exec "$@"')).toBe(true);
    for (const n of ['169.254.0.0/16', '10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '100.64.0.0/10']) {
      expect(AGY_SANDBOX_BLOCKED_V4).toContain(n);
      expect(script).toContain(`"$ip" rule add pref 200 to ${n} prohibit`);
    }
    for (const n of ['fc00::/7', 'fe80::/10', 'fd00:ec2::254/128']) {
      expect(AGY_SANDBOX_BLOCKED_V6).toContain(n);
      expect(script).toContain(`"$ip" -6 rule add pref 200 to ${n} prohibit`);
    }
  });
  it('lets only the in-sandbox DNS address through, ahead of the 169.254/16 block', () => {
    expect(script).toContain('"$ip" rule add pref 100 to 169.254.1.53/32 lookup main');
    expect(script.indexOf('169.254.1.53/32')).toBeLessThan(script.indexOf('169.254.0.0/16'));
  });
});

describe('extra mount sources (cindy#3 review item 3)', () => {
  it('refuses the real ~/.gemini as a writable dir', () => {
    expect(() => buildAgySandboxLaunch({ ...base, writableDirs: [{ source: '/home/u/.gemini', target: '/home/u/.gemini' }] }))
      .toThrow(/inside the home directory/);
  });
  it('refuses /, the home dir, a parent of it, or anything in it', () => {
    for (const source of ['/', '/home', '/home/u', '/home/u/.ssh', '/home/u/.cindy/agy-state/gemini']) {
      expect(() => buildAgySandboxLaunch({ ...base, taskDir: '/srv/task-1', writableDirs: [{ source, target: '/home/u/.gemini' }] }))
        .toThrow(AgySandboxUnavailableError);
    }
    expect(() => buildAgySandboxLaunch({ ...base, readOnlyPaths: ['/home/u/.ssh'],
      fs: fakeFs({ existing: ['/etc/hosts', '/home/u/.ssh'] }) })).toThrow(/inside the home directory/);
  });
  it('allows home paths only inside the state root', () => {
    expect(() => buildAgySandboxLaunch({ ...base, stateRoot: '/home/u/.cindy/agy-state',
      writableDirs: [{ source: '/home/u/.cindy/agy-state/gemini', target: '/home/u/.gemini' }] })).not.toThrow();
    expect(() => buildAgySandboxLaunch({ ...base, stateRoot: '/home/u/.cindy/agy-state',
      writableDirs: [{ source: '/home/u/.cindy/other', target: '/home/u/.gemini' }] })).toThrow(/inside the home directory/);
  });
  it('refuses a state root that is the real ~/.gemini, ~/.config/antigravity, a parent or home', () => {
    for (const stateRoot of ['/home/u/.gemini', '/home/u/.config/antigravity', '/home/u/.config', '/home/u', '/home', '/',
      '/home/u/.gemini/sub']) {
      expect(() => buildAgySandboxLaunch({ ...base, stateRoot, writableDirs: [{ source: `${stateRoot}/gemini`.replace('//', '/'), target: '/home/u/.gemini' }] }))
        .toThrow(/state root/);
    }
  });
  it('checks the path after resolving symlinks', () => {
    const fs: AgySandboxFsView = { ...fakeFs(), realpath: p => (p === '/srv/innocent' ? '/home/u/.gemini' : p) };
    expect(() => buildAgySandboxLaunch({ ...base, fs, writableDirs: [{ source: '/srv/innocent', target: '/home/u/.gemini' }] }))
      .toThrow(/inside the home directory/);
  });
});

describe('assertAgyTaskDirPaths', () => {
  it('accepts a normal project folder', () => {
    expect(() => assertAgyTaskDirPaths('/home/u/projects/a', '/home/u', ['/home/u/.gemini'])).not.toThrow();
  });
  it('rejects relative paths and parents of home', () => {
    expect(() => assertAgyTaskDirPaths('work', '/home/u', [])).toThrow(/absolute/);
    expect(() => assertAgyTaskDirPaths('/srv', '/srv/u', [])).toThrow();
  });
});

describe('filterAgySandboxEnv', () => {
  it('passes LC_* and proxy settings', () => {
    const env = filterAgySandboxEnv({ LC_ALL: 'C', HTTPS_PROXY: 'http://p', AWS_SECRET_ACCESS_KEY: 'x' }, '/home/u', '/t');
    expect(env).toMatchObject({ LC_ALL: 'C', HTTPS_PROXY: 'http://p' });
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe('probeAgySystemSandbox', () => {
  it('is linux only', () => {
    expect(probeAgySystemSandbox({ platform: 'win32' })).toMatchObject({ ok: false, reason: 'unsupported-platform' });
  });
  it('reports missing network isolation (no pasta) instead of running with the host network', () => {
    const run = (_c: string, a: readonly string[]) => a[0] === '--version'
      ? { status: 0, stdout: 'bubblewrap 0.9.0\n', stderr: '' } : { status: 0, stdout: '', stderr: '' };
    expect(probeAgySystemSandbox({ platform: 'linux', exists: p => !p.includes('pasta'), run }))
      .toMatchObject({ ok: false, reason: 'network-isolation-missing' });
  });
  it('picks a non-loopback upstream DNS server', () => {
    expect(pickUpstreamDns(['nameserver 172.26.0.2\n', 'nameserver 127.0.0.53\n'])).toBe('172.26.0.2');
    expect(pickUpstreamDns([null, '# c\nnameserver 127.0.0.53\n'])).toBe('127.0.0.53');
    expect(pickUpstreamDns([null, null])).toBeNull();
  });
  it('reports a missing bubblewrap', () => {
    expect(probeAgySystemSandbox({ platform: 'linux', exists: () => false })).toMatchObject({ ok: false, reason: 'bwrap-missing' });
  });
  it('reports a host that blocks unprivileged namespaces', () => {
    const run = (_c: string, a: readonly string[]) => a[0] === '--version'
      ? { status: 0, stdout: 'bubblewrap 0.9.0\n', stderr: '' }
      : { status: 1, stdout: '', stderr: 'bwrap: setting up uid map: Permission denied' };
    expect(probeAgySystemSandbox({ platform: 'linux', exists: () => true, run })).toMatchObject({ ok: false, reason: 'bwrap-blocked' });
  });
  it('detects --disable-userns support from the version', () => {
    const run = (v: string) => (_c: string, a: readonly string[]) => a[0] === '--version'
      ? { status: 0, stdout: `bubblewrap ${v}\n`, stderr: '' } : { status: 0, stdout: '', stderr: '' };
    expect(probeAgySystemSandbox({ platform: 'linux', exists: () => true, run: run('0.6.1') })).toMatchObject({ ok: true, supportsDisableUserns: false });
    expect(probeAgySystemSandbox({ platform: 'linux', exists: () => true, run: run('0.8.0') })).toMatchObject({ ok: true, supportsDisableUserns: true });
  });
  it('parses versions', () => {
    expect(parseBwrapVersion('bubblewrap 0.11.0')).toEqual([0, 11, 0]);
    expect(parseBwrapVersion('nope')).toBeNull();
  });
});

describe('detectAgySandboxDenial', () => {
  const taskDir = '/home/u/work/task-1';
  it('attributes not-found / permission errors on paths outside the task dir', () => {
    const d = detectAgySandboxDenial({ paths: ['/home/u/.ssh/id_ed25519'], errorText: 'ENOENT: no such file or directory', taskDir, kind: 'read' });
    expect(d).toEqual({ path: '/home/u/.ssh/id_ed25519', kind: 'read' });
    expect(agySandboxDenialModelNote(d!)).toMatch(/^\[Cindy\] \/home\/u\/\.ssh\/id_ed25519 is outside/);
  });
  it('resolves relative paths against the task dir', () => {
    expect(detectAgySandboxDenial({ paths: ['../other/notes.md'], errorText: 'Permission denied', taskDir }))
      .toEqual({ path: '/home/u/work/other/notes.md', kind: 'unknown' });
  });
  it('does not attribute failures inside the task dir or visible system dirs', () => {
    expect(detectAgySandboxDenial({ paths: ['/home/u/work/task-1/missing.txt'], errorText: 'ENOENT', taskDir })).toBeNull();
    expect(detectAgySandboxDenial({ paths: ['/usr/bin/nothere', '/tmp/x'], errorText: 'ENOENT', taskDir })).toBeNull();
    expect(detectAgySandboxDenial({ paths: ['/home/u/.gemini/x'], errorText: 'ENOENT', taskDir, visibleDirs: ['/home/u/.gemini'] })).toBeNull();
  });
  it('ignores unrelated errors', () => {
    expect(detectAgySandboxDenial({ paths: ['/home/u/.ssh/id'], errorText: 'syntax error', taskDir })).toBeNull();
    expect(detectAgySandboxDenial({ paths: ['/home/u/.ssh/id'], errorText: undefined, taskDir })).toBeNull();
  });
});

describe('scanTaskDirForHardlinks', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agy-sbx-hl-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it('finds a hard link to an outside file and respects the limit', async () => {
    const task = path.join(root, 'task');
    mkdirSync(path.join(task, 'sub'), { recursive: true });
    writeFileSync(path.join(task, 'a.txt'), 'a');
    expect(await scanTaskDirForHardlinks(task)).toMatchObject({ hardlinked: null, truncated: false, scanned: 1 });
    writeFileSync(path.join(root, 'outside.txt'), 'o');
    linkSync(path.join(root, 'outside.txt'), path.join(task, 'sub', 'innocent.txt'));
    expect((await scanTaskDirForHardlinks(task)).hardlinked).toBe(path.join(task, 'sub', 'innocent.txt'));
    expect(await scanTaskDirForHardlinks(task, 0)).toMatchObject({ truncated: true });
  });
});

// Real bubblewrap on Linux hosts that allow it (runs on arena; skipped elsewhere).
const probe = probeAgySystemSandbox(process.env.AGY_SANDBOX_TEST_PASTA ? { pastaCandidates: [process.env.AGY_SANDBOX_TEST_PASTA] } : {});
describe.runIf(probe.ok)('real bubblewrap decoy check', () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-sbx-test-')));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('blocks reads and writes outside the task dir and allows them inside', async () => {
    const task = path.join(root, 'task');
    const decoy = path.join(root, 'outside', 'fake_credentials');
    mkdirSync(task, { recursive: true });
    mkdirSync(path.dirname(decoy), { recursive: true });
    const canary = `CANARY-${Math.random().toString(36).slice(2)}`;
    writeFileSync(decoy, canary);
    const before = statSync(decoy);
    const hostSrv = net.createServer(s => s.destroy());
    await new Promise<void>(res => hostSrv.listen(0, '127.0.0.1', () => res()));
    const port = (hostSrv.address() as net.AddressInfo).port;
    const abstractName = `agy-sbx-test-${Math.random().toString(36).slice(2)}`;
    const absSrv = net.createServer(s => s.destroy());
    await new Promise<void>(res => absSrv.listen('\0' + abstractName, () => res()));
    const egress = process.env.AGY_SANDBOX_TEST_EGRESS === '1';
    const script = `
      const fs = require('fs'); const r = {};
      const t = (k, f) => { try { f(); r[k] = 'ok'; } catch (e) { r[k] = e.code || String(e); } };
      t('readDecoy', () => { r.leak = fs.readFileSync(${JSON.stringify(decoy)}, 'utf8'); });
      t('writeDecoy', () => fs.appendFileSync(${JSON.stringify(decoy)}, 'x'));
      t('newOutside', () => fs.writeFileSync(${JSON.stringify(path.join(root, 'outside', 'planted'))}, 'x'));
      t('symlinkRead', () => { fs.symlinkSync(${JSON.stringify(decoy)}, 'link'); r.leak2 = fs.readFileSync('link', 'utf8'); });
      t('sshVisible', () => fs.statSync(require('os').homedir() + '/.ssh'));
      t('writeInside', () => fs.writeFileSync('out.txt', 'hello'));
      t('busVisible', () => fs.statSync('/run/user/' + process.getuid() + '/bus'));
      r.dbusEnv = process.env.DBUS_SESSION_BUS_ADDRESS || '';
      const home = require('os').homedir();
      t('stateWrite', () => { fs.writeFileSync(home + '/.gemini/token-probe', 't');
        fs.writeFileSync(home + '/.config/antigravity/plugin-probe', 'p'); });
      const net = require('net');
      const tryc = o => new Promise(res => { const s = net.connect(o); const tm = setTimeout(() => { s.destroy(); res('timeout'); }, 3000);
        s.on('connect', () => { clearTimeout(tm); s.destroy(); res('CONNECTED'); }); s.on('error', e => { clearTimeout(tm); res(e.code); }); });
      (async () => {
        r.hostLoopback = await tryc({ host: '127.0.0.1', port: ${port} });
        r.hostAbstract = await tryc({ path: ${JSON.stringify('\0' + abstractName)} });
        if (${egress}) { try { const resp = await fetch('https://api.github.com/zen'); r.egress = 'HTTP ' + resp.status; } catch (e) { r.egress = String((e.cause && e.cause.code) || e); } }
        process.stdout.write(JSON.stringify(r));
      })();`;
    writeFileSync(path.join(task, 'probe.cjs'), script);
    const node = realpathSync(process.execPath);
    const stateRoot = path.join(root, 'agy-state');
    const launch = await prepareAgySandboxedLaunch({ binaryPath: node, args: ['probe.cjs'], taskDir: task,
      homeDir: os.homedir(), stateRoot, probe,
      env: { ...process.env, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid?.()}/bus` },
      passEnvKeys: ['DBUS_SESSION_BUS_ADDRESS'] });
    const res = spawnSync(launch.command, launch.args, { cwd: task, env: launch.env, encoding: 'utf8' });
    hostSrv.close();
    absSrv.close();
    expect(res.stderr).toBe('');
    const r = JSON.parse(res.stdout) as Record<string, string>;
    expect(r.readDecoy).not.toBe('ok');
    expect(r.writeDecoy).not.toBe('ok');
    expect(r.newOutside).not.toBe('ok');
    expect(r.symlinkRead).not.toBe('ok');
    expect(r.sshVisible).not.toBe('ok');
    expect(r.writeInside).toBe('ok');
    expect(r.hostLoopback).not.toBe('CONNECTED');
    expect(r.hostAbstract).not.toBe('CONNECTED');
    if (egress) expect(r.egress).toBe('HTTP 200');
    expect(r.busVisible).not.toBe('ok');
    expect(r.dbusEnv).toBe('');
    expect(r.stateWrite).toBe('ok');
    expect(readFileSync(path.join(stateRoot, 'gemini', 'token-probe'), 'utf8')).toBe('t');
    expect(readFileSync(path.join(stateRoot, 'config-antigravity', 'plugin-probe'), 'utf8')).toBe('p');
    expect(statSync(stateRoot).mode & 0o777).toBe(0o700);
    expect(res.stdout).not.toContain(canary);
    expect(readFileSync(decoy, 'utf8')).toBe(canary);
    const after = statSync(decoy);
    expect([after.mtimeMs, after.ctimeMs, after.size]).toEqual([before.mtimeMs, before.ctimeMs, before.size]);
    expect(existsSync(path.join(root, 'outside', 'planted'))).toBe(false);
    expect(readFileSync(path.join(task, 'out.txt'), 'utf8')).toBe('hello');
  });

  it('refuses to start when the task dir holds a hard link', async () => {
    const task = path.join(root, 'task-hl');
    mkdirSync(task, { recursive: true });
    writeFileSync(path.join(root, 'o.txt'), 'o');
    linkSync(path.join(root, 'o.txt'), path.join(task, 'h.txt'));
    await expect(prepareAgySandboxedLaunch({ binaryPath: '/bin/true', args: [], taskDir: task, homeDir: os.homedir(), env: {}, probe }))
      .rejects.toMatchObject({ reason: 'task-dir-unsafe' });
  });
});
