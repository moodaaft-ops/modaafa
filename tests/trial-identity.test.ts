import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { trialLedgerKey } from '../lib/billing/checkout-policy';
import {
  DISPOSABLE_EMAIL_DOMAINS,
  isDisposableEmailDomain,
  legacyTrialEmailKey,
  normalizeTrialEmail,
  normalizedTrialEmailKey,
  trialEmailKeys,
} from '../lib/billing/trial-identity';
import { TRIAL_EMAIL_FIXTURES } from './fixtures/trial-email-fixtures';

test('every pinned fixture normalises and hashes to the documented value', () => {
  for (const fixture of TRIAL_EMAIL_FIXTURES) {
    assert.equal(normalizeTrialEmail(fixture.input), fixture.normalized, `normalize ${fixture.input}`);
    assert.equal(normalizedTrialEmailKey(fixture.input), fixture.key, `key ${fixture.input}`);
    // The pinned key is plain sha256 of the normalised text, so the SQL side can reproduce it.
    assert.equal(createHash('sha256').update(fixture.normalized).digest('hex'), fixture.key);
  }
});

test('plus tags and Gmail dots collapse to the same inbox key', () => {
  const base = normalizedTrialEmailKey('ayman@gmail.com');
  for (const variant of [
    'ayman+trial2@gmail.com',
    'a.y.m.a.n@gmail.com',
    'A.Yman+x@GMAIL.COM',
    'ayman@googlemail.com',
    ' ayman+1@googlemail.com ',
  ]) {
    assert.equal(normalizedTrialEmailKey(variant), base, variant);
  }
});

test('dots and tags on other domains: only the tag is dropped', () => {
  assert.equal(normalizeTrialEmail('first.last+news@company.sa'), 'first.last@company.sa');
  assert.notEqual(
    normalizedTrialEmailKey('first.last@company.sa'),
    normalizedTrialEmailKey('firstlast@company.sa')
  );
});

test('genuinely different inboxes keep different keys', () => {
  assert.notEqual(normalizedTrialEmailKey('one@gmail.com'), normalizedTrialEmailKey('two@gmail.com'));
  assert.notEqual(normalizedTrialEmailKey('one@gmail.com'), normalizedTrialEmailKey('one@outlook.com'));
});

test('the legacy key is exactly the old trimmed-lowercase hash and matches trialLedgerKey', () => {
  assert.equal(legacyTrialEmailKey('  Owner@Example.com '), trialLedgerKey('owner@example.com'));
  assert.equal(
    legacyTrialEmailKey('owner@example.com'),
    createHash('sha256').update('owner@example.com').digest('hex')
  );
});

test('trialEmailKeys returns the legacy and the normalised key, de-duplicated', () => {
  const plain = trialEmailKeys('owner@example.com');
  assert.equal(plain.length, 1, 'identical keys are returned once');

  const tagged = trialEmailKeys('Owner+promo@Example.com');
  assert.equal(tagged.length, 2);
  assert.ok(tagged.includes(legacyTrialEmailKey('owner+promo@example.com')));
  assert.ok(tagged.includes(normalizedTrialEmailKey('owner@example.com')));
  for (const key of tagged) assert.match(key, /^[a-f0-9]{64}$/);
});

test('disposable domains are matched exactly and case-insensitively', () => {
  for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
    assert.equal(isDisposableEmailDomain(`someone@${domain}`), true, domain);
    assert.equal(isDisposableEmailDomain(`  Someone@${domain.toUpperCase()} `), true, domain);
  }
  assert.equal(DISPOSABLE_EMAIL_DOMAINS.length, 16);
  assert.equal(isDisposableEmailDomain('someone@gmail.com'), false);
  assert.equal(isDisposableEmailDomain('someone@mailinator.com.evil.example'), false);
  assert.equal(isDisposableEmailDomain('someone@sub.mailinator.com'), false);
  assert.equal(isDisposableEmailDomain('mailinator.com'), false, 'no at-sign is not an address');
  assert.equal(isDisposableEmailDomain(null), false);
  assert.equal(isDisposableEmailDomain(undefined), false);
  assert.equal(isDisposableEmailDomain(''), false);
});
