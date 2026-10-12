import type { EvidenceRow, JarvisReadTool } from './types';
import {
  cleanText,
  currencyUnits,
  enumLabel,
  money,
  num0,
  okResult,
  optEnum,
  parseArgs,
  pct1,
  ratio,
  refCounter,
  round,
  runQuery,
  safeCurrency,
  str,
  tryQuery,
} from './shared';

export const GEO_PERIODS = ['LAST_7_DAYS', 'LAST_14_DAYS', 'LAST_30_DAYS'] as const;

const ROW_LIMIT = 200;
const MAX_CITY_NAMES = 50;
const LIST_SIZE = 10;
/** Only this shape is ever interpolated into the name lookup query. */
const CITY_RESOURCE = /^geoTargetConstants\/\d+$/;

type CityTotals = { resource: string; cost: number; clicks: number; conversions: number };

export const getGeoTool: JarvisReadTool = {
  name: 'get_geo',
  description:
    'Shows where the money goes geographically: top cities by spend, cities that spent without converting, the share of spend coming from people only interested in the area, and which campaigns use the presence or interest location setting. Use it when spend looks wasted outside the intended area.',
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: [...GEO_PERIODS],
        description: 'Reporting window. Default LAST_30_DAYS.',
      },
    },
    additionalProperties: false,
  },
  async run(input, ctx) {
    const args = parseArgs(input, ['period']);
    const period = optEnum(args, 'period', GEO_PERIODS, 'LAST_30_DAYS');

    const [geoRows, settingRows] = await Promise.all([
      runQuery(
        ctx,
        `
        SELECT geographic_view.location_type, geographic_view.country_criterion_id,
          segments.geo_target_city,
          metrics.clicks, metrics.cost_micros, metrics.conversions
        FROM geographic_view
        WHERE segments.date DURING ${period}
        ORDER BY metrics.cost_micros DESC
        LIMIT ${ROW_LIMIT}
      `
      ),
      tryQuery(
        ctx,
        'campaign_geo_setting',
        `
        SELECT campaign.id, campaign.name, campaign.resource_name,
          campaign.geo_target_type_setting.positive_geo_target_type
        FROM campaign
        WHERE campaign.status = 'ENABLED'
      `
      ),
    ]);

    let totalCost = 0;
    let areaOfInterestCost = 0;
    const cities = new Map<string, CityTotals>();
    for (const row of geoRows) {
      const cost = currencyUnits(row, 'metrics.cost_micros');
      totalCost += cost;
      if (str(row, 'geographic_view.location_type') === 'AREA_OF_INTEREST') areaOfInterestCost += cost;
      const resource = str(row, 'segments.geo_target_city');
      if (!CITY_RESOURCE.test(resource)) continue;
      const city = cities.get(resource) ?? { resource, cost: 0, clicks: 0, conversions: 0 };
      city.cost += cost;
      city.clicks += num0(row, 'metrics.clicks');
      city.conversions += num0(row, 'metrics.conversions');
      cities.set(resource, city);
    }

    const ranked = [...cities.values()].sort((a, b) => b.cost - a.cost);
    const named = ranked.slice(0, MAX_CITY_NAMES);

    // Names for at most 50 cities. Every resource already matched CITY_RESOURCE above.
    const names = new Map<string, { name: string; canonical: string }>();
    if (named.length > 0) {
      const list = named.map((city) => `'${city.resource}'`).join(', ');
      const nameRows = await tryQuery(
        ctx,
        'geo_target_names',
        `
        SELECT geo_target_constant.resource_name, geo_target_constant.name,
          geo_target_constant.canonical_name
        FROM geo_target_constant
        WHERE geo_target_constant.resource_name IN (${list})
      `
      );
      for (const row of nameRows ?? []) {
        names.set(str(row, 'geo_target_constant.resource_name'), {
          name: cleanText(str(row, 'geo_target_constant.name')),
          canonical: cleanText(str(row, 'geo_target_constant.canonical_name')),
        });
      }
    }

    const nextRef = refCounter();
    const evidence: EvidenceRow[] = [];
    const refByCity = new Map<string, string>();

    const cityRow = (city: CityTotals) => {
      let ref = refByCity.get(city.resource);
      const label = names.get(city.resource);
      if (!ref) {
        ref = nextRef('geo');
        refByCity.set(city.resource, ref);
        evidence.push({
          ref,
          kind: 'geo',
          data: {
            city_resource_name: city.resource,
            name: label?.name || null,
            canonical_name: label?.canonical || null,
            clicks: city.clicks,
            cost: money(city.cost),
            conversions: round(city.conversions, 2),
          },
        });
      }
      return {
        ref,
        city: label?.name || null,
        cost: money(city.cost),
        clicks: city.clicks,
        conversions: round(city.conversions, 2),
        cost_share_pct: pct1(ratio(city.cost, totalCost)),
      };
    };

    const topCities = named.slice(0, LIST_SIZE).map(cityRow);
    const zeroConversion = named
      .filter((city) => city.cost > 0 && city.conversions <= 0)
      .slice(0, LIST_SIZE)
      .map(cityRow);

    const campaignsPresenceOrInterest = (settingRows ?? [])
      .filter(
        (row) => enumLabel(str(row, 'campaign.geo_target_type_setting.positive_geo_target_type')) === 'PRESENCE_OR_INTEREST'
      )
      .map((row) => {
        const ref = nextRef('cmp');
        const name = cleanText(str(row, 'campaign.name'));
        evidence.push({
          ref,
          kind: 'campaign',
          data: {
            id: str(row, 'campaign.id'),
            name,
            resource_name: str(row, 'campaign.resource_name'),
            positive_geo_target_type: 'PRESENCE_OR_INTEREST',
          },
        });
        return { ref, name };
      });

    return okResult(
      {
        period,
        currency: safeCurrency(ctx),
        truncated: geoRows.length >= ROW_LIMIT,
        total_cost: money(totalCost),
        area_of_interest: {
          cost: money(areaOfInterestCost),
          share_of_spend_pct: pct1(ratio(areaOfInterestCost, totalCost)),
        },
        cities_total: cities.size,
        cities_named: named.length,
        top_cities: topCities,
        zero_conversion_cities: zeroConversion,
        campaign_settings_available: settingRows !== null,
        campaigns_using_presence_or_interest: campaignsPresenceOrInterest,
      },
      evidence
    );
  },
};
