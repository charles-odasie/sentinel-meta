/**
 * Provider / model configuration. Keys come ONLY from the environment; nothing here
 * reads or prints a key. See .env.example at the repo root.
 */
export type ProviderId = 'baseten' | 'fireworks' | 'meta';

export interface ProviderConfig {
  id: ProviderId;
  label: string;
  baseUrl: string; // OpenAI-compatible /v1
  host: string;
  apiKeyEnv: string;
  model: string;
  openWeights: boolean;
  /** USD per 1M tokens. `null` = UNVERIFIED (not published on the provider's own page at build time). */
  priceIn: number | null;
  priceOut: number | null;
}

const PROVIDERS: Record<ProviderId, ProviderConfig> = {
  baseten: {
    id: 'baseten',
    label: 'Baseten Model APIs',
    baseUrl: 'https://inference.baseten.co/v1',
    host: 'inference.baseten.co',
    apiKeyEnv: 'BASETEN_API_KEY',
    model: process.env.SENTINEL_BASETEN_MODEL ?? 'meta-models/muse-spark-open',
    openWeights: true,
    priceIn: 1.25,
    priceOut: 4.25,
  },
  fireworks: {
    id: 'fireworks',
    label: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    host: 'api.fireworks.ai',
    apiKeyEnv: 'FIREWORKS_API_KEY',
    model: process.env.SENTINEL_FIREWORKS_MODEL ?? 'accounts/fireworks/models/muse-glimmer-30b',
    openWeights: true,
    priceIn: null,
    priceOut: null,
  },
  meta: {
    id: 'meta',
    label: 'Meta Model API (hosted, not open-weight — fallback only)',
    baseUrl: 'https://api.meta.ai/v1',
    host: 'api.meta.ai',
    apiKeyEnv: 'MODEL_API_KEY',
    model: process.env.SENTINEL_META_MODEL ?? 'muse-spark-1.3',
    openWeights: false,
    priceIn: 1.25,
    priceOut: 4.25,
  },
};

export type Role = 'reasoner' | 'fast';

export function providerFor(id: ProviderId): ProviderConfig {
  return PROVIDERS[id];
}

export function hasKey(p: ProviderConfig): boolean {
  return Boolean(process.env[p.apiKeyEnv]);
}

export function apiKey(p: ProviderConfig): string {
  const k = process.env[p.apiKeyEnv];
  if (!k) throw new Error(`Missing ${p.apiKeyEnv} in environment`);
  return k;
}

/**
 * Routing: the reasoner does the agentic work (repro, fix); the fast model does
 * cheap classification/summaries. Defaults: reasoner=baseten (Muse Spark Open),
 * fast=fireworks (Muse Glimmer 30B) when its key exists, else the reasoner.
 * Override with SENTINEL_REASONER / SENTINEL_FAST = baseten|fireworks|meta.
 */
export function resolveRouting(): { reasoner: ProviderConfig; fast: ProviderConfig } {
  const pick = (env: string | undefined, fallbacks: ProviderId[]): ProviderConfig => {
    const order: ProviderId[] = [];
    if (env && env in PROVIDERS) order.push(env as ProviderId);
    order.push(...fallbacks);
    for (const id of order) if (hasKey(PROVIDERS[id])) return PROVIDERS[id];
    return PROVIDERS[order[0]];
  };
  const reasoner = pick(process.env.SENTINEL_REASONER, ['baseten', 'fireworks', 'meta']);
  const fast = pick(process.env.SENTINEL_FAST, ['fireworks', reasoner.id]);
  return { reasoner, fast };
}

export function allowedHosts(): string[] {
  const { reasoner, fast } = resolveRouting();
  return Array.from(new Set([reasoner.host, fast.host]));
}
