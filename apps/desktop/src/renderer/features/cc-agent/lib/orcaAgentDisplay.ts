export type OrcaDisplayAgentKind = 'claude-code' | 'codex' | 'pi' | 'agy';
export type OrcaDisplayVendor = 'cc' | 'codex' | 'pi' | 'agy';

export function normalizeOrcaDisplayAgentKind(agentKind: unknown): OrcaDisplayAgentKind {
  if (agentKind === 'codex') return 'codex';
  if (agentKind === 'pi') return 'pi';
  if (agentKind === 'agy') return 'agy';
  if (agentKind === 'cc' || agentKind === 'claude-code') return 'claude-code';
  return 'claude-code';
}

export function orcaAgentLabel(agentKind: OrcaDisplayAgentKind): string {
  return agentKind === 'codex' ? 'Codex' : agentKind === 'pi' ? 'Pi' : agentKind === 'agy' ? 'Antigravity' : 'Claude';
}

export function orcaVendorForAgentKind(agentKind: OrcaDisplayAgentKind): OrcaDisplayVendor {
  return agentKind === 'codex' ? 'codex' : agentKind === 'pi' ? 'pi' : agentKind === 'agy' ? 'agy' : 'cc';
}
