# اجتياز مراجعة Google لشاشة موافقة OAuth

- المشروع: `modaafa-prod` — Google Auth Platform
- الحساب: `moodaaft@gmail.com` (بروفايل «مُضاعفة»)
- تاريخ آخر مراجعة من Google: **18 يوليو 2026**
- تاريخ الفحص المباشر للبريد: **28 يوليو 2026**

---

## 1) الحالة الفعلية — الطلب يحتاج استكمالاً قبل إعادة الإرسال

| # | البند | الحالة |
|---|---|---|
| 1 | Homepage requirements | ✅ مكتمل |
| 2 | Branding guidelines | ✅ مكتمل |
| 3 | Request minimum scopes | ✅ مكتمل |
| 4 | **App functionality** | ❌ **فيديو جديد + إظهار أثر التعديل في Google Ads** |
| 5 | Privacy policy requirements | ❌ **طُلب إفصاح صريح عن مشاركة بيانات Google** |

**حالة النشر:** In production · **نوع المستخدم:** External · **سقف المستخدمين:** 3 من 100

**أحدث رسالة فعلية في Gmail** من
`api-oauth-dev-verification-reply+23188ncljqpol1d@google.com` بتاريخ 18 يوليو، ولم يوجد رد مُرسل عليها حتى فحص
28 يوليو. طلبت الرسالة:

1. فيديو شامل يعرض شاشة الموافقة وكل النطاقات بعد توسيعها.
2. عرض أقصى وظائف النطاق `https://www.googleapis.com/auth/adwords`.
3. لأن النطاق يسمح بالكتابة: عرض تعديل معتمد من المنصة ثم ظهوره فعلياً داخل واجهة Google Ads للحساب المصدر.
4. خطوات اختبار واضحة، مع بيانات اختبار إن وُجدت عوائق دخول.
5. تحديث سياسة الخصوصية لتذكر صراحةً مع من تُشارك أو تُنقل أو يُفصح عن بيانات مستخدم Google.
6. الرد على نفس الرسالة بعد تحديث الفيديو والسياسة وإعادة إرسال الطلب من Google Cloud Console.

تم تحديث سياسة الخصوصية في الكود بتاريخ 28 يوليو. المتبقي إجراء بشري/إنتاجي: تسجيل الفيديو على حساب إعلاني
تجريبي أو بموافقة صريحة على تعديل آمن، رفعه Unlisted، إعادة الإرسال، ثم الرد على نفس سلسلة البريد.

### تصحيح افتراض سابق

الروابط المسجّلة عند Google هي:

| الحقل | القيمة المسجّلة | الحالة |
|---|---|---|
| Application home page | `https://ai.modaafa.com/` | ✅ يعمل |
| Application privacy policy link | `https://ai.modaafa.com/privacy` | ✅ يعمل |
| Application terms of service link | `https://ai.modaafa.com/terms` | ✅ يعمل |
| Authorized domain 1 | `modaafa.com` | ✅ صحيح — Google تطلب النطاق الجذر المسجَّل، لا النطاق الفرعي |

لذلك **404 على `modaafa.com/privacy` ليست عائق مراجعة**، وبند «Homepage requirements» اجتاز فعلاً. تبقى إعادة التوجيه من النطاق الجذر تحسيناً مفيداً للزوار الذين يكتبون `modaafa.com` مباشرة، لكنها نزلت من P1 إلى P3.

---

## 2) سكربت الفيديو التوضيحي

**المواصفات الإلزامية** (وإلا يُرفض مرة أخرى):

- **الطول:** 3–5 دقائق. لا تختصر — البند المرفوض هو «لا يوضّح وظائف التطبيق بما يكفي».
- **اللغة:** تعليق صوتي **بالإنجليزية**، أو واجهة عربية مع **ترجمة إنجليزية مكتوبة (subtitles)**. المراجع لا يقرأ العربية.
- **الرفع:** YouTube بخيار **Unlisted** (لا Private — المراجع لن يستطيع فتحه).
- **شريط العنوان مرئي طوال الفيديو.** هذا شرط لا يتساهلون فيه.
- **تصوير الإنتاج الفعلي** على `ai.modaafa.com`، لا localhost ولا بيئة تجريبية.
- **جودة تكفي لقراءة النص** — 1080p على الأقل، وكبّر الخط إن لزم.

