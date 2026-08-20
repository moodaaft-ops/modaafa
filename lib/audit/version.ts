export const AUDIT_ENGINE_VERSION = 2;

type AuditSnapshot = {
  audit_engine_version?: unknown;
};

export function auditEngineVersion(snapshot: unknown): number | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;

  const value = (snapshot as AuditSnapshot).audit_engine_version;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return null;

  return value;
}

export function isCurrentAuditEngine(snapshot: unknown): boolean {
  const version = auditEngineVersion(snapshot);
  return version !== null && version >= AUDIT_ENGINE_VERSION;
}
