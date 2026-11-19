import { ANTIGRAVITY_PROVIDER_ID, type ProviderView } from '@cindy/model-providers';

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
let probing = false;
let lastFailedAt = 0;

export function setAntigravityModelSource(next: AntigravityModelSource): void {
  source = next;
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
    if (!probing && Date.now() - lastFailedAt > PROBE_RETRY_MS) {
      probing = true;
      const current = source;
      void current.probe()
        .then(() => { if (current.read().length) current.changed(); })
        .catch(() => { lastFailedAt = Date.now(); })
        .finally(() => { probing = false; });
    }
    return provider;
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
