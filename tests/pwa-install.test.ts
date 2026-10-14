import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DISMISS_COOLDOWN_MS,
  isChromiumFamily,
  isIosThirdPartyBrowser,
  parseInstallMemory,
  resolveInstallMode,
  shouldOfferInstall,
} from '../lib/pwa/install';

const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.6478.153 Mobile/15E148 Safari/604.1',
  iphoneWebView:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
  iphoneTikTok:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/ar Region/SA',
  macSafari17:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macSafari16:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',
  macChrome:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  winEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
  androidWebView:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36',
  androidTikTok:
    'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Mobile Safari/537.36 musical_ly_2023501030 BytedanceWebview/d8a21c6',
  winFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
};

function mode(userAgent: string, over: { maxTouchPoints?: number; standalone?: boolean; hasPromptEvent?: boolean } = {}) {
  return resolveInstallMode({ userAgent, maxTouchPoints: 0, standalone: false, hasPromptEvent: false, ...over });
}

test('an app that is already installed is never offered the install again', () => {
  assert.equal(mode(UA.androidChrome, { standalone: true, hasPromptEvent: true }), 'installed');
  assert.equal(mode(UA.iphoneSafari, { standalone: true }), 'installed');
});

test('iPhone: Safari and Chrome get the share-sheet steps, a bare web view gets nothing', () => {
  assert.equal(mode(UA.iphoneSafari, { maxTouchPoints: 5 }), 'ios');
  assert.equal(mode(UA.iphoneChrome, { maxTouchPoints: 5 }), 'ios');
  assert.equal(mode(UA.iphoneWebView, { maxTouchPoints: 5 }), 'none');
  assert.equal(isIosThirdPartyBrowser(UA.iphoneChrome), true);
  assert.equal(isIosThirdPartyBrowser(UA.iphoneSafari), false);
});

test('iPad that reports itself as a Mac is told apart from a Mac by touch', () => {
  assert.equal(mode(UA.macSafari17, { maxTouchPoints: 5 }), 'ios');
  assert.equal(mode(UA.macSafari17, { maxTouchPoints: 0 }), 'mac-safari');
});

test('Safari on a Mac is offered Add to Dock from version 17 only', () => {
  assert.equal(mode(UA.macSafari17), 'mac-safari');
  assert.equal(mode(UA.macSafari16), 'none');
});

test('Chrome and Edge get the one-tap prompt only once the browser has raised its event', () => {
  for (const ua of [UA.macChrome, UA.winEdge, UA.androidChrome]) {
    assert.equal(mode(ua, { hasPromptEvent: true }), 'native', ua);
    assert.equal(mode(ua, { hasPromptEvent: false }), 'none', ua);
  }
});

test('Chrome on a Mac is not mistaken for Safari even though its UA says Safari', () => {
  assert.equal(mode(UA.macChrome, { hasPromptEvent: true }), 'native');
});

test('Firefox on desktop has nothing to offer even if some event were present', () => {
  assert.equal(mode(UA.winFirefox, { hasPromptEvent: true }), 'native', 'resolve trusts the event: it only exists where the browser raised it');
  assert.equal(isChromiumFamily(UA.winFirefox), false, 'so the component never registers the worker for Firefox');
});

test('in-app browsers never get a banner, on iPhone or Android', () => {
  assert.equal(mode(UA.iphoneTikTok, { maxTouchPoints: 5 }), 'none');
  assert.equal(mode(UA.androidTikTok, { hasPromptEvent: true }), 'none');
});

test('Chromium family: Chrome, Edge and Samsung yes; Android web views, iOS Chrome and Firefox no', () => {
  assert.equal(isChromiumFamily(UA.androidChrome), true);
  assert.equal(isChromiumFamily(UA.winEdge), true);
  assert.equal(isChromiumFamily(UA.macChrome), true);
  assert.equal(isChromiumFamily(UA.androidWebView), false);
  assert.equal(isChromiumFamily(UA.iphoneChrome), false);
  assert.equal(isChromiumFamily(UA.macSafari17), false);
});

test('parseInstallMemory survives garbage and keeps only the two known fields', () => {
  assert.deepEqual(parseInstallMemory(null), {});
  assert.deepEqual(parseInstallMemory(''), {});
  assert.deepEqual(parseInstallMemory('not json'), {});
  assert.deepEqual(parseInstallMemory('[1,2]'), {});
  assert.deepEqual(parseInstallMemory('{"dismissedAt":"yesterday","installed":"yes"}'), {});
  assert.deepEqual(parseInstallMemory('{"dismissedAt":1700000000000,"installed":true,"x":1}'), {
    dismissedAt: 1700000000000,
    installed: true,
  });
});

test('shouldOfferInstall: nothing to offer, installed, and the 30-day cooldown after "not now"', () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldOfferInstall('none', {}, now), false);
  assert.equal(shouldOfferInstall('installed', {}, now), false);
  assert.equal(shouldOfferInstall('native', {}, now), true);
  assert.equal(shouldOfferInstall('ios', { installed: true }, now), false);

  assert.equal(shouldOfferInstall('ios', { dismissedAt: now - 1000 }, now), false, 'a second ago');
  assert.equal(shouldOfferInstall('ios', { dismissedAt: now - DISMISS_COOLDOWN_MS + 1 }, now), false, 'one ms short of a month');
  assert.equal(shouldOfferInstall('ios', { dismissedAt: now - DISMISS_COOLDOWN_MS }, now), true, 'a month exactly');
  assert.equal(shouldOfferInstall('ios', { dismissedAt: now + 60_000 }, now), false, 'a clock set backwards keeps it quiet');
});
