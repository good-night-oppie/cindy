import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { withAgyPermissionTransition } from '../agyPermissionLifecycle.js';
import { MAKER_INVOKE } from '../channels';
import { withSendToSessionLock } from '../sendToSessionLock.js';
import { withSessionPermissionChange } from '../sessionPermissionChange.js';
import {
  applyPendingAgentSwitchIfIdle,
  createPendingAgentSwitchRegistry,
  holdAgySwitchForConfirmation,
  performSessionAgentSwitch,
  registerMakerSessionAgentSwitchHandler,
  type AgentSwitchSessionRow,
  type MakerSessionAgentSwitchHandlerDeps,
  type PendingAgentSwitchIntent,
} from '../sessionAgentSwitchHandler';
import { agySwitchPermissionChange, permissionModeAfterSwitchToAgy } from '../../../shared/agentKindConversion';
import { AgentSwitchPermissionUnconfirmedError, agySwitchPermissionIsUnconfirmed } from '../agentSwitchPermissionAgreement';
import { runDeviceLinkInvokeContext } from '../../device-link/invoke-context.js';
import { createScheduledModelScope, type ScheduledModelSelection } from '../scheduledModelSelection';
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

  // The registry the app uses: it stamps each registration with the session's revision.
  const hooks = { landed: () => {}, restoreSettled: () => {} };
  let agreed = 0;
  const newRegistry = () => createPendingAgentSwitchRegistry({ onScheduledRestoreSettled: () => { hooks.restoreSettled(); } });
  const pendingSwitches = newRegistry();
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
    pendingSwitches,
    onUserRouteSelectionLanded: () => { hooks.landed(); },
    onPendingSwitchAgreed: () => { agreed += 1; },
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
    /**
     * The task's confirmation entry: an answer about the pending switch to `model`, and nothing else.
     * `from` is where the answer comes from.
     */
    /** 'recordOnly' is the task's own entry; 'send' is a dialog or banner the user agrees in to send. */
    agreeOnly: async (agreedFor: string, model = 'gemini-test', from: 'here' | 'remote' = 'here', shownRevision?: number | null, providerId: string | null = null, purpose: 'recordOnly' | 'send' = 'recordOnly',
      window: {
        /** What this window believes the host has on record: 'shown' is what the host reports now (the app), 'unsaid' is a window that does not say. */
        knows?: 'shown' | 'unsaid' | { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string };
        /** The permission menu: the mode being chosen, and the one the window shows the task in. */
        changing?: { to: string; from: string };
      } = {}) => {
      // By default the answer is about the registration the task's window shows right now.
      const shown = (await ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, id)) as
        { agyPermissionRevision?: number; agyPermissionAgreement?: { change: 'fromFullAccess' | 'fromUnsupported' | null; mode: string } | null } | null;
      const revision = shownRevision !== undefined ? shownRevision : shown?.agyPermissionRevision;
      const knows = window.knows ?? 'shown';
      const expected = knows === 'shown' ? shown?.agyPermissionAgreement : knows === 'unsaid' ? null : knows;
      const call = () => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', model, providerId, undefined, undefined, {
        agyPermissionAgreementOnly: true,
        ...(purpose === 'send' ? { agyPermissionAgreementForSend: true } : {}),
        ...(expected ? { agyPermissionAgreementExpected: expected } : {}),
        ...(window.changing ? { agyPermissionChangingTo: window.changing.to, agyPermissionChangingFrom: window.changing.from } : {}),
        ...(typeof revision === 'number' ? { agyPermissionRevision: revision } : {}),
        agyPermissionAgreement: { change: agySwitchPermissionChange(agreedFor), mode: permissionModeAfterSwitchToAgy(agreedFor) },
      });
      return from === 'remote'
        ? runDeviceLinkInvokeContext({ controllerDeviceId: 'controller-1', channel: MAKER_INVOKE.SWITCH_SESSION_AGENT }, call)
        : call();
    },
    pickOtherGeminiModel: () => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', 'gemini-other', null),
    shownRevision: async () =>
      ((await ipc.invoke(MAKER_INVOKE.GET_SESSION_AGENT_SWITCH_INTENT, id)) as { agyPermissionRevision?: number } | null)?.agyPermissionRevision,
    /** As register.ts wires the schedule's restore: the refused switch becomes a pending one. */
    hold: (route: Pick<ScheduledModelSelection, 'model' | 'providerId'> & Partial<Pick<ScheduledModelSelection, 'effort' | 'fastMode' | 'agentDeviceId'>>,
      currentAgentDeviceId?: string | null) => holdAgySwitchForConfirmation(switchDeps, id, route, currentAgentDeviceId),
    hasPendingSwitch: () => !!switchDeps.pendingSwitches?.get(id),
    /** The host's own record, with what the windows are not told (where the switch came from). */
    pendingRecord: () => switchDeps.pendingSwitches?.get(id),
    hostRevision: () => switchDeps.pendingSwitches?.revision?.(id),
    pickGeminiModelOfProvider: (providerId: string) => ipc.invoke(MAKER_INVOKE.SWITCH_SESSION_AGENT, id, 'agy', 'gemini-test', providerId),
    onLanded: (fn: () => void) => { hooks.landed = fn; },
    onRestoreSettled: (fn: () => void) => { hooks.restoreSettled = fn; },
    /** As register.ts wires it: the apply step waits for the saved model of an applied restore to be retired. */
    onRestoreLanded: (fn: () => Promise<void>) => { switchDeps.onScheduledRestoreLanded = fn; },
    /** How often the host was told "the pending switch has just been agreed to". */
    agreedSignals: () => agreed,
    /**
     * The model picker as register.ts wires it: a model of the engine the task runs on is not a
     * no-op that clears the pending switch, it registers a same-engine selection in its place
     * (applied by the next send). This is the path a real withdrawal takes.
     */
    wireModelPickerLikeTheApp: () => {
      switchDeps.selectSameAgentModel = async (sessionId, intent, applyNow) => {
        if (applyNow) { switchDeps.pendingSwitches?.clear(sessionId); return { deferred: false }; }
        switchDeps.pendingSwitches?.set(sessionId, { ...intent, sameAgentSelection: true });
        return { deferred: true, superseded: false };
      };
    },
    /** The app is quit and started again: pending switches are memory only; the store is not. */
    restartHost: () => { switchDeps.pendingSwitches = newRegistry(); },
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

  // QQ's ruling on the desktop entry: a message refused on its way in from IM is not kept by
  // the host; its sender is told to confirm in the task and send again. The task therefore has to
  // say that its pending switch still waits (the host reports no agreement with the switch), and
  // confirming there must record the agreement and do nothing else: no switch, no launch, nothing
  // sent. The message goes out when it is sent again, once. `send` here is the step every
  // host-dispatched message takes; the IM runner's own reply is in turnRunnerCompanionRouting.test.ts.
  it('refuses a host-dispatched message, records the agreement from the task without dispatching, and delivers the message sent again', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy', agyPermissionAgreement: null });

    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ switched: false, agyPermissionAgreementRecorded: true });
    expect(h.log).toEqual([]);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.state.live).toBeNull();
    await expect(h.pendingSwitch()).resolves.toMatchObject({
      targetAgentKind: 'agy', model: 'gemini-test', agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' },
    });

    await h.send();
    await h.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
    await expect(h.pendingSwitch()).resolves.toBeNull();
  });

  it('leaves everything as it was when the task\'s entry is not confirmed', async () => {
    const h = fixture('acceptEdits');
    await h.pickGeminiModel(null);
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    // Declining sends nothing to the host. The switch still waits, and so does the entry.
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy', agyPermissionAgreement: null });
    expect(h.log).toEqual([]);
  });

  it.each([
    ['withdrawn', (h: ReturnType<typeof fixture>) => h.withdrawSwitch(), null],
    ['replaced by another model', (h: ReturnType<typeof fixture>) => h.pickOtherGeminiModel(), 'gemini-other'],
  ] as const)('does not let an answer about a switch since %s authorize anything', async (_name, change, pendingModel) => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    await change(h);
    // The dialog was opened for the earlier switch and is answered now.
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    if (pendingModel) {
      await expect(h.pendingSwitch()).resolves.toMatchObject({ model: pendingModel, agyPermissionAgreement: null });
      await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    } else {
      await expect(h.pendingSwitch()).resolves.toBeNull();
      await h.send();
    }
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    expect(h.log).toEqual([]);
  });

  // QQ after reading 8f6e1b2d: the answer was matched to the pending switch by target, model and
  // provider. Withdraw the switch and register the very same one again, and a dialog opened
  // before the withdrawal could still authorize the new registration. The host now stamps every
  // registration with a revision that is never reused in a session, the window sends back the one
  // it showed, and the host checks it where the agreement is written. All the confirmation
  // entries (send, permission change, held message, the task's entry) answer through this option.
  it('does not let an answer from before a withdrawal authorize the identical switch registered after it', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    const shownBefore = await h.shownRevision();
    await h.withdrawSwitch();
    await h.pickGeminiModel(null);
    const shownNow = await h.shownRevision();
    expect(shownBefore).toBeTypeOf('number');
    expect(shownNow).not.toBe(shownBefore);

    // The old dialog is answered now: same task, same engine, same model, same provider.
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', shownBefore))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    // An answer that names no registration at all is no better.
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', null))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreement: null, agyPermissionRevision: shownNow });
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(h.log).toEqual([]);

    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', shownNow))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    await h.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
  });

  // DD 7080449825 (the rest of blocker 2) and QQ's ruling on it. After a scheduled run with its own
  // model, the next send puts the user's model back. When that is a switch into Antigravity which
  // would change the task's permissions, the host refuses it, and it did so again on every later
  // send with no switch pending that anyone could confirm: the task was stuck.
  // The refused restore now becomes a pending switch without agreement. The saved model stays on
  // record (it is what the task shows as its model, and it survives a restart) until the user
  // confirms, withdraws, or picks something else; while the switch is pending the restore is not
  // attempted again; after a restart nothing agreed earlier counts.
  // The scope, the registry and both handlers are real; the store and the runtime are stand-ins.
  // Retiring the saved model is the host's updateScheduledPreference(null), stood in for here.
  function scheduleReplacedTheModel(h: ReturnType<typeof fixture>, currentAgentDeviceId: string | null = null) {
    const usersModel: ScheduledModelSelection = { agentKind: 'agy', model: 'gemini-test', providerId: null, effort: null, fastMode: false, agentDeviceId: null };
    let profile: ScheduledModelSelection = usersModel;
    const saved = { baseline: null as string | null, retiredBy: [] as string[] };
    const restores: string[] = [];
    h.onLanded(() => { saved.retiredBy.push('landed as the user\'s own pick'); });
    // Retiring is a read and a conditional write in the store, each a step later, as in the app:
    // it clears the saved model it read, if that is still the one there.
    const retire = async (by: string) => {
      await Promise.resolve();
      const read = saved.baseline;
      await Promise.resolve();
      if (saved.baseline === read) saved.baseline = null;
      saved.retiredBy.push(by);
    };
    // Replaced or withdrawn: not waited for by whatever replaced it.
    h.onRestoreSettled(() => { void retire('settled'); });
    // Applied: the apply step waits.
    h.onRestoreLanded(() => retire('applied'));
    const scope = createScheduledModelScope({
      createId: () => 'scope-1',
      read: async () => ({ profile: { ...profile, effort: profile.effort ?? '' }, baseline: saved.baseline }),
      write: async (_id, value) => { saved.baseline = value ? JSON.stringify(value) : null; },
      isBusy: () => false,
      apply: async (_id, target) => {
        restores.push(target.model);
        await h.switchFromHost({ applyNow: true, configStaged: true, model: target.model });
      },
      holdBaselineForConfirmation: (_id, target, current) => target.agentKind === 'agy' && h.hold(target, current.agentDeviceId),
      baselineAwaitsPendingSwitch: (_id, target) => target.agentKind === 'agy' && h.hasPendingSwitch(),
    });
    return {
      saved, restores,
      begin: async () => {
        await scope.begin(h.id);
        profile = { agentKind: 'claude-code', model: 'claude-test', providerId: null, effort: null, fastMode: false, agentDeviceId: currentAgentDeviceId };
      },
      /** The task is back on the user's model (the restore was applied). */
      backOnTheUsersModel: () => { profile = usersModel; },
      /** The send step, in the order register.ts runs it. */
      send: async () => { await scope.restore(h.id); await h.send(); },
    };
  }
  const HELD = { code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' };

  it('keeps the model a schedule replaced on record while its refused restore waits, across a restart, and applies it once when the user confirms', async () => {
    const h = fixture('bypassPermissions');
    const s = scheduleReplacedTheModel(h);
    await s.begin();

    await expect(s.send()).rejects.toMatchObject(HELD);
    expect(JSON.parse(s.saved.baseline!)).toMatchObject({ agentKind: 'agy', model: 'gemini-test', agentDeviceId: null });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy', model: 'gemini-test', agyPermissionAgreement: null });
    // Waiting: the restore is not tried again and nothing is registered again.
    const registered = await h.shownRevision();
    await expect(s.send()).rejects.toMatchObject(HELD);
    await expect(s.send()).rejects.toMatchObject(HELD);
    expect(s.restores).toEqual(['gemini-test']);
    expect(await h.shownRevision()).toBe(registered);

    // The user agrees, and the app is restarted before any message is sent.
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    h.restartHost();
    await expect(h.pendingSwitch()).resolves.toBeNull();
    expect(JSON.parse(s.saved.baseline!)).toMatchObject({ agentKind: 'agy', model: 'gemini-test' });
    // Still refused, still nothing sent anywhere; the same model is held again, with no agreement.
    await expect(s.send()).rejects.toMatchObject(HELD);
    await expect(h.pendingSwitch()).resolves.toMatchObject({ model: 'gemini-test', agyPermissionAgreement: null });
    expect(s.restores).toEqual(['gemini-test', 'gemini-test']);
    expect(h.log).toEqual([]);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });

    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    await s.send();
    await s.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
    // Retired because its question was answered, not by being counted as a pick of the user's:
    // putting the user's model back must not detach an IM task from the route it follows (item 4).
    await settle();
    expect(s.saved).toMatchObject({ baseline: null, retiredBy: ['applied'] });
    expect(s.restores).toEqual(['gemini-test', 'gemini-test']);
  });

  // DD 7085158660, item 2. The saved model of an applied restore was retired by the registry's
  // callback, which nothing waits for. A schedule firing next applies the pending restore and
  // then reads the saved model to decide whether to save the task's model anew: it read the old
  // one, kept it, and the late clear then deleted it. After that run nothing was on record to go
  // back to, and the task stayed on the schedule's model. The apply step now waits for the clear.
  it('retires the saved model of an applied restore before the schedule that fires next reads it, so that run can save the model again', async () => {
    const h = fixture('bypassPermissions');
    const s = scheduleReplacedTheModel(h);
    await s.begin();
    await expect(s.send()).rejects.toMatchObject(HELD);
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });

    // The next scheduled run, in the order register.ts runs it: apply what is pending, then begin.
    await h.send();
    expect(h.row).toMatchObject({ agentKind: 'agy', model: 'gemini-test' });
    expect(s.saved).toMatchObject({ baseline: null, retiredBy: ['applied'] });
    s.backOnTheUsersModel();
    await s.begin();
    await settle();
    // What this run saved is still there to go back to, and nothing retired it a second time.
    expect(JSON.parse(s.saved.baseline!)).toMatchObject({ agentKind: 'agy', model: 'gemini-test' });
    expect(s.saved.retiredBy).toEqual(['applied']);
  });

  // DD 7083915988, item 3. In the app the model picker does not reach the handler's "clear the
  // pending switch" branch: a model of the current engine is registered as a same-engine selection
  // that the next send applies. The saved model used to be retired only then, so a restart between
  // the withdrawal and the next send brought the refused restore, and its question, back. It is
  // retired the moment the held switch is replaced, whichever way that happens.
  it.each([
    ['the model picker, as the app wires it', true],
    ['the handler\'s own same-engine branch', false],
  ])('does not put the model back once the user withdraws the held restore through %s, not even when the app restarts before the next send', async (_name, likeTheApp) => {
    const h = fixture('bypassPermissions');
    if (likeTheApp) h.wireModelPickerLikeTheApp();
    const s = scheduleReplacedTheModel(h);
    await s.begin();
    await expect(s.send()).rejects.toMatchObject(HELD);

    // Picking a model of the engine the task runs on: it stays there, with its permissions.
    await h.withdrawSwitch();
    expect(s.saved).toMatchObject({ baseline: null, retiredBy: ['settled'] });
    // Restarted before anything is sent: nothing is left to put back.
    h.restartHost();
    await s.send();
    await s.send();
    expect(h.log).toEqual([]);
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'bypassPermissions' });
    await expect(h.pendingSwitch()).resolves.toBeNull();
    expect(s.restores).toEqual(['gemini-test']);
  });

  it('retires the saved model as well when the user picks another Gemini model instead of the held one', async () => {
    const h = fixture('bypassPermissions');
    const s = scheduleReplacedTheModel(h);
    await s.begin();
    await expect(s.send()).rejects.toMatchObject(HELD);
    await h.pickOtherGeminiModel();
    expect(s.saved).toMatchObject({ baseline: null, retiredBy: ['settled'] });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ model: 'gemini-other', agyPermissionAgreement: null });
  });

  // DD 7083915988, items 1 and 2. The host is told whenever the pending switch has just been
  // agreed to, so that it can let the message held for it go on: when the agreement is recorded
  // for a switch already pending, and when a switch is registered with its agreement (the model
  // picker). A registration that carries no agreement is not such a moment.
  //
  // JJ 7084937114: the task's own entry tells the user that confirming sends no message, and it
  // recorded its agreement through the same request, so the host let a held message go on it
  // too. The request now says whether the user agreed in order to send. The entry does not: its
  // agreement is recorded, reported to the windows as one that sends nothing, and gives no signal.
  // Neither does a later pick that only carries that agreement over.
  it('tells the host when the pending switch has just been agreed to for a send, and not when the task entry records an agreement', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    expect(h.agreedSignals()).toBe(0);
    await h.agreeOnly('bypassPermissions', 'gemini-test', 'remote', await h.shownRevision(), null, 'send');
    expect(h.agreedSignals()).toBe(0);

    // The task's entry.
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    expect(h.agreedSignals()).toBe(0);
    const recordedOnly = await h.pendingSwitch();
    expect(recordedOnly).toMatchObject({ agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' } });
    expect(recordedOnly).not.toHaveProperty('agyPermissionAgreementForSend');
    // Another Gemini model keeps the agreement, as what it was.
    await h.pickOtherGeminiModel();
    expect(h.agreedSignals()).toBe(0);
    expect(await h.pendingSwitch()).not.toHaveProperty('agyPermissionAgreementForSend');

    // The banner of a held message, or the dialog of a send.
    await h.agreeOnly('bypassPermissions', 'gemini-other', 'here', undefined, null, 'send');
    expect(h.agreedSignals()).toBe(1);
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreementForSend: true });
    // The entry recording the same thing afterwards takes nothing back and signals nothing.
    await h.agreeOnly('bypassPermissions', 'gemini-other');
    expect(h.agreedSignals()).toBe(1);
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreementForSend: true });

    // The model picker, agreed in its own dialog.
    await h.withdrawSwitch();
    await h.pickGeminiModel();
    expect(h.agreedSignals()).toBe(2);
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreementForSend: true });
  });

  // Where it goes back to. Antigravity runs only on the task's own computer, so a saved
  // Antigravity model was running there. If the schedule moved the task elsewhere, the held switch
  // says "back to the task's computer" rather than leaving the place to whatever is current; a
  // saved model that names another computer is not held at all, so nothing is defaulted to here.
  it('holds the restore for the place the saved model ran in', async () => {
    const moved = fixture('bypassPermissions');
    expect(moved.hold({ model: 'gemini-test', providerId: null, agentDeviceId: null }, 'device-2')).toBe(true);
    await expect(moved.pendingSwitch()).resolves.toMatchObject({ targetAgentKind: 'agy', agentDeviceId: null });

    const sameComputer = fixture('bypassPermissions');
    expect(sameComputer.hold({ model: 'gemini-test', providerId: null, agentDeviceId: null }, null)).toBe(true);
    expect(await sameComputer.pendingSwitch()).not.toHaveProperty('agentDeviceId');

    const elsewhere = fixture('bypassPermissions');
    expect(elsewhere.hold({ model: 'gemini-test', providerId: null, agentDeviceId: 'device-2' }, null)).toBe(false);
    await expect(elsewhere.pendingSwitch()).resolves.toBeNull();
  });

  // DD 7082445534, item 2. The agreement is written on the pending switch itself, under the task's
  // send lock. It used to be written outside the lock, on a copy that replaced the switch and
  // moved the host's revision: a withdrawal that had read the revision could then fail to clear
  // the switch, and the applied switch no longer recognised its own intent when it finished.
  it('writes the agreement on the pending switch itself, under the send lock, without making it another registration', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    const record = h.pendingRecord();
    const revision = h.hostRevision();

    let release!: () => void;
    const lockHeld = withSendToSessionLock(h.id, () => new Promise<void>((resolve) => { release = resolve; }));
    let answered = false;
    const answer = h.agreeOnly('bypassPermissions').then((result) => { answered = true; return result; });
    await settle();
    expect(answered).toBe(false);
    expect(h.pendingRecord()?.agyPermissionAgreement).toBeUndefined();
    release();
    await lockHeld;
    await expect(answer).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });

    expect(h.pendingRecord()).toBe(record);
    expect(h.hostRevision()).toBe(revision);
    await expect(h.pendingSwitch()).resolves.toMatchObject({
      agyPermissionAgreement: { change: 'fromFullAccess', mode: 'auto' }, agyPermissionRevision: revision,
    });
    // A withdrawal still clears it: nothing made it "another selection".
    await h.withdrawSwitch();
    await expect(h.pendingSwitch()).resolves.toBeNull();
    await h.send();
    expect(h.log).toEqual([]);
  });

  // DD's review of e4dff8f7 asked for this and 7082445534 (item 4) asked again: recording the
  // agreement must not rewrite where the switch came from. A switch staged by configuration, or
  // requested by an agent, that came back as "the user's own pick" would detach the task from what
  // it follows. The windows are told that it was staged (item 5); the agent source stays host-only.
  it.each([
    ['staged by configuration', { configStaged: true, effort: 'high', fastMode: true }, { configStaged: true, effort: 'high', fastMode: true }, true],
    ['requested by an agent', { runtimeSource: 'agent', effort: 'low' }, { runtimeSource: 'agent', effort: 'low' }, false],
  ] as const)('keeps a switch %s what it was after its agreement is recorded', async (_name, extra, kept, reportedAsStaged) => {
    const h = fixture('bypassPermissions');
    await h.switchFromHost({ ...extra });
    await expect(h.pendingSwitch()).resolves.toMatchObject(reportedAsStaged ? { configStaged: true } : { targetAgentKind: 'agy' });
    if (!reportedAsStaged) expect(await h.pendingSwitch()).not.toHaveProperty('configStaged');
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    expect(h.pendingRecord()).toMatchObject({ ...kept, targetAgentKind: 'agy', model: 'gemini-test' });
    await h.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
  });

  it('keeps the place a held switch goes back to after its agreement is recorded', async () => {
    const h = fixture('bypassPermissions');
    h.hold({ model: 'gemini-test', providerId: null, agentDeviceId: null }, 'device-2');
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    expect(h.pendingRecord()).toMatchObject({ targetAgentDeviceId: null, restoresScheduledBaseline: true });
  });

  // Item 6: an answer names the switch by its provider too.
  it('does not record an answer that names another provider than the pending switch has', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModelOfProvider('antigravity');
    const revision = await h.shownRevision();
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', revision, null)).resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', revision, 'another-provider')).resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ providerId: 'antigravity', agyPermissionAgreement: null });
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', revision, 'antigravity')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
  });

  // QQ's ruling on point e, the host's side. An agreement recorded from one window of this
  // computer stands for the task: a message sent from another window, which asked nothing and
  // sends no agreement of its own, is applied by the host's own record, once. The record is for
  // one change: once the stored mode makes it another change, the same send is refused again,
  // and a remote controller can add nothing to it.
  // DD 7085158660, item 5, on the host (QQ, 2026-11-22: "the host must keep a stale answer from
  // replacing a valid agreement; it cannot be left to an up-to-date window"). The record is
  // written under the task's lock and only when the answer is about a mode the host can name and,
  // if it would replace a different agreement, when the caller shows it knew that one.
  // Two windows are two callers of the real handler; nothing here is an attack, only what an
  // older window, or one that read before a change, sends.
  it('refuses an answer that would replace a different agreement the sender had not seen, and wakes nothing for it', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    // Window B: the user agrees, for a send. That is the host's record now.
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'here', undefined, null, 'send'))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    expect(h.agreedSignals()).toBe(1);
    const valid = { change: 'fromFullAccess', mode: 'auto' };

    // Window A still holds an answer about the mode the task was in before (plan). It asks to
    // wake a held message too. An older window says nothing of what it knew; one that read
    // before B's answer says "nothing was agreed"; neither replaces the record.
    for (const knows of ['unsaid', { change: 'fromUnsupported', mode: 'ask' }] as const) {
      await expect(h.agreeOnly('plan', 'gemini-test', 'here', undefined, null, 'send', { knows }))
        .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    }
    // Nor does an answer about another mode from a window that did see the record.
    await expect(h.agreeOnly('plan', 'gemini-test', 'here', undefined, null, 'send'))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreement: valid, agyPermissionAgreementForSend: true });
    expect(h.agreedSignals()).toBe(1);

    // The record still does what it was given for.
    await h.send();
    expect(h.log).toEqual(['switched agy auto', 'launch agy auto isolated']);
  });

  it('takes the agreement of a change of mode the user confirms, for the new mode, only while the task is still in the mode they saw', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });

    // The permission menu, as the app orders it: agree first, then store the new mode.
    await expect(h.agreeOnly('acceptEdits', 'gemini-test', 'here', undefined, null, 'recordOnly',
      { changing: { to: 'acceptEdits', from: 'bypassPermissions' } })).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreement: { change: 'fromUnsupported', mode: 'ask' } });
    expect(h.agreedSignals()).toBe(0);
    await h.setPermission('acceptEdits');
    await h.send();
    expect(h.log).toEqual(['saved acceptEdits', 'switched agy ask', 'launch agy ask isolated']);

    // Another window confirms a change it started from a mode the task has since left.
    const moved = fixture('bypassPermissions');
    await moved.pickGeminiModel(null);
    await moved.setPermission('acceptEdits');
    await expect(moved.agreeOnly('plan', 'gemini-test', 'here', undefined, null, 'recordOnly',
      { changing: { to: 'plan', from: 'bypassPermissions' } })).resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    // And an answer that names a new mode without saying which mode it started from is about
    // the stored mode like any other, which it does not fit.
    await expect(moved.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(moved.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreement: null });
    await expect(moved.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(moved.agreedSignals()).toBe(0);
  });

  it('applies a send from a window that asked nothing on the agreement another window recorded, and refuses again once it no longer fits', async () => {
    const reused = fixture('bypassPermissions');
    await reused.pickGeminiModel(null);
    await expect(reused.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    // The other window: registers nothing, agrees to nothing, just sends.
    await reused.send();
    await reused.send();
    expect(reused.log).toEqual(['switched agy auto', 'launch agy auto isolated']);

    const expired = fixture('bypassPermissions');
    await expired.pickGeminiModel(null);
    await expect(expired.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    await expired.setPermission('acceptEdits');
    await expect(expired.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    await expect(expired.agreeOnly('acceptEdits', 'gemini-test', 'remote', await expired.shownRevision()))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(expired.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(expired.log).toEqual(['saved acceptEdits']);
    await expect(expired.agreeOnly('acceptEdits')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    await expired.send();
    expect(expired.log).toEqual(['saved acceptEdits', 'switched agy ask', 'launch agy ask isolated']);
  });

  it('records an agreement only for the stored mode it was given for, and not from a remote controller', async () => {
    const h = fixture('bypassPermissions');
    await h.pickGeminiModel(null);
    // Everything about the answer is right (the registration, the model, the agreement); it is
    // refused for one reason only, that it comes from another computer.
    await expect(h.agreeOnly('bypassPermissions', 'gemini-test', 'remote', await h.shownRevision()))
      .resolves.toMatchObject({ agyPermissionAgreementRecorded: false });
    await expect(h.pendingSwitch()).resolves.toMatchObject({ agyPermissionAgreement: null });
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });

    await expect(h.agreeOnly('bypassPermissions')).resolves.toMatchObject({ agyPermissionAgreementRecorded: true });
    // The mode is changed again before the message is sent again: what was agreed no longer fits.
    await h.setPermission('acceptEdits');
    await expect(h.send()).rejects.toMatchObject({ code: 'AGENT_SWITCH_PERMISSION_UNCONFIRMED' });
    expect(h.row).toMatchObject({ agentKind: 'cc', permissionMode: 'acceptEdits' });
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
