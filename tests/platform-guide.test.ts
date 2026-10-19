import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PLATFORM_GUIDE_AFTER_START_SECONDS,
  PLATFORM_GUIDE_CHAPTERS,
  PLATFORM_GUIDE_DURATION_SECONDS,
  PLATFORM_GUIDE_VIDEO_ID,
  formatGuideTime,
  platformGuideEmbedUrl,
} from '../lib/onboarding/platform-guide';
import { buildContentSecurityPolicy } from '../lib/security/csp';

const startOf = (n: number) => new URL(platformGuideEmbedUrl({ start: n })).searchParams.get('start');

test('the guide embeds only the privacy-enhanced host the CSP allows', () => {
  const url = new URL(platformGuideEmbedUrl());
  assert.equal(url.origin, 'https://www.youtube-nocookie.com');
  assert.equal(url.pathname, `/embed/${PLATFORM_GUIDE_VIDEO_ID}`);
  assert.ok(buildContentSecurityPolicy('n').includes(`frame-src ${url.origin}`));
});

test('the video id is well formed', () => {
  assert.match(PLATFORM_GUIDE_VIDEO_ID, /^[A-Za-z0-9_-]{11}$/);
});

test('the guide never autoplays unless asked', () => {
  assert.equal(new URL(platformGuideEmbedUrl()).searchParams.get('autoplay'), '0');
  assert.equal(new URL(platformGuideEmbedUrl({ autoplay: true })).searchParams.get('autoplay'), '1');
});

test('the start second is clamped into the video', () => {
  assert.equal(startOf(-5), '0');
  assert.equal(startOf(Number.NaN), '0');
  assert.equal(startOf(132.9), '132');
  assert.equal(startOf(99999), String(PLATFORM_GUIDE_DURATION_SECONDS - 1));
});

test('chapters start at 0:00, ascend, stay inside the video and have unique ids', () => {
  assert.equal(PLATFORM_GUIDE_CHAPTERS[0].start, 0);
  for (let i = 1; i < PLATFORM_GUIDE_CHAPTERS.length; i += 1) {
    assert.ok(PLATFORM_GUIDE_CHAPTERS[i].start > PLATFORM_GUIDE_CHAPTERS[i - 1].start, `chapter ${i} out of order`);
  }
  assert.ok(PLATFORM_GUIDE_CHAPTERS[PLATFORM_GUIDE_CHAPTERS.length - 1].start < PLATFORM_GUIDE_DURATION_SECONDS);
  assert.equal(new Set(PLATFORM_GUIDE_CHAPTERS.map((c) => c.id)).size, PLATFORM_GUIDE_CHAPTERS.length);
});

test('«وش يصير بعد ما أبدأ؟» opens on the daily-screen chapter', () => {
  const chapter = PLATFORM_GUIDE_CHAPTERS.find((c) => c.id === 'daily');
  assert.equal(chapter?.start, PLATFORM_GUIDE_AFTER_START_SECONDS);
});

test('chapter times read like YouTube chapters', () => {
  assert.equal(formatGuideTime(0), '0:00');
  assert.equal(formatGuideTime(132), '2:12');
  assert.equal(formatGuideTime(184), '3:04');
});
