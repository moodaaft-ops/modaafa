import { OnboardingProgress } from '../../onboarding/onboarding-progress';
import { ConnectGoogleAdsButton } from '../../onboarding/connect/connect-google-ads-button';
import { Alert } from '@/lib/ui/alert';
import { OnboardingShell } from '../layout';

export default function Page() {
  return (
    <OnboardingShell>
      <main className="px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <OnboardingProgress active="connect" />
          <div className="mb-6 mt-8">
            <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">ربط Google Ads</h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
              موافقة واحدة تكفي لسحب كل حساباتك، وبعدها تختار الحساب الذي نبدأ به.
            </p>
          </div>
          <div className="mb-5">
            <Alert tone="info" title="هذه ليست إعادة تسجيل الدخول">
              أنت مسجّل في مُضاعِف بالفعل. تسجيل الدخول منحنا اسمك وبريدك فقط، أما هذه الخطوة فتطلب من Google صلاحية Google Ads حتى تستطيع المنصة قراءة حساباتك وتحديث بياناتها.
            </Alert>
          </div>
          <ConnectGoogleAdsButton />
        </div>
      </main>
    </OnboardingShell>
  );
}