### المشاهد بالترتيب

| # | المدة | ما يظهر على الشاشة | ما يُقال (إنجليزي) |
|---|---|---|---|
| 1 | 0:00–0:20 | `https://ai.modaafa.com` — الصفحة التعريفية. مرّر ببطء على قسم «كيف تعمل». | "This is Modaafa, an Arabic-language platform that helps small advertisers in Saudi Arabia manage their Google Ads accounts. I'll show the full flow, including the OAuth consent screen." |
| 2 | 0:20–0:45 | اضغط «تسجيل الدخول» → صفحة `/login`. أدخل بريداً واستقبل رابط الدخول. | "Sign-in is by email magic link — no Google account is required to reach the consent screen." |
| 3 | 0:45–1:05 | صفحة `/onboarding/business` — املأ اسم النشاط والمجال والميزانية واحفظ. | "First the user describes their business. This is used only to prioritise recommendations." |
| 4 | 1:05–1:20 | صفحة `/onboarding/connect` — اقرأ النقاط الثلاث ببطء ثم **توقف قبل الضغط**. | "Here we explain exactly what access we request and why, before asking for it." |
| 5 | **1:20–2:00** | **اضغط «بدء الربط عبر Google». صوّر شاشة موافقة Google كاملة بلا قطع:** اختيار الحساب ← اسم التطبيق «مُضاعف» والشعار ← **نص النطاق `.../auth/adwords` مقروءاً** ← **شريط العنوان و`client_id=` ظاهر بوضوح** ← الضغط على Continue/Allow. | "This is the OAuth consent screen. The app name and logo are shown, and the only scope requested is `https://www.googleapis.com/auth/adwords`. The client ID is visible in the address bar." |
| 6 | 2:00–2:20 | العودة للمنصة وظهور الحسابات المربوطة بأسمائها وأرقامها. | "After consent we read the account list, including client accounts under a manager account." |
| 7 | 2:20–2:50 | لوحة التحكم ثم `/campaigns` — الحملات والصرف والتحويلات. | "This is what we do with the adwords scope: we read campaigns and performance metrics and show them to the account owner in Arabic." |
| 8 | 2:50–3:20 | `/audit` — شغّل الفحص وأظهر درجة الصحة والتوصيات. | "We analyse the account and produce recommendations." |
| 9 | 3:20–3:50 | `/optimizer` — أظهر بطاقة «التعديل الفعلي عند التنفيذ» واعتمد توصية على **حساب اختباري فقط**. | "Every change requires explicit approval, and we show the exact API operation before it runs." |
| 10 | 3:50–4:15 | نفّذ التعديل الآمن على الحساب الاختباري، ثم افتح Google Ads وأظهر أن القيمة تغيّرت في المورد نفسه. | "After the owner explicitly approves and executes the action, the requested change is applied to the selected Google Ads account. Here is the same resource in Google Ads reflecting that change." |
| 11 | 4:15–4:35 | `/settings` — «حذف الحساب نهائياً»، واقرأ النص الذي يشرح إبطال صلاحية Google. | "The user can revoke access and delete all their data at any time." |
| 12 | 4:35–4:55 | `/privacy` على `ai.modaafa.com`، ومرّر على قسم مشاركة بيانات Google باللغتين. | "The privacy policy names every processor that receives Google user data, its purpose, and the prohibited uses." |

### أخطاء ترفض الفيديو — تجنّبها

- قطع أو تسريع أثناء شاشة الموافقة → البند الأول المرفوض حالياً.
- إخفاء شريط العنوان أو تشغيل ملء الشاشة أثناء الموافقة.
- عرض الشعار والاسم فقط دون **نص النطاق** `auth/adwords`.
- الاكتفاء بإظهار الربط دون إظهار **ماذا تفعل بالبيانات** → البند الثاني المرفوض.
- عرض الاعتماد داخل مُضاعِف دون إظهار أثر التعديل نفسه داخل واجهة Google Ads → مخالف لطلب Source Account Impact.
- تنفيذ التعديل على حساب عميل حقيقي دون موافقة صريحة؛ استخدم حساباً اختبارياً أو اطلب موافقة المالك على تعديل آمن.
- رفع الفيديو Private، أو تركه بلا ترجمة إنجليزية.

