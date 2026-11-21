import { ANTIGRAVITY_PROVIDER_ID, BUILTIN_PROVIDERS, type ProviderView } from '@cindy/model-providers';
import { afterEach, expect, it, vi } from 'vitest';
import { attachAntigravityModels, retryAntigravityModels, setAntigravityModelSource } from '../antigravity-models';

const provider: ProviderView = {
  ...BUILTIN_PROVIDERS.find(item => item.id === ANTIGRAVITY_PROVIDER_ID)!,
  connected: true,
};
const model = { id: 'fixture', displayName: 'Fixture', contextWindow: 1000, efforts: [], defaultEffort: null };

afterEach(() => vi.useRealTimers());

it('publishes a missing-bubblewrap hint once and waits for an explicit retry to load models', async () => {
  vi.useFakeTimers();
  const models: typeof model[] = [];
  const changed = vi.fn();
  const probe = vi.fn<() => Promise<void>>()
    .mockRejectedValueOnce(Object.assign(new Error('host detail'), {
      name: 'AgySandboxUnavailableError', reason: 'bwrap-missing',
    }))
    .mockImplementationOnce(async () => { models.push(model); });
  setAntigravityModelSource({ read: () => models, changed, probe });

  attachAntigravityModels(provider);
  attachAntigravityModels(provider);
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(attachAntigravityModels(provider).modelDiscoveryFailure).toEqual({
    kind: 'bwrapMissing', at: new Date().toISOString(),
  });

  await vi.advanceTimersByTimeAsync(120_000);
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
  expect(attachAntigravityModels(provider).modelDiscoveryFailure?.kind).toBe('rejected');
  await vi.advanceTimersByTimeAsync(0);
  expect(probe).toHaveBeenCalledTimes(2);
});
