import assert from 'node:assert/strict';
import test from 'node:test';
import { EvidenceRegistry } from '../lib/jarvis/evidence';
import { PREPARE_CHANGE_TOOL, prepareChange, prepareChangeToolFor, type PrepareContext } from '../lib/jarvis/prepare-change';
import type { EvidenceRow } from '../lib/jarvis/tools';
import { createLandingCheckTool } from '../lib/jarvis/tools/get-landing-check';
import { getAdAssetsTool } from '../lib/jarvis/tools/get-ad-assets';

const CID = '1234567890';
const CAMPAIGN = `customers/${CID}/campaigns/11`;
const AD = `customers/${CID}/adGroupAds/5~6`;

async function withFlags<T>(studio: string | undefined, extended: string | undefined, fn: () => Promise<T>): Promise<T> {
  const old = [process.env.ADS_STUDIO_ENABLED, process.env.EXTENDED_ACTIONS_ENABLED, process.env.LANDING_CHECK_ENABLED];
  const set = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  set('ADS_STUDIO_ENABLED', studio);
  set('EXTENDED_ACTIONS_ENABLED', extended);
  set('LANDING_CHECK_ENABLED', 'true');
  try {
    return await fn();
  } finally {
    set('ADS_STUDIO_ENABLED', old[0]);
    set('EXTENDED_ACTIONS_ENABLED', old[1]);
    set('LANDING_CHECK_ENABLED', old[2]);
  }
}

function fakeAdmin() {
  const inserted: any[] = [];
  const from = (table: string) => {
    let op = 'select';
    let payload: any;
    const builder: any = {
      select: () => builder,
      insert: (p: any) => {
        op = 'insert';
        payload = p;
        return builder;
      },
      maybeSingle: () => Promise.resolve(op === 'insert' ? (inserted.push({ table, payload }), { data: { id: 'rec-new' }, error: null }) : { data: null, error: null }),
      then: (resolve: any) => resolve({ data: [], error: null, count: 0 }),
    };
    for (const name of ['eq', 'in', 'gte', 'lte', 'order', 'limit']) builder[name] = () => builder;
    return builder;
  };
  return { from, inserted };
}
function registryWith(rows: EvidenceRow[]) {
  const registry = new EvidenceRegistry();
  registry.add({ items: rows.map((row) => ({ ref: row.ref })) }, rows);
  return registry;
}
function ctx(rows: EvidenceRow[], admin = fakeAdmin()): PrepareContext {
  return {
    registry: registryWith(rows),
    accountId: '00000000-0000-4000-8000-000000000001',
    customerId: CID,
    currencyCode: 'SAR',
    sessionId: null,
    subscriptionActive: true,
    admin,
    proposalsThisTurn: 0,
    now: new Date('2026-10-20T10:00:00Z'),
    deps: { checkGuardrails: async (a) => a, findBlocking: async () => null },
  };
}
const campaign: EvidenceRow = { ref: 'cmp_1', kind: 'campaign', data: { id: '11', name: 'حملة الصالون', resource_name: CAMPAIGN, status: 'ENABLED' } };
const rsa = (): EvidenceRow => ({
  ref: 'rsa_1',
  kind: 'rsa_ad',
  data: {
    campaign: 'حملة الصالون',
    ad_group: 'قص وتصفيف',
    ad_group_ad: AD,
    best: { headlines: [{ text: 'صالون الورد الرياض' }], descriptions: [{ text: 'صالون نسائي في الرياض نقدم قص وصبغة' }] },
    verdict: {
      replace: [
        { text: 'خدمات تجميل نسائية', field: 'HEADLINE', reason: 'low_performance' },
        { text: 'نخدمك في حي الورود بأجواء هادئة', field: 'DESCRIPTION', reason: 'low_performance' },
      ],
    },
  },
});
const sp = (n: number, url: string): EvidenceRow => ({ ref: `sp_${n}`, kind: 'site_page', data: { url, title: 'خدمات الصالون', h1: '', anchor: '', host: 'rose.sa' } });
const phone: EvidenceRow = { ref: 'ph_1', kind: 'verified_phone', data: { phone: '+966501234567', source: 'merchant_saved' } };
const run = (args: Record<string, unknown>, rows: EvidenceRow[], admin = fakeAdmin()) =>
  prepareChange({ why_ar: 'نحسن الإعلان', ...args }, ctx(rows, admin));

test('tool schema: flag off is the same object, flag on adds the five operations', () => {
  assert.equal(prepareChangeToolFor(false), PREPARE_CHANGE_TOOL);
  assert.equal(prepareChangeToolFor(false, true), PREPARE_CHANGE_TOOL, 'no extended actions means no studio operations either');
  const extendedOnly: any = prepareChangeToolFor(true);
  assert.ok(!JSON.stringify(extendedOnly).includes('add_sitelinks'));
  const studio: any = prepareChangeToolFor(true, true);
  for (const op of ['replace_rsa_assets', 'add_sitelinks', 'add_callouts', 'add_structured_snippet', 'add_call_asset']) {
    assert.ok(studio.input_schema.properties.operation.enum.includes(op), op);
  }
  assert.ok(studio.input_schema.properties.choices.properties.sitelinks);
});

