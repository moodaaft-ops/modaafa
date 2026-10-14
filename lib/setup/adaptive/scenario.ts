import {
  KIND_CONFIDENT_LEAD,
  KIND_CONFIDENT_SCORE,
  TRACKING_SUSPECT_MIN_CLICKS,
  type AccountState,
  type BusinessKind,
  type ClassifyInput,
  type ClinicSpecialty,
  type Scenario,
  type StorePlatform,
} from './types';
import {
  CLINIC_WORDS,
  DENTAL_WORDS,
  DERMA_WORDS,
  LOCAL_WORDS,
  PLATFORM_HOSTS,
  SERVICES_WORDS,
  STATED_KIND,
  answeredChoice,
  averageOrder,
  campaignTotals,
  containsAny,
  countMatches,
  dominantGroup,
  groupConversions,
  outcomeOfGroup,
  sigValue,
} from './shared';

type Scored = Exclude<BusinessKind, 'general'>;

/** Tie order when two kinds score the same. */
const SCORED_KINDS: Scored[] = ['ecommerce', 'clinic', 'services', 'local'];

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** Dental unless the name is about hair (زراعة الشعر), derma, else general. */
function specialtyOf(names: string[]): ClinicSpecialty {
  let dental = 0;
  let derma = 0;
  for (const name of names) {
    const isHair = containsAny(name, ['شعر', 'hair']);
    if (containsAny(name, DENTAL_WORDS) && !(isHair && !containsAny(name, ['أسنان', 'dental']))) dental += 1;
    if (containsAny(name, DERMA_WORDS)) derma += 1;
  }
  if (dental > derma) return 'dental';
  if (derma > dental) return 'derma';
  return 'general';
}

/**
 * The tree's state, kind and evidence, from what the account says and what the
 * customer already answered. Pure rules; a signal that failed to read is never
 * leaned on, so a failed read just leaves the question to be asked.
 */
