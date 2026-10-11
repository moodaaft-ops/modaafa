import { OnboardingProgress } from '../../onboarding/onboarding-progress';
import { ChooseAccountForm } from '../../onboarding/choose/choose-account-form';
import { OnboardingShell } from '../layout';

export default function Page() {
  return (
    <OnboardingShell>
      <main className="px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-4xl">
          <OnboardingProgress active="choose" />
          <div className="mb-6 mt-8">
            <h2 className="text-[26px] font-bold leading-tight sm:text-3xl">اختر الحساب الذي نبدأ به</h2>
          </div>
          <ChooseAccountForm
            initialCustomerId={null}
            accounts={[
              { customer_id: '1112223334', customer_name: 'متجر تجريبي', google_status: 'ENABLED', currency_code: 'SAR', spend: 4200 },
              { customer_id: '5556667778', customer_name: 'حساب قديم', google_status: 'ENABLED', currency_code: 'SAR', spend: 310 },
            ]}
          />
        </div>
      </main>
    </OnboardingShell>
  );
}
