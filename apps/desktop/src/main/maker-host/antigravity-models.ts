import { ANTIGRAVITY_PROVIDER_ID, type ProviderModelDiscoveryFailureView, type ProviderView } from '@cindy/model-providers';

interface AntigravityModel {
  id: string;
  displayName: string;
  description?: string;
  contextWindow: number;
  efforts: readonly string[];
  defaultEffort: string | null;
}

interface AntigravityModelSource {
  /** Models the Antigravity CLI reported in its last ACP session; empty before the first probe. */
  read(): readonly AntigravityModel[];
  /** Starts the CLI once to read its model list. */
  probe(): Promise<void>;
  /** Tells windows the provider list changed. */
  changed(): void;
}

const PROBE_RETRY_MS = 60_000;
let source: AntigravityModelSource | null = null;
let pending: Promise<void> | null = null;
let failure: ProviderModelDiscoveryFailureView | undefined;

export function setAntigravityModelSource(next: AntigravityModelSource): void {
  source = next;
  pending = null;
  failure = undefined;
}

async function probe(current: AntigravityModelSource): Promise<void> {
  try {
    await current.probe();
    if (current === source) failure = current.read().length ? undefined : { kind: 'empty', at: new Date().toISOString() };
  } catch (error) {
    if (current !== source) return;
    const missingBwrap = error instanceof Error && error.name === 'AgySandboxUnavailableError'
      && 'reason' in error && error.reason === 'bwrap-missing';
    failure = { kind: missingBwrap ? 'bwrapMissing' : 'rejected', at: new Date().toISOString() };
  } finally {
    if (current === source) {
      pending = null;
      current.changed();
    }
  }
}

export async function retryAntigravityModels(): Promise<ProviderModelDiscoveryFailureView | null> {
  const current = source;
  if (current) await (pending ??= Promise.resolve().then(() => probe(current)));
  return failure ?? null;
}

/**
 * The Google Gemini subscription provider has no model list of its own: its models only exist in
 * the Antigravity CLI. Once the provider is connected, attach the CLI's list so every reader of
 * the provider list (model picker, draft validation, settings) sees the same models. The first
 * read starts one probe and publishes a provider change when it lands.
 */
export function attachAntigravityModels(provider: ProviderView): ProviderView {
  if (provider.id !== ANTIGRAVITY_PROVIDER_ID || !provider.connected || !source) return provider;
  const models = source.read();
  if (!models.length) {
    if (!pending && (!failure || (failure.kind !== 'bwrapMissing' && Date.now() - Date.parse(failure.at) > PROBE_RETRY_MS))) {
      void retryAntigravityModels();
    }
    return failure ? { ...provider, modelDiscoveryFailure: failure } : provider;
  }
  return {
    ...provider,
    models: {
      ...provider.models,
      agy: models.map((m) => ({
        id: m.id,
        name: m.displayName,
        ...(m.description ? { description: m.description } : {}),
        mode: 'chat',
        contextWindow: m.contextWindow,
        efforts: [...m.efforts] as never,
        defaultEffort: m.defaultEffort as never,
      })),
    },
  } as ProviderView;
}
