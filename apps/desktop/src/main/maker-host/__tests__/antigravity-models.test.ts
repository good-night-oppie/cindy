import { ANTIGRAVITY_PROVIDER_ID, BUILTIN_PROVIDERS, type ProviderView } from '@cindy/model-providers';
import { afterEach, expect, it, vi } from 'vitest';
import { attachAntigravityModels, probeAntigravityModelsIfNeeded, retryAntigravityModels, setAntigravityModelSource } from '../antigravity-models';

const provider: ProviderView = {
  ...BUILTIN_PROVIDERS.find(item => item.id === ANTIGRAVITY_PROVIDER_ID)!,
  connected: true,
};
const model = { id: 'fixture', displayName: 'Fixture', contextWindow: 1000, efforts: [], defaultEffort: null };

afterEach(() => vi.useRealTimers());

it.each([
  ['AgySandboxUnavailableError', 'bwrap-missing', 'bwrapMissing'],
  ['AgySandboxUnavailableError', 'bwrap-blocked', 'sandboxBlocked'],
  ['AgySandboxUnavailableError', 'network-isolation-missing', 'networkIsolationUnavailable'],
  ['AgySandboxUnavailableError', 'task-dir-unsafe', 'unsafeTaskDir'],
  ['AgySandboxUnavailableError', 'unsupported-platform', 'sandboxUnsupported'],
  ['AgyBinaryUnavailableError', 'agy_binary_missing', 'agyCliUnavailable'],
])('reports a persistent %s (%s) once, then recovers after explicit retry', async (name, reason, expectedKind) => {
  vi.useFakeTimers();
  const models: typeof model[] = [];
  const changed = vi.fn();
  const probe = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(Object.assign(new Error('host detail'), {
      name, reason,
    }))
    .mockImplementationOnce(async () => { models.push(model); });
  setAntigravityModelSource({ read: () => models, changed, probe });

  attachAntigravityModels(provider);
  attachAntigravityModels(provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(attachAntigravityModels(provider).modelDiscoveryFailure).toEqual({
    kind: expectedKind, at: new Date().toISOString(),
  });

  await vi.advanceTimersByTimeAsync(120_000);
  expect((await probeAntigravityModelsIfNeeded())?.kind).toBe(expectedKind);
  attachAntigravityModels(provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(await Promise.all([retryAntigravityModels(), retryAntigravityModels()])).toEqual([null, null]);
  expect(probe).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenCalledTimes(2);
  const recovered = attachAntigravityModels(provider);
  expect(recovered.modelDiscoveryFailure).toBeUndefined();
  expect(recovered.models.agy).toMatchObject([{ id: 'fixture', name: 'Fixture' }]);
});

it('allows another automatic probe after a temporary failure', async () => {
  vi.useFakeTimers();
  const probe = vi.fn().mockRejectedValue(new Error('temporary failure'));
  setAntigravityModelSource({ read: () => [], changed: vi.fn(), probe });
  attachAntigravityModels(provider);
  await vi.advanceTimersByTimeAsync(60_001);
  expect(attachAntigravityModels(provider).modelDiscoveryFailure?.kind).toBe('agyProbeFailed');
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(2);
});

it('preserves a rejection reported by ACP', async () => {
  const probe = vi.fn().mockRejectedValue(Object.assign(new Error('Rejected'), { name: 'AcpRpcError', code: -32603 }));
  setAntigravityModelSource({ read: () => [], changed: vi.fn(), probe });
  expect((await probeAntigravityModelsIfNeeded())?.kind).toBe('rejected');
});
