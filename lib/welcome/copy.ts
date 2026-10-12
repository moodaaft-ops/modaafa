/**
 * Every word on /welcome lives in this one file, so the copy can be read,
 * approved and changed without touching the layout.
 *
 * Facts in here were checked against the code on 12 Oct 2026:
 * - Scope: lib/google-ads/oauth.ts asks for one scope only, `adwords`.
 * - Changes: executed only from the approvals centre (app/api/recommendations/action).
 * - Autopilot: default mode is 'off', and its only allowed action is
 *   add_negative_keyword (lib/autopilot/types.ts).
 * - Disconnect: no in-app button exists. The two real routes are Google's
 *   connections page and deleting the account, which revokes the Google grant
 *   first (app/api/account/delete/route.ts).
 */

export const GOOGLE_CONNECTIONS_URL = 'https://myaccount.google.com/connections';

export const WELCOME_COPY = {
  pageTitle: 'ابدأ بربط حسابك',

  eyebrow: 'حسابك جاهز، ناقص الربط بس',
  headline: 'اربط حسابك، ونوريك وين تضيع فلوس إعلاناتك',
  intro:
    'موافقة وحدة على Google، وبعدها نفحص حسابك ونرتب لك الصرف اللي ما جاب نتيجة والفرص اللي تفوتك، من الأهم للأقل.',

  connectLabel: 'اربط حسابك',
  connectLoading: 'جاري فتح شاشة Google...',
  connectNote: 'أول فحص مجاني وبدون بطاقة. نقرأ حسابك أولاً، وأي تعديل ما ينفذ إلا بعد ما تعتمده أنت.',
  teamLinkLabel: 'أبي أكلم أحد من الفريق',

  videoHeading: 'شاهد كيف يشتغل الربط',
  videoCaption: 'شرح مصوّر لشاشات Google وللي يجي بعدها.',

  stepsHeading: 'وش يصير بعد ما تضغط',
  steps: [
    {
      title: 'بريدك في Google',
      body: 'اختر البريد اللي تدخل به على ads.google.com. وقد يكون غير البريد اللي سجلت به عندنا.',
    },
    {
      title: 'توافق على صلاحية وحدة',
      body: 'صلاحية Google Ads بس. ما نطلب Gmail ولا ملفاتك.',
      // Shown only while Google's review of the app is unfinished
      // (GOOGLE_OAUTH_APP_VERIFIED !== 'true'), because only then does Google
      // put its "unverified app" warning in front of the user.
      unverifiedNote:
        'Google بيعرض لك تحذير إن التطبيق غير موثّق، لأن مراجعتهم لمُضاعِف ما خلصت. اضغط «خيارات متقدمة» ثم «المتابعة».',
    },
    {
      title: 'نسحب حساباتك',
      body: 'حسابك المباشر وكل حساب عميل تحت أي MCC. وإذا عندك أكثر من حساب، تختار اللي نبدأ فيه.',
    },
    {
      title: 'وبعدها أول فحص',
      body: 'تطلع لك درجة لصحة حسابك، وتحتها الصرف الضايع وأول خطوة تسويها، مرتبين بالأثر.',
    },
  ],
  limitNote:
    'حد صريح: لو حسابك جديد وما فيه حملات، الفحص يطلع قصير لأنه ما عنده بيانات يقرأها. الأفضل تربط حساب فيه حملات شغالة.',

  trustHeading: 'قبل ما توافق',
  trust: [
    {
      id: 'permissions',
      question: 'وش الصلاحيات اللي تاخذونها؟',
      answer: [
        'صلاحية وحدة من Google اسمها Google Ads. بها نقرأ حسابك وحسابات العملاء تحت أي MCC. ما نطلب Gmail ولا ملفاتك.',
        'وتسجيل دخولك الأول أعطانا اسمك وبريدك بس.',
      ],
    },
    {
      id: 'edits',
      question: 'هل تعدلون حملاتي؟',
      answer: [
        'لا، ما نعدل شي من نفسنا. كل تعديل يطلع لك توصية في مركز الموافقات، ولا ينفذ إلا بعد ما تضغط اعتماد.',
        'والطيار الآلي مطفي من الأساس. لو شغلته بنفسك يسمح بشي واحد بس، وهو إضافة كلمات سلبية، بحد يومي صغير.',
        'حد صريح: صلاحية Google Ads ما تفصل بين القراءة والتعديل، فالصلاحية نفسها تسمح بالتعديل تقنياً. المنع عندنا في المنصة، ما هو عند Google.',
      ],
    },
    {
      id: 'disconnect',
      question: 'كيف أفصل الربط؟',
      answer: [
        'من صفحة اتصالات حساب Google تشيل وصول مُضاعِف متى ما بغيت، وبعدها ما نقدر نقرأ حسابك. حملاتك وحسابك عند Google ما يتأثرون.',
        'وإذا حذفت حسابك من الإعدادات، نسحب الصلاحية من Google قبل الحذف.',
        'حد صريح: ما عندنا زر فصل داخل المنصة للحين.',
      ],
      linkLabel: 'فتح اتصالات حساب Google',
      linkHref: GOOGLE_CONNECTIONS_URL,
    },
    {
      id: 'no-account',
      question: 'ما عندي حساب إعلانات؟',
      answer: [
        'ما عليك. نفتحه معك مجاناً على واتساب خطوة بخطوة، أو تقرأ الشرح المكتوب وتفتحه بنفسك.',
      ],
    },
  ],
  noAccountWhatsApp: 'افتحه معي على واتساب',
  noAccountGuide: 'الشرح المكتوب',
} as const;
