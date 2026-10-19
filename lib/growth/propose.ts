import { buildDemandGenPlan, evaluateDemandGenReadiness, type DemandGenInput, type DemandGenContext } from '../demand-gen/plan';
import { readReadiness } from './readiness';
import { proposeExperimentPlan, type ExperimentInput } from '../experiments/plan';
import { readExperimentResults } from '../experiments/results';
import { validateCreateUserListParams } from '../audiences/user-lists';
import { validatePromoteParams, validateEndParams } from '../experiments/execute';
import { guardedFetch, type FetchDeps } from '../landing-check/fetch';
import { resolveSiteUrl } from '../launch/assets';
import { extractImageCandidates } from '../image-assets/extract';
import { fetchImage } from '../image-assets/fetch';
import { evaluateImage, type ImageEvaluation } from '../image-assets/evaluate';
import { MAX_IMAGES_PER_CARD, type ImageAssetItem } from '../image-assets/execute';
import { IMAGE_SLOTS, type ImageSlot } from '../image-assets/requirements';
import { createGrowthCard, growthCardRow } from './card';
import { growthOperationEnabled } from './flags';
import type { GrowthCustomer } from './types';

/**
 * Proposals: read the account, build the plan on the server, and (when it is allowed) create ONE
 * pending approval card. Nothing here changes the Google Ads account.
 */

