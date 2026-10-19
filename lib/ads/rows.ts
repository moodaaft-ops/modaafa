/**
 * Row access for Google Ads REST results, which arrive camelCase or snake_case
 * depending on the code path. Local copy of the helpers in
 * lib/jarvis/tools/shared.ts so this folder has no import into the optimizer
 * (that would make an import cycle through the extended-actions pipeline).
 */

function toCamel(segment: string) {
  return segment.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

export function pick(row: unknown, path: string): unknown {
  let current: unknown = row;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    const object = current as Record<string, unknown>;
    const camel = toCamel(segment);
    current = object[camel] !== undefined ? object[camel] : object[segment];
  }
  return current;
}

export function str(row: unknown, path: string): string {
  const raw = pick(row, path);
  return raw === undefined || raw === null ? '' : String(raw);
}

export function num(row: unknown, path: string): number {
  const raw = pick(row, path);
  if (raw === undefined || raw === null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function list(row: unknown, path: string): unknown[] {
  const raw = pick(row, path);
  return Array.isArray(raw) ? raw : [];
}

export function esc(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

const ENUM = /^[A-Z][A-Z0-9_]{0,63}$/;
export function enumOf(row: unknown, path: string): string {
  const raw = str(row, path);
  return ENUM.test(raw) ? raw : '';
}
