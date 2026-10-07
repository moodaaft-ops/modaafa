import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GENERIC_PROMPTS,
  SLOW_REPLY_AFTER_MS,
  buildSuggestedPrompts,
  chatStorageKey,
  parseStoredChat,
  recommendationHref,
  serializeChat,
  thinkingStageAt,
} from '../lib/assistant/chat-ui';

test('thinking stages advance with time and flag a slow reply', () => {
  assert.equal(thinkingStageAt(0).index, 0);
  assert.equal(thinkingStageAt(5_000).index, 1);
  assert.equal(thinkingStageAt(12_000).index, 2);
  assert.equal(thinkingStageAt(12_000).slow, false);
  assert.equal(thinkingStageAt(SLOW_REPLY_AFTER_MS).slow, true);
});

test('suggested prompts are generic without account data', () => {
  assert.deepEqual(buildSuggestedPrompts(null), GENERIC_PROMPTS.slice(0, 6));
  assert.deepEqual(buildSuggestedPrompts({ latestAudit: null, pendingRecommendations: [] }), GENERIC_PROMPTS.slice(0, 6));
});

test('suggested prompts lead with the account audit and the most severe pending recommendation', () => {
  const prompts = buildSuggestedPrompts({
    latestAudit: { healthScore: 61, estimatedWaste: 900, ranAt: '2026-10-01T00:00:00Z' },
    pendingRecommendations: [
      { id: 'a', title: 'ارفع الميزانية', severity: 'growth' },
      { id: 'b', title: 'أوقف كلمة تهدر الصرف', severity: 'critical' },
    ],
  });
  assert.equal(prompts.length, 6);
  assert.match(prompts[0], /أوقف كلمة تهدر الصرف/);
  assert.ok(prompts.some((prompt) => prompt.includes('آخر فحص')));
  assert.ok(prompts.some((prompt) => prompt.includes('الهدر')));
  assert.equal(new Set(prompts).size, prompts.length);
});

test('waste prompt only appears when the audit found waste', () => {
  const prompts = buildSuggestedPrompts({
    latestAudit: { healthScore: 80, estimatedWaste: 0, ranAt: null },
    pendingRecommendations: [],
  });
  assert.ok(!prompts.some((prompt) => prompt.includes('من وين جا الهدر')));
});

test('recommendation links point at the recommendation, never an unsafe value', () => {
  assert.equal(recommendationHref('3f2a-91'), '/optimizer#rec-3f2a-91');
  assert.equal(recommendationHref(null), '/optimizer');
  assert.equal(recommendationHref(''), '/optimizer');
  assert.equal(recommendationHref('"><script>'), '/optimizer');
});

test('saved conversation round-trips and rejects stale, foreign or broken data', () => {
  const chat = [
    { role: 'assistant' as const, content: 'أهلاً' },
    { role: 'user' as const, content: 'حلل الصرف' },
    { role: 'assistant' as const, content: 'تم' },
  ];
  const now = 1_800_000_000_000;
  const raw = serializeChat(chat, 'session-1', now);
  assert.deepEqual(parseStoredChat(raw, now + 1000), { chat, sessionId: 'session-1' });
  assert.equal(parseStoredChat(raw, now + 8 * 24 * 60 * 60 * 1000), null, 'older than a week');
  assert.equal(parseStoredChat(null), null);
  assert.equal(parseStoredChat('{broken'), null);
  assert.equal(parseStoredChat(JSON.stringify({ v: 99, savedAt: now, chat })), null);
  assert.equal(parseStoredChat(serializeChat([chat[0]], null, now), now), null, 'seed only is not a conversation');
});

test('saved conversation is scoped by user and account', () => {
  assert.notEqual(chatStorageKey('u1', '111'), chatStorageKey('u2', '111'));
  assert.notEqual(chatStorageKey('u1', '111'), chatStorageKey('u1', '222'));
});

test('saved conversation keeps only the latest items', () => {
  const chat = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? ('assistant' as const) : ('user' as const), content: `m${i}` }));
  const restored = parseStoredChat(serializeChat(chat, null));
  assert.ok(restored);
  assert.equal(restored.chat.length, 40);
  assert.equal(restored.chat.at(-1)?.content, 'm99');
});
