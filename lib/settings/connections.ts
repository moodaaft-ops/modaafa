import { EXTRA_FEATURES, FEATURE_CONSENT_COPY_AR, isExtraFeature, isExtraFeatureEnabled, type ExtraFeature } from '../google-auth/features';
import { isStoreSyncEnabled } from '../stores/flags';
import { isStorePlatform } from '../stores/state';

/** Pure view model for the Settings "connections" section: what to show, in Arabic, from flags and rows. */

type Env = Record<string, string | undefined>;
export type GrantStatus = 'active' | 'revoked' | 'error' | 'none';
export type StoreRow = { platform: string; external_store_id: string; status: string; last_error?: string | null };

const EXTRA_OUTCOME_AR: Record<string, { tone: 'success' | 'danger' | 'warning'; text: string }> = {
  connected: { tone: 'success', text: 'تم الربط.' },
  declined: { tone: 'warning', text: 'ما أكملت الموافقة في قوقل، فما انربط شي.' },
  missing_scope: { tone: 'warning', text: 'ألغيت خانة الصلاحية في شاشة قوقل، فما انربط. أعد المحاولة وخلها مفعلة.' },
  extra_scope: { tone: 'danger', text: 'قوقل رجّعت صلاحيات أكثر من المطلوب، فرفضنا الربط حمايةً لك.' },
  no_refresh_token: { tone: 'warning', text: 'قوقل ما أعطتنا إذن يدوم. أعد المحاولة ووافق من جديد.' },
  state_invalid: { tone: 'danger', text: 'انتهت صلاحية طلب الربط. ابدأ من جديد.' },
  state_user_mismatch: { tone: 'danger', text: 'طلب الربط يخص حساباً ثاني. سجل دخولك وابدأ من جديد.' },
  state_unavailable: { tone: 'danger', text: 'تعذر بدء الربط الحين. أعد المحاولة بعد شوي.' },
  oauth_config_missing: { tone: 'danger', text: 'الربط غير مجهز على المنصة بعد. تواصل معنا.' },
  oauth_failed: { tone: 'danger', text: 'تعذر إكمال الربط. أعد المحاولة.' },
  missing_params: { tone: 'danger', text: 'رجع الطلب ناقص. ابدأ من جديد.' },
  too_many_requests: { tone: 'warning', text: 'حاولت عدة مرات. انتظر شوي ثم أعد المحاولة.' },
  security_service_unavailable: { tone: 'danger', text: 'تعذر التحقق الأمني الحين. أعد المحاولة بعد شوي.' },
  store_unreadable: { tone: 'danger', text: 'ما قدرنا نقرأ بيانات المتجر من المنصة، فما انربط.' },
  invalid_shop: { tone: 'warning', text: 'اكتب عنوان المتجر بالشكل: اسم-متجرك.myshopify.com' },
  store_taken: { tone: 'danger', text: 'هذا المتجر مربوط بحساب ثاني.' },
};

export function outcomeMessage(outcome: unknown): { tone: 'success' | 'danger' | 'warning'; text: string } | null {
  return typeof outcome === 'string' ? (EXTRA_OUTCOME_AR[outcome] ?? { tone: 'danger', text: 'تعذر إكمال الربط.' }) : null;
}

/** Which reads the Settings section needs. All false (every flag off): no read at all. */
export function connectionsReads(env: Env = process.env): { grants: boolean; stores: boolean } {
  return { grants: EXTRA_FEATURES.some((f) => isExtraFeatureEnabled(f, env)), stores: isStoreSyncEnabled(env) };
}

export type ConnectionsView = {
  show: boolean;
  notice: { tone: 'success' | 'danger' | 'warning'; text: string } | null;
  google: { feature: ExtraFeature; title: string; body: string; status: GrantStatus; label: string; actionHref: string | null; actionLabel: string }[];
  stores: { platform: 'salla' | 'zid' | 'shopify'; name: string; status: 'connected' | 'needs_reconnect' | 'none'; label: string; detail: string | null; actionHref: string; needsShop: boolean; actionLabel: string }[];
};

const STORE_NAME = { salla: 'سلة', zid: 'زد', shopify: 'شوبيفاي' } as const;
const GRANT_LABEL: Record<GrantStatus, string> = { active: 'مربوط', revoked: 'انسحبت الصلاحية', error: 'يحتاج إعادة ربط', none: 'غير مربوط' };

export function buildConnectionsView(args: {
  params: { extra?: string; feature?: string; store?: string; platform?: string } | undefined;
  grants: Record<ExtraFeature, GrantStatus> | null;
  stores: StoreRow[];
  env?: Env;
}): ConnectionsView {
  const env = args.env ?? process.env;
  const google = EXTRA_FEATURES.filter((f) => isExtraFeatureEnabled(f, env)).map((feature) => {
    const status = args.grants?.[feature] ?? 'none';
    const copy = FEATURE_CONSENT_COPY_AR[feature];
    return {
      feature,
      title: copy.title,
      body: copy.body,
      status,
      label: GRANT_LABEL[status],
      actionHref: `/api/auth/google-extra/start?feature=${feature}`,
      actionLabel: status === 'active' ? 'إعادة الربط' : 'ربط',
    };
  });
  const storeOn = isStoreSyncEnabled(env);
  const stores = storeOn
    ? (['salla', 'zid', 'shopify'] as const).map((platform) => {
        const row = args.stores.find((s) => s.platform === platform);
        const status: 'none' | 'connected' | 'needs_reconnect' = !row ? 'none' : row.status === 'active' ? 'connected' : 'needs_reconnect';
        return {
          platform,
          name: STORE_NAME[platform],
          status,
          label: status === 'connected' ? 'مربوط' : status === 'needs_reconnect' ? 'يحتاج إعادة ربط' : 'غير مربوط',
          detail: row ? `رقم المتجر ${row.external_store_id}` : null,
          actionHref: `/api/auth/stores/${platform}/start`,
          needsShop: platform === 'shopify',
          actionLabel: status === 'connected' ? 'إعادة الربط' : 'ربط المتجر',
        };
      })
    : [];
  const p = args.params ?? {};
  const raw = p.extra ?? p.store;
  const featureOk = p.extra ? isExtraFeature(p.feature) : p.store ? isStorePlatform(p.platform) || p.platform === 'shopify' : false;
  return {
    show: google.length > 0 || stores.length > 0,
    notice: raw && featureOk ? outcomeMessage(raw) : null,
    google,
    stores,
  };
}
