import type { AgentEvent, Session } from '@cindy/maker-core';

import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordModelTurnUsage } from '../usageBroadcaster.js';

export interface RecordSessionAgyTurnUsageDeps {
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
}

/**
 * Antigravity (agy) turns in the usage history.
 *
 * The CLI reports tokens for a finished turn and nothing else: no cost, and no remaining
 * allowance of the Google Gemini subscription. So a turn is recorded as tokens only, under
 * the engine 'agy' and the model the task ran on; no amount is estimated.
 *
 * The engine's done event carries the turn total and the output tokens. The total already
 * includes cache reads, which the event does not report separately, so everything that is not
 * output is recorded as input.
 */
export function recordSessionAgyTurnUsage(
  deps: RecordSessionAgyTurnUsageDeps,
  session: Session,
  event: AgentEvent,
): void {
  if (event.type !== 'done' || session.agentKind !== 'agy') return;
  const modelPromise =
    deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
  deps.turnModelPromiseBySession.delete(session.id);
  const data = (event.data ?? {}) as { tokenUsage?: unknown; outputTokens?: unknown };
  const count = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const total = count(data.tokenUsage);
  if (total <= 0) return;
  const output = Math.min(count(data.outputTokens), total);
  void recordSessionTurnTokens(session.id, total);
  void (async () => {
    const model = await modelPromise.catch(() => '');
    if (!model) return;
    await recordModelTurnUsage({
      sessionId: session.id,
      agentKind: 'agy',
      model,
      inputTokensDelta: total - output,
      outputTokensDelta: output,
      cacheReadTokensDelta: 0,
      cacheCreateTokensDelta: 0,
    });
  })();
}
