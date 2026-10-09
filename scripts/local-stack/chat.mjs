// /api/chat/start against the running app with real session cookies (10 checks).
// Needs app.sh and isolation.mjs (which writes the synthetic users) first.
import { createServerClient } from '@supabase/ssr';
import fs from 'node:fs';
import path from 'node:path';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const base = `http://127.0.0.1:${process.env.APP_PORT ?? 3100}`;
const users = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '.local-stack/users.json'), 'utf8'));

async function cookieFor(email) {
  const jar = new Map();
  const client = createServerClient(url, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: { getAll: () => [...jar].map(([name, value]) => ({ name, value })), setAll: (list) => list.forEach(({ name, value }) => jar.set(name, value)) },
  });
  const signed = await client.auth.signInWithPassword({ email, password: users.password });
  if (signed.error) throw signed.error;
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

const post = (cookie, body, origin = base) =>
  fetch(`${base}/api/chat/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, json: await res.json().catch(() => null) }));

let failures = 0;
let total = 0;
function check(name, ok, note = '') {
  total += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${note ? `  [${note}]` : ''}`);
}

const cookieA = await cookieFor(users.emailA);
const cookieB = await cookieFor(users.emailB);
let r = await post(null, { message: 'hello' });
check('no session cookie gives 401', r.status === 401, r.status);
r = await post(cookieA, { message: 'hello' }, 'http://evil.example');
check('a foreign origin gives 403', r.status === 403, r.status);
r = await post(cookieA, {});
check('an empty body gives 400', r.status === 400, r.status);
r = await post(cookieA, { message: 'وش وضع حسابي؟' });
check('A chat turn works', r.status === 200, `${r.status} keys=${Object.keys(r.json ?? {}).join(',')}`);
const sessionA = r.json?.sessionId;
const replyA = JSON.stringify(r.json);
check('A gets a session id', Boolean(sessionA));
r = await post(cookieB, { message: 'continue', sessionId: sessionA });
check('B cannot use the session of A (404)', r.status === 404, r.status);
r = await post(cookieB, { message: 'وش وضع حسابي؟', customerId: '1234567890' });
check('B cannot pick a customer id it does not own', r.status === 404, r.status);
r = await post(cookieA, { message: 'continue', sessionId: sessionA });
check('A continues its own session', r.status === 200, r.status);
r = await post(cookieA, { message: 'x', sessionId: 'not-a-uuid' });
check('a malformed session id gives 404', r.status === 404, r.status);
r = await post(cookieA, { message: 'x', action: { type: 'request_apply', recommendationId: '00000000-0000-0000-0000-000000000000' } });
check('an unknown recommendation gives 404', r.status === 404, r.status);
const leaks = replyA.includes(users.B) || replyA.includes('synthetic account B');
console.log(`reply of A leaks data of B: ${leaks}`);
const calls = await (await fetch(`http://127.0.0.1:${process.env.LLM_STUB_PORT ?? 54330}/__calls`)).text();
console.log(`model calls made to the local stub: ${calls}`);
console.log(`${failures} failures of ${total}`);
process.exit(failures === 0 && total === 10 && !leaks ? 0 : 1);
