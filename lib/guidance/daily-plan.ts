export type DailyPlanRecommendation = {
  id?: string | null;
  title?: string | null;
  status?: string | null;
  severity?: string | null;
  expected_impact?: { delta_sar_per_month?: number | null } | null;
  created_at?: string | null;
};

export type DailyPlanAction = {
  id?: string | null;
  description_ar?: string | null;
  created_at?: string | null;
  observed_impact?: unknown;
  reverted_at?: string | null;
};

export type DailyPlanTask = {
  id: string;
  title: string;
  description: string;
  href: string;
  cta: string;
  priority: number;
  tone: 'danger' | 'warning' | 'primary' | 'neutral';
};

export type DailyPlan = {
  primary: DailyPlanTask;
  tasks: DailyPlanTask[];
  pendingDecisions: number;
  summary: string;
};

export function buildDailyPlan({
  hasAccount,
  revokedAccounts = 0,
  subscriptionActive,
  campaignCount,
  lastSyncedAt,
  latestAuditAt,
  recommendations,
  actions,
  now = new Date(),
}: {
  hasAccount: boolean;
  revokedAccounts?: number;
  subscriptionActive: boolean;
  campaignCount: number;
  lastSyncedAt?: string | null;
  latestAuditAt?: string | null;
  recommendations: DailyPlanRecommendation[];
  actions: DailyPlanAction[];
  now?: Date;
}): DailyPlan {
  const tasks: DailyPlanTask[] = [];
  const pendingRecommendations = recommendations.filter((item) => item.status === 'pending');
  const failedRecommendations = recommendations.filter((item) => item.status === 'failed');
  const approvedRecommendations = recommendations.filter((item) =>
    ['approved', 'executing'].includes(String(item.status ?? ''))
  );
  const syncAgeHours = ageHours(lastSyncedAt, now);
  const auditAgeHours = ageHours(latestAuditAt, now);
  const actionNeedingMeasurement = actions.find((action) =>
    !action.reverted_at &&
    !hasObservedImpact(action.observed_impact) &&
    (ageHours(action.created_at, now) ?? 0) >= 24
  );

  if (!hasAccount) {
    tasks.push({
      id: revokedAccounts > 0 ? 'reconnect' : 'connect',
      title: revokedAccounts > 0 ? 'أعد ربط حسابات Google Ads' : 'اربط حسابات Google Ads',
      description:
        revokedAccounts > 0
          ? 'انتهت صلاحية الربط، لذلك توقفت البيانات والفحوصات. إعادة الربط تستعيد الحسابات المحفوظة.'
          : 'موافقة واحدة تجلب حسابك المباشر وكل حساب عميل متاح لك، ثم تختار الحساب الذي تريد العمل عليه.',
      href: '/onboarding/connect',
      cta: revokedAccounts > 0 ? 'إعادة الربط' : 'بدء الربط',
      priority: 120,
      tone: revokedAccounts > 0 ? 'danger' : 'primary',
    });
  }

  if (hasAccount && !subscriptionActive) {
    tasks.push({
      id: 'subscription',
      title: 'فعّل التجربة لتشغيل أدوات التحسين',
      description: 'تبقى الحسابات والبيانات محفوظة، وتفتح التجربة الفحص والمساعد ومركز الموافقات.',
      href: '/billing',
      cta: 'عرض الخطط والتجربة',
      priority: 110,
      tone: 'warning',
    });
  }

  if (hasAccount && (campaignCount === 0 || syncAgeHours === null || syncAgeHours > 24)) {
    tasks.push({
      id: 'sync',
      title: campaignCount === 0 ? 'اجلب بيانات الحملات أولاً' : 'حدّث بيانات الحساب قبل اتخاذ قرار',
      description:
        syncAgeHours !== null && syncAgeHours > 24
          ? `آخر بيانات متاحة أقدم من ${formatHours(syncAgeHours)}. التحديث يمنع بناء قرار على أرقام قديمة.`
          : 'نحتاج بيانات الحملات والصرف والتحويلات حتى يكون التحليل مبنياً على واقع الحساب.',
      href: '/campaigns',
      cta: 'تحديث البيانات',
      priority: 100,
      tone: syncAgeHours !== null && syncAgeHours > 72 ? 'danger' : 'warning',
    });
  }

  if (hasAccount && campaignCount > 0 && (auditAgeHours === null || auditAgeHours > 168)) {
    tasks.push({
      id: 'audit',
      title: auditAgeHours === null ? 'شغّل أول فحص ذكي للحساب' : 'جدّد فحص الحساب هذا الأسبوع',
      description:
        auditAgeHours === null
          ? 'الفحص يراجع الأداء والإعدادات ويحوّل المشكلات إلى قرارات واضحة مع دليل من الحساب.'
          : `آخر فحص مضى عليه ${formatHours(auditAgeHours)}. أعده لاكتشاف التغييرات الجديدة وترتيب الأولويات.`,
      href: '/audit',
      cta: auditAgeHours === null ? 'بدء الفحص' : 'إعادة الفحص',
      priority: 90,
      tone: 'primary',
    });
  }

  if (failedRecommendations.length > 0) {
    tasks.push({
      id: 'failed-recommendations',
      title: `راجع ${countLabel(failedRecommendations.length, 'توصية')} تعذر تجهيزها`,
      description: 'لم يُنفذ أي تعديل. افتح التفاصيل لمعرفة سبب التعذر واتخاذ قرار آمن.',
      href: '/optimizer',
      cta: 'مراجعة التعذر',
      priority: 88,
      tone: 'danger',
    });
  }

  if (pendingRecommendations.length > 0) {
    const top = [...pendingRecommendations].sort(recommendationPriority)[0];
    tasks.push({
      id: 'pending-recommendations',
      title: `اتخذ قراراً بشأن ${countLabel(pendingRecommendations.length, 'توصية')}`,
      description: top?.title
        ? `ابدأ بالأهم: ${cleanText(top.title)}. سترى الدليل والتعديل الفعلي قبل اعتماد أي شيء.`
        : 'راجع الدليل والأثر المتوقع، ثم اعتمد المناسب أو تجاهله. لا ينفذ شيء من دون موافقتك.',
      href: '/audit',
      cta: 'مراجعة التوصيات',
      priority: 80,
      tone: pendingRecommendations.some((item) => item.severity === 'critical') ? 'danger' : 'primary',
    });
  }

  if (approvedRecommendations.length > 0) {
    tasks.push({
      id: 'approved-recommendations',
      title: `${countLabel(approvedRecommendations.length, 'توصية')} في انتظار المراجعة النهائية`,
      description: 'راجع التعديل الدقيق مرة أخيرة في مركز الموافقات قبل إرساله إلى Google Ads.',
      href: '/optimizer',
      cta: 'فتح مركز الموافقات',
      priority: 75,
      tone: 'warning',
    });
  }

  if (actionNeedingMeasurement) {
    tasks.push({
      id: 'measure-action',
      title: 'قِس نتيجة آخر تعديل بدل الاكتفاء بتنفيذه',
      description: actionNeedingMeasurement.description_ar
        ? `مرّ يوم على «${cleanText(actionNeedingMeasurement.description_ar)}». راجع الأثر الفعلي قبل إجراء تعديل جديد.`
        : 'مرّ يوم على تعديل مطبق. راجع الأثر الفعلي قبل إجراء تعديل جديد.',
      href: '/optimizer',
      cta: 'مراجعة نتيجة التعديل',
      priority: 70,
      tone: 'neutral',
    });
  }

  if (tasks.length === 0) {
    tasks.push({
      id: 'monitor',
      title: 'الحساب مستقر، راقب الاتجاه ولا تغيّر لمجرد التغيير',
      description: 'راجع ملخص الأداء واسأل المساعد عن أكبر فرصة اليوم. أي توصية جديدة ستظهر هنا تلقائياً.',
      href: '/assistant',
      cta: 'اسأل عن فرصة اليوم',
      priority: 40,
      tone: 'neutral',
    });
  }

  const ordered = tasks.sort((left, right) => right.priority - left.priority).slice(0, 4);
  const pendingDecisions = pendingRecommendations.length + approvedRecommendations.length + failedRecommendations.length;

  return {
    primary: ordered[0],
    tasks: ordered,
    pendingDecisions,
    summary:
      pendingDecisions > 0
        ? `لديك ${countLabel(pendingDecisions, 'قرار')} يحتاج انتباهك، وبدأنا بالأكثر تأثيراً.`
        : ordered[0].id === 'monitor'
          ? 'لا يوجد قرار عاجل الآن. استمر بالمراقبة واتخذ إجراءً فقط عندما يدعمه الدليل.'
          : 'رتبنا الخطوات حسب ما يمنعك من الوصول إلى قرار موثوق أولاً.',
  };
}

function ageHours(value: string | null | undefined, now: Date) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 3_600_000);
}

function hasObservedImpact(value: unknown) {
  return Boolean(value && typeof value === 'object' && Object.keys(value as Record<string, unknown>).length > 0);
}

function recommendationPriority(left: DailyPlanRecommendation, right: DailyPlanRecommendation) {
  const severity = { critical: 3, medium: 2, growth: 1 } as const;
  const severityDifference = (severity[right.severity as keyof typeof severity] ?? 0) -
    (severity[left.severity as keyof typeof severity] ?? 0);
  if (severityDifference !== 0) return severityDifference;
  return impact(right) - impact(left);
}

function impact(item: DailyPlanRecommendation) {
  const value = Number(item.expected_impact?.delta_sar_per_month ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function cleanText(value: string) {
  return value.replace(/\s+/g, ' ').trim().slice(0, 120);
}

function countLabel(count: number, singular: string) {
  return `${count} ${singular}`;
}

function formatHours(hours: number) {
  if (hours >= 48) return `${Math.round(hours / 24)} أيام`;
  return `${Math.max(1, Math.round(hours))} ساعة`;
}
