import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withAgyPermissionTransition } from '../agyPermissionLifecycle.js';
import { MAKER_INVOKE } from '../channels';
import { withSendToSessionLock } from '../sendToSessionLock.js';
import { withSessionPermissionChange } from '../sessionPermissionChange.js';
import {
  applyPendingAgentSwitchIfIdle,
  performSessionAgentSwitch,
  registerMakerSessionAgentSwitchHandler,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from '../sessionAgentSwitchHandler';
import { agySwitchPermissionChange, permissionModeAfterSwitchToAgy } from '../../../shared/agentKindConversion';
import { AgentSwitchPermissionUnconfirmedError, agySwitchPermissionIsUnconfirmed } from '../agentSwitchPermissionAgreement';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
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
  const state: { live: Live | null; closeFails: boolean; launchGate?: Promise<void>; saveGate?: Promise<void>;
    /** What the switch's early read reports instead of the stored mode: a change landing just after it. */
    staleModeAtEarlyRead?: string } = { live: null, closeFails: false };
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
  const guards: Array<{ guarded: boolean; agreement?: unknown }> = [];
  const switchDeps: MakerSessionAgentSwitchHandlerDeps = {
    confirmNativeHistoryFallback: vi.fn(async () => true),
    getSessionRow: vi.fn(async () => ({ ...row, ...(state.staleModeAtEarlyRead ? { permissionMode: state.staleModeAtEarlyRead } : {}) })),
    getLiveSession: () => state.live,
    closeSession: async () => { state.live = null; },
    listMessagesForHandoff: vi.fn(async () => [{ role: 'user', content: 'hello', createdAt: 1 }]),
    applyAgentSwitchToDb: vi.fn(async (_id, patch) => {
      guards.push(patch.agyPermissionGuard ? { guarded: true, agreement: patch.agyPermissionGuard.agreement } : { guarded: false });
      // As the row commit does inside its statement (pinned to the real SQL in sessionsUpdate.test.ts).
      if (patch.agyPermissionGuard && row.agentKind !== 'agy'
        && agySwitchPermissionIsUnconfirmed(row.permissionMode, patch.agyPermissionGuard.agreement)) {
        throw new AgentSwitchPermissionUnconfirmedError();
      }
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
    id, row, log, broadcasts, state, maker, guards,
    /** A switch that does not come from the user's pick: applied at once, or staged by configuration or the agent. */
    switchFromHost: (extra: Record<string, unknown>) => performSessionAgentSwitch(switchDeps, {
      sessionId: id, targetAgentKind: 'agy', model: 'gemini-test', providerId: null, ...extra,
    }),
    /** The picker's entry: registers the switch, which the next send applies. */
    /**
     * As the composer does: the switch carries what its dialog told the user about the mode the
     * task is in when the model is picked (or re-confirmed later, for `agreedFor`).
     */
    pickGeminiModel: (agreedFor: string | null = row.permissionMode) => ipc.invoke(
      MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', 'gemini-test', null, undefined, undefined,
      agreedFor === null ? undefined : { agyPermissionAgreement: {
        change: agySwitchPermissionChange(agreedFor), mode: permissionModeAfterSwitchToAgy(agreedFor),
      } }),
    /** The same pick arriving from another computer that controls this one, claiming an agreement. */
    pickGeminiModelFromRemote: (agreedFor: string) => runDeviceLinkInvokeContext(
      { controllerDeviceId: 'controller-1', channel: MAKER_INVOKE.SWITCH_SESSION_AGENT },
      () => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', 'gemini-test', null, undefined, undefined,
        { agyPermissionAgreement: {
          change: agySwitchPermissionChange(agreedFor), mode: permissionModeAfterSwitchToAgy(agreedFor),
        } })),
    pendingSwitch: () => ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, id),
    /** Picking a model of the engine the task runs on withdraws the pending switch. */
    withdrawSwitch: () => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'claude-code', 'claude-test', null),
    /** The send transaction's step: under the send lock, apply the registered switch and start the engine. */
    send: () => withSendToSessionLock(id, () => applyPendingAgentSwitchIfIdle(switchDeps, id, { bootstrapAfterSwitch: true })),
    setPermission: (mode: string) => setMode({}, id, mode),
    lastBroadcastMode: () => [...broadcasts].reverse().find(patch => 'permissionMode' in patch)?.permissionMode,
  };
}

