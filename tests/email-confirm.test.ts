import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { NextRequest } from 'next/server';

import {
  authErrorFromHash,
  classifyVerifyError,
  parseConfirmParams,
  verifyEmailToken,
} from '../lib/auth/email-confirm';
import { createEmailVerifyHandler } from '../lib/auth/email-confirm-handler';

const APP = 'https://ai.modaafa.com';
const HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const allowed = [APP];

test('a valid link parses and defaults to the dashboard', () => {
  const result = parseConfirmParams({ tokenHash: HASH, type: 'email' }, allowed);
  assert.deepEqual(result, { ok: true, params: { tokenHash: HASH, type: 'email', next: '/dashboard' } });
});

test('only the three email OTP types are accepted', () => {
  for (const type of ['email', 'magiclink', 'signup']) {
    assert.equal(parseConfirmParams({ tokenHash: HASH, type }, allowed).ok, true, type);
  }
  for (const type of ['recovery', 'invite', 'email_change', 'sms', '', 'EMAIL']) {
    assert.equal(parseConfirmParams({ tokenHash: HASH, type }, allowed).ok, false, type);
  }
});

test('a missing, short or malformed token is rejected before reaching Supabase', () => {
  for (const tokenHash of [undefined, null, '', 'abc', 'a'.repeat(15), `${HASH} DROP`, `${HASH}&x=1`, 'a'.repeat(300)]) {
    assert.equal(parseConfirmParams({ tokenHash, type: 'email' }, allowed).ok, false, String(tokenHash));
  }
});

test('an explicit next path is kept, an external one is replaced by the default', () => {
  const kept = parseConfirmParams({ tokenHash: HASH, type: 'email', next: '/billing?plan=growth' }, allowed);
  assert.equal(kept.ok && kept.params.next, '/billing?plan=growth');

  for (const next of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)']) {
    const result = parseConfirmParams({ tokenHash: HASH, type: 'email', next }, allowed);
    assert.equal(result.ok && result.params.next, '/dashboard', next);
  }
});

test('next is read from redirect_to only when that points at this app', () => {
  const own = parseConfirmParams(
    { tokenHash: HASH, type: 'email', redirectTo: `${APP}/auth/callback?next=${encodeURIComponent('/billing?plan=growth')}` },
    allowed,
  );
  assert.equal(own.ok && own.params.next, '/billing?plan=growth');

  const foreign = parseConfirmParams(
    { tokenHash: HASH, type: 'email', redirectTo: 'https://evil.example/auth/callback?next=/billing' },
    allowed,
  );
  assert.equal(foreign.ok && foreign.params.next, '/dashboard');

  const garbage = parseConfirmParams({ tokenHash: HASH, type: 'email', redirectTo: 'not a url' }, allowed);
  assert.equal(garbage.ok && garbage.params.next, '/dashboard');
});

test('Supabase otp_expired and used-link messages map to the expired-link message', () => {
  assert.equal(classifyVerifyError({ code: 'otp_expired' }), 'auth_link_expired');
  assert.equal(classifyVerifyError({ message: 'Email link is invalid or has expired' }), 'auth_link_expired');
  assert.equal(classifyVerifyError({ message: 'Token has already been used' }), 'auth_link_expired');
  assert.equal(classifyVerifyError({ code: 'unexpected_failure', message: 'database down', status: 500 }), 'auth_callback_failed');
  assert.equal(classifyVerifyError(null), 'auth_callback_failed');
});

test('verifyEmailToken passes the token hash and type to Supabase and reports success', async () => {
  const seen: unknown[] = [];
  const outcome = await verifyEmailToken(
    {
      auth: {
        verifyOtp: async (args) => {
          seen.push(args);
          return { error: null };
        },
      },
    },
    { tokenHash: HASH, type: 'email' },
  );
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(seen, [{ token_hash: HASH, type: 'email' }]);
});

test('verifyEmailToken never puts the token or the message into the log detail', async () => {
  const outcome = await verifyEmailToken(
    { auth: { verifyOtp: async () => ({ error: { code: 'otp_expired', message: `link for user@example.com ${HASH}`, status: 403 } }) } },
    { tokenHash: HASH, type: 'email' },
  );
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.code, 'auth_link_expired');
  assert.equal(outcome.detail, 'code=otp_expired status=403');
  assert.ok(!outcome.detail.includes(HASH));
  assert.ok(!outcome.detail.includes('@'));
});

