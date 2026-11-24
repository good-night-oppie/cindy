/** Standard tier: real native control transport with in-memory CLI pipes.
 * Protects profile separation, bounded subprocess lifetime and sanitized errors, without real credentials.
 */
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  binary: '/fixture/codex' as string | null,
  spawn: vi.fn(),
  error: false,
  hold: false,
  accountResult: undefined as unknown,
  oldAuthenticated: false,
  oldLogin: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true })),
  oldCancel: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('@cindy/maker-core', () => ({
  cleanProcessEnv: () => ({
    PATH: '/fixture/bin',
    OPENAI_API_KEY: 'fixture-key',
    CODEX_API_KEY: 'fixture-key',
    CODEX_HOME: '/wrong-profile',
  }),
}));
vi.mock('../../agent-binaries/index.js', () => ({ getReadyBinaryPath: () => h.binary }));
vi.mock('../../maker-host/codex-account-auth.desktop.js', () => ({
  codexAccountState: () => ({ authenticated: h.oldAuthenticated, errorReason: h.oldAuthenticated ? undefined : 'oauth_expired' }),
  loginCodexAccount: h.oldLogin,
  cancelCodexAccountLogin: h.oldCancel,
}));
vi.mock('../../maker-host/claude-native-cli.desktop.js', () => ({
  refreshClaudeCliLoginStatus: vi.fn(),
  readClaudeCliPlanUsage: vi.fn(),
  runClaudeCliLogin: vi.fn(),
}));
import {
  codexAccountRpc,
  readNativeAccount,
  readNativeAccountUsage,
  loginNativeAccount,
  readNativeCodexTokens,
  readLegacyCodexProviderAccount,
  loginLegacyCodexProviderAccount,
} from '../nativeCli.js';
import { refreshClaudeCliLoginStatus, runClaudeCliLogin } from '../../maker-host/claude-native-cli.desktop.js';
import { loginAntigravityAccount } from '../nativeCli.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const children: (EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
})[] = [];

// Unit regression: account replacement during CLI startup must prevent the
// reset request itself, not merely reject its already-consumed response.
it('does not dispatch a reset after its credential guard expires during startup', async () => {
  await expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => false)).rejects.toThrow('changed before dispatch');
  const methods = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method);
  expect(methods).toEqual(['initialize', 'initialized']);
});

// Existing pooled accounts use synchronous proofs. Do not insert a new yield between proof and write.
it('preserves synchronous guarded dispatch before the next microtask', async () => {
  let methodsAtNextMicrotask: string[] = [];
  await codexAccountRpc('/second', 'account/rateLimitResetCredit/consume', { idempotencyKey: 'key' }, () => {
    queueMicrotask(() => {
      methodsAtNextMicrotask = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method);
    });
    return true;
  });
  expect(methodsAtNextMicrotask).toEqual(['initialize', 'initialized', 'account/rateLimitResetCredit/consume']);
});

// #10408, unit: filesystem/source checks are asynchronous. A Promise is not authorization;
// inspect actual CLI writes, including connection termination while the proof is pending.
it.each([true, false])('waits for an asynchronous dispatch proof (allowed: %s)', async (allowed) => {
  let decide!: (allowed: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proof = new Promise<boolean>(resolve => { decide = resolve; });
  const pending = codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => { entered(); return proof; });
  const observed = allowed ? expect(pending).resolves.toBeDefined()
    : expect(pending).rejects.toThrow('changed before dispatch');
  await started;
  try {
    expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
      .toEqual(['initialize', 'initialized']);
  } finally {
    decide(allowed);
    await observed;
  }
  expect(children[0].stdin.write.mock.calls.some(([line]) =>
    JSON.parse(line).method === 'account/rateLimitResetCredit/consume')).toBe(allowed);
});

it('does not dispatch after the connection closes while an asynchronous proof is pending', async () => {
  let decide!: (allowed: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proof = new Promise<boolean>(resolve => { decide = resolve; });
  const pending = expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => { entered(); return proof; })).rejects.toThrow('connection closed');
  await started;
  children[0].emit('close', null);
  await pending;
  decide(true);
  await Promise.resolve();
  expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
    .toEqual(['initialize', 'initialized']);
});

it('rejects a failed asynchronous proof without sending or exposing its error details', async () => {
  await expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, async () => { throw new Error('fixture-secret-must-not-leak'); }))
    .rejects.toThrow('Codex account changed before dispatch');
  expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
    .toEqual(['initialize', 'initialized']);
});

