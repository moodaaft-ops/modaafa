import assert from 'node:assert/strict';
import test from 'node:test';
import { assertSupabaseRead, SupabaseReadError } from '../lib/supabase/query-errors';

test('successful empty reads remain valid empty states', () => {
  assert.doesNotThrow(() => assertSupabaseRead(null, 'load campaigns'));
  assert.doesNotThrow(() => assertSupabaseRead(undefined, 'load campaigns'));
});

test('database read failures cannot masquerade as empty product states', () => {
  const cause = { code: 'PGRST000', message: 'database unavailable' };

  assert.throws(
    () => assertSupabaseRead(cause, 'load campaigns'),
    (error: unknown) => {
      assert.ok(error instanceof SupabaseReadError);
      assert.equal(error.operation, 'load campaigns');
      assert.equal(error.cause, cause);
      return true;
    }
  );
});
