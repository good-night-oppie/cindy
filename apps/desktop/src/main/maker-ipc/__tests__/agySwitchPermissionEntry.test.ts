import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withAgyPermissionTransition } from '../agyPermissionLifecycle.js';
import { MAKER_INVOKE } from '../channels';
import { withSendToSessionLock } from '../sendToSessionLock.js';
import { withSessionPermissionChange } from '../sessionPermissionChange.js';
import {
  applyPendingAgentSwitchIfIdle,
  registerMakerSessionAgentSwitchHandler,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from '../sessionAgentSwitchHandler';
import { permissionModeAfterSwitchToAgy } from '../../../shared/agentKindConversion';
import { IpcHarness } from './helpers/ipcHarness';

const ownership = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../localDb/client/current.js', () => ({ getCurrentDbClientSnapshot: () => ownership.current }));

// cindy#19 (QQ 2026-11-22): the task's model picker can now switch a task into Antigravity. The
// lock-level cases (agyPermissionLifecycle.test.ts) call the transition helper directly; these go
// through the two IPC handlers a user reaches: maker:switch-session-agent, then the step of the
// send transaction that applies the registered switch under the send lock, and
// maker:set-permission-mode (the real handler source from register.ts, as pluginWriteAccess.test.ts
// runs it). The runtime and the store are stand-ins; the row commit stand-in applies the shared
// rule that sessionsUpdate.test.ts pins to the real SQL. Linux is forced: launch style only differs there.
const source = readFileSync(new URL('../register.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const permissionSource = source.slice(
  source.indexOf('  async function commitSessionPermissionMode('),
  source.indexOf('  ipcMain.handle(\n    MAKER_INVOKE.SET_PLAN_MODE,'),
);
const permissionJs = ts.transpileModule(permissionSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

type Row = AgentSwitchSessionRow & { permissionMode: string };
type Live = { agentKind: string; stablePermissionModeState: { mode: string }; isTurnRunning: () => boolean;
  setPermissionMode: (mode: string) => Promise<void>; abort: () => Promise<void> };
const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(initialMode: string) {
  const id = `task-${initialMode}-${Math.random().toString(36).slice(2, 8)}`;
  const row: Row = {
    id, agentKind: 'cc', model: 'claude-test', providerId: null, status: 'active', remoteHostId: null,
    orcaRole: null, sdkSessionId: null, workingDir: '/project', permissionMode: initialMode,
  };
  const log: string[] = [];
  const broadcasts: Record<string, unknown>[] = [];
  const state: { live: Live | null; closeFails: boolean; launchGate?: Promise<void>; saveGate?: Promise<void> } =
    { live: null, closeFails: false };
  const launch = async () => {
    await state.launchGate;
    const mode = row.permissionMode;
    state.live = {
      agentKind: row.agentKind, stablePermissionModeState: { mode }, isTurnRunning: () => false,
      setPermissionMode: async (next) => { state.live!.stablePermissionModeState.mode = next; log.push(`runtime ${next}`); },
      abort: async () => {},
    };
    // Antigravity on Linux: isolated unless the mode it starts with is Full access.
    log.push(`launch ${row.agentKind} ${mode} ${row.agentKind === 'agy' && mode !== 'bypassPermissions' ? 'isolated' : 'unsandboxed'}`);
  };
  const maker = {
    getSession: () => state.live,
    closeSession: vi.fn(async () => {
      if (state.closeFails) throw new Error('close failed');
      state.live = null;
      log.push('closed');
    }),
  };
  ownership.current = { client: {
    drizzle: { select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ permissionMode: row.permissionMode, agentKind: row.agentKind }] }) }) }) },
    tx: async (_name: string, args: { mode: string }) => {
      await state.saveGate;
      row.permissionMode = args.mode;
      log.push(`saved ${args.mode}`);
      return { updated: true };
    },
    query: async () => [{ sessionId: id, agentKind: row.agentKind, permissionMode: row.permissionMode }],
  } };

  const pending = new Map<string, PendingAgentSwitchIntent>();
  const switchDeps: MakerSessionAgentSwitchHandlerDeps = {
    confirmNativeHistoryFallback: vi.fn(async () => true),
    getSessionRow: vi.fn(async () => ({ ...row })),
    getLiveSession: () => state.live,
    closeSession: async () => { state.live = null; },
    listMessagesForHandoff: vi.fn(async () => [{ role: 'user', content: 'hello', createdAt: 1 }]),
    applyAgentSwitchToDb: vi.fn(async (_id, patch) => {
      if (patch.agentKind === 'agy' && row.agentKind !== 'agy') row.permissionMode = permissionModeAfterSwitchToAgy(row.permissionMode);
      row.agentKind = patch.agentKind;
      row.model = patch.model;
      broadcasts.push({ agentKind: row.agentKind, permissionMode: row.permissionMode });
      log.push(`switched ${row.agentKind} ${row.permissionMode}`);
    }),
    setSessionProvider: vi.fn(),
    insertBoundaryMessage: vi.fn(async () => 'boundary'),
    applyResumeFallbackAtomically: vi.fn(async () => {}),
    setPendingHandoff: vi.fn(),
    bootstrapSwitchedSession: vi.fn(launch),
    withCloseSuppressed: vi.fn((_sessionId, fn) => fn()),
    withSessionLock: withSendToSessionLock,
    pendingSwitches: { set: (key, intent) => void pending.set(key, intent), get: key => pending.get(key), clear: key => void pending.delete(key) },
    log: { info: vi.fn(), warn: vi.fn() },
  };
  const ipc = new IpcHarness();
  registerMakerSessionAgentSwitchHandler(ipc, switchDeps);

  let setMode!: (event: unknown, sessionId: string, mode: string) => Promise<unknown>;
  const permissionDeps = {
    withBotPermissionChange: async (_id: string, change: () => Promise<unknown>) => change(),
    withSessionPermissionChange,
    getCurrentDbClientSnapshot: () => ownership.current,
    assertReviewSettingsUnlocked: async () => {},
    sessions: { id: 'id', permissionMode: 'permissionMode', agentKind: 'agentKind' },
    eq: () => true,
    botPermissionTargets: async () => [],
    withAgyPermissionTransition: (targets: Parameters<typeof withAgyPermissionTransition>[0], mode: string,
      runtime: Parameters<typeof withAgyPermissionTransition>[2], commit: Parameters<typeof withAgyPermissionTransition>[3]) =>
      withAgyPermissionTransition(targets, mode, runtime, commit, 'linux'),
    maker,
    log: { warn: vi.fn() },
    forgetCredentialGrants: vi.fn(),
    broadcastSessionPatched: (_id: string, patch: Record<string, unknown>) => { broadcasts.push(patch); },
    syncBotLinkedLanePermissions: async () => {},
    markRemoteSettingPersistedInsideHandler: () => {},
    throwIpcError: (code: string, message: string) => { throw Object.assign(new Error(message), { code }); },
    ipcMain: { handle: (_name: unknown, handler: typeof setMode) => { setMode = handler; } },
    MAKER_INVOKE: { SET_PERMISSION_MODE: 'permission' },
    isDeviceLinkInvoke: () => false,
    assertTrustedAppRendererEvent: () => {},
    isSessionPermissionMode: () => true,
    persistPermissionModeWithoutRuntime: async () => true,
  };
  new Function(...Object.keys(permissionDeps), permissionJs)(...Object.values(permissionDeps));
  expect(setMode, 'SET_PERMISSION_MODE source extraction must register its handler').toBeTypeOf('function');

  return {
    id, row, log, broadcasts, state, maker,
    /** The picker's entry: registers the switch, which the next send applies. */
    pickGeminiModel: () => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', 'gemini-test', null),
    /** The send transaction's step: under the send lock, apply the registered switch and start the engine. */
    send: () => withSendToSessionLock(id, () => applyPendingAgentSwitchIfIdle(switchDeps, id, { bootstrapAfterSwitch: true })),
    setPermission: (mode: string) => setMode({}, id, mode),
    lastBroadcastMode: () => [...broadcasts].reverse().find(patch => 'permissionMode' in patch)?.permissionMode,
  };
}

