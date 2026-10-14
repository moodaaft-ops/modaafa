import assert from 'node:assert/strict';
import test from 'node:test';
import { EMAIL_COPY } from '../lib/lifecycle/copy';
import { EMPTY_FACTS } from '../lib/lifecycle/types';
import { buildOptOutUrl, verifyOptOutToken } from '../lib/messaging/opt-out';
import { renderTemplate } from '../lib/messaging/render';
import { withEnv } from './support/with-env';

// The welcome mail itself is rendered from lib/lifecycle/copy.ts (`welcome_ads_connect`) and sent through
// sendTemplate; its rendering is covered by email-copy / email-render and its sending (claim, opt-out,
// provider failure, funnel event) by email-send. The legacy `send()` path and lib/messaging/templates.ts that
// this file used to test are gone, so only the opt-out token, which every optional mail still carries, stays here.

const USER_ID = '8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33';
const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' };

test('opt-out token verifies only for the right user and survives tampering checks', () =>
  withEnv(env, () => {
    const url = new URL(buildOptOutUrl(USER_ID)!);
    const t = url.searchParams.get('t');
    assert.equal(verifyOptOutToken(USER_ID, t), true);
    assert.equal(verifyOptOutToken('11111111-1111-1111-1111-111111111111', t), false);
    assert.equal(verifyOptOutToken(USER_ID, `${t}x`), false);
    assert.equal(verifyOptOutToken(USER_ID, null), false);
  }));

test('opt-out link cannot be built without a signing key', () =>
  withEnv({ UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    assert.equal(buildOptOutUrl(USER_ID), null);
  }));

test('the welcome copy renders with the /welcome link, the opt-out footer and the one-click headers', () =>
  withEnv(env, () => {
    const mail = renderTemplate({
      copy: EMAIL_COPY.welcome_ads_connect,
      templateKey: 'welcome_ads_connect',
      user: { id: USER_ID, email: 'client@example.com', name: 'أيمن أمين' },
      facts: { ...EMPTY_FACTS, firstName: 'أيمن' },
    })!;
    assert.ok(mail, 'the welcome copy has content for a new user');
    assert.match(mail.html, /هلا أيمن/);
    assert.match(mail.html, /\/m\/c\?u=/, 'the call to action is a tracked link');
    assert.match(mail.html, /\/api\/messages\/opt-out\?u=/);
    assert.match(mail.headers['List-Unsubscribe'], /^<https:\/\/ai\.modaafa\.com\/api\/messages\/opt-out/);
    assert.equal(mail.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.doesNotMatch(mail.subject + mail.html, /[—–]/);
  }));
