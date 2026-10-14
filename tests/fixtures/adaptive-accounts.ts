import type { AccountSignals, CampaignSignal, ConversionGroup, HourSignal, ProductSignal } from '../../lib/setup/adaptive/types';

/**
 * Synthetic account reads for the round-two tests. Nothing here is a real
 * account: names, hosts and numbers are made up.
 */

export const READ_AT = '2026-10-14T08:00:00.000Z';

export const failed = { ok: false as const, error: 'not_read' };

export function account(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return {
    version: 1,
    readAt: READ_AT,
    customerId: '1234567890',
    currency: 'SAR',
    campaigns: failed,
    enabledConversionActions: failed,
    conversionsByGroup: failed,
    autoTagging: failed,
    landingHosts: failed,
    merchantCenterLinked: failed,
    assets: failed,
    targetedPlaces: failed,
    externalManager: failed,
    otherEditors14d: failed,
    hours: failed,
    products: failed,
    ...overrides,
  };
}

export function campaign(overrides: Partial<CampaignSignal> & { id: string; name: string }): CampaignSignal {
  return {
    kind: 'SEARCH',
    status: 'ENABLED',
    cost30: 0,
    impressions30: 0,
    clicks30: 0,
    conversions30: 0,
    value30: 0,
    ...overrides,
  };
}

export function groups(...rows: Array<[ConversionGroup, number]>) {
  return { ok: true as const, value: rows.map(([group, conversions]) => ({ group, conversions })) };
}

function clinicHours(): HourSignal[] {
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    cost: hour >= 9 && hour < 22 ? 120 : 30,
    clicks: 10,
    conversions: 1,
    phoneCalls: hour >= 9 && hour < 22 ? 5 : 1,
  }));
}

/** A dental clinic that spends, tracks calls and is plainly «clinic». */
export function clinicAccount(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'بحث - زراعة الأسنان', cost30: 1100, impressions30: 30000, clicks30: 900, conversions30: 40 }),
        campaign({ id: '2', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 33 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 3 },
    conversionsByGroup: groups(['call', 64], ['lead_form', 9]),
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: ['smile-clinic.example.sa'] },
    merchantCenterLinked: { ok: true, value: false },
    assets: { ok: true, value: { call: true, locations: 0 } },
    targetedPlaces: { ok: true, value: ['Jeddah'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    hours: { ok: true, value: clinicHours() },
    ...overrides,
  });
}

/** Spends, and no enabled conversion action at all: the `no_tracking` state. */
export function untrackedAccount(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return clinicAccount({
    enabledConversionActions: { ok: true, value: 0 },
    conversionsByGroup: groups(),
    campaigns: {
      ok: true,
      value: [campaign({ id: '1', name: 'بحث - تقويم الأسنان', cost30: 900, impressions30: 20000, clicks30: 600, conversions30: 0 })],
    },
    ...overrides,
  });
}

export const PRODUCTS: ProductSignal[] = [
  { id: 'a', title: 'عطر العود الملكي', cost30: 520, conversions30: 9, value30: 2000 },
  { id: 'b', title: 'عطر الورد', cost30: 410, conversions30: 7, value30: 1500 },
  { id: 'c', title: 'بخور فاخر', cost30: 90, conversions30: 0, value30: 0 },
];

/** A perfume store: 41 orders worth 7626, an average order of 186. */
export function sallaAccount(overrides: Partial<AccountSignals> = {}): AccountSignals {
  return account({
    campaigns: {
      ok: true,
      value: [
        campaign({ id: '1', name: 'أداء أقصى - عطور', kind: 'PMAX', cost30: 2000, impressions30: 50000, clicks30: 1500, conversions30: 30, value30: 5580 }),
        campaign({ id: '2', name: 'بحث - عطور', cost30: 1200, impressions30: 12000, clicks30: 700, conversions30: 11, value30: 2046 }),
      ],
    },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: groups(['purchase', 41]),
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: ['myperfume.salla.sa'] },
    merchantCenterLinked: { ok: true, value: true },
    assets: { ok: true, value: { call: false, locations: 0 } },
    targetedPlaces: { ok: true, value: ['Saudi Arabia'] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    products: { ok: true, value: PRODUCTS },
    ...overrides,
  });
}

/** The read with a given age, as it is stored. */
export function readAgo(signals: AccountSignals, now: Date, hours: number): AccountSignals {
  return { ...signals, readAt: new Date(now.getTime() - hours * 3_600_000).toISOString() };
}

/** Every one of the twelve signals present and ok (the stored shape check needs `ok` on all of them). */
export function storable(signals: AccountSignals): AccountSignals {
  const filled = { ...signals } as Record<string, unknown>;
  const defaults: Record<string, unknown> = {
    campaigns: { ok: true, value: [] },
    enabledConversionActions: { ok: true, value: 1 },
    conversionsByGroup: { ok: true, value: [] },
    autoTagging: { ok: true, value: true },
    landingHosts: { ok: true, value: [] },
    merchantCenterLinked: { ok: true, value: false },
    assets: { ok: true, value: { call: false, locations: 0 } },
    targetedPlaces: { ok: true, value: [] },
    externalManager: { ok: true, value: { linked: false, managerIds: [] } },
    otherEditors14d: { ok: true, value: 0 },
    hours: { ok: true, value: [] },
    products: { ok: true, value: [] },
  };
  for (const key of Object.keys(defaults)) {
    const read = filled[key] as { ok?: boolean } | undefined;
    if (!read || typeof read.ok !== 'boolean') filled[key] = defaults[key];
  }
  return filled as unknown as AccountSignals;
}

/** The `job_runs` row the read is stored as (`saveSignals`). */
export function signalsRow(signals: AccountSignals) {
  return { details: { signals: storable(signals) } };
}
