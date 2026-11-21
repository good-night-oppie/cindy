import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearAgyVersionCache } from './version.js';
import { AgyAgent, type AgyAgentDeps } from './index.js';
import { AgentNotAuthenticatedError, AgentStartupStoppedError } from '../base-agent.js';
import type { AcpTransport } from '../acp/transport.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../types/events.js';
import { createConsoleLogger } from '../../interfaces/logger.js';
import { tmpdir as osTmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { setAgyTaskDirStoreFile } from './host-path-guard.js';

// Sessions here register their task folder; keep that registry out of the real ~/.cindy.
setAgyTaskDirStoreFile(joinPath(osTmpdir(), `agy-task-dirs-${process.pid}-index.json`));

// FakeTransport structure follows the Cursor ACP tests in makecindy/cindy#5611.
interface Frame { id?: string | number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown }

const MODEL_OPTION = (current: string) => ({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
  options: [{ value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }, { value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }] });
const EFFORT_OPTION = (current: string) => ({ id: 'thought_level', name: 'Thinking Level', category: 'thought_level', type: 'select', currentValue: current,
  options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] });
const MODE_OPTION = (current: string) => ({ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: current,
  options: ['default', 'accept-edits', 'auto', 'plan'].map(value => ({ value, name: value })) });

/** In-memory agy 1.5 ACP server: answers control requests, holds session/prompt until the test finishes it. */
class FakeAgy implements AcpTransport {
  lines = new Set<(line: string) => void>();
  closes = new Set<(info: { reason: string }) => void>();
  written: Frame[] = [];
  closeCount = 0;
  config = { model: 'gemini-4-carbon', thought_level: 'medium' as string | undefined, mode: 'default' };
  /** Overrides what set_config_option reports back (receipt mismatch). */
  receiptOverride?: (configId: string, value: string) => Record<string, string | undefined>;
  failSessionNew?: { code: number; message: string; data?: unknown };
  cancelResolves = true;
  cancelWriteBlocked = false;
  stderr = '';
  configOptions() {
    return [MODEL_OPTION(this.config.model), ...(this.config.thought_level ? [EFFORT_OPTION(this.config.thought_level)] : []), MODE_OPTION(this.config.mode)];
  }
  async writeLine(line: string) {
    const message: Frame = JSON.parse(line);
    this.written.push(message);
    const reply = (result: unknown) => queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, result }));
    const fail = (error: { code: number; message: string }) => queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: message.id, error }));
    switch (message.method) {
      case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'Antigravity ACP Server', version: '1.5.9' },
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true, embeddedContext: true }, sessionCapabilities: { resume: {}, load: {} } },
        authMethods: [{ id: 'oauth-personal' }] });
      case 'session/new':
        if (this.failSessionNew) return fail(this.failSessionNew);
        return reply({ sessionId: 'agy-1', models: { currentModelId: 'gemini-4-carbon-medium', availableModels: [
          { modelId: 'gemini-4-carbon-low' }, { modelId: 'gemini-4-carbon-medium' }, { modelId: 'gemini-4-carbon-high' }, { modelId: 'gpt-oss-120b-medium' }] },
        configOptions: this.configOptions() });
      case 'session/resume': return reply({ configOptions: this.configOptions() });
      case 'session/load': return reply({ configOptions: this.configOptions() });
      case 'session/set_config_option': {
        const { configId, value } = message.params as { configId: string; value: string };
        if (configId === 'model') {
          this.config.model = value;
          this.config.thought_level = value.startsWith('gpt-oss') ? undefined : this.config.thought_level ?? 'medium';
        } else if (configId === 'thought_level') this.config.thought_level = value;
        else if (configId === 'mode') this.config.mode = value;
        if (this.receiptOverride) Object.assign(this.config, this.receiptOverride(configId, value));
        return reply({ configOptions: this.configOptions() });
      }
      case 'session/cancel': {
        if (this.cancelWriteBlocked) return new Promise<void>(() => {});
        if (!this.cancelResolves) return;
        const prompt = this.lastPrompt();
        if (prompt) queueMicrotask(() => this.emit({ jsonrpc: '2.0', id: prompt.id, result: { stopReason: 'cancelled' } }));
        return;
      }
      default: return;
    }
  }
  lastPrompt() { return this.written.filter(item => item.method === 'session/prompt').at(-1); }
  emit(message: unknown) { for (const listener of this.lines) listener(JSON.stringify(message)); }
  update(sessionUpdate: string, data: Record<string, unknown> = {}) {
    this.emit({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'agy-1', update: { sessionUpdate, ...data } } });
  }
  finish(stopReason = 'end_turn') {
    this.emit({ jsonrpc: '2.0', id: this.lastPrompt()!.id, result: { stopReason,
      usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 50, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 170 } } });
  }
  crash() { for (const listener of this.closes) listener({ reason: 'ACP process exited' }); }
  permission(id: string, toolCall: Record<string, unknown>) {
    this.emit({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'agy-1', toolCall,
      options: [{ optionId: 'always', name: 'Always', kind: 'allow_always' }, { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }] } });
  }
  responseTo(id: string) { return this.written.find(item => item.id === id && !item.method); }
  onLine(handler: (line: string) => void) { this.lines.add(handler); return () => { this.lines.delete(handler); }; }
  onClose(handler: (info: { reason: string }) => void) { this.closes.add(handler); return () => { this.closes.delete(handler); }; }
  getPid() { return null; }
  getStderrTail() { return this.stderr; }
  async close() { this.closeCount++; this.crash(); }
}

