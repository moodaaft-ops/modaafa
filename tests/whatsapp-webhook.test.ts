import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { NextRequest } from 'next/server';
import { verifyWebhookSignature, safeEqual } from '../lib/whatsapp/signature';
import {
  createWhatsAppWebhookHandler,
  parseWhatsAppPayload,
  type WhatsAppEvent,
} from '../lib/whatsapp/webhook';

const PHONE_ID = '1343281345540372';
const SECRET = 'app-secret';
const config = { appSecret: SECRET, verifyToken: 'verify-me', phoneNumberId: PHONE_ID };

function sign(body: string, secret = SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body, 'utf8').digest('hex')}`;
}

function payload(value: Record<string, unknown>, phoneNumberId = PHONE_ID) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, ...value } }] }],
  };
}

const inboundText = (body: string, id = 'wamid.IN1') =>
  payload({ messages: [{ id, from: '966501112233', timestamp: '1760000000', type: 'text', text: { body } }] });

const deliveredStatus = payload({
  statuses: [{ id: 'wamid.OUT1', status: 'delivered', recipient_id: '966501112233', timestamp: '1760000100' }],
});

function post(body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return new NextRequest('https://ai.modaafa.com/api/webhooks/whatsapp', {
    method: 'POST',
    body: raw,
    headers: { 'x-hub-signature-256': sign(raw), ...headers },
  });
}

function harness(overrides: Record<string, unknown> = {}) {
  const calls = { recorded: [] as WhatsAppEvent[][], optOuts: [] as string[], alerts: [] as WhatsAppEvent[] };
  const handler = createWhatsAppWebhookHandler({
    readConfig: () => config,
    recordEvents: async (events) => {
      calls.recorded.push(events);
      return events;
    },
    applyOptOut: async (waId) => {
      calls.optOuts.push(waId);
    },
    alertInbound: async (event) => {
      calls.alerts.push(event);
    },
    alertsEnabled: () => true,
    ...overrides,
  });
  return { handler, calls };
}

test('signature check accepts the right secret and nothing else', () => {
  const body = '{"a":1}';
  assert.equal(verifyWebhookSignature(body, sign(body), SECRET), true);
  assert.equal(verifyWebhookSignature(body, sign(body, 'other'), SECRET), false);
  assert.equal(verifyWebhookSignature(body + ' ', sign(body), SECRET), false);
  assert.equal(verifyWebhookSignature(body, null, SECRET), false);
  assert.equal(verifyWebhookSignature(body, 'sha256=zz', SECRET), false);
  assert.equal(verifyWebhookSignature(body, sign(body), ''), false);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
});

test('parser reads inbound text and delivery statuses for our number only', () => {
  const [message] = parseWhatsAppPayload(inboundText('هلا'), PHONE_ID);
  assert.deepEqual(message, {
    wamid: 'wamid.IN1',
    eventKey: 'message',
    waId: '966501112233',
    kind: 'text',
    body: 'هلا',
    errorCode: null,
    occurredAt: '2025-10-09T08:53:20.000Z',
  });

  const [status] = parseWhatsAppPayload(deliveredStatus, PHONE_ID);
  assert.equal(status.eventKey, 'delivered');
  assert.equal(status.wamid, 'wamid.OUT1');

  assert.deepEqual(parseWhatsAppPayload(inboundText('هلا'), 'another-number'), []);
});

test('parser keeps the error code of a failed status and skips junk', () => {
  const failed = payload({
    statuses: [{ id: 'wamid.OUT2', status: 'failed', recipient_id: '966501112233', errors: [{ code: 131047, title: 'x' }] }],
  });
  const [event] = parseWhatsAppPayload(failed, PHONE_ID);
  assert.equal(event.eventKey, 'failed');
  assert.equal(event.errorCode, 131047);

  assert.deepEqual(parseWhatsAppPayload(null, PHONE_ID), []);
  assert.deepEqual(parseWhatsAppPayload({ entry: 'nope' }, PHONE_ID), []);
  assert.deepEqual(parseWhatsAppPayload(payload({ statuses: [{ id: 'x', status: 'deleted', recipient_id: '1' }] }), PHONE_ID), []);
  assert.deepEqual(parseWhatsAppPayload(payload({ messages: [{ from: '966501112233' }] }), PHONE_ID), []);
});

test('non-text messages are stored without a body', () => {
  const image = payload({ messages: [{ id: 'wamid.IMG', from: '966501112233', timestamp: '1760000000', type: 'image', image: { id: 'm' } }] });
  const [event] = parseWhatsAppPayload(image, PHONE_ID);
  assert.equal(event.kind, 'image');
  assert.equal(event.body, null);
});

test('GET handshake echoes the challenge only for the right token', async () => {
  const { handler } = harness();
  const url = (token: string) =>
    new NextRequest(`https://ai.modaafa.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=12345`);

  const ok = await handler.GET(url('verify-me'));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');

  assert.equal((await handler.GET(url('wrong'))).status, 403);
  assert.equal(
    (await handler.GET(new NextRequest('https://ai.modaafa.com/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me'))).status,
    403,
  );
});

