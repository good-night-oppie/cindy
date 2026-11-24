import type { AgentKind } from '@cindy/maker-core';

import { beginTurnChangeSet, finalizeTurnChangeSet, waitForTurnChangeSetSeal } from './store.js';

/** The session fields the dispatch boundary reads. */
export interface TurnChangeSetDispatchSession {
  id: string;
  agentKind: AgentKind;
  workDir: string;
  remoteHostId: string | null;
}

/** Starts exact turn capture at the accepted, durable user-message boundary. */
export async function beginTurnChangeSetAtDispatch(
  session: TurnChangeSetDispatchSession,
  anchorClientId: string,
): Promise<void> {
  // Per-turn file capture is not integrated for Antigravity yet (the change-set store only knows
  // the three older engines). The task still runs; its file edits are just not recorded as a
  // reviewable change set (trial decision 2026-11-18, cindy#1). Close any open set and stop here.
  if (session.agentKind === 'agy') {
    await waitForTurnChangeSetSeal(session.id);
    await finalizeTurnChangeSet(session.id, null, 'partial');
    return;
  }
  await waitForTurnChangeSetSeal(session.id);
  await finalizeTurnChangeSet(session.id, null, 'partial');
  await waitForTurnChangeSetSeal(session.id);
  await beginTurnChangeSet({
    sessionId: session.id,
    anchorClientId,
    provider: session.agentKind,
    cwd: session.workDir,
    remote: session.remoteHostId !== null,
  });
}
