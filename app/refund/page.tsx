import Link from 'next/link';
import { LegalPage, LegalSection } from '@/lib/ui/legal-page';
import { pageMetadata } from '@/lib/seo/site';
import { ownerConfig, showDrafts } from '@/lib/landing/owner-config';

export const metadata = pageMetadata({
  title: 'سياسة الاسترجاع والاسترداد',
  path: '/refund',
  description: 'متى يُخصم الاشتراك، وكيف تلغيه قبل أول خصم، وما الذي يشمله الاسترداد في مُضاعِف.',
});

export default function RefundPage() {
  // The guarantee shows here only once the owner approves it; a draft shows on
  // preview deployments so it can be read in place before approval.
  const guarantee = ownerConfig.guarantee.approved || showDrafts() ? ownerConfig.guarantee : null;
  return (
    <LegalPage
      title="سياسة الاسترجاع والاسترداد"
      description="متى يُخصم الاشتراك، وكيف تلغيه قبل أول خصم، وما الذي يشمله الاسترداد."
      updatedAt="14 أكتوبر 2026"
    >
      <LegalSection title="ما الذي تغطيه هذه السياسة">
        <p>
          مُضاعِف خدمة اشتراك رقمية على الإنترنت، تملكها وتشغّلها مؤسسة تقنيات أيمن للتسويق الإلكتروني (الرقم الوطني الموحد
          7038156571). لا نبيع منتجات مادية ولا نشحن شيئاً، فلا توجد مرتجعات بضائع. هذه السياسة تخص الاشتراكات المدفوعة فقط،
          وتُقرأ مع <Link href="/terms" className="font-semibold text-primary hover:underline dark:text-primary">شروط الاستخدام</Link>.
        </p>
      </LegalSection>

      <LegalSection title="التجربة المجانية">
        <p>
          كل خطة تبدأ بتجربة مجانية مدتها 14 يوماً. نطلب وسيلة دفع صالحة عند بدء التجربة، ولا يُخصم منها أي مبلغ خلال هذه
          المدة. أول خصم يكون في اليوم الخامس عشر، ونرسل لك تنبيهاً بالبريد قبل أول تجديد.
        </p>
        <p>
          لو ألغيت قبل اليوم الخامس عشر فلن يُخصم منك أي مبلغ.
        </p>
      </LegalSection>

      <LegalSection title="كيف تلغي الاشتراك">
        <p>
          من صفحة الفوترة داخل المنصة تضغط «إلغاء الاشتراك» ثم تؤكد. الإلغاء يوقف التجديد القادم ويبقى اشتراكك شغالاً حتى
          نهاية الفترة الحالية، ولا يحتاج رسالة ولا موافقة منا. وتغيير وسيلة الدفع من زر «البطاقة والفواتير» في نفس الصفحة. وإذا حذفت حسابك من الإعدادات فإن المنصة تلغي اشتراكك أولاً
          ثم تكمل الحذف.
        </p>
      </LegalSection>

      <LegalSection title="الاسترداد">
        <p>
          لا يشمل الإلغاء عادةً استرداد فترة مدفوعة بدأت. يعني ذلك أن الشهر أو السنة التي خُصمت قيمتها تبقى مدفوعة حتى لو
          ألغيت بعد الخصم بيوم. نستثني من ذلك حالتين: عندما يفرض النظام المعمول به في المملكة خلاف ذلك، وعندما توافق مُضاعِف
          كتابياً على طلبك.
        </p>
        <p>
          الخصم المكرر أو الناتج عن خطأ تقني من جانبنا يُراجَع ويُصحَّح، ولا يدخل في القاعدة أعلاه.
        </p>
      </LegalSection>

      {guarantee && (
        <div id="guarantee" className="scroll-mt-24">
          <LegalSection title={guarantee.approved ? guarantee.title : `${guarantee.title} (مسودة للاعتماد)`}>
            <p>{guarantee.promise}</p>
            <ul className="list-disc space-y-2 ps-5">
              {guarantee.terms.map((term) => (
                <li key={term}>{term}</li>
              ))}
            </ul>
            <p>هذا الضمان موافقة كتابية من مُضاعِف بالمعنى المذكور في قسم الاسترداد أعلاه.</p>
          </LegalSection>
        </div>
      )}

      <LegalSection title="كيف تطلب مراجعة خصم">
        <p>
          راسلنا على moodaaft@gmail.com من البريد المرتبط بحسابك، واذكر تاريخ الخصم والمبلغ وأرفق الفاتورة إن وجدت. بعد
          المراجعة يصلك الرد بالبريد ومعه القرار وسببه.
        </p>
      </LegalSection>

      <LegalSection title="إذا تمت الموافقة على الاسترداد">
        <p>
          يُعاد المبلغ إلى وسيلة الدفع نفسها التي استُخدمت في الخصم. أما موعد ظهوره في كشف حسابك فيحدده البنك المُصدِر
          لبطاقتك، وليس لنا تحكم فيه.
        </p>
      </LegalSection>

      <LegalSection title="التواصل">
        <p>
          لأي سؤال عن الفوترة أو الاسترداد راسلنا على{' '}
          <a href="mailto:moodaaft@gmail.com" className="font-semibold text-primary hover:underline dark:text-primary">
            moodaaft@gmail.com
          </a>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
