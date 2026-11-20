import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { AgyAgent, type AgyAgentDeps } from './index.js';
import { AgyTranslator, agyToolPaths } from './translator.js';
import type { AgySandboxProbe } from './system-sandbox.js';
import { AgentStartupStoppedError } from '../base-agent.js';
import type { AgentEvent } from '../../types/events.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { setAgyTaskDirStoreFile } from './host-path-guard.js';

// Sessions here register their task folder; keep that registry out of the real ~/.cindy.
setAgyTaskDirStoreFile(path.join(os.tmpdir(), `agy-task-dirs-${process.pid}-wiring.json`));

const OK_PROBE: AgySandboxProbe = { ok: true, bwrapPath: '/usr/bin/bwrap', pastaPath: '/usr/bin/pasta', ipPath: '/usr/sbin/ip', version: '0.6.1', supportsDisableUserns: false };
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-wire-')));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function agentWith(extra: Partial<AgyAgentDeps>, authEnv: Record<string, string> = {}) {
  const captured: { binaryPath?: string; args?: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }[] = [];
  const agent = new AgyAgent({ binaryPath: realpathSync(process.execPath), runtimeConfig: {},
    auth: { getState: vi.fn(async () => ({ authenticated: true })), getAuthEnv: vi.fn(async () => authEnv),
      triggerLogin: vi.fn(async () => ({ authenticated: true })), logout: vi.fn(async () => {}) },
    logger: createConsoleLogger('agy-wire-test'),
    skipAgyBinaryPreflight: true,
    createAgyTransport: options => { captured.push(options); throw new Error('transport captured'); },
    ...extra,
  } as AgyAgentDeps);
  return { agent, captured };
}

describe('agy launch goes through the system sandbox', () => {
  it('refuses catalog discovery when isolation is unavailable', async () => {
    const { agent, captured } = agentWith({ agySandbox: { probe: { ok: false, reason: 'network-isolation-missing', detail: 'unavailable' } } });
    await expect(agent.probeModels()).rejects.toBeInstanceOf(Error);
    expect(captured).toHaveLength(0);
  });

  it('spawns pasta -> bwrap -> agy with only the task folder and drops the session bus', async () => {
    const task = path.join(root, 'task');
    (await import('node:fs')).mkdirSync(task, { recursive: true });
    const stateRoot = path.join(root, 'state');
    const { agent, captured } = agentWith({ agySandbox: { probe: OK_PROBE, stateRoot } },
      { AGY_AUTH_HINT: 't', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus' });
    await expect(agent.startSession({ workingDir: task, model: 'gpt-oss-120b-medium' })).rejects.toBeInstanceOf(AgentStartupStoppedError);
    expect(captured).toHaveLength(1);
    const { binaryPath, args = [], env = {} } = captured[0]!;
    expect(binaryPath).toBe('/usr/bin/pasta');
    expect(args).toEqual(expect.arrayContaining(['--no-map-gw', '/usr/bin/bwrap']));
    const chdir = args.indexOf('--chdir');
    expect(args.slice(chdir - 3, chdir + 2)).toEqual(['--bind', task, task, '--chdir', task]);
    expect(args.slice(args.lastIndexOf('--'))).toEqual(['--', realpathSync(process.execPath), 'acp', '--disable-telemetry']);
    expect(args).toEqual(expect.arrayContaining([path.join(stateRoot, 'gemini'), path.join(os.homedir(), '.gemini')]));
    expect(env.AGY_AUTH_HINT).toBe('t');
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
  });

  it('uses the real path of a symlinked task folder for the sandbox and the agy cwd', async () => {
    const fs = await import('node:fs');
    const real = path.join(root, 'real-task');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(root, 'linked-task');
    fs.symlinkSync(real, link);
    const { agent, captured } = agentWith({ agySandbox: { probe: OK_PROBE, stateRoot: path.join(root, 'state2') } });
    await expect(agent.startSession({ workingDir: link, model: 'gpt-oss-120b-medium' })).rejects.toBeInstanceOf(AgentStartupStoppedError);
    const { args = [], cwd } = captured[0]! as { args?: readonly string[]; cwd?: string };
    expect(cwd).toBe(real);
    const chdir = args.indexOf('--chdir');
    expect(args.slice(chdir - 3, chdir + 2)).toEqual(['--bind', real, real, '--chdir', real]);
    expect(args).not.toContain(link);
  });

  it('refuses to start, with a plain reason, when isolation is unavailable', async () => {
    const { agent, captured } = agentWith({ agySandbox: { probe: { ok: false, reason: 'network-isolation-missing', detail: 'pasta (passt) not installed' } } });
    await expect(agent.startSession({ workingDir: root, model: 'gpt-oss-120b-medium' }))
      .rejects.toThrow(/^\[agy_sandbox_unavailable\] .*pasta or iproute2 is not installed.*\(pasta \(passt\) not installed\)$/);
    expect(captured).toHaveLength(0);
  });
});

describe('blocked reads and writes are not silent', () => {
  const ctx = { taskDir: '/home/u/work/task', homeDir: '/home/u', visibleDirs: ['/home/u/.gemini'] };
  const run = (updates: Record<string, unknown>[]) => {
    const events: AgentEvent[] = [];
    const t = new AgyTranslator(e => events.push(e), ctx);
    t.beginTurn();
    for (const u of updates) t.update(u);
    return events;
  };
  const failed = (id: string, kind: string, rawInput: Record<string, unknown>, text = 'Error: ENOENT: no such file or directory') => [
    { sessionUpdate: 'tool_call', toolCallId: id, kind, rawInput },
    { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed', content: [{ type: 'content', content: { type: 'text', text } }] },
  ];

  it('tells the user and the model when a path outside the task folder was blocked', () => {
    const events = run(failed('1', 'read', { AbsolutePath: '/home/u/.ssh/id_ed25519' }));
    const notice = events.find(e => e.type === 'error');
    expect(notice?.data).toMatchObject({ isTerminal: false, reason: 'agy_sandbox_blocked' });
    expect((notice?.data as { message: string }).message).toMatch(/^\[agy_sandbox_blocked\] Antigravity tried to read "\/home\/u\/\.ssh\/id_ed25519"/);
    const result = events.find(e => e.type === 'tool_result_full')?.data as { fullText: string; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.fullText).toMatch(/\[Cindy\] \/home\/u\/\.ssh\/id_ed25519 is outside this task's folder/);
  });

  it('finds paths in shell commands and says it once per path per turn', () => {
    const events = run([...failed('1', 'execute', { CommandLine: 'cat ~/.aws/credentials' }, 'cat: /home/u/.aws/credentials: No such file or directory'),
      ...failed('2', 'execute', { CommandLine: 'cat ~/.aws/credentials' }, 'No such file or directory')]);
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
    expect(agyToolPaths({ rawInput: { CommandLine: 'cp ../other/a.txt ./b && cat /etc/shadow' } }, '/home/u'))
      .toEqual(expect.arrayContaining(['../other/a.txt', '/etc/shadow']));
  });

  it('stays quiet for failures inside the task folder or without isolation', () => {
    expect(run(failed('1', 'edit', { TargetFile: '/home/u/work/task/missing.ts' })).some(e => e.type === 'error')).toBe(false);
    const events: AgentEvent[] = [];
    const bare = new AgyTranslator(e => events.push(e));
    for (const u of failed('1', 'read', { AbsolutePath: '/home/u/.ssh/id' })) bare.update(u);
    expect(events.some(e => e.type === 'error')).toBe(false);
  });
});
