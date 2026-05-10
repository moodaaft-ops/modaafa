import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createServerClient } from '@/lib/supabase/server';

const ERROR_MESSAGES: Record<string, { title: string; detail: string; hint?: string }> = {
  oauth_failed: {
    title: 'فشل ربط حساب Google Ads',
    detail: 'حصل خطأ أثناء التواصل مع Google Ads API.',
    hint: 'الأسباب الأكثر احتمالاً: (1) الـ Developer Token لسّه على Basic Access وما تمت الموافقة على Standard Access بعد، (2) الحساب الذي سجّلت دخوله ليس عنده أي حساب Google Ads.',
  },
  developer_token: {
    title: 'الـ Developer Token غير مفعّل بشكل كامل',
    detail: 'Google Ads API ما يقدر يقرأ بياناتك لأن الـ Developer Token لسّه على Basic Access.',
    hint: 'هذا متوقع — أنت قدّمت طلب Standard Access وننتظر رد Google (3-5 أيام عمل). لو فيه ردّ منهم، تأكد من التفعيل في api-center في Google Ads.',
  },
  no_refresh_token: {
    title: 'Google ما رجّع refresh token',
    detail: 'هذا يحصل عادةً لو ربطت Modaafa مع نفس الحساب من قبل.',
    hint: 'روح myaccount.google.com/permissions، أزل الإذن لـ Modaafa، ثم رجع وحاول.',
  },
  invalid_grant: {
    title: 'انتهت صلاحية رابط الموافقة',
    detail: 'مرّت فترة طويلة بين ضغطك على "Connect" وموافقتك على Google.',
    hint: 'حاول مرة ثانية بسرعة.',
  },
  state_mismatch: {
    title: 'انتهت صلاحية الجلسة',
    detail: 'الرابط الذي رجعت منه ما ضبط مع جلستك. هذا يحدث لو فتحت الرابط بعد فترة طويلة أو في متصفح مختلف.',
    hint: 'حاول مرة ثانية من نفس المتصفح.',
  },
  missing_params: {
    title: 'الرابط ناقص بيانات',
    detail: 'الـ callback من Google ما رجع كل البيانات المطلوبة.',
  },
  no_accounts: {
    title: 'ما وجدنا حسابات Google Ads',
    detail: 'الحساب الذي سجّلت دخوله ما عنده أي حساب Google Ads مرتبط فيه.',
    hint: 'تأكد إنك سجّلت بالحساب الصحيح. لو ما عندك حساب Google Ads، أنشئ واحد من ads.google.com ثم رجع هنا.',
  },
  db_error: {
    title: 'خطأ في حفظ الربط',
    detail: 'تم الربط مع Google لكن حدث خطأ أثناء حفظ البيانات في قاعدة البيانات.',
    hint: 'حاول مرة ثانية. لو استمرت المشكلة تواصل معنا.',
  },
  access_denied: {
    title: 'تم رفض الإذن',
    detail: 'لم تمنح Modaafa الإذن للوصول لحساب Google Ads.',
    hint: 'تحتاج تضغط "السماح" في شاشة Google ليكتمل الربط.',
  },
};

export default async function ConnectGoogleAdsPage({
  searchParams,
}: {
  searchParams: { error?: string };
}) {
  const supabase = createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/onboarding/connect');

  // If already connected, skip to dashboard
  const { data: business } = await supabase
    .from('businesses')
    .select('id')
    .eq('user_id', user.id)
    .single();

  if (business) {
    const { data: existingAccount } = await supabase
      .from('google_ads_accounts')
      .select('id')
      .eq('business_id', business.id)
      .eq('status', 'active')
      .limit(1)
      .single();
    if (existingAccount) redirect('/dashboard?connected=1');
  }

  const errorKey = searchParams.error;
  const errorInfo = errorKey ? ERROR_MESSAGES[errorKey] ?? {
    title: 'حدث خطأ غير متوقع',
    detail: `رمز الخطأ: ${errorKey}`,
  } : null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-ink-50 to-brand-50 p-4">
      <div className="w-full max-w-xl bg-white rounded-3xl shadow-xl p-8 md:p-10">
        <div className="text-center mb-8">
          <div className="inline-flex w-16 h-16 rounded-2xl bg-gradient-to-br from-brand-500 to-cyan-500 items-center justify-center text-white text-3xl font-bold mb-4">
            ×
          </div>
          <h1 className="text-2xl font-bold mb-1">اربط حسابك في Google Ads</h1>
          <p className="text-ink-500 text-sm">
            ليبدأ مُضاعِف بإدارة حملاتك بالذكاء الاصطناعي
          </p>
        </div>

        {errorInfo && (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 p-5">
            <div className="flex items-start gap-3">
              <div className="w-6 h-6 rounded-full bg-red-500 text-white flex items-center justify-center text-sm font-bold flex-shrink-0 mt-0.5">
                !
              </div>
              <div>
                <h3 className="font-bold text-red-900 mb-1">{errorInfo.title}</h3>
                <p className="text-sm text-red-800 mb-2">{errorInfo.detail}</p>
                {errorInfo.hint && (
                  <p className="text-xs text-red-700 leading-relaxed">{errorInfo.hint}</p>
                )}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 mb-6 text-sm text-ink-600 leading-relaxed">
          <div className="flex items-start gap-3">
            <span className="text-emerald-500 font-bold">✓</span>
            <span>القراءة فقط في البداية — لا نغيّر شيئاً بدون إذنك</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-emerald-500 font-bold">✓</span>
            <span>تشفير الـ tokens في قاعدة البيانات (AES-256)</span>
          </div>
          <div className="flex items-start gap-3">
            <span className="text-emerald-500 font-bold">✓</span>
            <span>تقدر تفصل الربط في أي وقت من الإعدادات</span>
          </div>
        </div>

        <a
          href="/api/auth/google-ads/connect"
          className="w-full block text-center py-3.5 rounded-xl bg-gradient-to-r from-brand-600 to-brand-500 text-white font-semibold hover:from-brand-700 hover:to-brand-600 transition"
        >
          {errorInfo ? 'حاول مرة ثانية' : 'ربط حساب Google Ads'}
        </a>

        <div className="mt-6 pt-6 border-t border-ink-100 text-center">
          <Link �ref="/dashboard" className="text-sm text-ink-500 hover:text-ink-900">
            تخطّي مؤقتاً
          </Link>
        </div>
      </div>
    </div>
  );
}