function create(fake = new FakeAgy(), extra: Partial<AgyAgentDeps> = {}) {
  const agent = new AgyAgent({ binaryPath: '/fake/agy', runtimeConfig: {},
    auth: { getState: vi.fn(async () => ({ authenticated: true })), getAuthEnv: vi.fn(async () => ({})),
      triggerLogin: vi.fn(async () => ({ authenticated: true })), logout: vi.fn(async () => {}) },
    logger: createConsoleLogger('agy-test'),
    skipAgyBinaryPreflight: true,
    createAgyTransport: () => fake, ...extra,
  } as AgyAgentDeps);
  return { fake, agent, start: (options = {}) => agent.startSession({ workingDir: '/tmp/agy-work', model: 'gpt-oss-120b-medium', ...options }) };
}

async function drain(handle: { events(): AsyncIterable<AgentEvent> }, sink: AgentEvent[]) {
  for await (const event of handle.events()) sink.push(event);
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function ticks(count = 5) { for (let index = 0; index < count; index++) await tick(); }

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); delete process.env.CINDY_AGY_STALL_TIMEOUT_MS; });

describe('AgyAgent startup and configuration receipts', () => {
  it('only registers the local tool bridge for an identified task', async () => {
    const local = 'http://127.0.0.1:9000/mcp';
    const prepare = vi.fn(async () => ({
      mcpBridge: { token: 'fixture', servers: [
        { name: 'helper', url: local }, { name: 'alias', url: 'http://localhost:9000/mcp' },
      ] },
    }));
    const anonymous = create(new FakeAgy(), { preparePiExtraSpawnConfig: prepare });
    await (await anonymous.start()).close();
    expect(prepare).not.toHaveBeenCalled();
    const task = create(new FakeAgy(), { preparePiExtraSpawnConfig: prepare });
    const handle = await task.start({ sessionId: 'fixture-task' });
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(task.fake.written.find(frame => frame.method === 'session/new')?.params?.mcpServers).toEqual([
      { type: 'http', name: 'helper', url: local, headers: [{ name: 'Authorization', value: 'Bearer fixture' }] },
    ]);
    await handle.close();
  });

  it('discovers and caches the catalog from an empty probe folder with no tool bridge', async () => {
    const fs = await import('node:fs');
    const fake = new FakeAgy();
    const root = fs.mkdtempSync(joinPath(osTmpdir(), 'agy-probe-test-'));
    const spawn = vi.fn((opts: { cwd: string; binaryPath: string }) => {
      expect(fs.readdirSync(opts.cwd)).toEqual([]);
      if (process.platform === 'linux') expect(opts.binaryPath).toBe('/usr/bin/pasta');
      return fake;
    });
    try {
      const { agent } = create(fake, {
        binaryPath: fs.realpathSync(process.execPath), readAgyVersion: async () => '1.5.9',
        agySandbox: { stateRoot: root, allowWithoutSystemSandbox: true, probe: {
          ok: true, bwrapPath: '/usr/bin/bwrap', pastaPath: '/usr/bin/pasta', ipPath: '/usr/sbin/ip',
          version: '0.6.1', supportsDisableUserns: false,
        } },
        createAgyTransport: spawn,
      });
      await Promise.all([agent.probeModels(), agent.probeModels()]);
      await agent.probeModels();
      expect(spawn).toHaveBeenCalledTimes(1);
      const cwd = spawn.mock.calls[0]![0].cwd;
      expect(fake.written.find(frame => frame.method === 'session/new')?.params).toEqual({ cwd, mcpServers: [] });
      expect(fs.existsSync(cwd)).toBe(false);
      expect(agent.capabilities.availableModels.length).toBeGreaterThan(0);
    } finally {
      clearAgyVersionCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([true, false])('reports the first catalog failure when cleanup fails (session failed: %s)', async sessionFails => {
    const fs = await import('node:fs');
    const root = fs.mkdtempSync(joinPath(osTmpdir(), 'agy-probe-errors-'));
    const fake = new FakeAgy();
    if (sessionFails) fake.failSessionNew = { code: -32000, message: 'catalog unavailable for fixture' };
    const close = vi.spyOn(fake, 'close').mockRejectedValue(new Error('fixture cleanup failed'));
    const { agent } = create(fake, {
      binaryPath: fs.realpathSync(process.execPath), readAgyVersion: async () => '1.5.9',
      agySandbox: { stateRoot: root, allowWithoutSystemSandbox: true, probe: {
        ok: true, bwrapPath: '/usr/bin/bwrap', pastaPath: '/usr/bin/pasta', ipPath: '/usr/sbin/ip',
        version: '0.6.1', supportsDisableUserns: false,
      } },
    });
    try {
      await expect(agent.probeModels()).rejects.toThrow(sessionFails ? 'catalog unavailable for fixture' : 'fixture cleanup failed');
      expect(close).toHaveBeenCalledTimes(1);
      expect(agent.capabilities.availableModels).toHaveLength(0);
    } finally {
      clearAgyVersionCache();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Regression #25: startSession/setModel/send must not use an unspecified or
  // host-disallowed model. Existing tests only covered explicit receipt mismatch.
  // Unit tier: in-memory transport, no real CLI/auth/files. Minimal inputs are a
  // missing model and a config notification during send's async preparation.
  // Standalone file wall time: 2.626s (2026-11-14, pnpm exec vitest run this file).
  it.each([undefined, '', ' ', 'default'])('rejects implicit model %s before creating a transport', async model => {
    const fake = new FakeAgy();
    const transport = vi.fn(() => fake);
    const { start } = create(fake, { createAgyTransport: transport });
    const outcome = await start({ model }).then(handle => handle.close().then(() => undefined), error => error);
    expect(outcome).toBeInstanceOf(Error);
    expect(String(outcome)).toContain('explicit model');
    expect(transport).not.toHaveBeenCalled();
  });

  it('enforces the host allowlist at startup and model switches without changing the active model', async () => {
    const { fake, start } = create(new FakeAgy(), { agyAllowedModels: ['gpt-oss-120b-medium'] });
    const rejected = await start({ model: 'gemini-4-carbon' }).then(handle => handle.close().then(() => undefined), error => error);
    expect(String(rejected)).toContain('not allowed');
    expect(fake.written).toHaveLength(0);
    const handle = await start();
    try {
      await expect(handle.setModel!('gemini-4-carbon')).rejects.toThrow('not allowed');
      await expect(handle.setModel!('default')).rejects.toThrow('explicit model');
      expect(handle.model).toBe('gpt-oss-120b-medium');
      expect(fake.written.some(frame => frame.method === 'session/set_config_option' && frame.params?.value === 'gemini-4-carbon')).toBe(false);
    } finally { await handle.close(); }
  });

  it('checks the receipt again after asynchronous prompt preparation before writing session/prompt', async () => {
    const { fake, start } = create();
    const handle = await start();
    try {
      const sending = handle.send({ type: 'user', content: 'hi' });
      fake.update('config_option_update', { configOptions: [MODEL_OPTION('gemini-4-carbon'), EFFORT_OPTION('medium'), MODE_OPTION('default')] });
      await expect(sending).rejects.toThrow('send blocked');
      expect(fake.lastPrompt()).toBeUndefined();
    } finally { await handle.close(); }
  });

  it('spawns `agy acp --disable-telemetry`, applies the requested model, and pins default mode', async () => {
    const createAgyTransport = vi.fn(() => fake);
    const fake = new FakeAgy();
    fake.config.mode = 'accept-edits';
    const { start } = create(fake, { createAgyTransport });
    const handle = await start();
    expect(createAgyTransport).toHaveBeenCalledWith(expect.objectContaining({ binaryPath: '/fake/agy', args: ['acp', '--disable-telemetry'], cwd: '/tmp/agy-work' }));
    const sets = fake.written.filter(item => item.method === 'session/set_config_option').map(item => item.params);
    expect(sets).toEqual([
      { sessionId: 'agy-1', configId: 'model', value: 'gpt-oss-120b-medium' },
      { sessionId: 'agy-1', configId: 'mode', value: 'default' },
    ]);
    expect(handle.model).toBe('gpt-oss-120b-medium');
    expect(handle.id).toBe('agy-1');
    await handle.close();
  });

  it('fails startup when the set_config_option receipt does not match (no silent substitution)', async () => {
    const fake = new FakeAgy();
    fake.receiptOverride = configId => configId === 'model' ? { model: 'gemini-4-carbon' } : {};
    const { start } = create(fake);
    const error = await start().catch(err => err);
    expect(error).toBeInstanceOf(AgentStartupStoppedError);
    expect(String(error.message)).toContain('did not apply model=gpt-oss-120b-medium');
    expect(fake.written.some(item => item.method === 'session/prompt')).toBe(false);
    expect(fake.closeCount).toBeGreaterThan(0);
  });

  it('blocks a send when agy later reports a different model than requested', async () => {
    const { fake, start } = create();
    const handle = await start();
    fake.update('config_option_update', { configOptions: [MODEL_OPTION('gemini-4-carbon'), EFFORT_OPTION('medium'), MODE_OPTION('default')] });
    await expect(handle.send({ type: 'user', content: 'hi' })).rejects.toThrow(/reports model "gemini-4-carbon".*send blocked/);
    expect(fake.written.some(item => item.method === 'session/prompt')).toBe(false);
    await handle.close();
  });

  it('blocks a send when agy switches itself into a self-approving mode', async () => {
    const { fake, start } = create();
    const handle = await start();
    fake.update('config_option_update', { configOptions: [MODEL_OPTION('gpt-oss-120b-medium'), MODE_OPTION('auto')] });
    await expect(handle.send({ type: 'user', content: 'hi' })).rejects.toThrow(/mode "auto".*send blocked/);
    await handle.close();
  });

  it('applies thought_level with a receipt and rejects efforts the model does not offer', async () => {
    const { fake, start } = create();
    const handle = await start({ model: 'gemini-4-carbon', effort: 'high' });
    expect(fake.config.thought_level).toBe('high');
    expect(handle.getEffort?.()).toBe('high');
    await handle.setModel!('gpt-oss-120b-medium');
    await expect(handle.setEffort!('high')).rejects.toThrow(/effort/);
    await handle.close();
  });

  it('maps ACP auth_required to AgentNotAuthenticatedError without starting a login', async () => {
    const fake = new FakeAgy();
    fake.failSessionNew = { code: -32000, message: 'Authentication required' };
    const { start } = create(fake);
    const error = await start().catch(err => err);
    expect(error).toBeInstanceOf(AgentNotAuthenticatedError);
    expect(error.message).toMatch(/ACP session requires authentication/);
    expect(error.message).not.toMatch(/not signed in|sign in, then retry/);
    expect(fake.written.some(item => item.method === 'authenticate')).toBe(false);
  });

  // #27: startup errors used to discard RPC diagnostics and claim local logout.
  // Unit fake: preserve stage/code and safe message/data without secrets or login.
  it.each([-32000, -32603])('captures redacted RPC diagnostics for error %s before startup wrapping', async code => {
    const fake = new FakeAgy();
    fake.failSessionNew = { code, message: 'Authentication required for private@example.test projectId=private-project token=private-token',
      data: { reason: 'auth_required', access_token: 'secret-value', projectId: 'private-project',
        details: [{ message: 'account=private-account email=private@example.test' }], unknown: 'unclassified-secret' } };
    const diagnostic = vi.fn();
    const { start } = create(fake, { onAgyRpcError: diagnostic });
    await start().catch(() => {});
    expect(diagnostic).toHaveBeenCalledTimes(1);
    const captured = diagnostic.mock.calls[0][0];
    expect(captured).toMatchObject({ method: 'session/new', code, data: { reason: 'auth_required' } });
    const serialized = JSON.stringify(captured);
    for (const secret of ['private@example.test', 'private-project', 'private-token', 'secret-value', 'private-account', 'unclassified-secret']) {
      expect(serialized).not.toContain(secret);
    }
    expect(fake.written.some(frame => frame.method === 'authenticate' || frame.method === 'session/prompt')).toBe(false);
  });

  it('does not persist free-text account or project identifiers in RPC diagnostics', async () => {
    const fake = new FakeAgy();
    fake.failSessionNew = { code: -32603, message: "Project 'private-project' not found; Authentication failed for account private-account",
      data: { reason: 'private-account', details: [{ message: 'Unclassified private-project diagnostic' }] } };
    const diagnostic = vi.fn();
    const { start } = create(fake, { onAgyRpcError: diagnostic });
    await start().catch(() => {});
    expect(diagnostic).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(diagnostic.mock.calls[0][0])).not.toMatch(/private-project|private-account/);
  });

  it('reports a missing or too-old agy binary instead of falling back', async () => {
    const missing = create(new FakeAgy(), { skipAgyBinaryPreflight: false, binaryPath: '/nonexistent/agy' });
    await expect(missing.start()).rejects.toThrow(/not found or is not executable/);
    const old = create(new FakeAgy(), { skipAgyBinaryPreflight: false, binaryPath: process.execPath, readAgyVersion: async () => '1.0.10' });
    await expect(old.start()).rejects.toThrow(/1\.0\.10 does not support ACP.*agy update/);
  });

  it('resumes with session/resume (no history replay) after a process restart', async () => {
    const { fake, start } = create();
    const handle = await start({ resumeSessionId: 'agy-1' });
    expect(fake.written.map(item => item.method)).toContain('session/resume');
    expect(fake.written.map(item => item.method)).not.toContain('session/new');
    await handle.close();
  });
});

describe('AgyAgent turns', () => {
  it.skipIf(process.platform === 'linux')('preserves host tool results without claiming sandbox protection', async () => {
    const { fake, start } = create(new FakeAgy(), { agySandbox: { allowWithoutSystemSandbox: true } });
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'fixture tool results' });
    const outside = joinPath(osTmpdir(), 'outside-task-fixture.txt');
    fake.update('tool_call', { toolCallId: 'write', kind: 'edit', status: 'completed', rawInput: { TargetFile: outside } });
    fake.update('tool_call', { toolCallId: 'read', kind: 'read', status: 'failed', rawInput: { AbsolutePath: outside },
      content: [{ type: 'content', content: { type: 'text', text: 'No such file or directory' } }] });
    fake.finish();
    await ticks();
    await handle.close();
    await drained;
    const notices = events.filter(e => e.type === 'error').map(e => e.data);
    expect(notices).not.toContainEqual(expect.objectContaining({ reason: 'agy_write_outside_task' }));
    expect(notices).not.toContainEqual(expect.objectContaining({ reason: 'agy_sandbox_blocked' }));
    expect(events.filter(e => e.type === 'tool_result_full').map(e => e.data)).toEqual([
      expect.objectContaining({ toolUseId: 'write', isError: false }),
      expect.objectContaining({ toolUseId: 'read', isError: true, fullText: 'No such file or directory' }),
    ]);
  });

  it('streams text, thoughts, tools and usage, then completes with prompt usage', async () => {
    const { fake, start } = create();
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'read notes.txt' });
    fake.update('agent_thought_chunk', { content: { type: 'text', text: 'thinking' } });
    fake.update('tool_call', { toolCallId: 't1', name: 'read_file', kind: 'read', title: 'File notes.txt', status: 'in_progress', rawInput: { Path: '/tmp/agy-work/notes.txt' } });
    fake.update('tool_call_update', { toolCallId: 't1', status: 'completed' });
    fake.update('usage_update', { used: 7359, size: 131072 });
    fake.update('agent_message_chunk', { content: { type: 'text', text: 'PELICAN' } });
    fake.finish();
    await ticks();
    await handle.close();
    await drained;
    const types = events.map(event => event.type);
    expect(types).toEqual(expect.arrayContaining(['session_id', 'thinking', 'tool_use', 'tool_result_full', 'tool_result', 'status', 'text', 'done']));
    const tool = events.find(event => event.type === 'tool_use')!.data as Record<string, unknown>;
    expect(tool).toMatchObject({ toolUseId: 't1', toolName: 'Read', input: { file_path: '/tmp/agy-work/notes.txt' } });
    const done = events.find(event => event.type === 'done')!.data as Record<string, unknown>;
    expect(done).toMatchObject({ stopReason: 'end_turn', cancelled: false, tokenUsage: 170, outputTokens: 20, contextTokens: 7359, contextWindow: 131072 });
    expect(events.every(event => event.source === 'agy')).toBe(true);
  });

  it('cancel sends session/cancel and completes the turn as cancelled', async () => {
    const { fake, start } = create();
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'long task' });
    await handle.abort();
    await ticks();
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(true);
    expect(handle.isTurnRunning!()).toBe(false);
    await handle.close();
    await drained;
    expect(events.find(event => event.type === 'done')?.data).toMatchObject({ stopReason: 'cancelled', cancelled: true });
  });

  it.each([false, true])('fences the process when cancellation does not complete (blocked write: %s)', async blocked => {
    vi.useFakeTimers();
    const fake = new FakeAgy();
    fake.cancelResolves = false;
    fake.cancelWriteBlocked = blocked;
    const { start } = create(fake);
    const handle = await start();
    await handle.send({ type: 'user', content: 'long task' });
    const aborting = handle.abort();
    await vi.advanceTimersByTimeAsync(10_001);
    await aborting;
    expect(fake.closeCount).toBeGreaterThan(0);
    await expect(handle.send({ type: 'user', content: 'again' })).rejects.toThrow(/closed/);
  });

  it('surfaces a process crash during a turn as a terminal error', async () => {
    const { fake, start } = create();
    fake.stderr = 'panic: something broke\n';
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'work' });
    fake.crash();
    await ticks();
    await handle.close();
    await drained;
    const error = events.find(event => event.type === 'error')!.data as Record<string, unknown>;
    expect(error).toMatchObject({ isTerminal: true, reason: 'agy_acp_disconnected' });
    expect(String(error.message)).toContain('panic: something broke');
    expect(String(error.message)).toContain('Select Retry');
  });
});

