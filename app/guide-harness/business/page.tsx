import { OnboardingProgress } from '../../onboarding/onboarding-progress';
import { BusinessForm } from '../../onboarding/business/business-form';
import { OnboardingShell } from '../layout';

export default function Page() {
  return (
    <OnboardingShell>
      <main className="px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <OnboardingProgress active="business" />
          <div className="mb-6 mt-8">
            <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">عرّفنا على نشاطك</h2>
            <p className="mt-2 max-w-2xl text-sm leading-7 text-muted-foreground">
              هذي البيانات لا تغيّر أي شيء في حسابك الإعلاني، لكنها تجعل التوصيات مناسبة لسوقك وميزانيتك.
            </p>
          </div>
          <BusinessForm
            initial={{ name: '', sector: '', website: '', monthly_budget: '', primary_goal: 'leads', target_regions: '' }}
            serverError={null}
            canLeave={false}
          />
        </div>
      </main>
    </OnboardingShell>
  );
}
