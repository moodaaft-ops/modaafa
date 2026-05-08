/**
 * Unified Anthropic client. Vertex AI temporarily disabled.
 * Until @anthropic-ai/vertex-sdk version conflict is fixed, only the direct
 * Anthropic API backend is wired. Set ANTHROPIC_API_KEY to enable AI features.
 */

import Anthropic from '@anthropic-ai/sdk';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

let _client: any = null;

export function getAnthropicClient() {
      if (_client) return _client;
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key || key.startsWith('BANNED')) {
      return new Proxy({}, { get(){ return ()=>{ throw new Error('AI features unavailable: ANTHROPIC_API_KEY not configured'); }; } });      }
      _client = new Anthropic({ apiKey: key });
      return _client;
}

export function getModelName(tier: ModelTier = 'opus'): string {
      return ({
              opus: 'claude-opus-4-7',
              sonnet: 'claude-sonnet-4-6',
              haiku: 'claude-haiku-4-5-20251001',
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
