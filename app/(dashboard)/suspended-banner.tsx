import { ShieldAlert } from 'lucide-react';
import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';

/**
 * Shown on every dashboard page while an operator has the account suspended.
 * Sync, the optimizer, execution and the assistant are all off until it is
 * lifted, so the customer needs to know why nothing is moving and who to call.
 */
export function SuspendedBanner() {
  return (
    <div
      role="alert"
      className="mx-4 mt-4 flex items-start gap-3 border border-danger/40 bg-danger/10 px-4 py-3 text-sm sm:mx-6 lg:mx-8"
    >
      <ShieldAlert className="mt-0.5 h-4 w-4 flex-shrink-0 text-danger" aria-hidden />
      <div className="leading-6 text-foreground">
        <span className="font-semibold">حسابك موقوف مؤقتاً.</span> ما راح نحدّث بيانات إعلاناتك ولا ننفذ أي توصية لين
        نرجّع التفعيل. تواصل معنا على واتساب{' '}
        <a
          href={`https://wa.me/${SUPPORT_WHATSAPP_NUMBER}`}
          className="font-semibold underline underline-offset-4"
          dir="ltr"
          target="_blank"
          rel="noreferrer"
        >
          {`0${SUPPORT_WHATSAPP_NUMBER.slice(3)}`}
        </a>
      </div>
    </div>
  );
}