const sar = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)} ريال`;

export async function proposeDemandGen(args: {
  admin: any;
  accountId: string;
  customer: GrowthCustomer;
  input: DemandGenInput;
  context: DemandGenContext;
}) {
  if (!growthOperationEnabled('launch_demand_gen')) throw new Error('disabled');
  const plan = buildDemandGenPlan(args.input, args.context);
  const readiness = await readReadiness(args.customer);
  const blockers = evaluateDemandGenReadiness(plan, readiness);
  const full = { ...plan, blockers: [...plan.blockers, ...blockers] };
  full.executable = full.blockers.length === 0;
  if (!full.executable) return { plan: full, cardId: null as string | null };
  const row = growthCardRow(
    args.accountId,
    'launch_demand_gen',
    { plan: full },
    `حملة «${full.name}» تنبني موقوفة بميزانية ${sar(full.budget.daily_sar)} يومياً. ما يصرف شي لين توافق على تشغيلها.`
  );
  const card = await createGrowthCard(args.admin, row);
  return { plan: full, cardId: card.id };
}

export async function proposeUserList(args: { admin: any; accountId: string; params: unknown }) {
  if (!growthOperationEnabled('create_user_list')) throw new Error('disabled');
  const checked = validateCreateUserListParams(args.params);
  if (!checked.ok) return { ok: false as const, code: checked.code };
  const kind = checked.value.kind === 'customer_match' ? 'قائمة عملاء، ما نرفع أسماء إلا بعد تأكيدك' : 'قائمة زوار الموقع';
  const card = await createGrowthCard(
    args.admin,
    growthCardRow(args.accountId, 'create_user_list', { ...checked.value }, `ننشئ «${checked.value.name}»: ${kind}.`, 'audience')
  );
  return { ok: true as const, cardId: card.id };
}

export async function proposeExperiment(args: { admin: any; accountId: string; customer: GrowthCustomer; input: ExperimentInput }) {
  if (!growthOperationEnabled('create_experiment')) throw new Error('disabled');
  const proposal = await proposeExperimentPlan(args.customer, args.input);
  if (!proposal.ok) return { ok: false as const, blockers: proposal.blockers, cardId: null };
  const plan = proposal.plan;
  const card = await createGrowthCard(
    args.admin,
    growthCardRow(
      args.accountId,
      'create_experiment',
      { plan },
      `تجربة على حملة «${plan.campaign_name}»: ${plan.treatment_split}٪ من الزيارات للتغيير و${100 - plan.treatment_split}٪ تبقى كما هي، من ${plan.start_date} إلى ${plan.end_date}. ما نحكم على النتيجة قبل ما تكفي الأرقام.`,
      'experiment'
    )
  );
  return { ok: true as const, plan, cardId: card.id };
}

export async function proposeEndExperiment(args: { admin: any; accountId: string; customerId: string; experiment_resource: string }) {
  if (!growthOperationEnabled('end_experiment')) throw new Error('disabled');
  const checked = validateEndParams({ experiment_resource: args.experiment_resource }, args.customerId);
  if (!checked.ok) return { ok: false as const, code: checked.code };
  const card = await createGrowthCard(
    args.admin,
    growthCardRow(args.accountId, 'end_experiment', { ...checked.value }, 'نوقف التجربة. الحملة الأصلية تكمل كما هي، والتجربة ما ترجع تشتغل.', 'experiment')
  );
  return { ok: true as const, cardId: card.id };
}

/** A promote card exists only when fresh numbers show the treatment winning. */
export async function proposePromoteExperiment(args: {
  admin: any;
  accountId: string;
  customer: GrowthCustomer;
  customerId: string;
  experiment_resource: string;
  metric: unknown;
}) {
  if (!growthOperationEnabled('promote_experiment')) throw new Error('disabled');
  const checked = validatePromoteParams({ experiment_resource: args.experiment_resource, metric: args.metric }, args.customerId);
  if (!checked.ok) return { ok: false as const, code: checked.code };
  const reading = await readExperimentResults(args.customer, checked.value.experiment_resource, checked.value.metric);
  const verdict = reading.verdict;
  if (verdict.status !== 'winner' || verdict.winner !== 'treatment') return { ok: false as const, code: 'no_winner', verdict };
  const card = await createGrowthCard(
    args.admin,
    growthCardRow(
      args.accountId,
      'promote_experiment',
      { ...checked.value },
      `${verdict.detail_ar} نطبّق التغيير على الحملة الأصلية. ما ينرجع بعد التطبيق.`,
      'experiment'
    )
  );
  return { ok: true as const, cardId: card.id, verdict };
}

export type ImageProposal = {
  page: string | null;
  evaluations: Array<ImageEvaluation & { source: string }>;
  chosen: ImageAssetItem[];
  cardId: string | null;
  note_ar: string | null;
};

/** Candidates from the merchant's own page, checked against the slots. Crops are proposals; nothing is generated. */
export async function proposeImageAssets(args: {
  admin: any;
  accountId: string;
  website: string | null | undefined;
  pageUrl?: string | null;
  deps: FetchDeps;
}): Promise<ImageProposal> {
  if (!growthOperationEnabled('create_image_assets')) throw new Error('disabled');
  const page = resolveSiteUrl(args.pageUrl ?? args.website ?? '', args.website);
  if (!page) return { page: null, evaluations: [], chosen: [], cardId: null, note_ar: 'ما قدرنا نحدد صفحة من موقعك' };
  const fetched = await guardedFetch(page, args.deps);
  if (!fetched.ok || !fetched.html) return { page, evaluations: [], chosen: [], cardId: null, note_ar: 'ما قدرنا نفتح الصفحة' };
  const candidates = extractImageCandidates(fetched.html, fetched.finalUrl);

  const evaluations: ImageProposal['evaluations'] = [];
  const chosen: ImageAssetItem[] = [];
  const taken = new Set<ImageSlot>();
  const seenHash = new Set<string>();
  for (const candidate of candidates.slice(0, 16)) {
    const image = await fetchImage(candidate.url, args.deps);
    if (!image.ok || seenHash.has(image.sha256)) continue;
    seenHash.add(image.sha256);
    const evaluation = evaluateImage({
      url: image.url, width: image.probe.width, height: image.probe.height, bytes: image.bytes.length,
      format: image.probe.format, sha256: image.sha256, source: candidate.source, alt: candidate.alt,
    });
    evaluations.push({ ...evaluation, source: candidate.source });
    for (const slot of IMAGE_SLOTS) {
      if (taken.has(slot) || !evaluation.fits.includes(slot) || chosen.length >= MAX_IMAGES_PER_CARD) continue;
      taken.add(slot);
      chosen.push({ url: evaluation.url, sha256: evaluation.sha256, width: evaluation.width, height: evaluation.height, bytes: evaluation.bytes, slot });
    }
  }
  if (chosen.length === 0) {
    return { page, evaluations, chosen, cardId: null, note_ar: 'ما لقينا صور جاهزة بالمقاس الصحيح. اقتراحات القص موجودة، والقص ما نسويه نيابة عنك' };
  }
  const card = await createGrowthCard(
    args.admin,
    growthCardRow(
      args.accountId,
      'create_image_assets',
      { images: chosen },
      `نرفع ${chosen.length} ${chosen.length === 1 ? 'صورة' : 'صور'} من صفحتك للحساب كما هي بدون تعديل. ما تظهر بأي إعلان قبل ما تنربط بحملة.`,
      'assets'
    )
  );
  return { page, evaluations, chosen, cardId: card.id, note_ar: null };
}

