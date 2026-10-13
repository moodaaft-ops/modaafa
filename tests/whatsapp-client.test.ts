import test from 'node:test';
import assert from 'node:assert/strict';
import { readSendConfig, readWebhookConfig } from '../lib/whatsapp/config';
import { sendWhatsAppTemplate, sendWhatsAppText } from '../lib/whatsapp/client';

const config = { accessToken: 'tok', phoneNumberId: '1343281345540372', graphVersion: 'v23.0' };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return { impl, calls };
}

test('config stays off until the flag and every credential are set', () => {
  assert.equal(readSendConfig({}), null);
  assert.equal(readSendConfig({ WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '1' }), null);
  assert.equal(readSendConfig({ WHATSAPP_ENABLED: 'true', WHATSAPP_ACCESS_TOKEN: 'a' }), null);
  assert.equal(readSendConfig({ WHATSAPP_ENABLED: 'true', WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '""' }), null);

  const on = readSendConfig({ WHATSAPP_ENABLED: 'TRUE', WHATSAPP_ACCESS_TOKEN: ' a ', WHATSAPP_PHONE_NUMBER_ID: '1' });
  assert.deepEqual(on, { accessToken: 'a', phoneNumberId: '1', graphVersion: 'v23.0' });
  assert.equal(
    readSendConfig({ WHATSAPP_ENABLED: 'true', WHATSAPP_ACCESS_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: '1', WHATSAPP_GRAPH_VERSION: 'v99.0' })?.graphVersion,
    'v99.0',
  );

  assert.equal(readWebhookConfig({ WHATSAPP_ENABLED: 'true', WHATSAPP_APP_SECRET: 's', WHATSAPP_PHONE_NUMBER_ID: '1' }), null);
  assert.deepEqual(
    readWebhookConfig({ WHATSAPP_ENABLED: 'true', WHATSAPP_APP_SECRET: 's', WHATSAPP_VERIFY_TOKEN: 'v', WHATSAPP_PHONE_NUMBER_ID: '1' }),
    { appSecret: 's', verifyToken: 'v', phoneNumberId: '1' },
  );
});

test('a template send posts the documented Cloud API body', async () => {
  const { impl, calls } = fakeFetch(200, { messages: [{ id: 'wamid.ABC' }] });
  const result = await sendWhatsAppTemplate(
    { to: '0554235720', template: 'connect_reminder', params: [' سارة '] },
    { fetchImpl: impl, config },
  );

  assert.deepEqual(result, { status: 'sent', wamid: 'wamid.ABC' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://graph.facebook.com/v23.0/1343281345540372/messages');
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: '966554235720',
    type: 'template',
    template: {
      name: 'modaafa_connect_reminder',
      language: { code: 'ar' },
      components: [{ type: 'body', parameters: [{ type: 'text', text: 'سارة' }] }],
    },
  });
});

test('sends are refused before any network call when input is wrong', async () => {
  const { impl, calls } = fakeFetch(200, {});
  assert.deepEqual(await sendWhatsAppTemplate({ to: '0554235720', template: 'audit_ready', params: [] }, { fetchImpl: impl, config }), { status: 'invalid_params' });
  assert.deepEqual(await sendWhatsAppTemplate({ to: '0554235720', template: 'audit_ready', params: ['  '] }, { fetchImpl: impl, config }), { status: 'invalid_params' });
  assert.deepEqual(await sendWhatsAppTemplate({ to: 'abc', template: 'audit_ready', params: ['سارة'] }, { fetchImpl: impl, config }), { status: 'invalid_number' });
  assert.deepEqual(await sendWhatsAppTemplate({ to: '0554235720', template: 'audit_ready', params: ['سارة'] }, { fetchImpl: impl, config: null }), { status: 'not_configured' });
  assert.deepEqual(await sendWhatsAppText({ to: '0554235720', body: '   ' }, { fetchImpl: impl, config }), { status: 'invalid_params' });
  assert.equal(calls.length, 0);
});

test('a Meta error comes back with its code and is not retryable', async () => {
  const { impl } = fakeFetch(400, { error: { code: 131047, message: 'Re-engagement message' } });
  const result = await sendWhatsAppText({ to: '0554235720', body: 'هلا' }, { fetchImpl: impl, config });
  assert.deepEqual(result, { status: 'failed', code: 131047, message: 'Re-engagement message', retryable: false });
});

test('5xx, 429 and network failures are retryable', async () => {
  for (const status of [429, 500, 503]) {
    const { impl } = fakeFetch(status, {});
    const result = await sendWhatsAppText({ to: '0554235720', body: 'هلا' }, { fetchImpl: impl, config });
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.retryable, true, String(status));
  }
  const broken = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;
  const result = await sendWhatsAppText({ to: '0554235720', body: 'هلا' }, { fetchImpl: broken, config });
  assert.deepEqual(result, { status: 'failed', message: 'socket hang up', retryable: true });
});

test('a 200 without a message id is not reported as sent', async () => {
  const { impl } = fakeFetch(200, { messages: [] });
  const result = await sendWhatsAppText({ to: '0554235720', body: 'هلا' }, { fetchImpl: impl, config });
  assert.equal(result.status, 'failed');
});
