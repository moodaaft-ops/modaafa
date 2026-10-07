import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auditErrorInfo,
  auditErrorSummary,
  formatResetDate,
  isKnownAuditErrorCode,
} from '../lib/audit/error-messages';

// Every code the audit endpoint and its stream can produce.
const ENDPOINT_CODES = [
  'unauthorized',
  'too_many_requests',
  'security_service_unavailable',
  'account_not_found',
  'service_unavailable',
  'subscription_required',
  'quota_exceeded',
  'usage_storage_unavailable',
  'invalid_origin',
  'audit_failed',
];

test('every endpoint error code has a message that says what happened and what to do', () => {
  for (const code of ENDPOINT_CODES) {
    assert.ok(isKnownAuditErrorCode(code), `${code} is mapped`);
    const info = auditErrorInfo(code);
    assert.equal(info.code, code);
    assert.ok(info.title.length > 3, `${code} title`);
    assert.ok(info.message.length > 10, `${code} message`);
    assert.ok(info.nextStep.length > 10, `${code} next step`);
  }
});

test('unknown or missing codes fall back to the generic failure with a retry', () => {
  for (const code of ['something_new', '', null, undefined, '__proto__', 'constructor']) {
    const info = auditErrorInfo(code);
    assert.equal(info.code, 'audit_failed');
    assert.ok(info.actions.includes('retry'));
  }
});

test('limit and billing errors offer a real exit instead of only retrying', () => {
  for (const code of ['subscription_required', 'quota_exceeded']) {
    const info = auditErrorInfo(code);
    assert.deepEqual(info.actions, ['billing']);
    assert.ok(!info.actions.includes('retry'), 'retrying cannot fix a limit');
  }
  assert.ok(auditErrorInfo('account_not_found').actions.includes('connect'));
});

test('quota message names the reset date when the server sends one', () => {
  const info = auditErrorInfo('quota_exceeded', { resetsAt: '2026-10-08T00:00:00.000Z' });
  assert.match(info.nextStep, /يتجدد الحد في/);
  assert.match(info.nextStep, /2026/);
  assert.doesNotMatch(info.nextStep, /[٠-٩]/, 'Latin digits only');
  assert.equal(auditErrorInfo('quota_exceeded', { resetsAt: 'not a date' }).nextStep, auditErrorInfo('quota_exceeded').nextStep);
  assert.equal(formatResetDate(null), '');
});

test('copy follows the writing rules: no dashes, no Latin comma, no invented numbers', () => {
  for (const code of [...ENDPOINT_CODES, 'unknown']) {
    const info = auditErrorInfo(code);
    const text = `${info.title} ${info.message} ${info.nextStep} ${auditErrorSummary(code)}`;
    assert.doesNotMatch(text, /[–—]/, `${code} has no en or em dash`);
    assert.doesNotMatch(text, /,/, `${code} has no Latin comma`);
    assert.doesNotMatch(text, /\d/, `${code} has no hard-coded numbers`);
  }
});

test('errors that never touch the account say no change was made', () => {
  assert.match(auditErrorInfo('audit_failed').message, /لم ننفذ أي تعديل/);
});
