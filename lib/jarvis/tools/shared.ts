import { sanitizePromptText } from '@/lib/ai/optimizer-agent';
import type { EvidenceRow, ToolContext, ToolResult } from './types';

export const READ_FAILED_MESSAGE_AR = 'ما قدرت أقرا هالجزء من حسابك الحين';
export const INVALID_INPUT_MESSAGE_AR = 'القيمة اللي انرسلت للأداة مو صحيحة';
export const UNKNOWN_TOOL_MESSAGE_AR = 'هالأداة مو موجودة عندي';

/** Raised for model-supplied input that fails validation. Never carries the bad value. */
export class ToolInputError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(detail);
    this.name = 'ToolInputError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Row reading: REST returns camelCase, older code paths return snake_case.
// ---------------------------------------------------------------------------

function toCamel(segment: string) {
  return segment.replace(/_([a-z0-9])/g, (_match, char: string) => char.toUpperCase());
}

/**
 * Reads a dotted snake_case GAQL path (`metrics.cost_micros`) from a result row,
 * accepting camelCase (`metrics.costMicros`) or snake_case at every level.
 */
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

/** Finite number or null. int64 fields arrive as strings; both are accepted. */
export function num(row: unknown, path: string): number | null {
  const raw = pick(row, path);
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Finite number, 0 when absent. */
export function num0(row: unknown, path: string): number {
  return num(row, path) ?? 0;
}

export function str(row: unknown, path: string): string {
  const raw = pick(row, path);
  return raw === undefined || raw === null ? '' : String(raw);
}

export function bool(row: unknown, path: string): boolean | null {
  const raw = pick(row, path);
  if (typeof raw === 'boolean') return raw;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

/** Cost-like micros field to account currency units (not rounded; round at output). */
export function currencyUnits(row: unknown, microsPath: string): number {
  return num0(row, microsPath) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Number formatting
// ---------------------------------------------------------------------------

export function round(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded; // no negative zero
}

export function money(value: number): number {
  return round(value, 2);
}

/** a / b, or null when b is 0 or the result is not finite. */
export function ratio(a: number, b: number): number | null {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  const value = a / b;
  return Number.isFinite(value) ? value : null;
}

/** 0.2345 -> 23.5. null stays null. */
export function pct1(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return round(value * 100, 1);
}

export function moneyOrNull(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : money(value);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Every third-party string (terms, names, labels) goes through this before a model sees it. */
export function cleanText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return sanitizePromptText(String(value)).trim();
}

export function enumLabel(value: unknown, fallback = 'OTHER'): string {
  const text = String(value ?? '');
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(text) ? text : fallback;
}

export function safeCurrency(ctx: ToolContext): string {
  const code = String(ctx.currencyCode ?? '').toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : 'SAR';
}

// ---------------------------------------------------------------------------
// Refs and results
// ---------------------------------------------------------------------------

/** Per-result ref allocator: next('st') gives st_1, st_2, ... */
export function refCounter() {
  const counts = new Map<string, number>();
  return (prefix: string) => {
    const next = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, next);
    return `${prefix}_${next}`;
  };
}

function jsonSafe<T>(value: T): T {
  // Drops undefined and turns NaN or Infinity into null, so no result ever carries NaN.
  return JSON.parse(JSON.stringify(value)) as T;
}

export function okResult(summary: Record<string, unknown>, rows: EvidenceRow[]): ToolResult {
  return { ok: true, summary: jsonSafe(summary), rows: jsonSafe(rows) };
}

export function failResult(error: string, messageAr: string): ToolResult {
  return { ok: false, error, message_ar: messageAr };
}

export function errorSummary(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.slice(0, 300);
}

// ---------------------------------------------------------------------------
// GAQL execution
// ---------------------------------------------------------------------------

export async function runQuery(ctx: ToolContext, gaql: string): Promise<any[]> {
  const rows = await ctx.customer.query(gaql);
  return Array.isArray(rows) ? rows : [];
}

/** For secondary queries: a failure degrades the tool instead of failing it. */
export async function tryQuery(ctx: ToolContext, label: string, gaql: string): Promise<any[] | null> {
  try {
    return await runQuery(ctx, gaql);
  } catch (error) {
    console.warn(`[jarvis-tools] optional query failed: ${label}: ${errorSummary(error)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Input validation. Only values that pass here are ever interpolated into GAQL.
// ---------------------------------------------------------------------------

const DIGITS = /^\d{1,20}$/;

export function parseArgs(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new ToolInputError('input must be an object');
  }
  const object = input as Record<string, unknown>;
  const unknown = Object.keys(object).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new ToolInputError(`unknown field, allowed: ${allowed.length ? allowed.join(', ') : 'none'}`);
  }
  return object;
}

export function optEnum<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  fallback: T
): T {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw new ToolInputError(`${key} must be one of: ${allowed.join(', ')}`);
}

export function optBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  throw new ToolInputError(`${key} must be true or false`);
}

export function optDigits(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (DIGITS.test(trimmed)) return trimmed;
  }
  throw new ToolInputError(`${key} must be digits only`);
}

export function reqDigits(args: Record<string, unknown>, key: string): string {
  const value = optDigits(args, key);
  if (value === undefined) throw new ToolInputError(`${key} is required and must be digits only`);
  return value;
}

// ---------------------------------------------------------------------------
// Dates (UTC, YYYY-MM-DD)
// ---------------------------------------------------------------------------

export function utcDate(date: Date): string {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new Error('invalid date');
  return date.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error('invalid date');
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

/** The last `days` FULL days in UTC, ending yesterday (today is excluded). */
export function lastFullDaysUtc(now: Date, days: number): { from: string; to: string } {
  const to = addDays(utcDate(now), -1);
  return { from: addDays(to, -(days - 1)), to };
}

/** Last path segment of a resource name (`customers/1/campaigns/22` -> `22`). */
export function resourceId(resourceName: string): string | null {
  const last = resourceName.split('/').pop() ?? '';
  return DIGITS.test(last) ? last : null;
}
