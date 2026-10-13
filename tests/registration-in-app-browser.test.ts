import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildOpenInBrowserHref,
  buildReopenUrl,
  detectInAppBrowser,
} from '../lib/registration/in-app-browser';

const UA = {
  tiktokIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_40.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/ar Region/SA',
  tiktokAndroid:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 trill_400104 BytedanceWebview/d8a21c6',
  instagramIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0.0.0.0 (iPhone15,2; iOS 18_5; ar_SA)',
  facebookIos:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/480.0.0.0;FBBV/1]',
  snapchatAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36 Snapchat/13.10.0.0',
  safari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
};

test('detects TikTok on iOS and Android', () => {
  assert.deepEqual(detectInAppBrowser(UA.tiktokIos), { app: 'tiktok', os: 'ios' });
  assert.deepEqual(detectInAppBrowser(UA.tiktokAndroid), { app: 'tiktok', os: 'android' });
});

test('detects the other in-app browsers', () => {
  assert.equal(detectInAppBrowser(UA.instagramIos)?.app, 'instagram');
  assert.equal(detectInAppBrowser(UA.facebookIos)?.app, 'facebook');
  assert.equal(detectInAppBrowser(UA.snapchatAndroid)?.app, 'snapchat');
});

test('leaves real browsers and empty user agents alone', () => {
  assert.equal(detectInAppBrowser(UA.safari), null);
  assert.equal(detectInAppBrowser(UA.chromeAndroid), null);
  assert.equal(detectInAppBrowser(''), null);
  assert.equal(detectInAppBrowser(null), null);
});

test('the reopen URL carries campaign parameters and nothing else', () => {
  const url = buildReopenUrl('https://ai.modaafa.com', '/register', {
    utm_source: 'tiktok',
    utm_content: 'jari',
    ttclid: 'E.C.P.abc123',
    landing_path: '/',
    captured_at: '2026-10-13T10:00:00.000Z',
  });
  assert.equal(url.origin, 'https://ai.modaafa.com');
  assert.equal(url.pathname, '/register');
  assert.equal(url.searchParams.get('utm_source'), 'tiktok');
  assert.equal(url.searchParams.get('utm_content'), 'jari');
  assert.equal(url.searchParams.get('ttclid'), 'E.C.P.abc123');
  assert.equal(url.searchParams.has('landing_path'), false);
  assert.equal(url.searchParams.has('captured_at'), false);
});

test('Android gets a Chrome intent with the plain link as fallback', () => {
  const target = new URL('https://ai.modaafa.com/register?utm_source=tiktok&ttclid=abc123');
  const href = buildOpenInBrowserHref(target, 'android');
  assert.ok(href?.startsWith('intent://ai.modaafa.com/register?utm_source=tiktok&ttclid=abc123#Intent;scheme=https;'));
  assert.ok(href?.includes('package=com.android.chrome'));
  assert.ok(href?.includes(`S.browser_fallback_url=${encodeURIComponent(target.toString())}`));
  assert.ok(href?.endsWith(';end'));
});

test('iOS gets the Safari scheme, other platforms and plain http get nothing', () => {
  const target = new URL('https://ai.modaafa.com/register?utm_source=tiktok');
  assert.equal(buildOpenInBrowserHref(target, 'ios'), 'x-safari-https://ai.modaafa.com/register?utm_source=tiktok');
  assert.equal(buildOpenInBrowserHref(target, 'other'), null);
  assert.equal(buildOpenInBrowserHref(new URL('http://127.0.0.1:3000/register'), 'ios'), null);
});
