export class SupabaseReadError extends Error {
  readonly operation: string;

  constructor(operation: string, cause: unknown) {
    super('Required account data could not be loaded', { cause });
    this.name = 'SupabaseReadError';
    this.operation = operation;
  }
}

/**
 * Empty rows and failed reads are different product states. A failed read must
 * reach the app error boundary instead of quietly rendering onboarding or an
 * empty dashboard that tells the customer their data disappeared.
 */
export function assertSupabaseRead(error: unknown, operation: string): asserts error is null | undefined {
  if (!error) return;

  console.error(`Supabase read failed: ${operation}`, error);
  throw new SupabaseReadError(operation, error);
}
