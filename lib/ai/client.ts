import Anthropic from '@anthropic-ai/sdk';
import { isConfiguredEnv } from '@/lib/platform/env';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';
export type AgentRole = 'audit' | 'assistant' | 'builder' | 'optimizer' | 'reporter';

export type AvailableModel = {
  id: string;
  createdAt: string | null;
};

type AIConfigurationCheck = {
  ok: boolean;
  configured: boolean;
  backend: 'anthropic' | null;
  status: 'ready' | 'api_key_missing' | 'no_models' | 'request_failed';
  modelsAvailable: number;
  preferredReporterModel: string | null;
};

const MODEL_CACHE_TTL_MS = 15 * 60 * 1000;

let client: Anthropic | null = null;
let availableModels: AvailableModel[] | null = null;
let modelsFetchedAt = 0;
let modelDiscovery: Promise<AvailableModel[]> | null = null;

export function getAnthropicClient() {
  if (client) return client;
  if (!hasAIBackend()) {
    throw new Error('No AI backend configured. Set ANTHROPIC_API_KEY.');
  }

  client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY!.trim(),
    timeout: 45_000,
    maxRetries: 2,
  });
  return client;
}

export function hasAIBackend() {
  return (
    isConfiguredEnv(process.env.ANTHROPIC_API_KEY) &&
    !process.env.ANTHROPIC_API_KEY!.trim().startsWith('BANNED')
  );
}

export function getModelName(tier: ModelTier = 'sonnet'): string {
  const configured = {
    opus:
      process.env.ANTHROPIC_MODEL_OPUS ??
      process.env.ANTHROPIC_MODEL_AUDIT ??
      process.env.ANTHROPIC_MODEL_BUILDER,
    sonnet:
      process.env.ANTHROPIC_MODEL_SONNET ??
      process.env.ANTHROPIC_MODEL_OPTIMIZER ??
      process.env.ANTHROPIC_MODEL_REPORTER,
    haiku: process.env.ANTHROPIC_MODEL_HAIKU,
  }[tier];

  if (isConfiguredEnv(configured)) return configured.trim();

  // These exact IDs are last-resort compatibility fallbacks. Normal requests
  // first discover the models actually enabled for the production API key.
  return {
    opus: 'claude-opus-5',
    sonnet: 'claude-sonnet-5',
    haiku: 'claude-haiku-4-5-20251001',
  }[tier];
}

export function getModelForAgent(agent: AgentRole): string {
  return getModelName(tierForAgent(agent));
}

export async function createMessageForAgent(
  agent: AgentRole,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>,
  requestOptions?: Anthropic.RequestOptions
) {
  const anthropic = getAnthropicClient();
  let lastError: unknown;
  const preferredModel = getModelForAgent(agent);
  const discoveredModels = await getAvailableModelCandidates(agent);
  const candidates = Array.from(
    new Set([preferredModel, ...discoveredModels, ...modelCandidatesForAgent(agent)])
  );

  for (const model of candidates) {
    try {
      return await anthropic.messages.create({ ...params, model }, requestOptions);
    } catch (error) {
      lastError = error;
      if (!isUnavailableModelError(error)) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('No supported Anthropic model is available.');
}

export async function checkAIConfiguration(): Promise<AIConfigurationCheck> {
  if (!hasAIBackend()) {
    return {
      ok: false,
      configured: false,
      backend: null,
      status: 'api_key_missing',
      modelsAvailable: 0,
      preferredReporterModel: null,
    };
  }

  try {
    const models = await discoverAvailableModels(true);
    const preferredReporterModel = rankModelCandidates(models, tierForAgent('reporter'))[0] ?? null;
    return {
      ok: models.length > 0,
      configured: true,
      backend: 'anthropic',
      status: models.length > 0 ? 'ready' : 'no_models',
      modelsAvailable: models.length,
      preferredReporterModel,
    };
  } catch {
    return {
      ok: false,
      configured: true,
      backend: 'anthropic',
      status: 'request_failed',
      modelsAvailable: 0,
      preferredReporterModel: null,
    };
  }
}

export function rankModelCandidates(models: AvailableModel[], tier: ModelTier) {
  const preferredFamilies =
    tier === 'opus' ? ['opus', 'sonnet', 'haiku'] : tier === 'sonnet' ? ['sonnet', 'haiku', 'opus'] : ['haiku', 'sonnet', 'opus'];

  return [...models]
    .filter((model) => model.id.startsWith('claude-'))
    .sort((left, right) => {
      const familyRank = (model: AvailableModel) => {
        const rank = preferredFamilies.findIndex((family) => model.id.includes(family));
        return rank === -1 ? preferredFamilies.length : rank;
      };
      const familyDifference = familyRank(left) - familyRank(right);
      if (familyDifference) return familyDifference;

      const createdDifference = modelTimestamp(right) - modelTimestamp(left);
      return createdDifference || right.id.localeCompare(left.id);
    })
    .map((model) => model.id);
}

async function getAvailableModelCandidates(agent: AgentRole) {
  try {
    const models = await discoverAvailableModels();
    return rankModelCandidates(models, tierForAgent(agent));
  } catch {
    return [];
  }
}

async function discoverAvailableModels(force = false) {
  const fresh = availableModels && Date.now() - modelsFetchedAt < MODEL_CACHE_TTL_MS;
  if (!force && fresh) return availableModels!;
  if (!force && modelDiscovery) return modelDiscovery;

  const discovery = (async () => {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: {
        'anthropic-version': '2023-06-01',
        'x-api-key': process.env.ANTHROPIC_API_KEY!.trim(),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12_000),
    });

    if (!response.ok) {
      throw new Error(`Anthropic model discovery failed with HTTP ${response.status}.`);
    }

    const payload = (await response.json()) as {
      data?: Array<{ id?: string; created_at?: string }>;
    };
    const models = (payload.data ?? [])
      .map((model) => ({
        id: model.id?.trim() ?? '',
        createdAt: model.created_at?.trim() || null,
      }))
      .filter((model): model is AvailableModel => Boolean(model.id));

    availableModels = models;
    modelsFetchedAt = Date.now();
    return models;
  })();

  if (!force) modelDiscovery = discovery;
  try {
    return await discovery;
  } finally {
    if (!force) modelDiscovery = null;
  }
}

function tierForAgent(agent: AgentRole): ModelTier {
  // The conversational assistant makes account-level strategic judgments and
  // root-cause explanations, so it uses the same reasoning tier as the audit
  // analyst. Routine scheduled summaries stay on Sonnet to contain cost.
  return agent === 'audit' || agent === 'assistant' || agent === 'builder' ? 'opus' : 'sonnet';
}

function modelCandidatesForAgent(agent: AgentRole) {
  const primary = getModelForAgent(agent);
  const compatibilityFallbacks =
    agent === 'audit' || agent === 'assistant' || agent === 'builder'
      ? ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-1-20250805']
      : ['claude-sonnet-5', 'claude-opus-5', 'claude-sonnet-4-6-20260217'];

  return Array.from(new Set([primary, ...compatibilityFallbacks]));
}

function modelTimestamp(model: AvailableModel) {
  if (model.createdAt) {
    const timestamp = Date.parse(model.createdAt);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  const date = model.id.match(/(20\d{6})$/)?.[1];
  if (!date) return 0;
  return Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T00:00:00Z`);
}

function isUnavailableModelError(error: unknown) {
  const status = Number((error as { status?: number })?.status ?? 0);
  const message = String((error as { message?: string })?.message ?? '');
  return [400, 403, 404].includes(status) && /model|not[_ -]?found|permission/i.test(message);
}