describe('AgyAgent permissions', () => {
  const command = { toolCallId: 'c1', name: 'run_command', kind: 'execute', title: 'ls -la', status: 'pending', rawInput: { CommandLine: 'ls -la' } };

  it('routes request_permission through the Cindy resolver and answers allow_once, never allow_always', async () => {
    const { fake, start } = create();
    const handle = await start({ permissionMode: 'ask' });
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver(async request => { seen.push(request); return { kind: 'permission', behavior: 'allow' } as InteractionDecision; });
    await handle.send({ type: 'user', content: 'run ls' });
    fake.permission('1', command);
    await ticks();
    expect(seen[0]).toMatchObject({ kind: 'permission', toolName: 'Bash', input: { command: 'ls -la' } });
    expect(fake.responseTo('1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await handle.close();
  });

  it('answers reject_once when the user denies', async () => {
    const { fake, start } = create();
    const handle = await start({ permissionMode: 'default' });
    handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'deny' }) as InteractionDecision);
    await handle.send({ type: 'user', content: 'run ls' });
    fake.permission('2', command);
    await ticks();
    expect(fake.responseTo('2')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'deny' } });
    await handle.close();
  });

  it('cancels the request when no resolver is attached', async () => {
    const { fake, start } = create();
    const handle = await start();
    await handle.send({ type: 'user', content: 'run ls' });
    fake.permission('3', command);
    await ticks();
    expect(fake.responseTo('3')?.result).toEqual({ outcome: { outcome: 'cancelled' } });
    await handle.close();
  });

  it('Full access uses the existing Cindy bypass semantics (allow_once, no prompt)', async () => {
    const { fake, start } = create();
    const handle = await start({ permissionMode: 'bypassPermissions' });
    const resolver = vi.fn();
    handle.setInteractionResolver(resolver);
    await handle.send({ type: 'user', content: 'run ls' });
    fake.permission('4', command);
    await ticks();
    expect(resolver).not.toHaveBeenCalled();
    expect(fake.responseTo('4')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await handle.close();
  });
});

