/**
 * Unified Anthropic client + smart model selection.
 *
 * Backend resolution order:
 *   1. ANTHROPIC_API_KEY  (direct API)
 *   2. Vertex AI          (Google Cloud — preferred)
 *   3. Stub               (throws on use, lets the build pass)
 */

import Anthropic from '@anthropic-ai/sdk';

export type ModelTier = 'opus' | 'sonnet' | 'haiku';

let _client: any = null;
let _backend: 'anthropic' | 'vertex' | null = null;

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
  const isRealAnthropicKey =
    key && !key.startsWith('sk-ant-dummy') && !key.startsWith('BANNED');

  if (isRealAnthropicKey) {
    _client = new Anthropic({ apiKey: key });
    _backend = 'anthropic';
    return _client;
  }

  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const region = process.env.VERTEX_AI_REGION || 'us-east5';
  const credBase64 = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_BASE64;

  if (projectId && credBase64) {
    try {
      const credentials = JSON.parse(
        Buffer.from(credBase64, 'base64').toString('utf-8')
      );
      const { AnthropicVertex } = require('@anthropic-ai/vertex-sdk');
      const { GoogleAuth } = require('google-auth-library');
      const googleAuth = new GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      });
      _client = new AnthropicVertex({ projectId, region, googleAuth });
      _backend = 'vertex';
      return _client;
    } catch (err) {
      console.error('Failed to init Vertex AI client', err);
    }
  }

  _client = makeStub(
    'AI features unavailable: configure ANTHROPIC_API_KEY or GOOGLE_SERVICE_ACCOUNT_JSON_BASE64.'
  );
  return _client;
}

export function getModelName(tier: ModelTier = 'opus'): string {
  if (!_backend) getAnthropicClient();

  if (_backend === 'vertex') {
    return ({
      opus: process.env.VERTEX_OPUS_MODEL || 'claude-opus-4@20250514',
      sonnet: process.env.VERTEX_SONNET_MODEL || 'claude-sonnet-4@20250514',
      haiku: process.env.VERTEX_HAIKU_MODEL || 'claude-3-5-haiku@20241022',
    } as const)[tier];
  }

  return ({
    opus: 'claude-opus-4-7',
    sonnet: 'claude-sonnet-4-6',
    haiku: 'claude-haiku-4-5-20251001',
  } as const)[tier];
}

export function getModelForAgent(
  agent: 'audit' | 'builder' | 'optimizer' | 'reporter'
): string {
  const tierMap: Record<string, ModelTier> = {
    audit: 'opus',
    builder: 'opus',
    optimizer: 'sonnet',
    reporter: 'sonnet',
  };
  return getModelName(tierMap[agent]);
}
