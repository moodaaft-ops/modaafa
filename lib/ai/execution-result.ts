import type { MeasurementDescriptor } from './execution-preflight';
import { isExtendedActionsEnabled } from './extended-actions/flag';
import { finalizeExtendedRollback, isExtendedRollback } from './extended-actions/execute';

/**
 * Turn a live Google Ads mutate result into the stored rollback and
 * measurement records. Shared by the manual execution route and the autopilot
 * executor so both persist exactly the same rollback shape for the same
 * action; the two private copies this replaces had already started to drift.
 */

/** Every resource name Google returned, in operation order. */
export function resultResourceNames(result: any): string[] {
  const results: any[] = Array.isArray(result?.results) ? result.results : [];
  const names = results
    .map((entry) => entry?.resourceName ?? entry?.resource_name)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  if (names.length > 0) return names;
  const single = result?.resourceName ?? result?.resource_name;
  return typeof single === 'string' && single.length > 0 ? [single] : [];
}

export function firstResultResourceName(result: any): string | null {
  return resultResourceNames(result)[0] ?? null;
}

export function finalizeRollbackPayload(payload: Record<string, unknown>, result: any) {
  if (isExtendedActionsEnabled() && isExtendedRollback(payload)) {
    return finalizeExtendedRollback(payload, result);
  }
  if (
    payload.action_type === 'remove_created_negative_keyword' ||
    payload.action_type === 'remove_created_keyword' ||
    payload.action_type === 'remove_created_data_exclusion' ||
    payload.action_type === 'remove_created_conversion_action'
  ) {
    return { ...payload, resource_name: firstResultResourceName(result) };
  }
  if (payload.action_type === 'remove_created_negative_keywords') {
    // A batch is ONE mutate call with N create operations; Google applies it
    // atomically, so every returned resource belongs to this execution and
    // the rollback must remove all of them, not just the first.
    const names = resultResourceNames(result);
    // No names means nothing can be removed safely: say so instead of
    // offering a rollback button that the rollback route would refuse.
    return names.length > 0
      ? { ...payload, resource_names: names }
      : { ...payload, reversible: false, resource_names: [], note: 'created_resources_unavailable' };
  }
  return payload;
}

export function finalizeMeasurement(measurement: MeasurementDescriptor | null, result: any) {
  if (!measurement) return null;
  if (measurement.level === 'created_criterion' && !measurement.resource) {
    return { ...measurement, resource: firstResultResourceName(result) };
  }
  return measurement;
}
