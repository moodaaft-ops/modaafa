# دليل إعداد Google Cloud + Google Ads API

> ⏱ الوقت المتوقع: ٣٠-٤٥ دقيقة
> 🎯 الهدف: الحصول على Developer Token + OAuth 2.0 Credentials للمنصة

---

## الخطوة ١: إنشاء Google Cloud Project

١. اذهب إلى: https://console.cloud.google.com
٢. سجّل دخول بنفس الحساب: `moodaaft@gmail.com`
٣. في الأعلى، اضغط على **قائمة المشاريع** (بجانب شعار Google Cloud)
٤. اضغط **NEW PROJECT**
٥. عبّئ التالي:
   - **Project name**: `Modaafa Production`
   - **Project ID**: `modaafa-prod` (لو كان متاحاً)
   - **Organization**: لا شي / No organization
٦. اضغط **CREATE**

⚠️ احفظ الـ Project ID — رح نحتاجه في كل الخطوات التالية.

---

## الخطوة ٢: تفعيل Google Ads API

١. تأكد أن مشروع `Modaafa Production` محدد في الأعلى
٢. اذهب إلى: https://console.cloud.google.com/apis/library
٣. ابحث عن: **Google Ads API**
٤. اضغط على النتيجة الأولى
٥. اضغط زر **ENABLE** الأزرق

✅ بعد ٣٠ ثانية، الـ API يصير مفعّل في مشروعك.

---

## الخطوة ٣: التحقق من Developer Token

عندك بالفعل MCC `756-114-1000` و Developer Token (لأنك قدّمت على Standard Access). نتحقق من حالته:

١. اذهب إلى: https://ads.google.com
٢. سجّل دخول بـ `moodaaft@gmail.com`
٣. تأكد أن الحساب المحدّد هو **Manager Account** `756-114-1000`
٤. من الأعلى، اضغط **Tools & Settings** → تحت **SETUP** → **API Center**
٥. ستجد:
   - **Developer Token**: انسخه واحفظه (سري - لا تشاركه)
   - **Access Level**: حالياً Basic أو Test (سيتحدث لـ Standard بعد القبول)
   - **API Contact Email**: `moodaaft@gmail.com` ✅

📝 احفظ الـ Developer Token في ملاحظات آمنة. ستحتاجه في `.env`.

---

## الخطوة ٤: إنشاء OAuth 2.0 Credentials

هذي الخطوة تخلّي العملاء يقدرون يربطون حساباتهم في منصتنا.

### ٤.١ تكوين OAuth Consent Screen

١. اذهب إلى: https://console.cloud.google.com/apis/credentials/consent
٢. اختر **External** (لأن العملاء خارج المنظمة)
٣. اضغط **CREATE**
٤. عبّئ:
   - **App name**: `Modaafa`
   - **User support email**: `moodaaft@gmail.com`
   - **App logo**: (اختياري - ارفع لوغو ١٢٠×١٢٠px)
   - **Application home page**: `https://modaafa.com`
   - **Application privacy policy**: `https://modaafa.com/privacy`
   - **Application terms of service**: `https://modaafa.com/terms`
   - **Authorized domains**: `modaafa.com`
   - **Developer contact**: `moodaaft@gmail.com`
٥. اضغط **SAVE AND CONTINUE**

### ٤.٢ إضافة Scopes

١. في صفحة **Scopes**، اضغط **ADD OR REMOVE SCOPES**
٢. ابحث عن: `adwords`
٣. علّم على: `https://www.googleapis.com/auth/adwords` (Google Ads API)
٤. اضغط **UPDATE** ثم **SAVE AND CONTINUE**

### ٤.٣ إضافة Test Users (مهم في فترة Basic)

١. في صفحة **Test users**، اضغط **+ ADD USERS**
٢. أضف الإيميلات اللي رح يختبرون المنصة (٥-١٠ بريد):
   - `moodaaft@gmail.com`
   - `[bمستخدم تجريبي ١]`
   - `[مستخدم تجريبي ٢]`
   - ... إلخ
٣. اضغط **SAVE AND CONTINUE**

⚠️ هؤلاء فقط من يقدرون يستخدمون OAuth في المنصة حالياً. نوسّع لاحقاً لما نقدّم على Production verification.

---

## الخطوة ٥: إنشاء OAuth Client ID

١. اذهب إلى: https://console.cloud.google.com/apis/credentials
٢. اضغط **+ CREATE CREDENTIALS** → **OAuth client ID**
٣. اختر **Application type**: `Web application`
٤. عبّئ:
   - **Name**: `Modaafa Web Client`
   - **Authorized JavaScript origins**:
     - `http://localhost:3000` (للتطوير)
     - `https://modaafa.com` (للإنتاج)
   - **Authorized redirect URIs**:
     - `http://localhost:3000/api/auth/google-ads/callback`
     - `https://modaafa.com/api/auth/google-ads/callback`