export function classifyScenario(input: ClassifyInput): Scenario {
  const { signals, linkedAccounts, connectNoAccount, answered } = input;
  const evidence: string[] = [];
  // The kind the customer agreed with on the opener. «general» says nothing, so it is not used.
  const confirmed = input.confirmed && input.confirmed.kind !== 'general' ? input.confirmed : null;

  const campaigns = sigValue(signals?.campaigns);
  const stated = (() => {
    const typeId = answeredChoice(answered, 'type');
    return typeId ? STATED_KIND[typeId] ?? null : null;
  })();
  const confirmedNo = answeredChoice(answered, 'confirm') === 'no';

  // --- state: the first rule that applies
  let state: AccountState = 'active';
  const declaredNone = connectNoAccount || answeredChoice(answered, 'has_account') === 'none';
  if (linkedAccounts === 0 && declaredNone) {
    state = 'no_account';
    evidence.push('no_account');
  } else if (!campaigns) {
    evidence.push('no_read');
    // The read failed, but the platform may already know whether the account spends. Only the
    // answer «nothing runs» changes the state; «it spends» keeps it active with no kind guessed.
    if (input.activityHint === 'empty') {
      state = 'new';
      evidence.push('hint:empty');
    } else if (input.activityHint === 'spends') {
      evidence.push('hint:spends');
    }
  } else {
    evidence.push('read');
    const totals = campaignTotals(campaigns);
    if (campaigns.length === 0 || (totals.cost <= 0 && totals.impressions <= 0)) {
      state = campaigns.some((campaign) => campaign.status === 'PAUSED') ? 'dormant' : 'new';
    } else if (totals.cost > 0) {
      const actions = sigValue(signals?.enabledConversionActions);
      if (actions === 0) {
        state = 'no_tracking';
      } else if (actions !== null && actions > 0 && totals.conversions <= 0 && totals.clicks >= TRACKING_SUSPECT_MIN_CLICKS) {
        state = 'tracking_suspect';
      }
    }
  }
  evidence.push(`state:${state}`);

  // --- managed
  const manager = answeredChoice(answered, 'manager');
  const external = sigValue(signals?.externalManager);
  const editors = sigValue(signals?.otherEditors14d);
  let managed: Scenario['managed'] = 'none';
  if (state !== 'no_account') {
    if (manager === 'agency' || manager === 'employee') {
      managed = 'confirmed';
    } else if (external?.linked === true || (editors !== null && editors >= 1)) {
      managed = 'suspected';
    }
    if (external !== null && editors !== null) evidence.push('mgr_read');
    if (external?.linked === true) evidence.push('mgr:link');
    if (editors !== null && editors >= 1) evidence.push('mgr:editors');
  }

  // --- what the account itself answers (the question bank skips these)
  if ((sigValue(signals?.targetedPlaces) ?? []).length > 0) evidence.push('places');
  if ((sigValue(signals?.landingHosts) ?? []).length > 0) evidence.push('hosts');

  // --- kind scores
  const scores: Record<Scored, number> = { ecommerce: 0, clinic: 0, services: 0, local: 0 };
  let platform: StorePlatform | null = null;
  const names = (campaigns ?? []).map((campaign) => campaign.name);
  const dominant = dominantGroup(signals);

  if (campaigns) {
    for (const host of sigValue(signals?.landingHosts) ?? []) {
      const hit = PLATFORM_HOSTS.find((entry) => hostMatches(host.toLowerCase().replace(/^www\./, ''), entry.host));
      if (hit) {
        platform = platform ?? hit.platform;
      }
    }
    if (platform) {
      scores.ecommerce += 3;
      evidence.push(`host:${platform}`);
    }
    if (sigValue(signals?.merchantCenterLinked) === true) {
      scores.ecommerce += 3;
      evidence.push('mc');
    }
    if (
      campaigns.some((campaign) => campaign.kind === 'SHOPPING' || campaign.kind === 'PMAX') &&
      groupConversions(signals, 'purchase') >= 1
    ) {
      scores.ecommerce += 2;
      evidence.push('pmax_purchase');
    }
    const totals = campaignTotals(campaigns);
    if (totals.value > 0) {
      scores.ecommerce += 1;
      evidence.push('value');
    }

    if (countMatches(names, CLINIC_WORDS) > 0) {
      scores.clinic += 3;
      evidence.push('words:clinic');
    }
    if (dominant === 'call' || dominant === 'booking') {
      scores.clinic += 1;
      scores.services += 1;
      evidence.push(`conv:${dominant === 'call' ? 'call' : 'booking'}`);
    } else if (dominant === 'lead_form' || dominant === 'contact') {
      // The design table gives services a point for forms and contacts without purchases.
      scores.services += 1;
      evidence.push(`conv:${dominant === 'lead_form' ? 'form' : 'contact'}`);
    } else if (dominant) {
      evidence.push(`conv:${dominant === 'purchase' ? 'purchase' : dominant === 'directions' ? 'directions' : 'store_visit'}`);
    }
    if (countMatches(names, SERVICES_WORDS) > 0) {
      scores.services += 3;
      evidence.push('words:services');
    }

    // A location asset is not a sign of a shop: on real accounts (14 Oct 2026) a dental clinic and a pool
    // contractor both had their Business Profile linked. Only a Local campaign counts.
    if (campaigns.some((campaign) => campaign.kind === 'LOCAL')) {
      scores.local += 2;
      evidence.push('loc');
    }
    if (dominant === 'directions' || dominant === 'store_visit') scores.local += 2;
    if (countMatches(names, LOCAL_WORDS) > 0) {
      scores.local += 3;
      evidence.push('words:local');
    }
  }

  const readable = Boolean(campaigns) && state !== 'no_account';
  const ranked = [...SCORED_KINDS].sort((a, b) => scores[b] - scores[a] || SCORED_KINDS.indexOf(a) - SCORED_KINDS.indexOf(b));
  const top = scores[ranked[0]];
  const second = scores[ranked[1]];

  // Nothing read, or no account: we guess nothing and ask everything.
  let kind: BusinessKind = 'general';
  let kindConfidence: Scenario['kindConfidence'] = 'none';
  if (readable && top >= 1) {
    kind = ranked[0];
    kindConfidence = top >= KIND_CONFIDENT_SCORE && top - second >= KIND_CONFIDENT_LEAD ? 'confident' : 'guess';
  }

  // Kinds in score order, «general» right after the ones that scored, then the rest. Always starts with `kind`.
  const scored = readable ? ranked.filter((key) => scores[key] >= 1) : [];
  let kindRanking: BusinessKind[] = [...scored, 'general', ...SCORED_KINDS.filter((key) => !scored.includes(key))];

  let usedConfirmed = false;
  if (stated) {
    kind = stated;
    kindConfidence = 'stated';
    kindRanking = [stated, ...kindRanking.filter((key) => key !== stated)];
    evidence.push('stated:type');
  } else if (confirmed && !confirmedNo && state !== 'no_account') {
    // The customer agreed with this kind on the opener. It stays their word when the read is gone or says something else.
    kind = confirmed.kind;
    kindConfidence = 'confident';
    kindRanking = [confirmed.kind, ...kindRanking.filter((key) => key !== confirmed.kind)];
    usedConfirmed = true;
    evidence.push('confirmed:kind');
  } else if (confirmedNo && kindConfidence !== 'none') {
    kindConfidence = 'none';
    evidence.push('confirm:no');
  }

  // --- platform and specialty only mean something for their kind
  const specialty: ClinicSpecialty | null = kind === 'clinic' ? specialtyOf(names) : null;
  const finalPlatform = kind === 'ecommerce' ? platform : null;

  // --- the average order the account reports, when it can (a question only exists then)
  if (averageOrder(signals) !== null) evidence.push('aov');
  if (sigValue(signals?.hours)) evidence.push('hours');
  if (sigValue(signals?.products)) evidence.push('products');

  let outcome: Scenario['outcome'] = campaigns ? outcomeOfGroup(dominant) : 'unknown';
  if (usedConfirmed && outcome === 'unknown' && confirmed?.outcome && confirmed.outcome !== 'unknown') {
    outcome = confirmed.outcome;
    evidence.push('confirmed:outcome');
  }

  return {
    state,
    managed,
    kind,
    kindConfidence,
    kindRanking,
    platform: finalPlatform,
    specialty,
    outcome,
    evidence,
  };
}