describe('switching a task into Antigravity from the model picker, with permission changes around it', () => {
  it.each([
    ['bypassPermissions', 'auto'], ['acceptEdits', 'ask'], ['plan', 'ask'], ['auto', 'auto'],
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

  // DD review 7077886823 (blocker 2) and QQ's ruling after it: a queued, IM or scheduled message is
  // dispatched by the host, not by the composer, and the stored mode can have been changed from
  // anywhere since the user agreed to the switch. The host used to apply the pending switch to
  // whatever was stored, rewriting it with no notice. It now applies a rewrite only when it is the
  // one the user agreed to; otherwise nothing is applied or launched and the switch stays pending.
  it.each([
    ['Auto-review, then Full access is stored', 'auto', 'bypassPermissions', 'auto'],
    ['Default permissions, then Accept edits is stored', 'ask', 'acceptEdits', 'ask'],
    ['Full access, then Accept edits is stored', 'bypassPermissions', 'acceptEdits', 'ask'],
  ])('holds a host-dispatched message until the rewrite is agreed, then switches once: agreed in %s', async (_name, agreedIn, stored, expected) => {
    const h = fixture(agreedIn);
    await h.pickGeminiModel();
    await h.setPermission(stored);
    const before = [...h.log];

    await expect(h.send()).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(h.log).toEqual(before);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: stored });
    expect(h.state.live).toBeNull();
    await expect(h.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy', model: 'gemini-test' });

    // The user confirms the actual change in the composer; the held message is retried.
    await h.pickGeminiModel(stored);
    await h.send();
    await h.send();
    expect(h.log.slice(before.length)).toEqual([`switched agy ${expected}`, `launch agy ${expected} isolated`]);
    await expect(h.pendingSwitch()).resolves.toBeNull();
  });

  it.each([
    ['a mode Antigravity keeps was stored after agreeing to leave Full access', 'bypassPermissions', 'ask', 'ask'],
    ['the stored mode is still the one agreed to', 'bypassPermissions', 'bypassPermissions', 'auto'],
    ['another unsupported mode with the same agreed outcome was stored', 'acceptEdits', 'plan', 'ask'],
  ])('applies a host-dispatched switch without asking when %s', async (_name, agreedIn, stored, expected) => {
    const h = fixture(agreedIn);
    await h.pickGeminiModel();
    if (stored !== agreedIn) await h.setPermission(stored);
    await h.send();
    expect(h.log.slice(-2)).toEqual([`switched agy ${expected}`, `launch agy ${expected} isolated`]);
  });

  it('holds a switch that arrived with no agreement at all when it would rewrite the mode, and applies one that would not', async () => {
    const rewritten = fixture('bypassPermissions');
    await rewritten.pickGeminiModel(null);
    await expect(rewritten.send()).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    expect(rewritten.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });

    const kept = fixture('auto');
    await kept.pickGeminiModel(null);
    await kept.send();
    expect(kept.row).toMatchObject({ agentKind: 'agy', permissionMode: 'auto' });
  });

  it('does not let an agreement from a withdrawn switch vouch for a later one', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel();
    await h.withdrawSwitch();
    await expect(h.pendingSwitch()).resolves.toBeNull();
    // Registered again from a window that asked nothing (another window, or a stale composer).
    await h.pickGeminiModel(null);
    await expect(h.send()).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.state.live).toBeNull();
  });

  it('catches a mode stored after the early read, when the switch is committed', async () => {
    const h = fixture('ask');
    await h.pickGeminiModel();
    h.row.permissionMode = 'bypassPermissions';
    h.state.staleModeAtEarlyRead = 'ask';
    await expect(h.send()).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.log).toEqual([]);
    await expect(h.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy' });
  });

  // QQ's ruling: any path that makes the same unconfirmed rewrite is checked by the host, not only
  // the user's pending pick. An agent's own request, an automation's model and an automatic
  // fallback have nobody to ask, so on a task whose mode would be rewritten they are refused and
  // the task is left as it was. The one exception is a partner's conversation following the
  // partner's settings, whose rewrite is the policy decided for cindy#18.
  it.each([
    ['requested by the agent itself, as a pending switch', { runtimeSource: 'agent' }, 'pending'],
    ['staged by configuration on an ordinary task, as a pending switch', { configStaged: true }, 'pending'],
    ['applied at once by an automation or a fallback', { applyNow: true }, 'now'],
    ['applied at once and staged by configuration on an ordinary task', { applyNow: true, configStaged: true }, 'now'],
  ] as const)('refuses a switch %s when it would rewrite Full access', async (_name, extra, timing) => {
    const h = fixture('bypassPermissions');
    const attempt = timing === 'now' ? h.switchFromHost(extra) : h.switchFromHost(extra).then(() => h.send());
    await expect(attempt).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.state.live).toBeNull();
  });

  it('lets the same switches through on a task whose mode Antigravity keeps', async () => {
    const h = fixture('auto');
    await h.switchFromHost({ applyNow: true, configStaged: true });
    expect(h.row).toMatchObject({ agentKind: 'agy', permissionMode: 'auto' });
    expect(h.guards).toEqual([{ guarded: true, agreement: undefined }]);
  });

  it('leaves a partner conversation that follows the partner\'s settings to the partner policy', async () => {
    const h = fixture('bypassPermissions');
    h.row.source = 'bot';
    await h.switchFromHost({ applyNow: true, configStaged: true });
    expect(h.row).toMatchObject({ agentKind: 'agy', permissionMode: 'auto' });
    expect(h.guards).toEqual([{ guarded: false }]);
  });

  it('still checks the user\'s own pick in a partner conversation', async () => {
    const h = fixture('bypassPermissions');
    h.row.source = 'bot';
    await h.pickGeminiModel(null);
    await expect(h.send()).rejects.toBeInstanceOf(AgentSwitchPermissionUnconfirmedError);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
  });

  // DD 7079095110: only this computer's composer shows the dialog an agreement comes from. A
  // controller on another computer can register the switch, and the registration succeeds, but an
  // agreement it sends along counts for nothing: the message is held until this computer confirms.
  // It also cannot take away an agreement this computer has already given.
  it('takes no agreement from a remote controller, and keeps this computer\'s own', async () => {
    const h = fixture('bypassPermissions');
    await expect(h.pickGeminiModelFromRemote('bypassPermissions')).resolves.toMatchObject({ deferred: true });
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    await expect(h.pickGeminiModelFromRemote('bypassPermissions')).resolves.toMatchObject({ deferred: true });
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.log).toEqual([]);

    await h.pickGeminiModel();
    await h.pickGeminiModelFromRemote('acceptEdits');
    await h.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
  });

  it('keeps what was agreed when another Gemini model is picked while the switch is pending', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel();
    await h.pickGeminiModel(null);
    await h.send();
    expect(h.row).toMatchObject({ agentKind: 'agy', permissionMode: 'auto' });
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
