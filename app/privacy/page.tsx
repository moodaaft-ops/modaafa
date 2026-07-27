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
      updatedAt="28 يوليو 2026"
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

      <LegalSection title="مشاركة بيانات Google والإفصاح عنها">
        <p>
          لا نشارك بيانات مستخدم Google إلا بالحد الضروري لتقديم وظائف مُضاعِف التي يطلبها المستخدم. الجهات التي قد
          تعالج هذه البيانات نيابة عنا هي:
        </p>
        <ul className="list-disc space-y-2 ps-5">
          <li>
            <strong>Google:</strong> لإتمام تفويض OAuth وقراءة حسابات Google Ads وتنفيذ التعديلات التي يعتمدها المستخدم
            صراحة.
          </li>
          <li>
            <strong>Supabase:</strong> للمصادقة وتخزين معرّفات الحسابات وبيانات الحملات والأداء وسجلات الموافقة، مع حفظ
            رموز ربط Google بصورة مشفرة.
          </li>
          <li>
            <strong>Vercel:</strong> لاستضافة التطبيق ومعالجة طلباته وتشغيل وظائفه الخلفية؛ وقد تتضمن السجلات التشغيلية
            المحدودة معرّفات تقنية لازمة للأمان وتشخيص الأعطال.
          </li>
          <li>
            <strong>Anthropic API:</strong> لمعالجة الحد الأدنى من سياق الحملات والأداء مع سؤال المستخدم كي يولد
            المساعد التحليل أو التوصية المطلوبة. لا نرسل إلى Anthropic رموز Google أو بيانات اعتماد OAuth، ولا نسمح
            باستخدام بيانات Google لتدريب نماذج ذكاء اصطناعي عامة.
          </li>
        </ul>
        <p>
          يعمل هؤلاء المزودون كمعالجي بيانات لتقديم وظائف المنصة، ولا يحق لهم استخدام بيانات Google لأغراضهم التسويقية
          المستقلة. وقد نفصح عن الحد الأدنى اللازم لجهة نظامية مختصة إذا أوجب القانون ذلك، أو لمزود دعم أمني تحت التزام
          بالسرية لمعالجة حادثة محددة.
        </p>
        <p>
          لا نبيع بيانات Google، ولا ننقلها إلى وسطاء بيانات أو بائعي معلومات، ولا نستخدمها أو نشاركها للإعلانات
          المستهدفة أو المخصصة أو إعادة الاستهداف، أو لتحديد الجدارة الائتمانية أو الإقراض، أو لتطوير أو تحسين أو تدريب
          نماذج ذكاء اصطناعي أو تعلم آلي عامة غير مخصصة للمستخدم.
        </p>
        <div lang="en" dir="ltr" className="space-y-3 text-start">
          <p className="font-semibold text-foreground">Google user data sharing and disclosure</p>
          <p>
            Modaafa shares Google user data only with service providers acting on our behalf and only to deliver
            user-requested product functionality: Google for OAuth and Google Ads operations; Supabase for
            authentication and secure storage; Vercel for hosting and request processing; and the Anthropic API for
            generating the requested analysis from the minimum necessary campaign and performance context. Google
            OAuth tokens and credentials are never sent to Anthropic.
          </p>
          <p>
            We do not sell Google user data or share it with data brokers or information resellers. We do not use or
            disclose it for targeted, personalized, retargeted, or interest-based advertising, creditworthiness,
            lending, or training generalized AI or machine-learning models. We may disclose only the minimum required
            by law or to a confidential security provider responding to a specific incident.
          </p>
        </div>
      </LegalSection>

      <LegalSection title="مزودو الخدمة الآخرون">
        <p>
          نستخدم Stripe للفوترة وResend للبريد التشغيلي. لا نرسل إليهما بيانات حملات Google Ads أو رموز ربط Google.
          يحصل كل مزود على الحد اللازم لأداء خدمته وفق اتفاقياته وسياساته.
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