describe('AgyAgent stall watchdog', () => {
  // #25: silence alone is not proof of a stalled native task. The previous
  // default cancelled a productive silent turn at 15 minutes. Unit virtual time
  // covers the real send/completion and explicit cancellation entry points.
  it('warns once but lets a default-policy silent turn finish after twenty minutes', async () => {
    vi.useFakeTimers();
    const { fake, start } = create();
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'quiet task' });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(false);
    expect(handle.isTurnRunning!()).toBe(true);
    expect(events.filter(event => event.type === 'status' && String((event.data as { status?: string }).status).includes('no events for'))).toHaveLength(1);
    fake.finish();
    await vi.advanceTimersByTimeAsync(1);
    await handle.close();
    await drained;
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('still cancels a long silent default-policy turn when the user stops it', async () => {
    vi.useFakeTimers();
    const { fake, start } = create();
    const handle = await start();
    await handle.send({ type: 'user', content: 'quiet task' });
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(handle.isTurnRunning!()).toBe(true);
    await handle.abort();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.written.filter(item => item.method === 'session/cancel')).toHaveLength(1);
    expect(handle.isTurnRunning!()).toBe(false);
    await handle.close();
  });

  it('keeps a turn alive while thought chunks or usage keep arriving', async () => {
    vi.useFakeTimers();
    const { fake, start } = create(new FakeAgy(), { agyStallTimeoutMs: 60_000 });
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'long task' });
    for (let index = 0; index < 10; index++) {
      await vi.advanceTimersByTimeAsync(25_000);
      fake.update(index % 2 ? 'usage_update' : 'agent_thought_chunk', index % 2 ? { used: index, size: 10 } : { content: { type: 'text', text: '.' } });
    }
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(false);
    expect(handle.isTurnRunning!()).toBe(true);
    fake.finish();
    await vi.advanceTimersByTimeAsync(1);
    await handle.close();
    await drained;
    expect(events.some(event => event.type === 'done')).toBe(true);
    expect(events.some(event => event.type === 'error')).toBe(false);
  });

  it('warns at half the limit, then cancels and reports a stall at the limit', async () => {
    vi.useFakeTimers();
    const { fake, start } = create(new FakeAgy(), { agyStallTimeoutMs: 60_000 });
    const handle = await start();
    const events: AgentEvent[] = [];
    const drained = drain(handle, events);
    await handle.send({ type: 'user', content: 'long task' });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(events.some(event => event.type === 'status' && String((event.data as { status?: string }).status).includes('no events for'))).toBe(true);
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    await handle.close();
    await drained;
    const error = events.find(event => event.type === 'error')!.data as Record<string, unknown>;
    expect(error).toMatchObject({ isTerminal: true, reason: 'agy_stall_timeout' });
    expect(String(error.message)).toContain('60s');
    expect(events.some(event => event.type === 'done')).toBe(false);
  });

  it('does not count time spent waiting for a user permission answer', async () => {
    vi.useFakeTimers();
    const { fake, start } = create(new FakeAgy(), { agyStallTimeoutMs: 60_000 });
    const handle = await start();
    let answer!: (decision: InteractionDecision) => void;
    handle.setInteractionResolver(() => new Promise(resolve => { answer = resolve; }));
    await handle.send({ type: 'user', content: 'run ls' });
    fake.permission('9', { toolCallId: 'c9', kind: 'execute', rawInput: { CommandLine: 'ls' } });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(false);
    answer({ kind: 'permission', behavior: 'allow' });
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.responseTo('9')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
    await handle.close();
  });

  it('honors the env limit and 0 = disabled', async () => {
    vi.useFakeTimers();
    process.env.CINDY_AGY_STALL_TIMEOUT_MS = '0';
    const { fake, start } = create();
    const handle = await start();
    await handle.send({ type: 'user', content: 'long task' });
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fake.written.some(item => item.method === 'session/cancel')).toBe(false);
    await handle.close();
  });
});

