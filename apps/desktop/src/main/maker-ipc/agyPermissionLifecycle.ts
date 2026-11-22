import type { Maker } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { withSendToSessionLock, withSessionRestartLock } from './sendToSessionLock.js';

export interface PermissionTarget {
  sessionId: string;
  agentKind?: string | null;
  previousMode?: string | null;
}

type Runtime = Pick<Maker, 'getSession' | 'closeSession'> & Partial<Pick<Maker, 'closeSessionIfCurrent'>>;
type StoredSelection = { agentKind?: string | null; permissionMode?: string | null };
/** The stored engine and mode of each task right now; `null` when the store cannot be read here. */
export type ReadStoredSelections = (sessionIds: readonly string[]) => Promise<ReadonlyMap<string, StoredSelection> | null>;

const readStoredSelections: ReadStoredSelections = async (sessionIds) => {
  const client = getCurrentDbClientSnapshot()?.client;
  if (!sessionIds.length || typeof client?.query !== 'function') return null;
  const rows = await client.query<{ sessionId: string } & StoredSelection>(
    `SELECT id AS sessionId, agent_kind AS agentKind, permission_mode AS permissionMode FROM sessions
    WHERE id IN (${sessionIds.map(() => '?').join(',')})`, [...sessionIds]);
  return new Map(rows.map(row => [row.sessionId, row]));
};

const sameIds = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  left.size === right.size && [...left].every(id => right.has(id));

/**
 * Hold every affected lane through exit confirmation and the single database commit.
 *
 * An engine switch, a task's first launch and a permission change all run under the task's send
 * lock. So this takes that lock for every target first, and only then reads the engine and mode
 * from the store and the runtime: a task that became Antigravity while this change was waiting
 * (an engine switch applied by a send) is seen as Antigravity, not as the engine it was leaving.
 */
export async function withAgyPermissionTransition<T>(
  targets: readonly PermissionTarget[], nextMode: string, maker: Runtime | null | undefined,
  commit: (fencedIds: ReadonlySet<string>) => Promise<T>, platform = process.platform, modelFollowers: readonly string[] = [],
  readStored: ReadStoredSelections = readStoredSelections,
): Promise<T> {
  const owner = getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    if (owner !== getCurrentDbClientSnapshot()) throw new Error('Account changed during permission update');
  };
  if (platform !== 'linux' || !maker) {
    assertCurrent();
    return commit(new Set());
  }
  const full = nextMode === 'bypassPermissions';
  const targetIds = [...new Set(targets.map(target => target.sessionId))];
  /** Antigravity lanes whose running process must exit before the new mode is committed. */
  const lanesToRetire = (stored: ReadonlyMap<string, StoredSelection> | null) => {
    const ids = new Set<string>();
    for (const target of targets) {
      const live = maker.getSession(target.sessionId);
      const row = stored?.get(target.sessionId);
      if ((live?.agentKind ?? (row ? row.agentKind : target.agentKind)) !== 'agy') continue;
      const savedMode = row ? row.permissionMode : target.previousMode;
      const savedCrosses = (savedMode === 'bypassPermissions') !== full;
      const liveMode = live?.stablePermissionModeState?.mode;
      if (savedCrosses || (live && (!liveMode || (liveMode === 'bypassPermissions') !== full))) {
        ids.add(target.sessionId);
      }
    }
    return ids;
  };
  // The guess decides only which kind of lock each lane gets (a restart fence rejects queued
  // sends, so it is kept to lanes that will be retired). The decision itself is made under the locks.
  let expected = lanesToRetire(null);
  for (let attempt = 0; attempt < 3; attempt++) {
    // A combined model/profile edit must take its model send locks in the same global order.
    const fenced: ReadonlySet<string> = expected.size ? new Set([...expected, ...modelFollowers]) : expected;
    const ordered = [...new Set([...targetIds, ...fenced])].sort();
    const outcome = await (async function transition(index: number): Promise<{ value: T } | { retry: Set<string> }> {
      assertCurrent();
      if (index < ordered.length) {
        const id = ordered[index]!;
        const next = () => transition(index + 1);
        return fenced.has(id) ? withSessionRestartLock(id, next) : withSendToSessionLock(id, next);
      }
      const stored = await readStored(targetIds);
      assertCurrent();
      const ids = lanesToRetire(stored);
      // A lane changed engine or mode while this change waited for its lock: take the locks again
      // with the right fences instead of retiring a lane that is not fenced.
      if (!sameIds(ids, expected)) return { retry: ids };
      // Every related send path is fenced before the first runtime is retired.
      for (const id of ids) {
        assertCurrent();
        const live = maker.getSession(id);
        if (live?.agentKind === 'agy') {
          if (live.isTurnRunning() && full && maker.closeSessionIfCurrent) {
            await maker.closeSessionIfCurrent(live, 'runtime-refresh', { afterCurrentTurn: true });
          } else {
            if (live.isTurnRunning()) await live.abort();
            await maker.closeSession(id, 'runtime-refresh');
          }
        }
      }
      assertCurrent();
      return { value: await commit(fenced) };
    })(0);
    if ('value' in outcome) return outcome.value;
    expected = outcome.retry;
  }
  throw new Error('The task kept changing during the permission update; try again');
}
