import type { Maker } from '@cindy/maker-core';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { withSessionRestartLock } from './sendToSessionLock.js';

export interface PermissionTarget {
  sessionId: string;
  agentKind?: string | null;
  previousMode?: string | null;
}

type Runtime = Pick<Maker, 'getSession' | 'closeSession'> & Partial<Pick<Maker, 'closeSessionIfCurrent'>>;

/** Hold every affected lane through exit confirmation and the single database commit. */
export async function withAgyPermissionTransition<T>(
  targets: readonly PermissionTarget[], nextMode: string, maker: Runtime | null | undefined,
  commit: (fencedIds: ReadonlySet<string>) => Promise<T>, platform = process.platform, modelFollowers: readonly string[] = [],
): Promise<T> {
  const owner = getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    if (owner !== getCurrentDbClientSnapshot()) throw new Error('Account changed during permission update');
  };
  const ids = new Set<string>();
  if (platform === 'linux' && maker) {
    for (const target of targets) {
      const live = maker.getSession(target.sessionId);
      if ((live?.agentKind ?? target.agentKind) !== 'agy') continue;
      const full = nextMode === 'bypassPermissions';
      const savedCrosses = (target.previousMode === 'bypassPermissions') !== full;
      const liveMode = live?.stablePermissionModeState?.mode;
      if (savedCrosses || (live && (!liveMode || (liveMode === 'bypassPermissions') !== full))) {
        ids.add(target.sessionId);
      }
    }
  }
  // A combined model/profile edit must take its model send locks in the same global order.
  const locks = ids.size ? new Set([...ids, ...modelFollowers]) : ids;
  const ordered = [...locks].sort();
  async function transition(index: number): Promise<T> {
    assertCurrent();
    if (index < ordered.length) {
      return withSessionRestartLock(ordered[index]!, () => transition(index + 1));
    }
    // Every related send path is fenced before the first runtime is retired.
    for (const id of ids) {
      assertCurrent();
      const live = maker?.getSession(id);
      if (maker && live?.agentKind === 'agy') {
        if (live.isTurnRunning() && nextMode === 'bypassPermissions' && maker.closeSessionIfCurrent) {
          await maker.closeSessionIfCurrent(live, 'runtime-refresh', { afterCurrentTurn: true });
        } else {
          if (live.isTurnRunning()) await live.abort();
          await maker.closeSession(id, 'runtime-refresh');
        }
      }
    }
    assertCurrent();
    return commit(locks);
  }
  return transition(0);
}
