import assert from 'node:assert/strict';
import test from 'node:test';
import { guardedFetch, LANDING_USER_AGENT, MAX_BODY_BYTES, type Transport, type TransportRequest } from '../lib/landing-check/fetch';
import { isBlockedIp, parseCheckableUrl, resolvePublicAddresses, UnsafeUrlError } from '../lib/landing-check/ssrf';

// ---------------------------------------------------------------------------
// IP classification
// ---------------------------------------------------------------------------

test('private, loopback, link local and metadata IPv4 addresses are blocked', () => {
  for (const ip of [
    '0.0.0.0',
    '10.0.0.1',
    '10.255.255.255',
    '100.64.0.1',
    '127.0.0.1',
    '127.255.255.254',
    '169.254.169.254',
    '169.254.0.1',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '192.0.0.8',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('public IPv4 addresses are allowed, and the edges of the private ranges are not over-blocked', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.1', '100.63.255.255', '100.128.0.1', '203.0.114.1', '93.184.216.34']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('IPv6 loopback, unique local, link local, mapped and embedded private addresses are blocked', () => {
  for (const ip of [
    '::',
    '::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:10.0.0.1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '64:ff9b::7f00:1',
    '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1',
    '2001:db8::1',
    '2001::1',
    '[::1]',
  ]) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
});

test('public IPv6 addresses are allowed and garbage is blocked', () => {
  assert.equal(isBlockedIp('2606:4700:4700::1111'), false);
  assert.equal(isBlockedIp('2a00:1450:4001:80b::200e'), false);
  assert.equal(isBlockedIp('::ffff:8.8.8.8'), false);
  for (const junk of ['', 'not-an-ip', '999.1.1.1', '1.2.3', 'fe80::1%eth0']) {
    assert.equal(isBlockedIp(junk), true, junk);
  }
});

// ---------------------------------------------------------------------------
// URL parsing
// ---------------------------------------------------------------------------

function codeOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof UnsafeUrlError, String(error));
    return error.code;
  }
  return 'ok';
}

test('only https URLs with a real public looking host name are accepted', () => {
  assert.equal(codeOf(() => parseCheckableUrl('https://example.com/page?utm=1#x')), 'ok');
  assert.equal(codeOf(() => parseCheckableUrl('https://shop.example.sa:443/a')), 'ok');
  assert.equal(codeOf(() => parseCheckableUrl('http://example.com')), 'not_https');
  assert.equal(codeOf(() => parseCheckableUrl('ftp://example.com')), 'not_https');
  assert.equal(codeOf(() => parseCheckableUrl('file:///etc/passwd')), 'not_https');
  assert.equal(codeOf(() => parseCheckableUrl('javascript:alert(1)')), 'not_https');
  assert.equal(codeOf(() => parseCheckableUrl('https://user:pw@example.com')), 'credentials_in_url');
  assert.equal(codeOf(() => parseCheckableUrl('https://example.com:8443/')), 'bad_port');
  assert.equal(codeOf(() => parseCheckableUrl('https://example.com:22/')), 'bad_port');
  assert.equal(codeOf(() => parseCheckableUrl('not a url')), 'bad_url');
  assert.equal(codeOf(() => parseCheckableUrl('')), 'bad_url');
});

test('IP literals in every spelling and internal host names are refused', () => {
  for (const url of [
    'https://127.0.0.1/',
    'https://169.254.169.254/latest/meta-data/',
    'https://2130706433/', // decimal 127.0.0.1
    'https://0x7f.1/', // hex
    'https://0177.0.0.1/', // octal
    'https://[::1]/',
    'https://[::ffff:127.0.0.1]/',
    'https://8.8.8.8/',
  ]) {
    assert.equal(codeOf(() => parseCheckableUrl(url)), 'ip_literal', url);
  }
  for (const url of [
    'https://localhost/',
    'https://app.localhost/',
    'https://printer.local/',
    'https://metadata.google.internal/computeMetadata/v1/',
    'https://db.internal/',
    'https://router.lan/',
    'https://intranet/',
  ]) {
    assert.equal(codeOf(() => parseCheckableUrl(url)), 'blocked_host', url);
  }
});

// ---------------------------------------------------------------------------
// DNS check
// ---------------------------------------------------------------------------