describe('AgyAgent auto-review roots inside the system sandbox', () => {
  it('reviews against the same real task folder agy sees, not a symlinked workingDir', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agy-roots-')));
    const real = path.join(root, 'real');
    fs.mkdirSync(real);
    const link = path.join(root, 'link');
    fs.symlinkSync(real, link);
    const requests: { workspaceRoots: string[]; writableRoots?: readonly string[]; action: { kind: string; cwd?: string } }[] = [];
    const delegate = vi.fn(async (request: (typeof requests)[number]) => { requests.push(request); return { verdict: 'allow' as const, reason: 'test' }; });
    const { fake, agent } = create(new FakeAgy(), {
      binaryPath: fs.realpathSync(process.execPath),
      agySandbox: { stateRoot: path.join(root, 'state'),
        probe: { ok: true, bwrapPath: '/usr/bin/bwrap', pastaPath: '/usr/bin/pasta', ipPath: '/usr/sbin/ip', version: '0.6.1', supportsDisableUserns: false } },
      reviewAutoPermissionAction: delegate as unknown as AgyAgentDeps['reviewAutoPermissionAction'],
    });
    try {
      const handle = await agent.startSession({ workingDir: link, model: 'gpt-oss-120b-medium', permissionMode: 'auto' });
      handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'deny' }) as InteractionDecision);
      await handle.send({ type: 'user', content: 'make a file' });
      fake.permission('r1', { toolCallId: 'c9', name: 'run_command', kind: 'execute', status: 'pending', rawInput: { CommandLine: 'touch b.ts' } });
      await ticks();
      expect(requests).toHaveLength(1);
      expect(requests[0]!.workspaceRoots).toEqual([real]);
      expect(requests[0]!.writableRoots).toEqual([real]);
      expect(requests[0]!.action).toMatchObject({ kind: 'exec', cwd: real });
      expect(fake.responseTo('r1')?.result).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
      await handle.close();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
