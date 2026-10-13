import { redirect } from 'next/navigation';
import { getAccountWorkspace } from '@/lib/accounts/selection';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { isSimpleExperience } from '@/lib/setup/mode';
import { loadSetupState } from '@/lib/setup/load';
import { SetupChat } from './setup/setup-chat';

export const metadata = {
  title: 'الإعداد الأول',
};

export default async function OnboardingPage({
  searchParams,
}: {
  searchParams?: Promise<{ edit?: string; error?: string; connect?: string }>;
}) {
  const { supabase, user } = await getRequestAuthContext();

  if (!user) redirect('/login?next=/onboarding');

  // The simple experience: the whole setup is one conversation with «مُضاعِف».
  if (isSimpleExperience(process.env, user.email)) {
    const params = await searchParams;
    let edit = params?.edit === '1';
    let state = await loadSetupState(supabase, user, { edit });
    // Editing needs a linked, chosen account; without one this is plain setup.
    if (edit && (state.stage === 'connect' || state.stage === 'connecting' || state.stage === 'choose')) {
      edit = false;
      state = await loadSetupState(supabase, user, { edit });
    }
    // «إضافة حساب» from inside the app opens the chat on the connect step.
    const adding = params?.connect === '1' && state.stage !== 'connecting';
    if (state.stage === 'done' && !edit && !adding) redirect('/home');
    return <SetupChat initial={state} errorCode={params?.error ?? null} adding={adding} />;
  }

  const { accounts, business } = await getAccountWorkspace(user.id);
  if (accounts.length > 0) redirect('/dashboard');

  if (business) redirect('/onboarding/connect');

  redirect('/onboarding/business');
}
