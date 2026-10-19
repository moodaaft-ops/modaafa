import assert from 'node:assert/strict';
import test from 'node:test';
import { FAQ_ITEMS } from '../lib/faq/data';
import { buildSupportKnowledge, SUPPORT_EXTRA_FACTS, supportSourceIds } from '../lib/support/kb';
import { buildSupportSystemPrompt, supportReplyTool } from '../lib/support/bot';
import { isSupportBotEnabled } from '../lib/support/flag';

test('the knowledge carries every FAQ question and answer, so /faq and the bot cannot disagree', () => {
  const kb = buildSupportKnowledge();
  for (const item of FAQ_ITEMS) {
    assert.ok(kb.includes(`[${item.id}]`), `${item.id} id missing`);
    assert.ok(kb.includes(item.q), `${item.id} question missing`);
    for (const paragraph of item.a) assert.ok(kb.includes(paragraph), `${item.id} answer missing`);
  }
});

test('the knowledge and the prompt follow the writing rules: no long or medium dash, no Latin comma in Arabic', () => {
  for (const text of [buildSupportKnowledge(), buildSupportSystemPrompt(), ...SUPPORT_EXTRA_FACTS]) {
    assert.ok(!/[—–]/.test(text), 'dash found');
    assert.ok(!/[؀-ۿ],|,[؀-ۿ]/.test(text), 'Latin comma next to Arabic');
    assert.ok(!/[​-‏‪-‮﻿]/.test(text), 'hidden character');
  }
});

test('the knowledge never says "before tax" and states that no tax is added', () => {
  const kb = buildSupportKnowledge();
  assert.ok(!kb.includes('قبل الضريبة'));
  assert.ok(kb.includes('ما تنضاف عليه ضريبة'));
});

test('the reply tool only lets the model cite real FAQ ids', () => {
  const tool = supportReplyTool();
  const allowed = tool.input_schema.properties.source.enum;
  assert.deepEqual([...allowed].sort(), [...supportSourceIds(), 'none'].sort());
  assert.deepEqual([...tool.input_schema.required].sort(), ['answer', 'handoff', 'reason', 'source', 'summary']);
});

test('the system prompt keeps the knowledge in one block that can be cached', () => {
  const prompt = buildSupportSystemPrompt();
  assert.equal(prompt.split('\n<knowledge>\n').length, 2, 'the block must open exactly once');
  assert.ok(prompt.endsWith('</knowledge>'));
  assert.ok(prompt.length < 60_000, `prompt is ${prompt.length} characters`);
});

test('the rollout flag is off unless it is exactly "true"', () => {
  assert.equal(isSupportBotEnabled({}), false);
  assert.equal(isSupportBotEnabled({ SUPPORT_BOT_ENABLED: '' }), false);
  assert.equal(isSupportBotEnabled({ SUPPORT_BOT_ENABLED: 'yes' }), false);
  assert.equal(isSupportBotEnabled({ SUPPORT_BOT_ENABLED: 'false' }), false);
  assert.equal(isSupportBotEnabled({ SUPPORT_BOT_ENABLED: ' TRUE ' }), true);
});
