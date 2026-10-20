import { landingCheckEnabled } from './flag';
import type { LandingCheckStore, TrackingEvidence } from './run';

/**
 * The landing page's tag evidence as SUPPORT for the conversion-tracking verdict.
 * It never changes the verdict: it only says whether the page code agrees with
 * a suspect or missing verdict, so the merchant knows where to look first.
 */
export type LandingSupport = {
  supporting_only: true;
  google_tag: TrackingEvidence['googleTag'];
  pages_checked: number;
  checked_days_ago: number;
  line_ar: string;
  /** Present only when the verdict is about missing or silent tracking and the page shows no Google tag. */
  note_ar?: string;
};

const TRACKING_VERDICTS = new Set(['missing', 'suspect', 'broken_recently']);

/** Reads the stored check only (never fetches a page). Flag off: null without touching the store. */
export async function landingSupportForVerdict(args: {
  enabled?: boolean;
  store: () => LandingCheckStore | null;
  accountId: string;
  verdict: string;
  now: Date;
}): Promise<LandingSupport | null> {
  if (!(args.enabled ?? landingCheckEnabled())) return null;
  try {
    const store = args.store();
    if (!store) return null;
    const latest = await store.latest(args.accountId);
    if (!latest) return null;
    const tracking = latest.report.tracking;
    const days = Math.max(0, Math.floor((args.now.getTime() - Date.parse(latest.checked_at)) / 86_400_000));
    const out: LandingSupport = {
      supporting_only: true,
      google_tag: tracking.googleTag,
      pages_checked: tracking.pagesChecked,
      checked_days_ago: days,
      line_ar: tracking.line_ar,
    };
    if (TRACKING_VERDICTS.has(args.verdict) && tracking.googleTag === 'not_visible') {
      out.note_ar = 'كود صفحة الهبوط ما يظهر فيه وسم قوقل، وهذا يدعم احتمال إن التتبع ناقص. وهو قراءة من برا الصفحة، مو حكم نهائي.';
    }
    return out;
  } catch {
    return null;
  }
}
