/**
 * Unified Anthropic client + smart model selection.
 * NOTE: vertex-sdk import is dynamic to avoid build-time webpack resolution issues.
 */

import Anthropic from '@anthropic-ai/sdk';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

let _client: any = null;
let _backend: 'anthropic' | 'vertex' | null = null;

export function getAnthropicClient() {
    if (_client) return _client;

  if (process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_API_KEY.startsWith('BANNED')) {
        _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
        _backend = 'anthropic';
        return _client;
  }

  if (process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID) {
        // Lazy require so webpack doesn't try to resolve at build time
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { AnthropicVertex } = require('@anthropic-ai/vertex-sdk');
        _client = new AnthropicVertex({
                projectId: process.env.GOOGLE_CLOUD_PROJECT_ID || process.env.GCP_PROJECT_ID,
                region: process.env.VERTEX_AI_REGION || 'us-east5',
        });
        _backend = 'vertex';
        return _client;
  }

  throw new Error('No AI backend configured. Set ANTHROPIC_API_KEY or GOOGLE_CLOUD_PROJECT_ID.');
}

export function getModelName(tier: ModelTier = 'opus'): string {
    if (!_backend) getAnthropicClient();

  const map = {
        opus: 'claude-opus-4-7',
        sonnet: 'claude-sonnet-4-6',
        haiku: 'claude-haiku-4-5-20251001',
  } as const;

  if (_backend === 'anthropic') {
        return map[tier];
  }

  return ({
        opus: process.env.VERTEX_OPUS_MODEL || 'claude-opus-4-7',
        sonnet: process.env.VERTEX_SONNET_MODEL || 'claude-sonnet-4-6',
        haiku: process.env.VERTEX_HAIKU_MODEL || 'claude-haiku-4-5',
  } as const)[tier];
}

export function getModelForAgent(agent: 'audit' | 'builder' | 'optimizer' | 'reporter'): string {
    const tierMap: Record<string, ModelTier> = {
          audit: 'opus',
          builder: 'opus',
          optimizer: 'sonnet',
          reporter: 'sonnet',
    };
    return getModelName(tierMap[agent]);
}