test('a host that resolves to even one private address is rejected', async () => {
  await assert.rejects(resolvePublicAddresses('a.example.com', async () => ['93.184.216.34', '10.0.0.5']), (e: any) => e.code === 'private_address');
  await assert.rejects(resolvePublicAddresses('a.example.com', async () => ['127.0.0.1']), (e: any) => e.code === 'private_address');
  await assert.rejects(resolvePublicAddresses('a.example.com', async () => ['::1']), (e: any) => e.code === 'private_address');
  await assert.rejects(resolvePublicAddresses('a.example.com', async () => []), (e: any) => e.code === 'no_address');
  await assert.rejects(
    resolvePublicAddresses('a.example.com', async () => {
      throw new Error('ENOTFOUND');
    }),
    (e: any) => e.code === 'dns_failed'
  );
  const ok = await resolvePublicAddresses('a.example.com', async () => ['93.184.216.34', '2606:4700:4700::1111']);
  assert.deepEqual(ok, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:4700:4700::1111', family: 6 },
  ]);
});

// ---------------------------------------------------------------------------
// guardedFetch with a mocked transport and a mocked resolver
// ---------------------------------------------------------------------------

function html(body = '<html><head><title>x</title></head><body>hi</body></html>', status = 200, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
}
function redirect(location: string, status = 302) {
  return new Response(null, { status, headers: { location } });
}

function harness(routes: Record<string, () => Response>, dns: Record<string, string[]> = {}) {
  const requests: TransportRequest[] = [];
  const resolved: string[] = [];
  const transport: Transport = async (request) => {
    requests.push(request);
    const route = routes[request.url.toString()];
    if (!route) throw new Error(`no route for ${request.url}`);
    return route();
  };
  const resolve = async (host: string) => {
    resolved.push(host);
    return dns[host] ?? ['93.184.216.34'];
  };
  return { requests, resolved, deps: { transport, resolve } };
}

test('a normal page is fetched with the custom user agent, no cookie and the pinned address', async () => {
  const h = harness({ 'https://example.com/lp': () => html() });
  const page = await guardedFetch('https://example.com/lp', h.deps);
  assert.equal(page.ok, true);
  assert.equal(h.requests.length, 1);
  const headers = h.requests[0].headers;
  assert.equal(headers['user-agent'], LANDING_USER_AGENT);
  assert.equal(Object.keys(headers).some((name) => name.toLowerCase() === 'cookie'), false);
  assert.equal(h.requests[0].address.address, '93.184.216.34');
  if (page.ok) {
    assert.equal(page.status, 200);
    assert.match(page.html ?? '', /<title>x<\/title>/);
  }
});

test('a Set-Cookie on a response is ignored and never sent back on the next hop', async () => {
  const h = harness({
    'https://example.com/a': () => new Response(null, { status: 302, headers: { location: '/b', 'set-cookie': 'sid=1' } }),
    'https://example.com/b': () => html(),
  });
  const page = await guardedFetch('https://example.com/a', h.deps);
  assert.equal(page.ok, true);
  for (const request of h.requests) assert.equal('cookie' in request.headers, false);
});

test('private DNS answer: rejected before any request is made', async () => {
  const h = harness({ 'https://evil.example.com/': () => html() }, { 'evil.example.com': ['169.254.169.254'] });
  const page = await guardedFetch('https://evil.example.com/', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.code, 'private_address');
  assert.equal(h.requests.length, 0);
});

test('http, localhost and IP literal URLs never reach DNS or the transport', async () => {
  const h = harness({});
  for (const [url, code] of [
    ['http://example.com/', 'not_https'],
    ['https://localhost/', 'blocked_host'],
    ['https://127.0.0.1/', 'ip_literal'],
    ['https://[::1]/', 'ip_literal'],
  ] as const) {
    const page = await guardedFetch(url, h.deps);
    assert.equal(page.ok, false, url);
    if (!page.ok) assert.equal(page.code, code, url);
  }
  assert.equal(h.requests.length, 0);
  assert.equal(h.resolved.length, 0);
});

