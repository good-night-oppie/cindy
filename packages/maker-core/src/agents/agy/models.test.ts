import { describe, expect, it } from 'vitest';
import { readAgyCatalog, readFamilyEfforts } from './models.js';
import { compareVersions, parseAgyVersion } from './version.js';
import { resolveAgyStallTimeoutMs, AGY_DEFAULT_STALL_TIMEOUT_MS } from './watchdog.js';

describe('agy catalog', () => {
  const families = ['gemini-4-hydrogen', 'gemini-pro-orchestrator', 'gemini-pro-orchestrator-argon', 'gpt-oss-120b-medium'];
  it('derives per-family efforts from `<family>-<effort>` model ids without misreading longer families', () => {
    const efforts = readFamilyEfforts({ availableModels: [
      { modelId: 'gemini-4-hydrogen-high' }, { modelId: 'gemini-4-hydrogen-xhigh' }, { modelId: 'gemini-4-hydrogen-low' },
      { modelId: 'gemini-pro-orchestrator' }, { modelId: 'gemini-pro-orchestrator-argon' }, { modelId: 'gpt-oss-120b-medium' },
    ] }, families);
    expect(efforts.get('gemini-4-hydrogen')).toEqual(['low', 'high', 'xhigh']);
    expect(efforts.get('gemini-pro-orchestrator')).toEqual([]);
    expect(efforts.get('gemini-pro-orchestrator-argon')).toEqual([]);
    expect(efforts.get('gpt-oss-120b-medium')).toEqual([]);
  });

  it('reads current model, effort and mode from configOptions receipts', () => {
    const catalog = readAgyCatalog({ configOptions: [
      { id: 'model', currentValue: 'gpt-oss-120b-medium', options: [{ value: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' }] },
      { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'plan' }] },
    ] });
    expect(catalog.currentModel).toBe('gpt-oss-120b-medium');
    expect(catalog.currentEffort).toBeUndefined();
    expect(catalog.currentEfforts).toEqual([]);
    expect(catalog.modes).toEqual(['default', 'plan']);
    expect(catalog.models[0]).toMatchObject({ id: 'gpt-oss-120b-medium', efforts: [], defaultEffort: null, contextWindow: 0 });
  });
});

describe('agy version gate', () => {
  it('parses `agy --version` output and compares semver triples', () => {
    expect(parseAgyVersion('1.5.9\n')).toEqual([1, 5, 9]);
    expect(parseAgyVersion('agy version 1.10.0')).toEqual([1, 10, 0]);
    expect(parseAgyVersion('dev')).toBeNull();
    expect(compareVersions([1, 0, 10], [1, 5, 0])).toBeLessThan(0);
    expect(compareVersions([1, 10, 0], [1, 5, 0])).toBeGreaterThan(0);
  });
});

describe('agy stall limit resolution', () => {
  it('uses the first valid candidate, clamps tiny values, treats 0 as disabled and ignores junk', () => {
    expect(resolveAgyStallTimeoutMs(undefined, undefined)).toBe(AGY_DEFAULT_STALL_TIMEOUT_MS);
    expect(resolveAgyStallTimeoutMs(120_000, 60_000)).toBe(120_000);
    expect(resolveAgyStallTimeoutMs('abc', 60_000)).toBe(60_000);
    expect(resolveAgyStallTimeoutMs(5)).toBe(10_000);
    expect(resolveAgyStallTimeoutMs(0, 60_000)).toBe(0);
    expect(resolveAgyStallTimeoutMs(-1, '90000')).toBe(90_000);
  });
});
