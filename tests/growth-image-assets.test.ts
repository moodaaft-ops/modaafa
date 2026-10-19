import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { probeImage } from '../lib/image-assets/probe';
import { extractImageCandidates } from '../lib/image-assets/extract';
import { evaluateImage, centerCrop } from '../lib/image-assets/evaluate';
import { slotsFor, ratioMatches, meetsMinimum, SLOT_SPECS } from '../lib/image-assets/requirements';
import { fetchImage } from '../lib/image-assets/fetch';
import {
  validateCreateImageAssetsParams, executeCreateImageAssets, validateCreateImageAssets, imageAssetName,
} from '../lib/image-assets/execute';
import { CID, P, makeCustomer } from './growth-fixtures';

// ---- byte builders ------------------------------------------------------------

function png(w: number, h: number, pad = 0): Uint8Array {
  const b = new Uint8Array(33 + pad);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  b.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}
function jpeg(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  b.set([0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3], 20);
  return b;
}
function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x58]);
  b[24] = (w - 1) & 255; b[25] = ((w - 1) >> 8) & 255; b[26] = ((w - 1) >> 16) & 255;
  b[27] = (h - 1) & 255; b[28] = ((h - 1) >> 8) & 255; b[29] = ((h - 1) >> 16) & 255;
  return b;
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('probe reads png, jpeg, webp sizes and rejects junk', () => {
  assert.deepEqual(probeImage(png(1200, 628)), { format: 'png', width: 1200, height: 628 });
  assert.deepEqual(probeImage(jpeg(1080, 1350)), { format: 'jpeg', width: 1080, height: 1350 });
  assert.deepEqual(probeImage(webpVp8x(800, 600)), { format: 'webp', width: 800, height: 600 });
  assert.equal(probeImage(new Uint8Array(64)), null);
  assert.equal(probeImage(new Uint8Array(4)), null);
});

// ---- ratios and minimums -------------------------------------------------------------

test('slots: 1.91:1, 1:1 and 4:5 with their minimum pixel sizes', () => {
  assert.deepEqual(slotsFor(1200, 628), ['marketing']);
  assert.deepEqual(slotsFor(1200, 1200), ['square', 'logo']);
  assert.deepEqual(slotsFor(960, 1200), ['portrait']);
  assert.deepEqual(slotsFor(1000, 1000), ['square', 'logo']);
  assert.deepEqual(slotsFor(400, 209), [], 'ratio ok but below 600x314');
  assert.deepEqual(slotsFor(1200, 700), [], 'ratio off');
  assert.ok(ratioMatches(1910, 1000, SLOT_SPECS.marketing));
  assert.ok(!meetsMinimum(299, 299, SLOT_SPECS.square));
});

test('crops: the largest centered crop, only when it meets the slot minimum', () => {
  const crop = centerCrop(1600, 1200, 'marketing');
  assert.ok(crop);
  assert.equal(crop!.width, 1600);
  assert.equal(crop!.height, Math.round(1600 / 1.91));
  assert.equal(crop!.y, Math.floor((1200 - crop!.height) / 2));
  assert.equal(centerCrop(200, 200, 'marketing'), null);
  const sq = centerCrop(1600, 1200, 'square');
  assert.deepEqual([sq!.width, sq!.height, sq!.x], [1200, 1200, 200]);
});

test('evaluate: fits, crops, logo handling, size and format limits', () => {
  const base = { url: 'https://shop.example.com/a.png', sha256: 'a'.repeat(64), source: 'img' as const, alt: '' };
  const hero = evaluateImage({ ...base, width: 1200, height: 628, bytes: 400_000, format: 'png' });
  assert.deepEqual(hero.fits, ['marketing']);
  const wide = evaluateImage({ ...base, width: 1600, height: 1200, bytes: 400_000, format: 'jpeg' });
  assert.deepEqual(wide.fits, []);
  assert.ok(wide.crops.some((c) => c.slot === 'marketing'));
  assert.ok(wide.crops.some((c) => c.slot === 'square'));
  const logo = evaluateImage({ ...base, url: 'https://shop.example.com/logo.png', width: 512, height: 512, bytes: 40_000, format: 'png' });
  assert.deepEqual(logo.fits, ['logo']);
  const heavyLogo = evaluateImage({ ...base, url: 'https://shop.example.com/logo.png', width: 512, height: 512, bytes: 300_000, format: 'png' });
  assert.deepEqual(heavyLogo.fits, []);
  assert.ok(heavyLogo.issues_ar.length > 0);
  const webp = evaluateImage({ ...base, width: 1200, height: 628, bytes: 1000, format: 'webp' });
  assert.deepEqual(webp.fits, []);
  const huge = evaluateImage({ ...base, width: 1200, height: 628, bytes: 6 * 1024 * 1024, format: 'png' });
  assert.deepEqual(huge.fits, []);
  const tiny = evaluateImage({ ...base, width: 100, height: 52, bytes: 1000, format: 'png' });
  assert.deepEqual([tiny.fits.length, tiny.crops.length], [0, 0]);
  assert.ok(tiny.issues_ar.length > 0);
});

