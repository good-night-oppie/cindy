import { agySwitchPermissionChange, permissionModeAfterSwitchToAgy } from '../../shared/agentKindConversion.js';

/**
 * What the user agreed a pending switch into Antigravity would do to the task's permission mode:
 * the change they were told about (null when the mode is kept) and the mode it ends in. The
 * composer records it when the user answers its dialog and sends it with the switch.
 */
export interface AgySwitchPermissionAgreement {
  change: 'fromFullAccess' | 'fromUnsupported' | null;
  mode: string;
}

export function parseAgySwitchPermissionAgreement(value: unknown): AgySwitchPermissionAgreement | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { change, mode } = value as { change?: unknown; mode?: unknown };
  if (change !== null && change !== 'fromFullAccess' && change !== 'fromUnsupported') return undefined;
  return typeof mode === 'string' && mode ? { change, mode } : undefined;
}

/**
 * Whether applying a pending switch into Antigravity now would rewrite the stored permission mode
 * in a way the user has not agreed to. A mode Antigravity keeps as it is never needs agreement.
 * Any entry can apply a pending switch (the composer, a queued message, IM, a schedule) and only
 * the composer can ask, so the host checks before it applies instead of trusting that it was asked.
 */
export function agySwitchPermissionIsUnconfirmed(
  storedPermissionMode: string | null | undefined, agreement: AgySwitchPermissionAgreement | undefined,
): boolean {
  const change = agySwitchPermissionChange(storedPermissionMode);
  if (!change) return false;
  return agreement?.change !== change || agreement.mode !== permissionModeAfterSwitchToAgy(storedPermissionMode);
}

export const AGENT_SWITCH_PERMISSION_UNCONFIRMED = 'AGENT_SWITCH_PERMISSION_UNCONFIRMED';

/** The pending switch was not applied and stays pending; the message must not be sent on either engine. */
export class AgentSwitchPermissionUnconfirmedError extends Error {
  readonly code = AGENT_SWITCH_PERMISSION_UNCONFIRMED;

  constructor() {
    super('The pending switch to Antigravity would change this task\'s permissions in a way that has not been confirmed. '
      + 'Confirm the change in the task, then send again.');
    this.name = 'AgentSwitchPermissionUnconfirmedError';
  }
}
