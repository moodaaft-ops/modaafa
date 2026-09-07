import assert from 'node:assert/strict';
import test from 'node:test';
import { startJobRun } from '../lib/platform/jobs';

function database(responses: Array<{ data?: unknown; error?: unknown }>) {
  let consumed = 0;
  return {
    get consumed() { return consumed; },
    from(table: string) {
      assert.equal(table, 'job_runs');
      const result = responses[consumed++];
      if (!result) throw new Error('Unexpected database write');
      return {
        update() { return this; }, eq() { return this; }, lt() { return this; },
        select() { return this; }, gte() { return this; }, limit() { return this; },
        insert() { return this; }, maybeSingle() { return this; },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(result).then(resolve); },
      };
    },
  };
}

for (const stage of [0, 1, 2]) {
  test(`job reservation fails closed at database stage ${stage}`, async () => {
    const db = database([
      ...Array.from({ length: stage }, () => ({ data: null, error: null })),
      { error: { code: 'PGRST000', message: 'unavailable' } },
    ]);
    await assert.rejects(startJobRun(db, 'optimize'), /unavailable|reserve/);
    assert.equal(db.consumed, stage + 1);
  });
}

test('a reservation race returns already_running, not a second worker', async () => {
  const job = await startJobRun(database([
    {}, { data: null }, { error: { code: '23505' } },
  ]), 'optimize');
  assert.equal(job.alreadyRunning, true);
});

test('an empty insert response cannot authorize a job', async () => {
  await assert.rejects(startJobRun(database([{}, {}, {}]), 'optimize'), /no id/);
});

test('a durable reservation allows the worker to start', async () => {
  const job = await startJobRun(database([{}, {}, { data: { id: 'job-1' } }]), 'optimize');
  assert.equal(job.alreadyRunning, false);
  assert.equal(job.id, 'job-1');
});