// ---- extraction ---------------------------------------------------------------------

test('extract: og, twitter, img, srcset (widest), https only, no data uris, no svg, deduped', () => {
  const html = `
    <meta property="og:image" content="/img/hero.jpg">
    <meta name="twitter:image" content="https://cdn.example.com/t.png">
    <meta property="og:image" content="http://insecure.example.com/x.jpg">
    <link rel="apple-touch-icon" href="/icon.png">
    <img src="/img/hero.jpg" alt="x">
    <img src="data:image/png;base64,AAAA">
    <img src="/logo.svg">
    <img srcset="/a-400.jpg 400w, /a-1200.jpg 1200w, /a-800.jpg 800w" src="/a-400.jpg" alt="منتج">`;
  const c = extractImageCandidates(html, 'https://shop.example.com/offer');
  const urls = c.map((x) => x.url);
  assert.ok(urls.includes('https://shop.example.com/img/hero.jpg'));
  assert.ok(urls.includes('https://cdn.example.com/t.png'));
  assert.ok(urls.includes('https://shop.example.com/a-1200.jpg'));
  assert.ok(!urls.some((u) => u.startsWith('http://') || u.startsWith('data:') || u.endsWith('.svg')));
  assert.equal(new Set(urls).size, urls.length);
  assert.equal(c.find((x) => x.url.endsWith('/icon.png'))?.source, 'icon');
});

// ---- fetching -----------------------------------------------------------------------

const resolve = async () => ['93.184.216.34'];
function transportOf(map: Record<string, { status?: number; type?: string; body?: Uint8Array; location?: string }>) {
  return async ({ url }: any) => {
    const hit = map[url.toString()];
    if (!hit) return new Response(null, { status: 404 });
    const headers: Record<string, string> = {};
    if (hit.type) headers['content-type'] = hit.type;
    if (hit.location) headers.location = hit.location;
    return new Response(hit.body ? Buffer.from(hit.body) : null, { status: hit.status ?? 200, headers });
  };
}

test('fetch: reads dimensions and the hash, follows a redirect, and refuses non-images', async () => {
  const bytes = png(1200, 628);
  const transport = transportOf({
    'https://shop.example.com/a.png': { type: 'image/png', body: bytes },
    'https://shop.example.com/r': { status: 302, location: 'https://shop.example.com/a.png' },
    'https://shop.example.com/page': { type: 'text/html', body: new Uint8Array([60, 104]) },
  });
  const direct = await fetchImage('https://shop.example.com/a.png', { resolve, transport });
  assert.ok(direct.ok);
  if (direct.ok) {
    assert.equal(direct.sha256, sha(bytes));
    assert.equal(direct.probe.width, 1200);
  }
  assert.equal((await fetchImage('https://shop.example.com/r', { resolve, transport })).ok, true);
  const html = await fetchImage('https://shop.example.com/page', { resolve, transport });
  assert.deepEqual([html.ok, !html.ok && html.code], [false, 'not_image']);
});

test('fetch: private addresses, plain http, oversize and unreadable bodies are refused', async () => {
  const transport = transportOf({
    'https://shop.example.com/big.png': { type: 'image/png', body: png(1200, 628, 5 * 1024 * 1024 + 10) },
    'https://shop.example.com/bad.png': { type: 'image/png', body: new Uint8Array(100) },
  });
  const priv = await fetchImage('https://shop.example.com/a.png', { resolve: async () => ['10.0.0.5'], transport });
  assert.deepEqual([priv.ok, !priv.ok && priv.code], [false, 'unsafe_url']);
  const http = await fetchImage('http://shop.example.com/a.png', { resolve, transport });
  assert.equal(http.ok, false);
  const big = await fetchImage('https://shop.example.com/big.png', { resolve, transport });
  assert.deepEqual([big.ok, !big.ok && big.code], [false, 'too_large']);
  const bad = await fetchImage('https://shop.example.com/bad.png', { resolve, transport });
  assert.deepEqual([bad.ok, !bad.ok && bad.code], [false, 'unreadable']);
});

