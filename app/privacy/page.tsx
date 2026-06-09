export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-white px-6 py-12">
      <article className="mx-auto max-w-3xl text-ink-800">
        <h1 className="text-3xl font-bold">سياسة الخصوصية</h1>
        <p className="mt-4 text-sm leading-7 text-ink-600">
          تستخدم مُضاعِف بيانات حساب Google Ads التي يصرح بها العميل لتقديم تقارير وتوصيات وإجراءات تحسين بعد الموافقة.
          لا نبيع بيانات العملاء ولا نستخدمها خارج تشغيل المنصة.
        </p>
        <h2 className="mt-8 text-xl font-bold">البيانات التي نعالجها</h2>
        <p className="mt-3 text-sm leading-7 text-ink-600">
          بيانات الحساب الإعلاني، معرفات الحملات، مؤشرات الأداء، سجلات التوصيات، وبيانات الاشتراك والدفع اللازمة للتشغيل.
        </p>
        <h2 className="mt-8 text-xl font-bold">الأمان</h2>
        <p className="mt-3 text-sm leading-7 text-ink-600">
          رموز الربط تحفظ مشفرة، والتعديلات الإعلانية تمر عبر سجل ومركز موافقة قبل التنفيذ.
        </p>
        <h2 className="mt-8 text-xl font-bold">إلغاء الربط</h2>
        <p className="mt-3 text-sm leading-7 text-ink-600">
          يستطيع العميل إلغاء صلاحية Google من حسابه في Google أو التواصل معنا لحذف بياناته من المنصة.
        </p>
      </article>
    </main>
  );
}
