/**
 * Unified Anthropic client + smart model selection.
 *
 * Strategy: Use the highest-quality model for high-stakes decisions,
 * cheaper models for high-frequency tasks.
 *
 *   Opus 4.7    -> Audit Agent + Campaign Builder
 *   Sonnet 4.6  -> Optimizer (hourly cron, cost-sensitive)
 *
 * Backend resolution order:
 *   1. ANTHROPIC_API_KEY  (direct API)
 *   2. Vertex AI          (Google Cloud — preferred)
 *   3. AWS Bedrock        (fallback)
 */

import Anthropic from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

let _client: any = null;
let _backend: 'anthropic' | 'vertex' | null = null;

export function getAnthropicClient() {
  if (_client) return _client;

  // Backend 1: Direct Anthropic API
  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('BANNED')) {
    _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    _backend = 'anthropic';
    return _client;
  }

  // Backend 2: Vertex AI
  if (process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID) {
    _client = new AnthropicVertex({
      projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID,
      region: process.env.VERTEX_AI_REGION || 'us-east5',
    });
    _backend = 'vertex';
    return _client;
  }

  throw new Error(
    'No AI backend configured. Set ANTHROPIC_API_KEY or GOOGLE_CLOUD_PROJECT_ID.'
  );
}

/**
 * Returns the model identifier for the current backend.
 *
 * Default tier when called without args is 'opus' (highest quality).
 */
export function getModelName(tier: ModelTier = 'opus'): string {
  // Ensure backend resolution
  if (!_backend) getAnthropicClient();

  if (_backend === 'anthropic') {
    return {
      opus: 'claude-opus-4-7',
      sonnet: 'claude-sonnet-4-6',
      haiku: 'claude-haiku-4-5-20251001',
    }[tier];
  }

  // Vertex AI model IDs (matches what's in Model Garden)
  return {
    opus: process.env.VERTEX_OPUS_MODEL || 'claude-opus-4-7',
    sonnet: process.env.VERTEX_SONNET_MODEL || 'claude-sonnet-4-6',
    haiku: process.env.VERTEX_HAIKU_MODEL || 'claude-haiku-4-5',
  }[tier];
}

/**
 * Convenience: returns the model for a specific agent role.
 *
 * - Audit Agent: opus (deep analysis, runs once per audit)
 * - Builder Agent: opus (creative campaign generation)
 * - Optimizer Agent: sonnet (hourly cron, cost-sensitive)
 * - Reporter Agent: sonnet (weekly summaries)
 */
export function getModelForAgent(agent: 'audit' | 'builder' | 'optimizer' | 'reporter'): string {
  const tierMap: Record<string, ModelTier> = {
    audit: 'opus',
    builder: 'opus',
    optimizer: 'sonnet',
    reporter: 'sonnet',
  };
  return getModelName(tierMap[agent]);
}
