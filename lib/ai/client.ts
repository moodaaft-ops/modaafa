/**
 * Unified Anthropic client + smart model selection.
 *
 * Note: Vertex AI is intentionally NOT imported here because the
 * @anthropic-ai/vertex-sdk package has broken `exports` in its package.json
 * that fails Next.js builds. Re-enable it only after pinning a working version.
 *
 * For now: uses ANTHROPIC_API_KEY directly. If unset/dummy, returns a stub
 * that throws on use so the build still succeeds.
 */

import Anthropic from '@anthropic-ai/sdk';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

let _client: any = null;

function makeStub(message: string): any {
  return new Proxy({}, {
    get() {
      return () => { throw new Error(message); };
    },
  });
}

export function getAnthropicClient(): any {
  if (_client) return _client;

  const key = process.env.ANTHROPIC_API_KEY;
  const isReal =
    key && !key.startsWith('sk-ant-dummy') && !key.startsWith('BANNED');

  if (isReal) {
    _client = new Anthropic({ apiKey: key });
    return _client;
  }

  _client = makeStub(
    'AI features unavailable: configure a real ANTHROPIC_API_KEY in env vars.'
  );
  return _client;
}

export function getModelName(tier: ModelTier = 'opus'): string {
  return ({
    opus: 'claude-opus-4-6',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  } as const)[tier];
}

export function getModelForAgent(
  agent: 'audit' | 'builder' | 'optimizer' | 'reporter'
): string {
  // NOTE: audit was previously 'opus', but Opus + max_tokens=8000 takes 60–120s
  // which exceeds Vercel's Hobby function timeout (60s), causing the SDK to
  // throw a generic "Connection error". Sonnet 4.6 is ~3x faster with similar
  // quality for structured-JSON analysis tasks.
  const tierMap: Record<string, ModelTier> = {
    audit: 'sonnet',
    builder: 'sonnet',
    optimizer: 'haiku',
    reporter: 'haiku',
  };
  return getModelName(tierMap[agent]);
}