test('the channel answers 503 while it is not configured', async () => {
  const { handler } = harness({ readConfig: () => null });
  assert.equal((await handler.POST(post(inboundText('هلا')))).status, 503);
  assert.equal((await handler.GET(new NextRequest('https://ai.modaafa.com/api/webhooks/whatsapp?hub.mode=subscribe'))).status, 503);
});

test('POST rejects a missing or wrong signature before storing anything', async () => {
  const { handler, calls } = harness();
  const body = JSON.stringify(inboundText('هلا'));

  const unsigned = new NextRequest('https://ai.modaafa.com/api/webhooks/whatsapp', { method: 'POST', body });
  assert.equal((await handler.POST(unsigned)).status, 401);
  assert.equal((await handler.POST(post(body, { 'x-hub-signature-256': sign(body, 'other') }))).status, 401);
  assert.equal(calls.recorded.length, 0);
});

test('POST rejects a signed body that is not JSON', async () => {
  const { handler } = harness();
  assert.equal((await handler.POST(post('not json'))).status, 400);
});

test('a normal inbound message is stored and raises the ops alert', async () => {
  const { handler, calls } = harness();
  const response = await handler.POST(post(inboundText('ابغا اعرف السعر')));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, stored: 1 });
  assert.equal(calls.recorded[0][0].body, 'ابغا اعرف السعر');
  assert.equal(calls.alerts.length, 1);
  assert.deepEqual(calls.optOuts, []);
});

test('alerts stay quiet when switched off, and status updates never alert', async () => {
  const { handler, calls } = harness({ alertsEnabled: () => false });
  await handler.POST(post(inboundText('هلا')));
  await handler.POST(post(deliveredStatus));
  assert.equal(calls.alerts.length, 0);
});

test('a stop reply opts the user out and does not raise an alert', async () => {
  const { handler, calls } = harness();
  await handler.POST(post(inboundText('إيقاف')));
  assert.deepEqual(calls.optOuts, ['966501112233']);
  assert.equal(calls.alerts.length, 0);
});

test('a redelivered event that storage already had triggers no second action', async () => {
  const { handler, calls } = harness({ recordEvents: async () => [] });
  const response = await handler.POST(post(inboundText('إيقاف')));
  assert.deepEqual(await response.json(), { ok: true, stored: 0 });
  assert.deepEqual(calls.optOuts, []);
  assert.equal(calls.alerts.length, 0);
});

test('a storage failure answers 500 so Meta redelivers', async () => {
  const { handler } = harness({
    recordEvents: async () => {
      throw new Error('db down');
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handler.POST(post(inboundText('هلا')))).status, 500);
  } finally {
    console.error = original;
  }
});

test('an alert or opt-out failure does not change the 200 answer', async () => {
  const { handler } = harness({
    alertInbound: async () => {
      throw new Error('resend down');
    },
    applyOptOut: async () => {
      throw new Error('db down');
    },
  });
  const original = console.error;
  console.error = () => {};
  try {
    assert.equal((await handler.POST(post(inboundText('هلا')))).status, 200);
    assert.equal((await handler.POST(post(inboundText('stop', 'wamid.IN2')))).status, 200);
  } finally {
    console.error = original;
  }
});
