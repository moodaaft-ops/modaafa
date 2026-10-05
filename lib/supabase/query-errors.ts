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

/**
 * Human-readable text for anything that can be thrown. Supabase/PostgREST
 * errors are plain objects, not `Error` instances, so `${error}` printed
 * "[object Object]" and hid the real message from ops alerts.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const { code, message, details, hint } = error as Record<string, unknown>;
    const parts = [code, message, details, hint].filter(
      (part): part is string | number => typeof part === 'string' || typeof part === 'number'
    );
    if (parts.length > 0) return parts.join(' | ');
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}
