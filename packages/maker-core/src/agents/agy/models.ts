/**
 * Antigravity CLI (`agy acp`) session configuration, read only from ACP receipts.
 *
 * agy 1.5.x exposes three select config options on session/new and on every
 * session/set_config_option response:
 *   - `model`          family ids (e.g. `gemini-4-carbon`, `gpt-oss-120b-medium`)
 *   - `thought_level`  low/medium/high; absent when the current model has no effort
 *   - `mode`           default / accept-edits / auto / plan
 * The `models.availableModels` list carries `<family>-<effort>` ids, which is the
 * only per-family effort evidence agy gives without switching the model.
 */
import type { ModelDescriptor } from '../../types/capabilities.js';
import type { Effort } from '../../types/common.js';

export type AcpRecord = Record<string, unknown>;

export function record(value: unknown): AcpRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as AcpRecord : {};
}

export interface AgySelectOption {
  id: string;
  currentValue: string | undefined;
  values: Array<{ value: string; name: string; description?: string }>;
}

export const AGY_MODEL_CONFIG_ID = 'model';
export const AGY_EFFORT_CONFIG_ID = 'thought_level';
export const AGY_MODE_CONFIG_ID = 'mode';
/** Cindy never switches agy into a self-approving native mode; only `default` and `plan` are used. */
export const AGY_DEFAULT_MODE = 'default';
export const AGY_PLAN_MODE = 'plan';

const KNOWN_EFFORTS: readonly Effort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function isEffort(value: unknown): value is Effort {
  return typeof value === 'string' && (KNOWN_EFFORTS as readonly string[]).includes(value);
}

export function readSelectOption(configOptions: unknown, id: string): AgySelectOption | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  const raw = configOptions.map(record).find(option => option.id === id);
  if (!raw) return undefined;
  const values = (Array.isArray(raw.options) ? raw.options : []).map(record).flatMap(option =>
    typeof option.value === 'string'
      ? [{ value: option.value, name: typeof option.name === 'string' ? option.name : option.value,
        ...(typeof option.description === 'string' ? { description: option.description } : {}) }]
      : []);
  return { id, currentValue: typeof raw.currentValue === 'string' ? raw.currentValue : undefined, values };
}

/** Efforts per model family, from `<family>-<effort>` entries in `models.availableModels`. */
export function readFamilyEfforts(models: unknown, families: readonly string[]): Map<string, Effort[]> {
  const result = new Map<string, Effort[]>(families.map(family => [family, []]));
  const available = Array.isArray(record(models).availableModels) ? record(models).availableModels as unknown[] : [];
  // Longest family first, so `gemini-pro-orchestrator-argon` is never read as an effort of `gemini-pro-orchestrator`.
  const ordered = [...families].sort((a, b) => b.length - a.length);
  for (const item of available.map(record)) {
    if (typeof item.modelId !== 'string') continue;
    const family = ordered.find(candidate => item.modelId !== candidate && (item.modelId as string).startsWith(`${candidate}-`));
    if (!family) continue;
    const suffix = (item.modelId as string).slice(family.length + 1);
    if (isEffort(suffix) && !result.get(family)!.includes(suffix)) result.get(family)!.push(suffix);
  }
  for (const [family, efforts] of result) {
    result.set(family, KNOWN_EFFORTS.filter(effort => efforts.includes(effort)));
  }
  return result;
}

export interface AgyCatalog {
  models: ModelDescriptor[];
  currentModel: string | undefined;
  currentEffort: Effort | undefined;
  /** Effort values agy currently offers for the current model; empty when it has none. */
  currentEfforts: Effort[];
  currentMode: string | undefined;
  modes: string[];
}

export function readAgyCatalog(state: AcpRecord): AgyCatalog {
  const model = readSelectOption(state.configOptions, AGY_MODEL_CONFIG_ID);
  const effort = readSelectOption(state.configOptions, AGY_EFFORT_CONFIG_ID);
  const mode = readSelectOption(state.configOptions, AGY_MODE_CONFIG_ID);
  const families = model?.values.map(option => option.value) ?? [];
  const efforts = readFamilyEfforts(state.models, families);
  const currentEfforts = (effort?.values ?? []).map(option => option.value).filter(isEffort);
  const models: ModelDescriptor[] = (model?.values ?? []).map(option => {
    const familyEfforts = option.value === model?.currentValue && currentEfforts.length
      ? currentEfforts : efforts.get(option.value) ?? [];
    return {
      id: option.value,
      displayName: option.name,
      ...(option.description ? { description: option.description } : {}),
      // agy does not report context windows over ACP; 0 means unknown, never a fabricated limit.
      contextWindow: 0,
      efforts: familyEfforts,
      defaultEffort: familyEfforts.includes('medium') ? 'medium' : familyEfforts[0] ?? null,
    };
  });
  return {
    models,
    currentModel: model?.currentValue,
    currentEffort: isEffort(effort?.currentValue) ? effort!.currentValue as Effort : undefined,
    currentEfforts,
    currentMode: mode?.currentValue,
    modes: mode?.values.map(option => option.value) ?? [],
  };
}

/** Validate an exact selection before any native work; never inherit a CLI default.
 * The optional host policy narrows this adapter instance, not the public catalog.
 * An empty policy intentionally permits no model.
 */
export function assertAgyModelAllowed(model: unknown, allowedModels?: readonly string[]): asserts model is string {
  if (typeof model !== 'string' || !model.trim() || model !== model.trim() || model === 'default') {
    throw new Error('agy requires an explicit model; native defaults are not allowed');
  }
  if (allowedModels !== undefined && !allowedModels.includes(model)) {
    throw new Error('agy model is not allowed by the host policy');
  }
}
