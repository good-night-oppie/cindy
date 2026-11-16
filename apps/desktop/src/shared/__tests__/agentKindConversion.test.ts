import { describe, expect, it } from 'vitest';
import { dbToMakerAgentKind, makerToDbAgentKind, normalizeDbAgentKind } from '../agentKindConversion';

// Native agy identity must survive DB/IPC conversion instead of becoming Claude.
// Existing callers used the three-engine fallback. Unit tier, no host or I/O.
describe('agent identity round trips', () => {
  it.each(['codex', 'pi', 'agy'] as const)('preserves %s through storage and wire normalization', kind => {
    expect(dbToMakerAgentKind(makerToDbAgentKind(kind))).toBe(kind);
    expect(normalizeDbAgentKind(kind)).toBe(kind);
  });
  it('preserves Claude storage spelling and historical missing-value defaults', () => {
    expect(makerToDbAgentKind('claude-code')).toBe('cc');
    expect(dbToMakerAgentKind('cc')).toBe('claude-code');
    expect(dbToMakerAgentKind(undefined)).toBe('claude-code');
    expect(normalizeDbAgentKind(undefined)).toBe('cc');
  });
});
