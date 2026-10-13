import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createMessageForAgent,
  getAnthropicClient,
  getModelForAgent,
  getModelName,
  modelCandidatesForAgent,
  rankModelCandidates,
  tierForAgent,
  type AgentRole,
} from '../lib/ai/client';

const MODEL_ENV = [
  'ANTHROPIC_MODEL_OPUS',
  'ANTHROPIC_MODEL_AUDIT',
  'ANTHROPIC_MODEL_BUILDER',
  'ANTHROPIC_MODEL_SONNET',
  'ANTHROPIC_MODEL_OPTIMIZER',
  'ANTHROPIC_MODEL_REPORTER',
  'ANTHROPIC_MODEL_HAIKU',
] as const;

/** Runs `fn` with no model overrides in the environment, restoring them after. */
async function withCleanModelEnv<T>(fn: () => T | Promise<T>) {
  const saved = new Map(MODEL_ENV.map((name) => [name, process.env[name]]));
  for (const name of MODEL_ENV) delete process.env[name];
  try {
    return await fn();
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

const models = [
  { id: 'claude-haiku-4-5-20251001', createdAt: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-4-20250514', createdAt: '2025-05-14T00:00:00Z' },
  { id: 'claude-sonnet-4-6-20260217', createdAt: '2026-02-17T00:00:00Z' },
  { id: 'claude-sonnet-5', createdAt: '2026-06-30T00:00:00Z' },
  { id: 'claude-opus-4-1-20250805', createdAt: '2025-08-05T00:00:00Z' },
  { id: 'claude-opus-5', createdAt: '2026-07-15T00:00:00Z' },
  { id: 'unrelated-model', createdAt: '2030-01-01T00:00:00Z' },
];

test('reporting prefers the newest available Sonnet model', () => {
  assert.deepEqual(rankModelCandidates(models, 'sonnet').slice(0, 2), [
    'claude-sonnet-5',
    'claude-sonnet-4-6-20260217',
  ]);
});

test('high-stakes agents prefer Opus before Sonnet and Haiku', () => {
  const ranked = rankModelCandidates(models, 'opus');
  assert.equal(ranked[0], 'claude-opus-5');
  assert.ok(ranked.indexOf('claude-sonnet-4-6-20260217') < ranked.indexOf('claude-haiku-4-5-20251001'));
});

test('model ranking ignores non-Claude entries', () => {
  assert.ok(!rankModelCandidates(models, 'sonnet').includes('unrelated-model'));
});

test('agent roles map to the intended tiers', () => {
  const expected: Record<AgentRole, 'opus' | 'sonnet' | 'haiku'> = {
    audit: 'opus',
    jarvis_deep: 'opus',
    builder: 'sonnet',
    assistant: 'sonnet',
    jarvis: 'sonnet',
    optimizer: 'sonnet',
    reporter: 'sonnet',
    jarvis_fast: 'haiku',
  };
  for (const [role, tier] of Object.entries(expected) as Array<[AgentRole, 'opus' | 'sonnet' | 'haiku']>) {
    assert.equal(tierForAgent(role), tier, role);
  }
});

test('hard fallback model ids are the 5.5 generation', async () => {
  await withCleanModelEnv(() => {
    assert.equal(getModelName('opus'), 'claude-opus-5-5');
    assert.equal(getModelName('sonnet'), 'claude-sonnet-5-5');
    assert.equal(getModelName('haiku'), 'claude-haiku-5-5');
    assert.equal(getModelForAgent('jarvis'), 'claude-sonnet-5-5');
    assert.equal(getModelForAgent('jarvis_fast'), 'claude-haiku-5-5');
    assert.equal(getModelForAgent('jarvis_deep'), 'claude-opus-5-5');
    assert.equal(getModelForAgent('assistant'), 'claude-sonnet-5-5');
    assert.equal(getModelForAgent('audit'), 'claude-opus-5-5');
    assert.equal(getModelForAgent('builder'), 'claude-sonnet-5-5');
  });
});

test('environment overrides still win over the fallback ids', async () => {
  await withCleanModelEnv(() => {
    process.env.ANTHROPIC_MODEL_HAIKU = 'claude-haiku-custom';
    assert.equal(getModelForAgent('jarvis_fast'), 'claude-haiku-custom');
    assert.equal(modelCandidatesForAgent('jarvis_fast')[0], 'claude-haiku-custom');
  });
});

test('compatibility lists put 5.5 ids first and keep the older ids after them', async () => {
  await withCleanModelEnv(() => {
    assert.deepEqual(modelCandidatesForAgent('jarvis_fast'), [
      'claude-haiku-5-5',
      'claude-haiku-4-5-20251001',
      'claude-sonnet-5-5',
    ]);
    const opus = modelCandidatesForAgent('audit');
    assert.equal(opus[0], 'claude-opus-5-5');
    assert.ok(opus.indexOf('claude-opus-5-5') < opus.indexOf('claude-opus-5'));
    assert.ok(opus.includes('claude-opus-4-1-20250805'));
    const sonnet = modelCandidatesForAgent('jarvis');
    assert.equal(sonnet[0], 'claude-sonnet-5-5');
    assert.ok(sonnet.indexOf('claude-sonnet-5-5') < sonnet.indexOf('claude-sonnet-5'));
    assert.ok(sonnet.includes('claude-sonnet-4-6-20260217'));
    assert.deepEqual(modelCandidatesForAgent('assistant'), sonnet);
    assert.deepEqual(modelCandidatesForAgent('builder'), sonnet);
  });
});

test('createMessageForAgent records the call in llm_usage with attribution, and old callers still work', async () => {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: globalThis.fetch,
    error: console.error,
  };
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://supabase.test';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key-not-real';

  const inserts: any[] = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input);
    if (url.includes('/rest/v1/llm_usage')) {
      inserts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    }
    // Model discovery: unreachable, so the code falls back to its own id list.
    throw new Error('network disabled in test');
  }) as typeof fetch;
  console.error = () => {};

  const anthropic = getAnthropicClient() as any;
  const originalCreate = anthropic.messages.create;
  const requested: string[] = [];
  anthropic.messages.create = async (params: any) => {
    requested.push(params.model);
    return {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: params.model,
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 },
    };
  };

  const waitForInserts = async (count: number) => {
    for (let i = 0; i < 100 && inserts.length < count; i += 1) await new Promise((r) => setTimeout(r, 10));
  };

  try {
    await withCleanModelEnv(async () => {
      const params = { max_tokens: 10, messages: [{ role: 'user' as const, content: 'hi' }] };

      // Existing three-argument callers: no meta, recorded by agent role without a user.
      const legacy = await createMessageForAgent('reporter', params);
      assert.equal((legacy.content[0] as any).text, 'ok');
      await waitForInserts(1);
      assert.equal(inserts[0].feature, 'reporter');
      assert.equal(inserts[0].user_id, null);
      assert.equal(inserts[0].model, 'claude-sonnet-5-5');

      const userId = '11111111-1111-1111-1111-111111111111';
      const accountId = '22222222-2222-2222-2222-222222222222';
      await createMessageForAgent('jarvis_fast', params, undefined, {
        userId,
        accountId,
        feature: 'chat_start_language',
        channel: 'voice',
        toolRounds: 2,
        playbookVersion: 'pb-1',
      });
      await waitForInserts(2);
      const row = inserts[1];
      assert.equal(requested[1], 'claude-haiku-5-5');
      assert.equal(row.user_id, userId);
      assert.equal(row.account_id, accountId);
      assert.equal(row.feature, 'chat_start_language');
      assert.equal(row.channel, 'voice');
      assert.equal(row.model, 'claude-haiku-5-5');
      assert.equal(row.input_tokens, 1000);
      assert.equal(row.output_tokens, 200);
      assert.equal(row.cache_read_tokens, 5000);
      assert.equal(row.cache_write_tokens, 0);
      // 1000 x 0.10 + 200 x 0.50 + 5000 x 0.01 = 250 micro-dollars.
      assert.equal(row.cost_usd, 0.00025);
      assert.equal(row.priced, true);
      assert.equal(row.tool_rounds, 2);
      assert.equal(row.pricing_version, '2026-10-12');
      assert.equal(row.playbook_version, 'pb-1');
      assert.ok(Number.isInteger(row.latency_ms) && row.latency_ms >= 0);
    });
  } finally {
    anthropic.messages.create = originalCreate;
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
    for (const [name, value] of [
      ['ANTHROPIC_API_KEY', saved.key],
      ['NEXT_PUBLIC_SUPABASE_URL', saved.url],
      ['SUPABASE_SERVICE_ROLE_KEY', saved.service],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a failing usage insert never breaks the answer', async () => {
  const saved = {
    key: process.env.ANTHROPIC_API_KEY,
    url: process.env.NEXT_PUBLIC_SUPABASE_URL,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    fetch: globalThis.fetch,
    error: console.error,
  };
  process.env.ANTHROPIC_API_KEY = 'test-key-not-real';
  // Supabase is not configured at all: createAdminClient throws inside the recorder.
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  globalThis.fetch = (async () => {
    throw new Error('network disabled in test');
  }) as typeof fetch;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);

  const anthropic = getAnthropicClient() as any;
  const originalCreate = anthropic.messages.create;
  anthropic.messages.create = async (params: any) => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: params.model,
    content: [{ type: 'text', text: 'still fine' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  });

  try {
    await withCleanModelEnv(async () => {
      const response = await createMessageForAgent('audit', { max_tokens: 5, messages: [{ role: 'user', content: 'x' }] });
      assert.equal((response.content[0] as any).text, 'still fine');
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(logged.length >= 1, 'the failure is logged');
    });
  } finally {
    anthropic.messages.create = originalCreate;
    globalThis.fetch = saved.fetch;
    console.error = saved.error;
    for (const [name, value] of [
      ['ANTHROPIC_API_KEY', saved.key],
      ['NEXT_PUBLIC_SUPABASE_URL', saved.url],
      ['SUPABASE_SERVICE_ROLE_KEY', saved.service],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
