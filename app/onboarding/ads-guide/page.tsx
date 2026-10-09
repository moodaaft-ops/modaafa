import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ArrowLeft, ArrowUpLeft, MessageCircle } from 'lucide-react';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { buttonClasses } from '@/lib/ui/button';
import { SUPPORT_WHATSAPP_DISPLAY, whatsappHelpUrl } from '@/lib/support/contact';
import {
  ADS_SIGNUP_URL,
  GUIDE_LIMIT_NOTE,
  GUIDE_REGION_NOTICE,
  GUIDE_VIDEO_SEGMENT,
  GUIDE_STEPS,
  resolveGuideVideo,
} from '@/lib/onboarding/ads-guide';
import { OnboardingProgress } from '../onboarding-progress';
import { GuideVideoButton } from './guide-video';

export const metadata = {
  title: 'افتح حسابك الإعلاني',
};

export default async function AdsGuidePage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/onboarding/ads-guide');

  const { business } = await getAccountWorkspace(user.id);
  if (!business) redirect('/onboarding/business');

  const video = resolveGuideVideo(
    process.env.NEXT_PUBLIC_ADS_GUIDE_VIDEO_ID,
    'فتح حساب Google Ads (مقطع إنشاء الحساب فقط)',
    GUIDE_VIDEO_SEGMENT
  );

  return (
    <main className="px-4 py-8 sm:px-6">
      <div className="mx-auto max-w-4xl">
        <OnboardingProgress active="connect" />

        <div className="mb-6 mt-8">
          <Link
            href="/onboarding/connect"
            className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5 rotate-180" />
            رجوع لربط Google Ads
          </Link>
          <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">افتح حسابك الإعلاني</h2>
          <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
            فتح الحساب عندك أنت داخل Google، ونحن ما ننشئ حساباً ولا نضيف فوترة نيابة عنك. تخلصه في دقائق، وترجع هنا تكمل من نفس المكان.
          </p>
        </div>

        <section className="surface-card p-5 sm:p-6">
          <p className="mb-5 border-s-2 border-signal bg-background-elevated px-4 py-3 text-[13px] leading-7 text-foreground">
            {GUIDE_REGION_NOTICE}
          </p>

          <ol className="space-y-4">
            {GUIDE_STEPS.map((step, index) => (
              <li key={step.title} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center bg-signal text-xs font-bold text-signal-foreground">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="text-[14px] font-semibold leading-7 text-foreground">{step.title}</p>
                  <p className="text-[13px] leading-7 text-muted-foreground">{step.body}</p>
                </div>
              </li>
            ))}
          </ol>

          <p className="mt-5 border-t border-border pt-4 text-[12.5px] leading-6 text-muted-foreground">
            {GUIDE_LIMIT_NOTE} وشاشات Google تتغير، فإذا اختلف الشكل عندك راسلنا ونمشي معك.
          </p>

          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <a
              href={ADS_SIGNUP_URL}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonClasses({ variant: 'primary', size: 'lg' })}
            >
              افتح Google Ads
              <ArrowUpLeft className="h-4 w-4" />
            </a>
            {video && <GuideVideoButton video={video} />}
            <Link href="/onboarding/connect" className={buttonClasses({ variant: 'outline' })}>
              فتحت الحساب، أبغى أربطه
            </Link>
          </div>
        </section>

        <div className="mt-5 flex flex-col gap-3 border border-border bg-background-elevated px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] leading-7 text-foreground">تفضّل أحد يمشي معك؟ نفتحه معك على واتساب، بدون رسوم.</p>
          <a
            href={whatsappHelpUrl('no_ads_account', user.email)}
            target="_blank"
            rel="noopener noreferrer"
            className={`${buttonClasses({ variant: 'outline' })} flex-shrink-0`}
          >
            <MessageCircle className="h-4 w-4" />
            <span dir="ltr" className="numeric">
              {SUPPORT_WHATSAPP_DISPLAY}
            </span>
          </a>
        </div>
      </div>
    </main>
  );
}
