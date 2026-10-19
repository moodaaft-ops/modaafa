import Anthropic from '@anthropic-ai/sdk';
import { after } from 'next/server';
import { isConfiguredEnv } from '@/lib/platform/env';
import { PRICING_VERSION, costUsd, type AnthropicUsage } from './pricing';
import { recordLlmUsage, type LlmChannel } from './usage';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';
export type AgentRole =
  | 'audit'
  | 'assistant'
  | 'builder'
  | 'optimizer'
  | 'reporter'
  | 'jarvis'
  | 'jarvis_fast'
  | 'jarvis_deep'
  | 'support';

/**
 * Optional attribution for the llm_usage ledger. Every field is optional so
 * existing callers keep working; a call without `meta` is still recorded (by
 * agent role) but without a user.
 */
export type LlmCallMeta = {
  userId?: string | null;
  accountId?: string | null;
  feature?: string;
  channel?: LlmChannel;
  toolRounds?: number;
  playbookVersion?: string | null;
};

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
    opus: 'claude-opus-5-5',
    sonnet: 'claude-sonnet-5-5',
    haiku: 'claude-haiku-5-5',
  }[tier];
}

/**
 * A system prompt as one block marked for the 5 minute prompt cache. Only use
 * it for text that is identical across calls AND likely to be re-sent within
 * five minutes (a batch of accounts, a tool loop, a chat with follow-ups): a
 * cache write costs 1.25x the normal input price, a read 0.05x on Sonnet 5.5.
 * The SDK's TextBlockParam type predates cache_control but the API accepts it,
 * the same cast lib/jarvis/brain.ts uses. When the text is shorter than the
 * model's minimum (512 tokens on the 5.5 family) the API quietly skips the cache.
 */
export function cachedSystemBlock(text: string) {
  return [
    { type: 'text', text, cache_control: { type: 'ephemeral' } },
  ] as unknown as Anthropic.TextBlockParam[];
}

export function getModelForAgent(agent: AgentRole): string {
  return getModelName(tierForAgent(agent));
}

export async function createMessageForAgent(
  agent: AgentRole,
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>,
  requestOptions?: Anthropic.RequestOptions,
  meta?: LlmCallMeta
) {
  const anthropic = getAnthropicClient();
  let lastError: unknown;
  const preferredModel = getModelForAgent(agent);
  const discoveredModels = await getAvailableModelCandidates(agent);
  const candidates = Array.from(
    new Set([preferredModel, ...discoveredModels, ...modelCandidatesForAgent(agent)])
  );

  for (const model of candidates) {
    const startedAt = Date.now();
    try {
      const response = await anthropic.messages.create({ ...params, model }, requestOptions);
      trackUsage(agent, model, response, Date.now() - startedAt, meta);
      return response;
    } catch (error) {
      lastError = error;
      if (!isUnavailableModelError(error)) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('No supported Anthropic model is available.');
}

/**
 * Prices the response from its own `usage` and appends it to llm_usage. Never
 * throws and never waits: the answer is already in hand. `after()` keeps the
 * insert alive past the response on serverless; outside a request (scripts,
 * tests) it throws and the already-started insert simply runs on its own.
 */
function trackUsage(
  agent: AgentRole,
  requestedModel: string,
  response: Anthropic.Message,
  latencyMs: number,
  meta?: LlmCallMeta
) {
  try {
    const model = response.model || requestedModel;
    // The SDK's Usage type predates the cache fields, but the API returns them.
    const usage = response.usage as AnthropicUsage | undefined;
    const cost = costUsd(model, usage);
    const pending = recordLlmUsage({
      userId: meta?.userId ?? null,
      accountId: meta?.accountId ?? null,
      feature: meta?.feature ?? agent,
      channel: meta?.channel ?? null,
      model,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      costUsd: cost.costUsd,
      priced: cost.priced,
      toolRounds: meta?.toolRounds ?? 0,
      latencyMs,
      pricingVersion: PRICING_VERSION,
      playbookVersion: meta?.playbookVersion ?? null,
    });
    pending.catch(() => {});
    try {
      after(pending);
    } catch {
      // Not inside a request scope.
    }
  } catch {
    console.error('LLM usage tracking failed');
  }
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

/**
 * Fills the model-list cache ahead of the first real message. That list is a
 * free metadata request (no tokens), but every cold server instance otherwise
 * waits for it in front of its first model call. Fire and forget: a failure
 * here changes nothing, the real call retries the same way it always did.
 */
export function prewarmAIClient() {
  if (!hasAIBackend()) return;
  void discoverAvailableModels().catch(() => undefined);
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

/**
 * The free audit is the one model call a customer costs before they have
 * started a subscription, so it runs on Sonnet by default. Set
 * FREE_AUDIT_MODEL_TIER=opus to put it back on the top tier (sonnet and haiku
 * are accepted too); anything else is ignored. Only the audit reads this.
 * The 'jarvis_deep' role maps to Opus here, but NO CODE CALLS IT today: there
 * is no weekly deep review, and nothing in the product runs on Opus unless
 * this variable is set. Not implemented. Jarvis answers daily questions on
 * Sonnet (spec 8.2), the /assistant page and the campaign builder run on
 * Sonnet (Ayman, 2026-10-12), the hourly optimizer runs on Sonnet, and the
 * cheap classification and extraction role runs on Haiku.
 */
export function freeAuditTier(env: Record<string, string | undefined> = process.env): ModelTier {
  const value = env.FREE_AUDIT_MODEL_TIER?.trim().toLowerCase();
  if (value === 'opus' || value === 'sonnet' || value === 'haiku') return value;
  return 'sonnet';
}

/**
 * The customer-service bot answers from a short knowledge base and never calls
 * a tool that touches an account, so it starts on the cheap tier. If Haiku
 * turns out weak on Najdi phrasing, flip SUPPORT_BOT_TIER=sonnet in Vercel and
 * redeploy: no code change.
 */
export function supportBotTier(env: Record<string, string | undefined> = process.env): ModelTier {
  const value = env.SUPPORT_BOT_TIER?.trim().toLowerCase();
  if (value === 'opus' || value === 'sonnet' || value === 'haiku') return value;
  return 'haiku';
}

export function tierForAgent(agent: AgentRole): ModelTier {
  if (agent === 'audit') return freeAuditTier();
  if (agent === 'support') return supportBotTier();
  if (agent === 'jarvis_deep') return 'opus';
  if (agent === 'jarvis_fast') return 'haiku';
  return 'sonnet';
}

export function modelCandidatesForAgent(agent: AgentRole) {
  const primary = getModelForAgent(agent);
  const tier = tierForAgent(agent);
  // Newest ids first inside each family, older ids after them.
  const compatibilityFallbacks =
    tier === 'opus'
      ? ['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-4-1-20250805']
      : tier === 'haiku'
        ? ['claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-sonnet-5-5']
        : ['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-4-6-20260217'];

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
