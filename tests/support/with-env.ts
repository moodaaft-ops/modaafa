/**
 * Runs `fn` with environment variables set (undefined deletes), then puts the
 * previous values back, also when `fn` returns a promise.
 */
export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const restore = () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
  let result: T;
  try {
    result = fn();
  } catch (error) {
    restore();
    throw error;
  }
  if (result && typeof (result as unknown as Promise<unknown>).then === 'function') {
    return (result as unknown as Promise<unknown>).finally(restore) as unknown as T;
  }
  restore();
  return result;
}