---

## 3) مسودة الرد على إيميل Trust & Safety

> ردّ على **نفس سلسلة الإيميل** التي وصلتك منهم — لا تفتح سلسلة جديدة ولا ترسل من بريد آخر.
> استبدل ما بين `[ ]` قبل الإرسال.

```
Subject: Re: [اترك عنوان الرسالة الأصلي كما هو]

Hello,

Thank you for the review. I have addressed the three points raised under
"App functionality".

1. UPDATED DEMO VIDEO
   [ضع رابط YouTube غير المدرج هنا]
   The video now records the complete OAuth consent screen without any cut:
   account chooser, the app name and logo, the full scope text
   (https://www.googleapis.com/auth/adwords), the client ID visible in the
   address bar, and the grant itself. It then shows what the granted data is
   used for, screen by screen, including one explicitly approved test change
   and the same change reflected in the source Google Ads test account.

2. HOW TO TEST THE OAUTH CONSENT FLOW YOURSELVES

   No Google account or pre-created test user is needed. Sign-in is an email
   magic link, so you can use any address your team controls:

   Step 1 — Open https://ai.modaafa.com/login
   Step 2 — Enter your email address and click the sign-in button. A one-time
            sign-in link is emailed to you immediately. Open it.
   Step 3 — You land on a short business-details form. Any values are fine;
            click the button at the bottom to continue.
   Step 4 — You are now on https://ai.modaafa.com/onboarding/connect
            Click "بدء الربط عبر Google" (the green button with the Google
            logo). This is the button that starts the OAuth flow.
   Step 5 — The consent screen appears, requesting exactly one scope:
            https://www.googleapis.com/auth/adwords

   The consent screen is reachable at step 5 whether or not the Google account
   you choose owns any Google Ads account, so you can inspect the screen
   without granting access. If you do grant it, the app reads the account list
   and campaign metrics and displays them; it writes nothing to Google Ads
   until the account owner approves a specific change in the approval centre.

   If you prefer a pre-provisioned account instead, tell me the email address
   to whitelist and I will set one up.

3. WHY THE SCOPE IS NEEDED

   https://www.googleapis.com/auth/adwords is the only scope we request. It is
   required to:
     - list the customer accounts the user manages (customer_client)
     - read campaign, budget and performance metrics for reporting and audit
     - apply budget and bidding changes the account owner has explicitly
       approved inside our product, one change at a time

   There is no narrower Google Ads scope; the API does not offer a read-only
   variant. We never request Gmail, Drive, contacts, or any other scope.

4. PRIVACY POLICY

   We updated https://ai.modaafa.com/privacy to explicitly identify every
   service provider that receives Google user data, the limited processing
   purpose for each provider, and the prohibited uses. The policy now includes
   the disclosure in both Arabic and English.

Please let me know if anything else is needed.

Best regards,
[اسمك]
Modaafa — https://ai.modaafa.com
moodaaft@gmail.com
```

---

## 4) قائمة التحقق قبل إعادة الإرسال

- [ ] الفيديو مصوَّر على `ai.modaafa.com` الإنتاجي، لا محلياً.
- [ ] شاشة موافقة Google كاملة بلا قطع، وشريط العنوان ظاهر و`client_id=` مقروء.
- [ ] نص النطاق `https://www.googleapis.com/auth/adwords` مقروء على الشاشة.
- [ ] تعليق أو ترجمة إنجليزية طوال الفيديو.
- [ ] الفيديو **Unlisted** على YouTube، وتحققت من فتحه في نافذة تصفح خفي.
- [ ] الرد أُرسل على **نفس سلسلة الإيميل** الأصلية.
- [ ] أُعيد إرسال الطلب من Google Cloud Console بعد تحديث رابط الفيديو والسياسة.
- [ ] جرّبت خطوات «HOW TO TEST» بنفسك من نافذة خفية حتى النهاية — فإن تعثرت عندك ستتعثر عندهم.
- [ ] المنصة منشورة بآخر كود قبل التصوير (الهجرة ثم النشر — راجع `LAUNCH_READINESS.md` §8).

> **مهم:** لا تضبط `GOOGLE_OAUTH_APP_VERIFIED=true` حتى تتحول كل البنود الخمسة إلى ✅ في Verification Center.
