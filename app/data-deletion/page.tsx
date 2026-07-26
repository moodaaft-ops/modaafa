import Link from 'next/link';
import { LegalPage, LegalSection } from '@/lib/ui/legal-page';

export const metadata = {
  title: 'حذف الحساب والبيانات',
};

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="حذف الحساب والبيانات"
      description="يمكنك حذف حساب مُضاعِف والبيانات المرتبطة به من داخل المنصة أو إرسال طلب دعم إذا تعذر عليك الدخول."
      updatedAt="21 يوليو 2026"
    >
      <LegalSection title="الحذف من داخل المنصة">
        <ol className="list-decimal space-y-2 ps-5">
          <li>سجّل الدخول إلى مُضاعِف.</li>
          <li>افتح الإعدادات ثم قسم «حذف الحساب نهائياً».</li>
          <li>اكتب عبارة التأكيد ونفذ الحذف.</li>
        </ol>
        <p>
          تلغي المنصة اشتراكات Stripe القائمة أولاً، ثم تحذف بيانات النشاط والحسابات الإعلانية والمحادثات والتقارير
          والتوصيات وسجل المستخدم. إذا تعذر إلغاء الاشتراك فلن تكمل الحذف حمايةً لك من بقاء فوترة غير مرتبطة بحساب.
        </p>
        <p>
          <Link href="/settings" className="font-semibold text-primary hover:underline dark:text-primary">
            الانتقال إلى الإعدادات
          </Link>
        </p>
      </LegalSection>

      <LegalSection title="إذا لم تستطع تسجيل الدخول">
        <p>
          أرسل طلباً من البريد المرتبط بالحساب إلى{' '}
          <a href="mailto:moodaaft@gmail.com?subject=طلب حذف حساب مُضاعِف" className="font-semibold text-primary hover:underline dark:text-primary">
            moodaaft@gmail.com
          </a>{' '}
          بعنوان «طلب حذف حساب مُضاعِف». قد نطلب خطوة تحقق لحماية الحساب قبل تنفيذ الطلب.
        </p>
      </LegalSection>

      <LegalSection title="سحب صلاحية Google">
        <p>
          حذف حساب مُضاعِف لا يمنعك من سحب الصلاحية مباشرة من Google. يمكنك زيارة{' '}
          <a
            href="https://myaccount.google.com/connections"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary hover:underline dark:text-primary"
          >
            صفحة اتصالات حساب Google
          </a>{' '}
          وإزالة وصول مُضاعِف. لا يؤدي ذلك إلى حذف حملاتك أو حسابك لدى Google Ads.
        </p>
      </LegalSection>

      <LegalSection title="المدة والاستثناءات">
        <p>
          يبدأ الحذف الآلي فور تأكيده. قد تبقى نسخ احتياطية مشفرة لفترة محدودة إلى أن تنتهي دورة النسخ الاحتياطي، وقد نحتفظ
          بسجلات فواتير أو سجلات مطلوبة نظامياً للمدة التي يفرضها النظام، مع تقييد استخدامها لهذا الغرض فقط.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