test('studio operations are refused unless both flags are on', async () => {
  for (const [studio, extended] of [[undefined, 'true'], ['true', undefined], [undefined, undefined]] as const) {
    await withFlags(studio, extended, async () => {
      const out = await run({ operation: 'add_callouts', evidence_refs: ['cmp_1'], choices: { callouts: ['حجز سهل', 'فريق نسائي'] } }, [campaign]);
      assert.equal(out.ok, false);
      if (!out.ok) assert.equal(out.code, 'unknown_operation');
    });
  }
});

test('replace_rsa_assets: only texts the rules list, new words checked, resource from the row', async () => {
  await withFlags('true', 'true', async () => {
    const admin = fakeAdmin();
    const ok = await run({ operation: 'replace_rsa_assets', evidence_refs: ['rsa_1'], choices: { replacements: [{ n: 1, new_text: 'حجز موعد في صالون الورد' }] } }, [rsa()], admin);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const row = admin.inserted.find((i) => i.table === 'recommendations')!.payload;
    assert.equal(row.action_payload.operation, 'replace_rsa_assets');
    assert.equal(row.action_payload.source, 'jarvis_chat');
    assert.equal(row.action_payload.params.ad_group_ad_resource, AD);
    assert.deepEqual(row.action_payload.params.replacements.map((r: any) => r.old_text), ['خدمات تجميل نسائية']);

    const outOfList = await run({ operation: 'replace_rsa_assets', evidence_refs: ['rsa_1'], choices: { replacements: [{ n: 3, new_text: 'حجز موعد' }] } }, [rsa()]);
    assert.equal(outOfList.ok, false);
    const invented = await run({ operation: 'replace_rsa_assets', evidence_refs: ['rsa_1'], choices: { replacements: [{ n: 1, new_text: 'خصم 70 في المية اليوم' }] } }, [rsa()]);
    assert.equal(invented.ok, false, 'a number that is not in the ad is refused');
    const dash = await run({ operation: 'replace_rsa_assets', evidence_refs: ['rsa_1'], choices: { replacements: [{ n: 1, new_text: 'صالون الورد — حجز' }] } }, [rsa()]);
    assert.equal(dash.ok, false);
    const nothing = await run({ operation: 'replace_rsa_assets', evidence_refs: ['rsa_1'], choices: { replacements: [{ n: 1, new_text: 'حجز موعد' }] } }, [{ ...rsa(), data: { ...rsa().data, verdict: { replace: [] } } }]);
    assert.equal(nothing.ok, false);
    const campaignRef = await run({ operation: 'replace_rsa_assets', evidence_refs: ['cmp_1'], choices: {} }, [campaign]);
    assert.equal(campaignRef.ok, false);
  });
});

test('callouts and snippet: validated text, campaign from the row', async () => {
  await withFlags('true', 'true', async () => {
    const admin = fakeAdmin();
    const ok = await run({ operation: 'add_callouts', evidence_refs: ['cmp_1'], choices: { callouts: ['حجز سهل', 'فريق نسائي'] } }, [campaign], admin);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(admin.inserted[0].payload.action_payload.params.campaign_resource, CAMPAIGN);
    assert.equal((await run({ operation: 'add_callouts', evidence_refs: ['cmp_1'], choices: { callouts: ['حجز سهل'] } }, [campaign])).ok, false, 'at least two');
    assert.equal((await run({ operation: 'add_callouts', evidence_refs: ['cmp_1'], choices: { callouts: ['شحن 24 ساعة', 'فريق نسائي'] } }, [campaign])).ok, false, 'invented number');
    const snippet = await run({ operation: 'add_structured_snippet', evidence_refs: ['cmp_1'], choices: { header: 'Service catalog', values: ['قص', 'صبغة', 'عناية بالبشرة'] } }, [campaign]);
    assert.equal(snippet.ok, true, JSON.stringify(snippet));
    assert.equal((await run({ operation: 'add_structured_snippet', evidence_refs: ['cmp_1'], choices: { header: 'Nonsense', values: ['قص', 'صبغة', 'عناية'] } }, [campaign])).ok, false);
  });
});

