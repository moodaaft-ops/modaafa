import {
  detectAccountStatus,
  detectAdPolicy,
  detectBilling,
  detectConversionsZero,
  detectCpaSpike,
  detectOutsideChanges,
  detectSpend,
} from './detectors';
import { diagnoseAll } from './diagnose';
import type { GuardFinding, GuardSignals } from './types';
import { detectProductDisapprovals } from '../shopping/guard';

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, info: 3 } as const;
const DIAGNOSABLE = new Set(['spend_zero', 'spend_spike', 'cpa_spike', 'conversions_zero']);

export type Detected = { findings: GuardFinding[]; conversionsZeroIds: string[] };

/** Every rule, no diagnosis yet. */
export function detectAll(signals: GuardSignals): Detected {
  const conversions = detectConversionsZero(signals);
  const cpa = detectCpaSpike(signals);
  const status = detectAccountStatus(signals);
  const findings: GuardFinding[] = [
    ...(status ? [status] : []),
    ...detectBilling(signals),
    ...detectSpend(signals),
    ...(conversions.finding ? [conversions.finding] : []),
    ...(cpa ? [cpa] : []),
    ...detectAdPolicy(signals),
    ...detectOutsideChanges(signals),
    ...detectProductDisapprovals(signals),
  ];
  return { findings, conversionsZeroIds: conversions.campaignIds };
}

/** An anomaly fired: the diagnosis wants the lost impression share too. */
export const needsDiagnosisData = (findings: GuardFinding[]) => findings.some((f) => DIAGNOSABLE.has(f.code));

/** Attach the likely cause to the anomalies and order the list, worst first. */
export function finalize(detected: Detected, signals: GuardSignals): GuardFinding[] {
  return diagnoseAll(detected.findings, signals, detected.conversionsZeroIds).sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]
  );
}

/** Both steps for callers that already hold all the signals (tests, previews). */
export function analyze(signals: GuardSignals): GuardFinding[] {
  return finalize(detectAll(signals), signals);
}