test('a redirect to a private IP literal is refused on that hop', async () => {
  const h = harness({ 'https://example.com/': () => redirect('https://169.254.169.254/latest/meta-data/') });
  const page = await guardedFetch('https://example.com/', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) {
    assert.equal(page.code, 'ip_literal');
    assert.equal(page.failedUrl, 'https://169.254.169.254/latest/meta-data/');
  }
  assert.equal(h.requests.length, 1);
});

test('a redirect to a host that resolves private is refused (DNS checked on every hop)', async () => {
  const h = harness(
    { 'https://example.com/': () => redirect('https://internal.example.net/admin') },
    { 'example.com': ['93.184.216.34'], 'internal.example.net': ['192.168.0.10'] }
  );
  const page = await guardedFetch('https://example.com/', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.code, 'private_address');
  assert.equal(h.requests.length, 1);
});

test('a redirect down to http is refused', async () => {
  const h = harness({ 'https://example.com/': () => redirect('http://example.com/plain') });
  const page = await guardedFetch('https://example.com/', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.code, 'not_https');
});

test('relative redirects work and three hops are allowed, the fourth is not', async () => {
  const three = harness({
    'https://example.com/1': () => redirect('/2'),
    'https://example.com/2': () => redirect('/3'),
    'https://example.com/3': () => redirect('/4'),
    'https://example.com/4': () => html(),
  });
  const ok = await guardedFetch('https://example.com/1', three.deps);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.redirects.length, 3);
    assert.equal(ok.finalUrl, 'https://example.com/4');
  }

  const four = harness({
    'https://example.com/1': () => redirect('/2'),
    'https://example.com/2': () => redirect('/3'),
    'https://example.com/3': () => redirect('/4'),
    'https://example.com/4': () => redirect('/5'),
    'https://example.com/5': () => html(),
  });
  const bad = await guardedFetch('https://example.com/1', four.deps);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.code, 'too_many_redirects');
});

test('a redirect loop ends at the redirect limit', async () => {
  const h = harness({ 'https://example.com/a': () => redirect('https://example.com/a') });
  const page = await guardedFetch('https://example.com/a', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.code, 'too_many_redirects');
});

test('the body is capped at 1.5 MB and flagged as truncated', async () => {
  const big = 'a'.repeat(MAX_BODY_BYTES + 5000);
  const h = harness({ 'https://example.com/': () => html(big) });
  const page = await guardedFetch('https://example.com/', h.deps);
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.equal(page.truncated, true);
    assert.equal(page.bytes, MAX_BODY_BYTES);
    assert.equal(page.html?.length, MAX_BODY_BYTES);
  }
});

test('a slow server times out after five seconds, headers or body', async () => {
  const hang = harness({});
  hang.deps.transport = () => new Promise<Response>(() => undefined);
  let t = 0;
  const realSetTimeout = global.setTimeout;
  // Fast-forward the clock instead of waiting five real seconds.
  (global as any).setTimeout = (fn: () => void, ms?: number) => realSetTimeout(fn, ms && ms >= 1000 ? 5 : ms);
  try {
    const page = await guardedFetch('https://example.com/', { ...hang.deps, now: () => (t += 0) });
    assert.equal(page.ok, false);
    if (!page.ok) assert.equal(page.code, 'timeout');
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test('timings: first byte of the last hop is shorter than the total that includes the redirect', async () => {
  let tick = 0;
  const now = () => (tick += 10); // every clock read costs 10 ms
  const h = harness({
    'https://example.com/a': () => redirect('/b'),
    'https://example.com/b': () => html(),
  });
  const page = await guardedFetch('https://example.com/a', { ...h.deps, now });
  assert.equal(page.ok, true);
  if (page.ok) {
    assert.ok(page.ttfbMs > 0);
    assert.ok(page.totalMs > page.ttfbMs);
  }
});

test('a non HTML response is not read as a page', async () => {
  const h = harness({ 'https://example.com/file.pdf': () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } }) });
  const page = await guardedFetch('https://example.com/file.pdf', h.deps);
  assert.equal(page.ok, true);
  if (page.ok) assert.equal(page.html, null);
});

test('a transport that throws becomes a network failure, never an exception', async () => {
  const h = harness({});
  const page = await guardedFetch('https://example.com/missing', h.deps);
  assert.equal(page.ok, false);
  if (!page.ok) assert.equal(page.code, 'network');
});
