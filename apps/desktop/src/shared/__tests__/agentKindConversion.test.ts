import { describe, expect, it } from 'vitest';
import { dbToMakerAgentKind, isSessionSwitchTargetAgentKind, makerToDbAgentKind, normalizeDbAgentKind } from '../agentKindConversion';

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

describe('engines an existing task can switch to', () => {
  it('offers Antigravity only to a task that runs on this computer', () => {
    expect(isSessionSwitchTargetAgentKind('agy', true)).toBe(true);
    expect(isSessionSwitchTargetAgentKind('agy', false)).toBe(false);
  });
  it.each(['claude-code', 'codex', 'pi'] as const)('keeps %s a target wherever the task runs', kind => {
    expect(isSessionSwitchTargetAgentKind(kind, true)).toBe(true);
    expect(isSessionSwitchTargetAgentKind(kind, false)).toBe(true);
  });
  it('rejects values that are not engines', () => {
    expect(isSessionSwitchTargetAgentKind('orca', true)).toBe(false);
    expect(isSessionSwitchTargetAgentKind(undefined, true)).toBe(false);
  });
});