describe('switching a task into Antigravity from the model picker, with permission changes around it', () => {
  it.each([
    ['bypassPermissions', 'auto'], ['acceptEdits', 'auto'], ['ask', 'ask'],
  ])('a task in %s starts Antigravity isolated in %s, and store, runtime and broadcast agree', async (from, expected) => {
    const h = fixture(from);
    await expect(h.pickGeminiModel()).resolves.toMatchObject({ deferred: true });
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: from });
    await h.send();
    expect(h.log).toEqual([`switched agy ${expected}`, `launch agy ${expected} isolated`]);
    expect(h.row.permissionMode).toBe(expected);
    expect(h.state.live?.stablePermissionModeState.mode).toBe(expected);
    expect(h.lastBroadcastMode()).toBe(expected);
  });

  it('send first: a tighter mode picked while Antigravity is starting waits, then reaches the running process', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel();
    let finishLaunch!: () => void;
    h.state.launchGate = new Promise<void>((resolve) => { finishLaunch = resolve; });
    const sent = h.send();
    await settle();
    const changed = h.setPermission('ask');
    await settle();
    expect(h.log).toEqual(['switched agy auto']);

    finishLaunch();
    await sent;
    await expect(changed).resolves.toBe(true);
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated', 'runtime ask', 'saved ask']);
    expect(h.maker.closeSession).not.toHaveBeenCalled();
    expect([h.row.permissionMode, h.state.live?.stablePermissionModeState.mode, h.lastBroadcastMode()]).toEqual(['ask', 'ask', 'ask']);
  });

  it('permission change first: the send waits for the save and starts Antigravity with the saved mode', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel();
    let finishSave!: () => void;
    h.state.saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    const changed = h.setPermission('ask');
    await settle();
    const sent = h.send();
    await settle();
    expect(h.log).toEqual([]);

    finishSave();
    await expect(changed).resolves.toBe(true);
    await sent;
    expect(h.log).toEqual(['saved ask', 'switched agy ask', 'launch agy ask isolated']);
    expect([h.row.permissionMode, h.state.live?.stablePermissionModeState.mode, h.lastBroadcastMode()]).toEqual(['ask', 'ask', 'ask']);
  });

  it.each([true, false])('Full access chosen after the switch retires the isolated process first (close ok: %s)', async (closeOk) => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel();
    await h.send();
    h.state.closeFails = !closeOk;
    const changed = h.setPermission('bypassPermissions');
    if (closeOk) {
      await expect(changed).resolves.toBe(true);
      expect(h.log.slice(2)).toEqual(['closed', 'saved bypassPermissions']);
      expect(h.state.live).toBeNull();
      expect([h.row.permissionMode, h.lastBroadcastMode()]).toEqual(['bypassPermissions', 'bypassPermissions']);
    } else {
      await expect(changed).rejects.toThrow('close failed');
      expect(h.log.slice(2)).toEqual([]);
      expect([h.row.permissionMode, h.state.live?.stablePermissionModeState.mode, h.lastBroadcastMode()]).toEqual(['auto', 'auto', 'auto']);
    }
  });
});
