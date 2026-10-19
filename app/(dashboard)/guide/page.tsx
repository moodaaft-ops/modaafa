import { redirect } from 'next/navigation';
import { getRequestAuthContext } from '@/lib/supabase/server';
import { PlatformGuidePlayer } from '@/lib/ui/platform-guide';
import { CalmPage, CalmTitle } from '../calm-page';

export const metadata = {
  title: 'كيف أستخدم مُضاعِف',
};

export default async function GuidePage() {
  const { user } = await getRequestAuthContext();
  if (!user) redirect('/login?next=/guide');

  return (
    <CalmPage>
      <CalmTitle
        title="كيف أستخدم مُضاعِف"
        description="أربع دقايق من التسجيل لين أول قرار تعتمده. اضغط على أي فصل تبغاه وتبدأ منه."
      />
      <div className="mt-8">
        <PlatformGuidePlayer />
      </div>
    </CalmPage>
  );
}
