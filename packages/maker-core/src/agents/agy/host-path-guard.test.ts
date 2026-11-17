/**
 * Host-side path guard for agy task folders (good-night-oppie/cindy#1, QQ 6924350879 items 4 and 5).
 * Symlink cases need a POSIX host; CI runs on Linux.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AGY_HOST_PATH_USER_COPY, AgyLinkOutsideTaskError, agyWriteOutsideTask, checkAgyTaskPath,
  listAgyTaskDir, openAgyTaskFile, readAgyTaskFile, registerAgyTaskDir, walkAgyTaskDir,
} from './host-path-guard.js';
import { AgyTranslator } from './translator.js';
import { AgyAgent, type AgyAgentDeps } from './index.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';

const posix = process.platform !== 'win32';
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'agy-guard-')));
const task = path.join(root, 'task');
const outside = path.join(root, 'outside');
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(() => {
  mkdirSync(path.join(task, 'sub'), { recursive: true });
  mkdirSync(path.join(outside, 'secrets'), { recursive: true });
  writeFileSync(path.join(task, 'notes.md'), 'inside');
  writeFileSync(path.join(task, 'sub', 'a.txt'), 'a');
  writeFileSync(path.join(outside, 'config'), 'SECRET');
  writeFileSync(path.join(outside, 'secrets', 'token'), 'SECRET-TOKEN');
  if (!posix) return;
  // 1. file link pointing outside the task folder (the r12 case: link-to-config -> .../config)
  symlinkSync(path.join(outside, 'config'), path.join(task, 'link-to-config'));
  // 2. directory link pointing outside
  symlinkSync(path.join(outside, 'secrets'), path.join(task, 'link-to-dir'));
  // 3. several hops, the last one leaves the task folder
  symlinkSync(path.join(outside, 'config'), path.join(task, 'sub', 'hop3'));
  symlinkSync(path.join(task, 'sub', 'hop3'), path.join(task, 'hop2'));
  symlinkSync('hop2', path.join(task, 'hop1'));
  // a link that stays inside is fine
  symlinkSync('notes.md', path.join(task, 'inner-link'));
  // a dangling link (target missing on this host) and a loop
  symlinkSync('/nonexistent-agy-guard/x', path.join(task, 'dangling'));
  symlinkSync('loop-b', path.join(task, 'loop-a'));
  symlinkSync('loop-a', path.join(task, 'loop-b'));
});

describe('the one check: real path must stay inside the task folder', () => {
  it.skipIf(!posix)('refuses a file link that points outside the task folder', async () => {
    const target = path.join(task, 'link-to-config');
    expect(() => checkAgyTaskPath(target, { taskDir: task })).toThrow(AgyLinkOutsideTaskError);
    await expect(readAgyTaskFile(target, { taskDir: task })).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
  });

  it.skipIf(!posix)('refuses a directory link that points outside, and anything reached through it', async () => {
    const dir = path.join(task, 'link-to-dir');
    expect(() => checkAgyTaskPath(dir, { taskDir: task })).toThrow(AgyLinkOutsideTaskError);
    await expect(listAgyTaskDir(dir, { taskDir: task })).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
    await expect(readAgyTaskFile(path.join(dir, 'token'), { taskDir: task })).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
  });

  it.skipIf(!posix)('refuses a chain of links whose last hop leaves the task folder', async () => {
    expect(() => checkAgyTaskPath(path.join(task, 'hop1'), { taskDir: task })).toThrow(AgyLinkOutsideTaskError);
    await expect(readAgyTaskFile(path.join(task, 'hop1'), { taskDir: task })).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
  });

  it.skipIf(!posix)('refuses dangling and looping links instead of guessing', () => {
    expect(() => checkAgyTaskPath(path.join(task, 'dangling'), { taskDir: task })).toThrow(AgyLinkOutsideTaskError);
    expect(() => checkAgyTaskPath(path.join(task, 'loop-a'), { taskDir: task })).toThrow(AgyLinkOutsideTaskError);
  });

  it.skipIf(!posix)('allows files and links that stay inside', async () => {
    expect(checkAgyTaskPath(path.join(task, 'inner-link'), { taskDir: task })?.realPath).toBe(path.join(task, 'notes.md'));
    expect((await readAgyTaskFile(path.join(task, 'inner-link'), { taskDir: task })).toString()).toBe('inside');
    expect((await readAgyTaskFile('sub/a.txt', { taskDir: task })).toString()).toBe('a');
  });

  it('does not apply to paths outside the task folder (a file the user picked elsewhere)', async () => {
    expect(checkAgyTaskPath(path.join(outside, 'config'), { taskDir: task })).toBeNull();
    expect((await readAgyTaskFile(path.join(outside, 'config'), { taskDir: task })).toString()).toBe('SECRET');
  });

  it.skipIf(!posix)('tells the user JJ\'s sentence, word for word', () => {
    try { checkAgyTaskPath(path.join(task, 'link-to-config'), { taskDir: task, locale: 'zh-CN' }); throw new Error('not refused'); } catch (error) {
      expect(error).toBeInstanceOf(AgyLinkOutsideTaskError);
      expect((error as Error).message).toBe('这个文件本身只是个链接，指向任务文件夹外面，所以 Cindy 没有打开它。任务文件夹以外的文件，Cindy 不会替 Antigravity 打开。要用的话，把这个文件复制进任务文件夹，再试一次。');
      expect((error as AgyLinkOutsideTaskError).userMessage('en')).toBe(AGY_HOST_PATH_USER_COPY.linkOutside.en);
      expect((error as AgyLinkOutsideTaskError).code).toBe('agy_link_outside_task');
    }
  });
});

describe("JJ's third sentence, for refusals that are not about a link (JJ on cindy#15)", () => {
  it('is word for word', () => {
    expect(AGY_HOST_PATH_USER_COPY.notInTaskFolder['zh-CN'])
      .toBe('这个文件不在任务文件夹里，Cindy 没有打开它。要用的话，把它复制进任务文件夹，再试一次。');
    expect(AGY_HOST_PATH_USER_COPY.notInTaskFolder.en)
      .toBe('This file is not in the task folder, so Cindy did not open it. If you need it, copy it into the task folder and try again.');
  });
});

describe('the registry: host entries without a session find agy task folders', () => {
  let release: (() => void) | undefined;
  afterEach(() => { release?.(); release = undefined; });

  it('checks nothing while no agy task is registered', () => {
    expect(checkAgyTaskPath(path.join(task, 'notes.md'))).toBeNull();
  });

  it.skipIf(!posix)('applies to every path inside a registered agy task folder, and stops after release', () => {
    release = registerAgyTaskDir(task);
    expect(() => checkAgyTaskPath(path.join(task, 'link-to-config'))).toThrow(AgyLinkOutsideTaskError);
    expect(checkAgyTaskPath(path.join(task, 'notes.md'))?.taskDir).toBe(task);
    release(); release = undefined;
    expect(checkAgyTaskPath(path.join(task, 'link-to-config'))).toBeNull();
  });
});

describe('open, then check the handle (no swap between check and open)', () => {
  it.skipIf(!posix)('refuses when the checked file is swapped for a link before the open', async () => {
    const victim = path.join(task, 'swap.txt');
    writeFileSync(victim, 'ok');
    let swapped = false;
    const opened = openAgyTaskFile(victim, { taskDir: task, beforeOpenForTest: async () => {
      await rename(victim, `${victim}.bak`);
      symlinkSync(path.join(outside, 'config'), victim);
      swapped = true;
    } });
    await expect(opened).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
    expect(swapped).toBe(true);
  });

  it.skipIf(!posix)('refuses when a parent directory is swapped for an outside link before the open', async () => {
    const dir = path.join(task, 'swapdir');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'token'), 'fine');
    const opened = openAgyTaskFile(path.join(dir, 'token'), { taskDir: task, beforeOpenForTest: async () => {
      await rename(dir, `${dir}.bak`);
      symlinkSync(path.join(outside, 'secrets'), dir);
    } });
    await expect(opened).rejects.toBeInstanceOf(AgyLinkOutsideTaskError);
  });
});

describe('listing and walking never follow links', () => {
  it.skipIf(!posix)('lists links as links and does not descend into them', async () => {
    const entries = await listAgyTaskDir(task, { taskDir: task });
    expect(entries.find(e => e.name === 'link-to-dir')?.type).toBe('symlink');
    expect(entries.find(e => e.name === 'sub')?.type).toBe('directory');
    const seen: string[] = [];
    await walkAgyTaskDir(task, { taskDir: task }, entry => { seen.push(path.relative(task, entry.path)); });
    expect(seen).toContain(path.join('sub', 'a.txt'));
    expect(seen).toContain('link-to-dir');
    expect(seen.some(p => p.startsWith(`link-to-dir${path.sep}`))).toBe(false);
  });
});

describe('write-type tool calls aimed outside the task folder', () => {
  const home = '/home/u';
  it('flags writes, appends, deletes, moves, links and touch by their target path', () => {
    const exec = (CommandLine: string) => ({ kind: 'execute', rawInput: { CommandLine } });
    expect(agyWriteOutsideTask(exec('echo hi >> /srv/agy-b/workdata/config'), task, home)).toBe('/srv/agy-b/workdata/config');
    expect(agyWriteOutsideTask(exec('rm -rf /srv/agy-b/workdata'), task, home)).toBe('/srv/agy-b/workdata');
    expect(agyWriteOutsideTask(exec('touch ~/x.txt'), task, home)).toBe('/home/u/x.txt');
    expect(agyWriteOutsideTask(exec('mv notes.md ../elsewhere.md'), task, home)).toBe(path.join(root, 'elsewhere.md'));
    expect(agyWriteOutsideTask(exec('ln -s /etc/passwd /srv/link'), task, home)).toBe('/srv/link');
    expect(agyWriteOutsideTask(exec('cat a | tee /srv/out.txt'), task, home)).toBe('/srv/out.txt');
    expect(agyWriteOutsideTask({ kind: 'edit', rawInput: { TargetFile: '/srv/agy-b/workdata/config' } }, task, home)).toBe('/srv/agy-b/workdata/config');
    expect(agyWriteOutsideTask({ kind: 'delete', locations: [{ path: '/srv/x' }] }, task, home)).toBe('/srv/x');
  });

  it('stays quiet for writes inside the task folder, reads, and /dev/null', () => {
    const exec = (CommandLine: string) => ({ kind: 'execute', rawInput: { CommandLine } });
    expect(agyWriteOutsideTask(exec('touch b.ts && echo x > sub/c.txt'), task, home)).toBeNull();
    expect(agyWriteOutsideTask(exec('cat /etc/hosts 2>/dev/null'), task, home)).toBeNull();
    expect(agyWriteOutsideTask(exec('cp /etc/hosts ./hosts.copy'), task, home)).toBeNull();
    expect(agyWriteOutsideTask({ kind: 'read', rawInput: { AbsolutePath: '/etc/hosts' } }, task, home)).toBeNull();
    expect(agyWriteOutsideTask({ kind: 'edit', rawInput: { TargetFile: path.join(task, 'new.ts') } }, task, home)).toBeNull();
  });

  it.skipIf(!posix)('uses the same real-path check: a write through an inside link that points out is flagged', () => {
    expect(agyWriteOutsideTask({ kind: 'execute', rawInput: { CommandLine: 'echo x >> link-to-config' } }, task, home))
      .toBe(path.join(task, 'link-to-config'));
    expect(agyWriteOutsideTask({ kind: 'edit', rawInput: { TargetFile: path.join(task, 'link-to-dir', 'new') } }, task, home))
      .toBe(path.join(task, 'link-to-dir', 'new'));
  });

  const run = (status: 'completed' | 'failed', rawInput: Record<string, unknown>, kind = 'execute', locale?: string) => {
    const events: AgentEvent[] = [];
    const t = new AgyTranslator(e => events.push(e), { taskDir: task, homeDir: home, visibleDirs: [], locale: () => locale });
    t.beginTurn();
    t.update({ sessionUpdate: 'tool_call', toolCallId: '1', kind, rawInput });
    t.update({ sessionUpdate: 'tool_call_update', toolCallId: '1', status,
      content: [{ type: 'content', content: { type: 'text', text: status === 'failed' ? 'rm: cannot remove: Read-only file system' : 'Deleted.' } }] });
    return events.filter(e => e.type === 'error').map(e => e.data as { message: string; reason: string; isTerminal: boolean });
  };

  it('puts JJ\'s sentence beside the reply whether agy says completed or failed', () => {
    for (const status of ['completed', 'failed'] as const) {
      const notices = run(status, { CommandLine: 'rm -rf /srv/agy-b/workdata' }, 'execute', 'zh-CN');
      expect(notices).toEqual([{ isTerminal: false, reason: 'agy_write_outside_task',
        message: '这一步写的位置在任务文件夹外面，只在 Cindy 给 Antigravity 划出来的那个范围里生效了，你电脑上的文件没有变。要改外面的文件，先把它复制到任务文件夹里再改。' }]);
    }
    expect(run('completed', { CommandLine: 'touch /srv/x' }, 'execute', 'en')[0]?.message)
      .toBe('This step wrote to a place outside the task folder. It only happened inside the space Cindy sets aside for Antigravity, so nothing on your computer has changed. To change a file outside, copy it into the task folder first.');
  });

  it('says nothing for writes inside the task folder', () => {
    expect(run('completed', { CommandLine: 'touch b.ts' })).toEqual([]);
  });

  // JJ on #15: Cindy's agy private state (seen as ~/.gemini, ~/.config/antigravity in the sandbox) is
  // in scope; writing there is not "outside", so the sentence must not appear.
  it('treats agy private state dirs as in scope, and still flags real outside targets', () => {
    const exec = (CommandLine: string) => ({ kind: 'execute', rawInput: { CommandLine } });
    const privateState = ['/home/u/.gemini', '/home/u/.config/antigravity'];
    expect(agyWriteOutsideTask(exec('echo x > ~/.gemini/settings.json'), task, home, privateState)).toBeNull();
    expect(agyWriteOutsideTask({ kind: 'edit', rawInput: { TargetFile: '/home/u/.config/antigravity/a.json' } }, task, home, privateState)).toBeNull();
    expect(agyWriteOutsideTask(exec('touch /srv/x'), task, home, privateState)).toBe('/srv/x');
    expect(agyWriteOutsideTask(exec('touch ~/.geminiX'), task, home, privateState)).toBe('/home/u/.geminiX');
    const events: AgentEvent[] = [];
    const t = new AgyTranslator(e => events.push(e), { taskDir: task, homeDir: home, visibleDirs: privateState });
    t.beginTurn();
    t.update({ sessionUpdate: 'tool_call', toolCallId: 'p', kind: 'execute', rawInput: { CommandLine: 'touch ~/.gemini/state.json' } });
    t.update({ sessionUpdate: 'tool_call_update', toolCallId: 'p', status: 'completed' });
    expect(events.filter(e => e.type === 'error')).toEqual([]);
  });
});

describe('AgyAgent wiring', () => {
  /** Minimal agy ACP peer: enough for startSession and one send. */
  const fakeAgy = () => {
    const lines = new Set<(line: string) => void>();
    const written: { method?: string }[] = [];
    const option = (id: string, value: string, values: string[]) => ({ id, name: id, category: id, type: 'select', currentValue: value, options: values.map(v => ({ value: v, name: v })) });
    let mode = 'default';
    const configOptions = () => [option('model', 'gpt-oss-120b-medium', ['gpt-oss-120b-medium']), option('mode', mode, ['default', 'plan'])];
    const transport = {
      async writeLine(line: string) {
        const msg = JSON.parse(line) as { id?: number; method?: string; params?: { value?: string } };
        written.push(msg);
        const reply = (result: unknown) => queueMicrotask(() => { for (const l of lines) l(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })); });
        if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true } } });
        else if (msg.method === 'session/new') reply({ sessionId: 'agy-g', configOptions: configOptions() });
        else if (msg.method === 'session/set_config_option') { mode = msg.params?.value ?? mode; reply({ configOptions: configOptions() }); }
      },
      onLine(h: (line: string) => void) { lines.add(h); return () => { lines.delete(h); }; },
      onClose() { return () => {}; },
      getPid() { return null; }, getStderrTail() { return ''; }, async close() {},
    };
    return { transport, written };
  };
  const agentFor = (transport: unknown) => new AgyAgent({ binaryPath: '/fake/agy', runtimeConfig: {},
    auth: { getState: async () => ({ authenticated: true }), getAuthEnv: async () => ({}), triggerLogin: async () => ({ authenticated: true }), logout: async () => {} },
    logger: createConsoleLogger('agy-guard-test'), skipAgyBinaryPreflight: true,
    createAgyTransport: () => transport as never, uiLocale: () => 'zh-CN',
  } as AgyAgentDeps);

  it.skipIf(!posix)('registers the task folder while the session is open and releases it on close', async () => {
    const { transport } = fakeAgy();
    const handle = await agentFor(transport).startSession({ workingDir: task, model: 'gpt-oss-120b-medium' });
    expect(() => checkAgyTaskPath(path.join(task, 'link-to-config'))).toThrow(AgyLinkOutsideTaskError);
    await handle.close();
    expect(checkAgyTaskPath(path.join(task, 'link-to-config'))).toBeNull();
  });

  it.skipIf(!posix)('refuses an image attachment that is a link out of the task folder, before anything reaches agy', async () => {
    const { transport, written } = fakeAgy();
    const handle = await agentFor(transport).startSession({ workingDir: task, model: 'gpt-oss-120b-medium' });
    try {
      await expect(handle.send({ type: 'user', content: [{ type: 'image', path: path.join(task, 'link-to-config'), mimeType: 'image/png' }] }))
        .rejects.toThrow(AGY_HOST_PATH_USER_COPY.linkOutside['zh-CN']);
      expect(written.some(frame => frame.method === 'session/prompt')).toBe(false);
    } finally { await handle.close(); }
  });
});