// ---- card params and execution ------------------------------------------------------

const bytes = png(1200, 628);
const item = { url: 'https://shop.example.com/a.png', sha256: sha(bytes), width: 1200, height: 628, bytes: bytes.length, slot: 'marketing' as const };

test('params: slot fit, hash format, counts and duplicates are enforced', () => {
  assert.equal(validateCreateImageAssetsParams({ images: [item] }).ok, true);
  assert.equal(validateCreateImageAssetsParams({ images: [] }).ok, false);
  assert.equal(validateCreateImageAssetsParams({ images: [{ ...item, slot: 'square' }] }).ok, false, 'wrong ratio for the slot');
  assert.equal(validateCreateImageAssetsParams({ images: [{ ...item, sha256: 'xyz' }] }).ok, false);
  assert.equal(validateCreateImageAssetsParams({ images: [{ ...item, url: 'http://shop.example.com/a.png' }] }).ok, false);
  assert.equal(validateCreateImageAssetsParams({ images: [item, item] }).ok, false);
  assert.equal(validateCreateImageAssetsParams({ images: Array.from({ length: 9 }, (_, i) => ({ ...item, sha256: String(i).repeat(64) })) }).ok, false);
});

const transport = transportOf({ 'https://shop.example.com/a.png': { type: 'image/png', body: bytes } });
const deps = { resolve, transport };
const readbackRows = [{ asset: { resourceName: `${P}/assets/31`, imageAsset: { fullSize: { widthPixels: 1200, heightPixels: 628 } } } }];

test('execute: re-downloads, verifies the hash, validateOnly then live, readback by dimensions, not reversible', async () => {
  const stub = makeCustomer(
    [{ match: /WHERE asset\.name =/, rows: [] }, { match: /asset\.image_asset\.full_size/, rows: readbackRows }],
    { mutateNames: () => [`${P}/assets/31`] }
  );
  const result = await executeCreateImageAssets({ images: [item] }, stub, CID, deps);
  assert.deepEqual(stub.mutates.map((m: any) => m.validateOnly), [true, false]);
  const create = stub.mutates[1].ops[0].asset_operation.create;
  assert.equal(create.type, 'IMAGE');
  assert.equal(create.name, imageAssetName(item));
  assert.equal(Buffer.from(create.image_asset.data, 'base64').length, bytes.length);
  assert.equal(result.readback.ok, true);
  assert.equal(result.rollback_payload.reversible, false);
  assert.deepEqual(result.rollback_payload.retained_resources, [`${P}/assets/31`]);
});

test('execute: an image that changed since approval uploads nothing', async () => {
  const stub = makeCustomer([{ match: /WHERE asset\.name =/, rows: [] }]);
  const changed = transportOf({ 'https://shop.example.com/a.png': { type: 'image/png', body: png(1200, 628, 5) } });
  await assert.rejects(() => executeCreateImageAssets({ images: [item] }, stub, CID, { resolve, transport: changed }), /changed/);
  assert.equal(stub.mutates.length, 0);
});

test('execute: an asset with the same name is reused, not uploaded twice', async () => {
  const stub = makeCustomer([
    { match: /WHERE asset\.name =/, rows: [{ asset: { resourceName: `${P}/assets/31` } }] },
    { match: /asset\.image_asset\.full_size/, rows: readbackRows },
  ]);
  const result = await executeCreateImageAssets({ images: [item] }, stub, CID, deps);
  assert.equal(stub.mutates.length, 0);
  assert.equal(result.assets[0].reused, true);
});

test('validate: only validateOnly calls are made', async () => {
  const stub = makeCustomer([{ match: /WHERE asset\.name =/, rows: [] }]);
  const out = await validateCreateImageAssets({ images: [item] }, stub, deps);
  assert.equal(out.to_create, 1);
  assert.ok(stub.mutates.every((m: any) => m.validateOnly));
});

test('a wrong size readback is reported, not hidden', async () => {
  const stub = makeCustomer(
    [{ match: /WHERE asset\.name =/, rows: [] }, { match: /asset\.image_asset\.full_size/, rows: [{ asset: { imageAsset: { fullSize: { widthPixels: 10, heightPixels: 10 } } } }] }],
    { mutateNames: () => [`${P}/assets/31`] }
  );
  const result = await executeCreateImageAssets({ images: [item] }, stub, CID, deps);
  assert.equal(result.readback.ok, false);
});