test('sitelinks: URLs come only from sp_ rows, one host, texts validated', async () => {
  await withFlags('true', 'true', async () => {
    const rows = [campaign, sp(1, 'https://rose.sa/services'), sp(2, 'https://rose.sa/offers')];
    const admin = fakeAdmin();
    const choices = {
      sitelinks: [
        { page_ref: 'sp_1', link_text: 'خدماتنا', description1: 'قص وتصفيف وعناية', description2: 'احجزي موعدك بسهولة' },
        { page_ref: 'sp_2', link_text: 'العروض', description1: 'عروض الصالون', description2: 'شوفي الجديد عندنا' },
      ],
    };
    const ok = await run({ operation: 'add_sitelinks', evidence_refs: ['cmp_1', 'sp_1', 'sp_2'], choices }, rows, admin);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const urls = admin.inserted[0].payload.action_payload.params.sitelinks.map((s: any) => s.final_url);
    assert.deepEqual(urls.sort(), ['https://rose.sa/offers', 'https://rose.sa/services']);

    const noPages = await run({ operation: 'add_sitelinks', evidence_refs: ['cmp_1'], choices }, [campaign]);
    assert.equal(noPages.ok, false);
    const typedUrl = await run({ operation: 'add_sitelinks', evidence_refs: ['cmp_1', 'sp_1', 'sp_2'], choices: { sitelinks: choices.sitelinks.map((s) => ({ ...s, page_ref: 'sp_9' })) } }, rows);
    assert.equal(typedUrl.ok, false, 'a ref the server does not hold');
    const mixed = await run(
      { operation: 'add_sitelinks', evidence_refs: ['cmp_1', 'sp_1', 'sp_2'], choices },
      [campaign, sp(1, 'https://rose.sa/services'), { ...sp(2, 'https://other.sa/offers'), data: { ...sp(2, '').data, url: 'https://other.sa/offers', host: 'other.sa' } }]
    );
    assert.equal(mixed.ok, false, 'two hosts');
  });
});

test('call asset: the number is the one in the ph_ row, never a typed one', async () => {
  await withFlags('true', 'true', async () => {
    const admin = fakeAdmin();
    const ok = await run({ operation: 'add_call_asset', evidence_refs: ['cmp_1', 'ph_1'], choices: {} }, [campaign, phone], admin);
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(admin.inserted[0].payload.action_payload.params.phone_number, '+966501234567');
    const typed = await run({ operation: 'add_call_asset', evidence_refs: ['cmp_1'], choices: { phone_number: '0550000000' } as any }, [campaign]);
    assert.equal(typed.ok, false);
    if (!typed.ok) assert.equal(typed.code, 'phone_not_verified');
  });
});

test('a waiting nightly card for the same thing is returned instead of a second one', async () => {
  await withFlags('true', 'true', async () => {
    const c = ctx([campaign]);
    // Only the cron fingerprint is reported as waiting: the first lookup (chat fingerprint) is a different value.
    let calls = 0;
    c.deps = { checkGuardrails: async (a) => a, findBlocking: async () => (++calls === 2 ? ({ id: 'cron-card', status: 'pending', created_at: new Date().toISOString() } as any) : null) };
    const out = await prepareChange({ operation: 'add_callouts', evidence_refs: ['cmp_1'], choices: { callouts: ['حجز سهل', 'فريق نسائي'] }, why_ar: 'x' }, c);
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.equal(out.created, false);
      assert.equal(out.recommendationId, 'cron-card');
    }
  });
});

test('read tools: site pages become sp_ rows only with the studio on, and the call number a ph_ row', async () => {
  const report = {
    checkedAt: '2026-10-20T00:00:00Z',
    pages: [],
    tracking: {},
    sitePages: [{ url: 'https://rose.sa/services', title: 'خدمات', h1: 'خدمات الصالون', anchor: 'خدماتنا', status: 200 }],
  };
  const tool = createLandingCheckTool({
    store: () => ({ latest: async () => ({ checked_at: '2026-10-19T00:00:00Z', report: report as any }), save: async () => {} }),
    fetchDeps: { resolve: async () => [], transport: async () => new Response('') } as any,
    enabled: () => true,
  });
  const toolCtx: any = { customer: { query: async () => [] }, accountId: 'acc', customerId: CID, currencyCode: 'SAR', business: null, now: new Date('2026-10-20T10:00:00Z') };
  await withFlags('true', 'true', async () => {
    const result: any = await tool.run({}, toolCtx);
    assert.equal(result.ok, true);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].kind, 'site_page');
    assert.equal(result.rows[0].data.url, 'https://rose.sa/services');
    assert.ok(!JSON.stringify(result.summary).includes('https://rose.sa/services'), 'the URL stays server side');
  });
  await withFlags(undefined, undefined, async () => {
    const result: any = await tool.run({}, toolCtx);
    assert.equal(result.rows.length, 0);
    assert.equal(result.summary.site_pages, undefined);
  });

  const callRows = [{ asset: { call_asset: { phone_number: '0501234567', country_code: 'SA' } } }];
  const assetsCtx: any = {
    ...toolCtx,
    customer: {
      query: async (gaql: string) => {
        if (gaql.includes('call_asset')) return callRows;
        return [];
      },
    },
  };
  await withFlags('true', 'true', async () => {
    const result: any = await getAdAssetsTool.run({}, assetsCtx).catch((e: Error) => ({ error: e.message }));
    assert.equal(result.ok, true);
    const ph = result.rows.find((r: any) => r.kind === 'verified_phone');
    assert.ok(ph);
    assert.equal(ph.data.phone, '+966501234567');
    assert.equal(ph.data.source, 'account_call_asset');
  });
});