beforeEach(() => {
  h.binary = '/fixture/codex';
  h.error = false;
  h.hold = false;
  h.accountResult = undefined;
  h.oldAuthenticated = false;
  h.oldLogin.mockReset().mockResolvedValue({ ok: true });
  h.oldCancel.mockReset();
  children.length = 0;
  h.spawn.mockReset().mockImplementation((_binary, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      stdout: new EventEmitter(),
      kill: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      child.emit('close', null);
    });
    child.stdin.write.mockImplementation((line: string) => {
      const request = JSON.parse(line);
      if (!request.id || h.hold) return;
      queueMicrotask(() =>
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify(
              request.id === 1
                ? { id: 1, result: {} }
                : h.error
                  ? { id: 2, error: { message: 'fixture-secret-must-not-leak' } }
                  : {
                      id: 2,
                      result: h.accountResult ?? {
                        account: {
                          type: 'chatgpt',
                          email: options.env.CODEX_HOME + '@example.test',
                          planType: 'plus',
                        },
                      },
                    },
            ) + '\n',
          ),
        ),
      );
    });
    children.push(child);
    if (args[0] === 'login' && !h.hold) queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});
afterEach(() => vi.useRealTimers());
// Standard: expiry and renewal belong to the selected native profile, never the
// system default. Previous coverage exercised only Codex's RPC account reader.
describe('Claude profile renewal', () => {
  it('reads the selected profile expiry and forwards a verified renewal request', async () => {
    vi.mocked(refreshClaudeCliLoginStatus).mockResolvedValueOnce({ loggedIn: true,
      email: 'second@example.test', loginExpiresAt: '2030-01-05T00:00:00.000Z' });
    expect(await readNativeAccount('anthropic', '/fixture/claude-second', { force: true })).toMatchObject({
      authenticated: true, identity: 'second@example.test', loginExpiresAt: '2030-01-05T00:00:00.000Z',
    });
    expect(refreshClaudeCliLoginStatus).toHaveBeenLastCalledWith({ configDir: '/fixture/claude-second', force: true, requireFresh: true });
    const signal = new AbortController().signal;
    vi.mocked(runClaudeCliLogin).mockResolvedValueOnce({ ok: true, status: { loggedIn: true, email: 'second@example.test' } });
    await loginNativeAccount('anthropic', '/fixture/claude-second', signal, { renew: true, expectedEmail: 'second@example.test' });
    expect(runClaudeCliLogin).toHaveBeenLastCalledWith(signal, '/fixture/claude-second', { renew: true, expectedEmail: 'second@example.test' });
    vi.mocked(runClaudeCliLogin).mockResolvedValueOnce({ ok: false, reason: 'account_mismatch' });
    await expect(loginNativeAccount('anthropic', '/fixture/claude-second', signal, { renew: true, expectedEmail: 'second@example.test' }))
      .rejects.toThrow('account_mismatch');
  });
});
describe('official Codex profiles', () => {
  // #10110 review, unit: legacy auth has no plan. Keep the plan returned by the
  // selected profile's quota RPC; the old test fixtures only read account/read.
  it('preserves the selected profile plan alongside its sanitized Codex quota', async () => {
    h.accountResult = { rateLimits: { planType: 'pro', primary: {
      usedPercent: 20, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600,
    } } };
    expect(await readNativeAccountUsage('openai', '/fixture/legacy')).toMatchObject({
      codexPlan: 'pro', codexUsage: { appServerBuckets: { __default__: { primary: { usedPercent: 20 } } } },
    });
    expect(h.spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/fixture/legacy');
  });
  // Upgrade 2026-11-11, standard: a revoked imported login cannot be resurrected
  // by reading its still-present token file; successful reads keep the old native profile.
  it('honors the old connection revocation before reading its native account', async () => {
    expect(await readLegacyCodexProviderAccount('openai-old', '/fixture/imported')).toMatchObject({ authenticated: false, errorReason: 'oauth_expired' });
    expect(h.spawn).not.toHaveBeenCalled();
    h.oldAuthenticated = true;
    expect(await readLegacyCodexProviderAccount('openai-old', '/fixture/imported')).toMatchObject({ authenticated: true, plan: 'plus' });
    expect(h.spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/fixture/imported');
  });

  it('uses the original login cancellation path for an imported connection', async () => {
    const controller = new AbortController();
    h.oldLogin.mockImplementation(async (_id, isCurrent) => {
      controller.abort();
      expect((isCurrent as () => boolean)()).toBe(false);
      return { ok: true };
    });
    await expect(loginLegacyCodexProviderAccount('openai-old', controller.signal)).rejects.toThrow('login_cancelled');
    expect(h.oldCancel).toHaveBeenCalledWith('openai-old');
  });
  // #9517, unit: the real account reader must distinguish provider-managed
  // authentication from a signed-out ChatGPT account; older tests only returned ChatGPT.
  it.each([
    { account: null, requiresOpenaiAuth: false, reason: 'codex_provider_managed_auth' },
    { account: null, requiresOpenaiAuth: true, reason: undefined },
    { account: null, requiresOpenaiAuth: undefined, reason: undefined },
    { account: { type: 'chatgpt' }, requiresOpenaiAuth: false, reason: undefined },
  ])('classifies account=$account with requiresOpenaiAuth=$requiresOpenaiAuth', async ({ account, requiresOpenaiAuth, reason }) => {
    h.accountResult = { account, requiresOpenaiAuth };
    const result = await readNativeAccount('openai', '/fixture/custom-provider');
    expect(result.authenticated).toBe(account?.type === 'chatgpt');
    expect(result.errorReason).toBe(reason);
  });

  it('keeps the provider diagnosis if configuration changes while browser login is open', async () => {
    h.accountResult = { account: null, requiresOpenaiAuth: false };
    await expect(loginNativeAccount('openai', '/fixture/second', new AbortController().signal))
      .rejects.toThrow('codex_provider_managed_auth');
  });

  it('expires a selected-profile dispatch proof when that profile is replaced or removed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-subscription-proof-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-token-a', account_id: 'fixture-account-a' },
        }),
      );
      const [first, concurrent] = await Promise.all([
        readNativeCodexTokens(dir, true),
        readNativeCodexTokens(dir, true),
      ]);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(concurrent.accessToken).toBe(first.accessToken);
      expect(first.chatgptAccountId).toBe('fixture-account-a');
      expect(first.canDispatch()).toBe(true);
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-longer-token-b', account_id: 'fixture-account-b' },
        }),
      );
      expect(first.canDispatch()).toBe(false);
      const second = await readNativeCodexTokens(dir);
      expect(second.chatgptAccountId).toBe('fixture-account-b');
      await rm(authPath);
      expect(second.canDispatch()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('queries separate homes concurrently without changing process.env or passing API credentials', async () => {
    const inherited = process.env.CODEX_HOME;
    const result = await Promise.all([
      readNativeAccount('openai', '/fixture/default'),
      readNativeAccount('openai', '/fixture/second'),
    ]);
    expect(result.map((r) => r.identity)).toEqual([
      '/fixture/default@example.test',
      '/fixture/second@example.test',
    ]);
    expect(result.every((r) => r.authenticated)).toBe(true);
    expect(process.env.CODEX_HOME).toBe(inherited);
    expect(h.spawn.mock.calls.map((c) => c[2].env)).toEqual([
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/default' },
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/second' },
    ]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
  it('never returns CLI response details in errors and closes failed control processes', async () => {
    h.error = true;
    await expect(codexAccountRpc('/fixture/second', 'account/read', {})).rejects.toThrow(
      'Codex account request failed',
    );
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });
  it('bounds a stalled CLI read and cancels a browser login without querying another profile', async () => {
    vi.useFakeTimers();
    h.hold = true;
    const pending = expect(codexAccountRpc('/fixture/second', 'account/read', {})).rejects.toThrow(
      'timed out',
    );
    await vi.advanceTimersByTimeAsync(15_000);
    await pending;
    const abort = new AbortController();
    const login = expect(
      loginNativeAccount('openai', '/fixture/second', abort.signal),
    ).rejects.toThrow('login_cancelled');
    abort.abort();
    await login;
    expect(h.spawn.mock.calls.map((c) => c[1])).toEqual([['app-server'], ['login']]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
});

// Rule: cindy#1 (owner, 2026-11-23) - an additional Antigravity account signs in into its own
// directory through the official CLI: the CLI prints a Google link and waits for the code on its
// input (observed on CLI 1.5.15). No existing case covers this CLI. Unit tier: an in-memory
// process; the account directory is a temporary folder and the "sign-in file" is a fixture.
describe('Antigravity account sign-in', () => {
  const LINK = 'https://accounts.google.com/o/oauth2/auth?client_id=fixture&state=fixture';
  function fakeCli(dir: string, options: { writesSignIn?: boolean; exit?: number } = {}) {
    const calls: { args: string[]; cwd: string; env: Record<string, string>; stdio: unknown }[] = [];
    let child!: EventEmitter & { stdin: { end: ReturnType<typeof vi.fn> }; stdout: EventEmitter; kill: ReturnType<typeof vi.fn> };
    const spawn = vi.fn((_binary: string, args: string[], opts: { cwd: string; env: Record<string, string>; stdio: unknown }) => {
      calls.push({ args, cwd: opts.cwd, env: opts.env, stdio: opts.stdio });
      child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stdin: { end: vi.fn(() => {
          if (options.writesSignIn !== false) {
            mkdirSync(path.join(dir, 'gemini', 'antigravity-cli'), { recursive: true });
            writeFileSync(path.join(dir, 'gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'fixture, not a credential');
          }
          queueMicrotask(() => child.emit('close', options.exit ?? 0));
        }) },
        kill: vi.fn(() => queueMicrotask(() => child.emit('close', null))),
      });
      queueMicrotask(() => {
        child.stdout.emit('data', Buffer.from('Open this link in a browser to log in with Google:\n\n  https://accounts.goo'));
        child.stdout.emit('data', Buffer.from(`${LINK.slice('https://accounts.goo'.length)}\n\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`));
      });
      return child;
    });
    return { spawn: spawn as never, calls, child: () => child };
  }
  let dir = '';
  beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'cindy-agy-account-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('hands the link to the caller, passes the pasted code to the CLI only, and ends signed in', async () => {
    const cli = fakeCli(dir);
    const openLink = vi.fn();
    expect((await readNativeAccount('antigravity', dir)).authenticated).toBe(false);
    await loginAntigravityAccount(dir, new AbortController().signal,
      { openLink, readCode: async () => ' fixture-code ' }, { spawn: cli.spawn, binary: '/fixture/agy' });
    expect(openLink).toHaveBeenCalledExactlyOnceWith(LINK);
    expect(cli.child().stdin.end).toHaveBeenCalledExactlyOnceWith('fixture-code\n');
    // The same data directory and marker a task launch for this account uses.
    expect(cli.calls[0]!.args).toEqual(['acp', '--login', '--gemini-dir', path.join(dir, 'gemini')]);
    expect(cli.calls[0]!.env.SSH_CONNECTION).toBe('127.0.0.1 0 127.0.0.1 0');
    expect(cli.calls[0]!.stdio).toEqual(['pipe', 'pipe', 'ignore']);
    expect(await readNativeAccount('antigravity', dir)).toEqual({ authenticated: true, authSource: 'oauth' });
    expect(await readNativeAccountUsage('antigravity', dir)).toEqual({});
  });

  it.each([
    ['the CLI exits with an error', { exit: 1 }, 'login_failed'],
    ['the CLI exits without leaving a sign-in', { writesSignIn: false }, 'login_failed'],
  ] as const)('is not signed in when %s', async (_name, options, reason) => {
    const cli = fakeCli(dir, options);
    await expect(loginAntigravityAccount(dir, new AbortController().signal,
      { openLink: () => {}, readCode: async () => 'fixture-code' }, { spawn: cli.spawn, binary: '/fixture/agy' })).rejects.toThrow(reason);
  });

  it('stops the CLI when the person cancels while the code is awaited', async () => {
    const cli = fakeCli(dir);
    const abort = new AbortController();
    const pending = loginAntigravityAccount(dir, abort.signal, {
      openLink: () => {},
      readCode: signal => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('gone')), { once: true })),
    }, { spawn: cli.spawn, binary: '/fixture/agy' });
    await new Promise(resolve => setTimeout(resolve, 0));
    abort.abort();
    await expect(pending).rejects.toThrow('login_cancelled');
    expect(cli.child().kill).toHaveBeenCalled();
    expect(cli.child().stdin.end).not.toHaveBeenCalled();
  });

  it('never starts the sign-in of the CLI\u2019s own account, and starts none without a way to enter the code', async () => {
    const cli = fakeCli(dir);
    const signal = new AbortController().signal;
    await expect(loginAntigravityAccount(path.join(homedir(), '.gemini'), signal,
      { openLink: () => {}, readCode: async () => 'x' }, { spawn: cli.spawn, binary: '/fixture/agy' })).rejects.toThrow('agy_default_login_in_cli');
    await expect(loginAntigravityAccount(dir, signal, undefined, { spawn: cli.spawn, binary: '/fixture/agy' })).rejects.toThrow('agy_login_needs_code_entry');
    expect(cli.calls).toHaveLength(0);
  });
});
