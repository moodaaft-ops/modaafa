import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GUIDE_REGION_NOTICE,
  GUIDE_STEPS,
  NO_ACCOUNT_PATH,
  REVIEWED_GUIDE_VIDEOS,
  resolveGuideVideo,
} from '../lib/onboarding/ads-guide';
import { CHAT_HANDOFF_PATH } from '../lib/onboarding/chat-handoff';
import { classifyAuditStartError } from '../lib/onboarding/first-opportunities';
import { nextStepAfterConnect, safeOnboardingNext } from '../lib/onboarding/connect-progress';

test('the guide video is hidden unless a valid id is configured', () => {
  assert.equal(resolveGuideVideo(undefined), null);
  assert.equal(resolveGuideVideo(''), null);
  assert.equal(resolveGuideVideo('short'), null);
  assert.equal(resolveGuideVideo('abc"><script>1'), null);
});

test('the guide video embeds without autoplay on the privacy host', () => {
  const video = resolveGuideVideo('G9tynCxUlg4');
  assert.ok(video);
  assert.match(video.embedUrl, /^https:\/\/www\.youtube-nocookie\.com\/embed\/G9tynCxUlg4\?/);
  assert.match(video.embedUrl, /autoplay=0/);
  assert.doesNotMatch(video.embedUrl, /autoplay=1/);
});

test('the reviewed video is cut to the account-opening segment only', () => {
  assert.deepEqual(REVIEWED_GUIDE_VIDEOS.G9tynCxUlg4, { start: 76, end: 125 });
  const video = resolveGuideVideo('G9tynCxUlg4');
  assert.ok(video);
  assert.match(video.embedUrl, /[?&]start=76(&|$)/);
  assert.match(video.embedUrl, /[?&]end=125(&|$)/);
  assert.match(video.embedUrl, /autoplay=0/);
  assert.doesNotMatch(video.embedUrl, /autoplay=1/);
  // 2:20 is where campaign building starts, so the cut must end before it.
  assert.ok(video.segment.end < 140);
});

test('the player keeps its controls and keyboard', () => {
  const video = resolveGuideVideo('G9tynCxUlg4');
  assert.ok(video);
  assert.doesNotMatch(video.embedUrl, /controls=0/);
  assert.doesNotMatch(video.embedUrl, /disablekb/);
});

test('an unreviewed id fails closed instead of borrowing another video\'s cut', () => {
  for (const id of ['AAAAAAAAAAA', 'dQw4w9WgXcQ', '__proto__', 'constructor', 'toString']) {
    assert.equal(resolveGuideVideo(id), null);
  }
});

test('the region notice names Saudi Arabia, Riyadh and the riyal, without long dashes', () => {
  assert.match(GUIDE_REGION_NOTICE, /السعودية/);
  assert.match(GUIDE_REGION_NOTICE, /الرياض/);
  assert.match(GUIDE_REGION_NOTICE, /الريال/);
  assert.doesNotMatch(GUIDE_REGION_NOTICE, /[—–]|,/);
});

test('the written guide stands alone and promises nothing about the video', () => {
  assert.ok(GUIDE_STEPS.length >= 4);
  for (const step of GUIDE_STEPS) {
    assert.ok(step.title.length > 0 && step.body.length > 0);
    assert.doesNotMatch(`${step.title} ${step.body}`, /[—–]/, 'no long dashes in Arabic copy');
  }
  assert.equal(NO_ACCOUNT_PATH, '/onboarding/ads-guide');
});

test('no card step sits between connecting and the first audit', () => {
  assert.equal(nextStepAfterConnect({ linkableCount: 1, persistedSelectionStillLinked: false }), '/onboarding/first-audit');
  assert.equal(safeOnboardingNext('/onboarding/first-audit'), '/onboarding/first-audit');
});

test('audit refusal codes map to the screen that handles them', () => {
  assert.equal(classifyAuditStartError(402, 'free_audits_exhausted'), 'exhausted');
  assert.equal(classifyAuditStartError(409, 'audit_in_progress'), 'running');
  assert.equal(classifyAuditStartError(503, 'usage_storage_unavailable'), 'error');
  assert.equal(classifyAuditStartError(402, 'subscription_required'), 'error');
});

test('the chat hand-off is a plain query on the existing assistant route', () => {
  assert.equal(CHAT_HANDOFF_PATH, '/assistant?from=onboarding');
});