٥. اضغط **CREATE**

📋 ستظهر نافذة فيها:
- **Client ID**: انسخه (يبدأ بأرقام طويلة وينتهي بـ `.apps.googleusercontent.com`)
- **Client Secret**: انسخه (سري جداً)

احفظهم في ملاحظات آمنة.

---

## الخطوة ٦: إنشاء API Key (للقراءات العامة)

١. في نفس صفحة Credentials
٢. اضغط **+ CREATE CREDENTIALS** → **API key**
٣. انسخ المفتاح
٤. اضغط **RESTRICT KEY** وقيّده على Google Ads API فقط

---

## الخطوة ٧: الحصول على Customer IDs لاختبار MCC

١. ارجع لـ https://ads.google.com (Manager Account)
٢. من القائمة الجانبية، اختر **Sub-accounts** أو الأكاونت اللي رح نختبر عليه
٣. انسخ **Customer ID** بصيغة `123-456-7890`

نحتاجه لاختبار أول API call.

---

## ✅ Checklist - تأكد من جمع كل القيم

بعد إكمال الخطوات أعلاه، يجب يكون عندك:

- [ ] Project ID: `modaafa-prod` (أو ما اخترت)
- [ ] Developer Token: `_______________________`
- [ ] OAuth Client ID: `_______.apps.googleusercontent.com`
- [ ] OAuth Client Secret: `_______________________`
- [ ] API Key: `AIzaSy___________________`
- [ ] MCC ID: `756-114-1000` (موجود)
- [ ] Test Customer ID: `___-___-____`

✅ **الحفظ:** انسخ هذي القيم في `.env.local` (في مشروع Next.js اللي رح نبنيه).

---

## الخطوة ٨: حجز نطاق modaafa.com

إذا لسة ما حجزته:

١. اذهب إلى: https://www.namecheap.com أو https://domains.google
٢. ابحث عن `modaafa.com`
٣. لو متاح، احجزه (تكلفة ~٥٠ ر.س/سنة)
٤. لو محجوز، جرب البدائل: `modaafa.ai`, `modaafa.sa`, `getmodaafa.com`

📝 بعد الحجز، نحتاج نوجّه DNS لاحقاً لـ Vercel — سأعطيك الإرشادات لما يحين الوقت.

---

## الخطوة ٩: إنشاء حساب Supabase

١. اذهب إلى: https://supabase.com
٢. سجّل بـ GitHub أو Google
٣. اضغط **New Project**
٤. عبّئ:
   - **Project name**: `modaafa-prod`
   - **Database password**: (أنشئ كلمة مرور قوية واحفظها)
   - **Region**: اختر الأقرب — `Bahrain (me-central-1)` أو `Frankfurt (eu-central-1)`
   - **Pricing plan**: **Free** للتطوير (نرقّي لـ Pro عند الإطلاق)
٥. اضغط **Create new project**

⏱ ينتظر دقيقة لإعداد قاعدة البيانات.

بعد الإنشاء، اذهب لـ **Settings → API** وانسخ:
- **Project URL**: `https://_____.supabase.co`
- **anon public key**: (للـ frontend)
- **service_role key**: (للـ backend - سرّي جداً)

---

## الخطوة ١٠: إنشاء حساب Vercel + Anthropic

### Vercel (للنشر)
١. https://vercel.com → سجّل بـ GitHub
٢. الخطة المجانية كافية في البداية

### Anthropic API (للذكاء الاصطناعي)
١. https://console.anthropic.com → سجّل
٢. أنشئ API Key
٣. اشحن $20-50 رصيد مبدئياً

---

## 🎯 بعد إكمال هذي الخطوات

ابعت لي القيم التالية (انسخها من ملاحظاتك الآمنة):

```
GOOGLE_ADS_DEVELOPER_TOKEN=
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
GOOGLE_API_KEY=
MCC_CUSTOMER_ID=7561141000
TEST_CUSTOMER_ID=

SUPABASE_URL=
SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=

ANTHROPIC_API_KEY=
```

⚠️ **مهم:** لا ترسل هذي القيم في رسائل عامة - أرسلها لي هنا في الشات فقط. سأستخدمها لإعداد ملف `.env.local` في المشروع.

(إذا تحب تبني التطبيق محلياً بنفسك، نقدر نخلّي القيم في ملف خاص لا يخرج من جهازك — قول لي.)

---

✅ بمجرد ما تخلص هذي الخطوات، نقدر نبدأ في تشغيل أول API call حقيقي والاختبار على حسابك.
