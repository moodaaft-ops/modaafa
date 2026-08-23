import assert from 'node:assert/strict';
import test from 'node:test';
import { AUDIT_PROGRESS_STEPS, auditProgressEvent } from '../lib/audit/progress';

test('audit progress reflects a monotonic sequence of real checkpoints', () => {
  const percentages = AUDIT_PROGRESS_STEPS.flatMap((step) => [step.startPercent, step.completePercent]);
  assert.equal(new Set(AUDIT_PROGRESS_STEPS.map((step) => step.id)).size, AUDIT_PROGRESS_STEPS.length);
  assert.equal(percentages[0], 2);
  assert.equal(percentages.at(-1), 100);

  for (let index = 1; index < percentages.length; index += 1) {
    assert.ok(percentages[index] > percentages[index - 1], 'progress must never move backwards or repeat');
  }
});

test('audit progress events use the matching backend checkpoint labels', () => {
  const started = auditProgressEvent('live_data', 'started');
  const completed = auditProgressEvent('live_data', 'completed', {
    detail: 'تغطية الأدلة 92%',
    warning: true,
  });

  assert.deepEqual(started, {
    type: 'progress',
    step: 'live_data',
    phase: 'started',
    percent: 32,
    message: 'نفحص الكلمات وعبارات البحث والإعلانات والتحويلات',
  });
  assert.equal(completed.percent, 58);
  assert.equal(completed.message, 'تم جمع طبقات الأدلة الحية المتاحة');
  assert.equal(completed.detail, 'تغطية الأدلة 92%');
  assert.equal(completed.warning, true);
});