test('verifyEmailToken turns a thrown client error into a generic failure', async () => {
  const outcome = await verifyEmailToken(
    { auth: { verifyOtp: async () => { throw new Error('network'); } } },
    { tokenHash: HASH, type: 'email' },
  );
  assert.deepEqual(outcome, { ok: false, code: 'auth_callback_failed', detail: 'code=thrown status=n/a' });
});

test('the exact fragment Supabase sent the customer is recognised', () => {
  const hash = '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired';
  assert.equal(authErrorFromHash(hash), 'auth_link_expired');
  assert.equal(authErrorFromHash('#error=access_denied'), 'auth_link_expired');
  assert.equal(authErrorFromHash(''), null);
  assert.equal(authErrorFromHash(null), null);
  assert.equal(authErrorFromHash('#section-2'), null);
  assert.equal(authErrorFromHash('#access_token=abc&type=signup'), null);
});

// ---- POST /auth/verify -----------------------------------------------------

function post(fields: Record<string, string>, headers: Record<string, string> = { origin: APP }) {
  const body = new URLSearchParams(fields);
  return new NextRequest(`${APP}/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

function handlerWith(verifyOtp: (args: { token_hash: string; type: string }) => Promise<{ error: { code?: string; status?: number } | null }>) {
  let created = 0;
  const handler = createEmailVerifyHandler({
    createSupabase: async () => {
      created += 1;
      return { auth: { verifyOtp: verifyOtp as never } };
    },
  });
  return { handler, created: () => created };
}

test('a good POST spends the token and redirects to next with 303', async () => {
  const calls: unknown[] = [];
  const { handler } = handlerWith(async (args) => {
    calls.push(args);
    return { error: null };
  });
  const response = await handler(post({ token_hash: HASH, type: 'email', next: '/billing' }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${APP}/billing`);
  assert.deepEqual(calls, [{ token_hash: HASH, type: 'email' }]);
});

test('a cross-site POST is refused and the token is not touched', async () => {
  const { handler, created } = handlerWith(async () => ({ error: null }));
  const crossSite: Array<Record<string, string>> = [
    { origin: 'https://evil.example' },
    { origin: 'null' },
    { referer: 'https://evil.example/x' },
  ];
  for (const headers of crossSite) {
    const response = await handler(post({ token_hash: HASH, type: 'email' }, headers));
    assert.equal(response.status, 303);
    assert.equal(response.headers.get('location'), `${APP}/login?error=invalid_origin`);
  }
  assert.equal(created(), 0);
});

test('an expired or already used token sends the person to the expired-link message', async () => {
  const { handler } = handlerWith(async () => ({ error: { code: 'otp_expired', status: 403 } }));
  const response = await handler(post({ token_hash: HASH, type: 'email' }));
  assert.equal(response.status, 303);
  assert.equal(response.headers.get('location'), `${APP}/login?error=auth_link_expired`);
});

test('a malformed POST never reaches Supabase', async () => {
  const { handler, created } = handlerWith(async () => ({ error: null }));
  const response = await handler(post({ token_hash: 'short', type: 'email' }));
  assert.equal(response.headers.get('location'), `${APP}/login?error=auth_callback_failed`);
  assert.equal(created(), 0);
});

test('an external next in the POST cannot be used as an open redirect', async () => {
  const { handler } = handlerWith(async () => ({ error: null }));
  const response = await handler(post({ token_hash: HASH, type: 'email', next: 'https://evil.example/steal' }));
  assert.equal(response.headers.get('location'), `${APP}/dashboard`);
});

// ---- Email templates (Supabase dashboard copy) -------------------------------

for (const file of ['confirm-signup.html', 'magic-link.html']) {
  test(`${file} sends the link through /auth/confirm and not the one-shot ConfirmationURL`, () => {
    const html = readFileSync(new URL(`../docs/auth-email-templates/${file}`, import.meta.url), 'utf8');
    assert.ok(html.includes('{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}'), 'token_hash link');
    assert.ok(html.includes('redirect_to={{ .RedirectTo }}'), 'redirect_to is carried');
    assert.ok(!html.includes('{{ .ConfirmationURL }}'), 'must not use the link a scanner can burn');
    assert.ok(!/[—–]/.test(html), 'no long or medium dashes in Arabic copy');
    assert.ok(!html.includes('Inter'), 'no Inter font');
  });
}
