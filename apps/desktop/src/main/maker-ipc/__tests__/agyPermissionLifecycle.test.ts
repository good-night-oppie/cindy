import { describe, expect, it, vi } from 'vitest';
import { withAgyPermissionTransition, type PermissionTarget } from '../agyPermissionLifecycle';
import { withSendToSessionLock } from '../sendToSessionLock';

// cindy#19 (QQ 2026-11-22): a permission change used to decide "is this task Antigravity?" before
// taking the task's send lock, and took no lock at all when the answer was no. A send that applied
// an engine switch could then start Antigravity without isolation while the change saved a tighter
// mode. Existing cases start from a task that is already Antigravity; these start from a stale read.
// Unit tier: the real lock module, stand-ins for the runtime and the store.

type Stored = { agentKind: string; permissionMode: string };
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness(id: string, initial: Stored) {
  const stored = new Map<string, Stored>([[id, initial]]);
  const log: string[] = [];
  const state: { live: null | { agentKind: string; stablePermissionModeState: { mode: string }; isTurnRunning: () => boolean } } = { live: null };
  const launch = () => {
    const row = stored.get(id)!;
    state.live = { agentKind: row.agentKind, stablePermissionModeState: { mode: row.permissionMode }, isTurnRunning: () => false };
    log.push(`launch ${row.agentKind} ${row.permissionMode}`);
  };
  const staleTarget: PermissionTarget = { sessionId: id, agentKind: initial.agentKind, previousMode: initial.permissionMode };
  const change = (mode: string, runtime: Parameters<typeof withAgyPermissionTransition>[2], beforeSave?: Promise<void>) =>
    withAgyPermissionTransition([staleTarget], mode, runtime, async (fenced) => {
      await beforeSave;
      stored.set(id, { ...stored.get(id)!, permissionMode: mode });
      log.push(`saved ${mode} fenced=[${[...fenced]}]`);
      return 'saved' as const;
    }, 'linux', [], async () => stored);
  return { stored, log, state, launch, change };
}

describe('permission change racing an engine switch into Antigravity', () => {
  it.each([true, false])('send first: retires the Full access process the send started before saving a tighter mode (close ok: %s)', async (closeOk) => {
    const id = `send-first-${closeOk}`;
    const h = harness(id, { agentKind: 'cc', permissionMode: 'bypassPermissions' });
    const runtime = {
      getSession: () => h.state.live as never,
      closeSession: vi.fn(async () => {
        if (!closeOk) throw new Error('close failed');
        h.log.push('closed');
        h.state.live = null;
      }),
    };
    let finishSend!: () => void;
    const sendGate = new Promise<void>((resolve) => { finishSend = resolve; });
    const send = withSendToSessionLock(id, async () => {
      await sendGate;
      h.stored.set(id, { agentKind: 'agy', permissionMode: 'bypassPermissions' });
      h.launch();
    });
    await settle();
    const changed = h.change('ask', runtime);
    changed.catch(() => undefined);
    await settle();
    expect(h.log).toEqual([]);

    finishSend();
    await send;
    if (closeOk) {
      await expect(changed).resolves.toBe('saved');
      expect(h.log).toEqual(['launch agy bypassPermissions', 'closed', `saved ask fenced=[${id}]`]);
      expect(h.state.live).toBeNull();
    } else {
      await expect(changed).rejects.toThrow('close failed');
      expect(h.log).toEqual(['launch agy bypassPermissions']);
      expect(h.stored.get(id)!.permissionMode).toBe('bypassPermissions');
    }
  });

  it('permission change first: the send that switches the engine waits and launches with the saved mode', async () => {
    const id = 'change-first';
    const h = harness(id, { agentKind: 'cc', permissionMode: 'bypassPermissions' });
    const runtime = { getSession: () => h.state.live as never, closeSession: vi.fn(async () => {}) };
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => { finishSave = resolve; });
    const changed = h.change('ask', runtime, saveGate);
    await settle();
    const send = withSendToSessionLock(id, async () => {
      h.stored.set(id, { ...h.stored.get(id)!, agentKind: 'agy' });
      h.launch();
    });
    await settle();
    expect(h.log).toEqual([]);

    finishSave();
    await expect(changed).resolves.toBe('saved');
    await send;
    expect(h.log).toEqual(['saved ask fenced=[]', 'launch agy ask']);
    expect(runtime.closeSession).not.toHaveBeenCalled();
  });
});
