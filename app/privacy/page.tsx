import Link from 'next/link';
import { LegalPage, LegalSection } from '@/lib/ui/legal-page';

export const metadata = {
  title: 'سياسة الخصوصية',
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="سياسة الخصوصية"
      description="توضح هذه السياسة البيانات التي تعالجها منصة مُضاعِف، ولماذا نحتاجها، وكيف يمكنك التحكم بها أو حذفها."
      updatedAt="21 يوليو 2026"
    >
      <LegalSection title="من نحن">
        <p>
          مُضاعِف (Modaafa Ads AI) خدمة تملكها وتديرها مُضاعفة للتسويق الإلكتروني لمساعدة أصحاب الأنشطة والوكالات في
          قراءة بيانات إعلانات Google، إعداد التقارير والتوصيات، وتنفيذ الإجراءات التي يعتمدها المستخدم.
        </p>
      </LegalSection>

      <LegalSection title="البيانات التي نجمعها">
        <ul className="list-disc space-y-2 ps-5">
          <li>بيانات الحساب الأساسية مثل الاسم والبريد ومعرّف المستخدم.</li>
          <li>بيانات النشاط التي تدخلها، مثل الاسم والمجال والموقع والميزانية والأهداف.</li>
          <li>معرّفات حسابات Google Ads وأسماؤها وعملتها ومنطقتها الزمنية وهيكل الحملات ومؤشرات أدائها.</li>
          <li>المحادثات والمسودات والتوصيات والموافقات وسجل الإجراءات داخل المنصة.</li>
          <li>حالة الاشتراك والفواتير ومعرّفات Stripe اللازمة للفوترة؛ لا نخزن رقم بطاقتك الكامل.</li>
          <li>بيانات تشغيل وأمان محدودة مثل وقت الطلب وسجل الأخطاء وحدود الاستخدام.</li>
        </ul>
      </LegalSection>

      <LegalSection title="صلاحيات Google واستخدام البيانات">
        <p>
          عند ربط Google Ads نطلب الصلاحيات اللازمة للتعرف على حسابك، اكتشاف الحسابات الإعلانية التي يمكنك الوصول إليها،
          قراءة بياناتها، وتنفيذ التعديلات التي تعتمدها صراحة داخل مركز الموافقات. لا نستخدم بيانات Google للإعلانات
          المخصصة، ولا نبيعها، ولا نشاركها لأغراض تسويقية مستقلة.
        </p>
        <p>
          استخدام مُضاعِف للمعلومات المستلمة من واجهات Google API والتعامل معها يلتزم بسياسة{' '}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-primary hover:underline dark:text-primary"
          >
            Google API Services User Data Policy
          </a>{' '}
          بما في ذلك متطلبات Limited Use.
        </p>
      </LegalSection>

      <LegalSection title="لماذا نعالج البيانات">
        <p>
          نستخدم البيانات لتسجيل الدخول، ربط الحسابات، مزامنة الأداء، تشغيل الفحص، توليد التقارير والتوصيات، تقديم المساعد
          الذكي، تنفيذ الإجراءات الموافق عليها، إدارة الاشتراك، منع الاحتيال، حماية الخدمة، وتحسين الاعتمادية.
        </p>
      </LegalSection>

      <LegalSection title="مزودو الخدمة">
        <p>
          نستخدم مزودي خدمة ضروريين للتشغيل، منهم Google لخدمات الدخول وGoogle Ads، وSupabase للمصادقة وقاعدة البيانات،
          وAnthropic لتوليد الردود والتحليلات، وStripe للفوترة، وVercel للاستضافة، وResend للبريد التشغيلي. يحصل كل مزود
          على الحد اللازم لأداء خدمته وفق اتفاقياته وسياساته.
        </p>
      </LegalSection>

      <LegalSection title="الحفظ والأمان">
        <p>
          نحفظ البيانات طوال بقاء الحساب أو بقدر ما يلزم لتقديم الخدمة والوفاء بالالتزامات القانونية. رموز ربط Google
          تحفظ مشفرة، والوصول إلى البيانات مقيد بالمستخدم والخدمات الخلفية المصرح لها. لا توجد وسيلة إلكترونية تضمن أمناً
          مطلقاً، لكننا نطبق ضوابط وصول وتسجيل وموافقة وحدود استخدام مناسبة لطبيعة الخدمة.
        </p>
      </LegalSection>

      <LegalSection title="خياراتك وحذف بياناتك">
        <p>
          يمكنك سحب صلاحية مُضاعِف من صفحة أذونات حساب Google في أي وقت، وإدارة اشتراكك من صفحة الفوترة، وحذف حسابك
          وبياناته نهائياً من الإعدادات. يوضح <Link href="/data-deletion" className="font-semibold text-primary hover:underline dark:text-primary">دليل حذف البيانات</Link> الخطوات والتفاصيل.
        </p>
      </LegalSection>

      <LegalSection title="التحديثات والتواصل">
        <p>
          قد نحدث هذه السياسة عند تغير الخدمة أو المتطلبات النظامية، وسننشر تاريخ التحديث هنا. للاستفسارات أو طلبات
          الخصوصية تواصل عبر{' '}
          <a href="mailto:moodaaft@gmail.com" className="font-semibold text-primary hover:underline dark:text-primary">
            moodaaft@gmail.com
          </a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
