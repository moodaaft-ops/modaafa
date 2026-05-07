# Modaafa - Production App  

> منصة Modaafa الإنتاجية - Next.js 14 + Supabase + Google Ads API + Claude

**٣٦ ملف · ٣٬٣٨٠ سطر كود إنتاجي · جاهز للنشر**

---

## 📦 ما الموجود في هذه الحزمة

### الكود الإنتاجي

```
modaafa-app/
├── app/
│   ├── (auth)/login/page.tsx              ← صفحة تسجيل دخول (Google + Email OTP)
│   ├── (dashboard)/
│   │   ├── layout.tsx                      ← Layout مع Sidebar
│   │   ├── dashboard/page.tsx              ← الرئيسية مع KPIs
│   │   └── audit/page.tsx                  ← صفحة فحص الحساب
│   ├── api/
│   │   ├── audit/run/route.ts              ← يشغّل audit حقيقي
│   │   ├── auth/google-ads/connect/route.ts ← يبدأ OAuth
│   │   ├── auth/google-ads/callback/route.ts ← يستلم tokens + auto-link
│   │   ├── billing/checkout/route.ts       ← Stripe checkout session
│   │   ├── chat/builder/route.ts           ← Campaign builder chat
│   │   ├── cron/optimize/route.ts          ← Hourly optimizer cron
│   │   └── webhooks/stripe/route.ts        ← Stripe webhook handler
│   ├── globals.css
│   └── layout.tsx                          ← RTL + IBM Plex Sans Arabic
│
├── lib/
│   ├── ai/
│   │   ├── audit-agent.ts                  ← Audit AI (Claude Sonnet 4.6)
│   │   ├── optimizer-agent.ts              ← Hourly optimizer with guardrails
│   │   └── builder-agent.ts                ← Campaign builder with tool use
│   ├── billing/
│   │   ├── stripe.ts                        ← Stripe utilities
│   │   └── moyasar.ts                       ← Moyasar (Saudi payments)
│   ├── google-ads/
│   │   ├── oauth.ts                         ← OAuth helpers
│   │   ├── client.ts                        ← API client wrapper
│   │   └── audit-queries.ts                 ← ١٢ GAQL query
│   ├── supabase/
│   │   ├── server.ts                        ← server-side client
│   │   └── client.ts                        ← browser client
│   ├── crypto.ts                            ← AES-256-GCM
│   └── utils.ts                             ← formatters (SAR, Arabic numerals)
│
├── db/schema.sql                            ← ١٢ جدول + RLS + triggers
│
├── docs/01-GOOGLE-CLOUD-SETUP.md            ← دليل الإعدادات (٣٠-٤٥ دقيقة)
│
├── middleware.ts                            ← Auth gating
├── package.json                             ← ٢٠+ dependencies
├── .env.example                             ← ٢٥+ env vars منظّمة
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.js
├── next.config.js
└── vercel.json                              ← Cron schedule + function limits
```

---

## 🤖 الـ ٣ AI Agents

### ١. Audit Agent (`lib/ai/audit-agent.ts`)
يفحص الحساب كامل ويعطي:
- `health_score` 0-100
- `category_scores` (هيكلة، إعلانات، كلمات، سلبيات، مزايدة، ميزانية، استهداف)
- `findings[]` مع severity + expected impact + action_payload قابل للتنفيذ

**استدعاء:** `POST /api/audit/run` body: `{customerId}`

### ٢. Optimizer Agent (`lib/ai/optimizer-agent.ts`)
يشتغل **كل ساعة** عبر Vercel Cron. لكل حساب نشط:
- يجمع snapshot للـ ٧ أيام الماضية
- يقرر إجراءات (pause/negative/budget/bid)
- يطبّق guardrails صارمة (max 50% budget change/24h, max 8 actions/run)
- ينفّذ + يسجّل في `ai_actions`

**Guardrails:**
- لا يزيد ميزانية أكثر من ٢٥٪/مرة، ٥٠٪/يوم
- لا يوقف أكثر من ٢٠٪ من الكلمات في run واحد
- لا يلمس conversion tracking
- كل إجراء قابل للتراجع خلال ٣٠ يوم

### ٣. Campaign Builder Agent (`lib/ai/builder-agent.ts`)
محادثة AI مع **tool use** ل:
- `get_keyword_ideas` - يبحث عن كلمات بـ KeywordPlanIdeaService
- `forecast_campaign` - يتوقع الأداء قبل الإطلاق
- `finalize_draft` - يخرج الحملة الكاملة للمستخدم

**استدعاء:** `POST /api/chat/builder` body: `{brief, customerId}`

النتيجة: حملة كاملة (٣-٥ Ad Groups + ٤٠+ كلمة + إعلانات عربية) **بدون إطلاق تلقائي** - المستخدم لازم يأكد.

---

## 🚀 خطوات التشغيل

### ١. اتبع دليل Google Cloud Setup

افتح `docs/01-GOOGLE-CLOUD-SETUP.md` (٣٠-٤٥ دقيقة). ستحصل على:
- Developer Token
- OAuth Client ID + Secret
- Supabase Project + Keys
- Anthropic API Key
- Stripe API Keys

### ٢. إعداد المشروع

```bash
cd modaafa-app
npm install
cp .env.example .env.local
# عبّئ القيم في .env.local

# توليد encryption key
openssl rand -base64 32  # انسخ الناتج إلى ENCRYPTION_KEY
```

### ٣. تطبيق DB Schema

في Supabase Dashboard → SQL Editor:
```sql
-- انسخ محتوى db/schema.sql والصقه + Run
```

### ٤. إعداد Stripe

```bash
# في Stripe Dashboard:
# 1. أنشئ ٦ أسعار (3 plans × 2 periods) بالـ SAR
# 2. انسخ price IDs لـ .env.local
# 3. أعد webhook endpoint إلى /api/webhooks/stripe
# 4. أضف هذه الأحداث:
#    - checkout.session.completed
#    - customer.subscription.updated
#    - customer.subscription.deleted
#    - invoice.payment_succeeded
#    - invoice.payment_failed
```

### ٥. التشغيل

```bash
npm run dev
# افتح http://localhost:3000
```

### ٦. النشر على Vercel

```bash
# Push to GitHub
git init && git add . && git commit -m "Initial commit"
git remote add origin git@github.com:YOUR/modaafa.git
git push -u origin main

# Connect to Vercel:
# 1. Import project from GitHub
# 2. Add all .env.local variables to Vercel env
# 3. Deploy

# الـ vercel.json يفعّل cron تلقائياً (يشتغل /api/cron/optimize كل ساعة)
```

---

## 🧪 اختبار End-to-End

```bash
# 1. سجّل دخول في http://localhost:3000/login
# 2. اربط حساب Google Ads → /api/auth/google-ads/connect
# 3. شغّل audit (تلقائي بعد الربط، أو يدوياً):
curl -X POST http://localhost:3000/api/audit/run \
  -H "Content-Type: application/json" \
  -d '{"customerId":"YOUR_CUSTOMER_ID"}'

# 4. النتيجة:
# {"success":true,"audit_id":"uuid","health_score":72,"findings_count":11}

# 5. شوف /audit في الـ UI
# 6. جرّب campaign builder:
curl -X POST http://localhost:3000/api/chat/builder \
  -H "Content-Type: application/json" \
  -d '{"brief":"حملة لمنتج عطر رجالي بميزانية 3000 ر.س","customerId":"YOUR_ID"}'
```

---

## 🔐 الأمان

- **Refresh tokens**: مشفّرة AES-256-GCM (KMS في الإنتاج)
- **CSRF**: OAuth state cookie httpOnly + SameSite=Lax
- **RLS**: مفعّل على كل الجداول، كل عميل يشوف بياناته فقط
- **Service role key**: server-side فقط
- **Webhooks**: signature verification (Stripe + Moyasar)
- **Cron auth**: Bearer token (`CRON_SECRET`)

---

## 💰 التكلفة الشهرية (للتشغيل)

عند ١٠٠ عميل نشط:

| البند | التكلفة |
|---|---|
| Vercel Pro | ٧٥ ر.س |
| Supabase Pro | ٩٠ ر.س |
| Anthropic Claude | ٢٬٢٠٠ ر.س |
| Stripe + Moyasar fees (3%) | ٢٬٧٠٠ ر.س |
| Resend + monitoring | ٥٠٠ ر.س |
| **الإجمالي** | **~٥٬٥٦٥ ر.س/شهر** |

عند ١٠٠ عميل بـ ٨٠٠ ر.س متوسط = **٨٠٬٠٠٠ ر.س/شهر** → هامش ٩٣٪.

---

## ⏭️ ما تبقى

### قبل الإطلاق التجاري
- [ ] صفحات `/campaigns` و `/optimizer` و `/reports` و `/settings` (نسخها من `app.html` mockups)
- [ ] Onboarding wizard (4 خطوات)
- [ ] صفحة الهبوط (انسخ من `index.html`)
- [ ] Email templates (welcome, audit ready, weekly report)
- [ ] WhatsApp notifications via Unifonic
- [ ] OAuth Production verification في Google Cloud
- [ ] حماية CRON_SECRET في Vercel env

### بعد الإطلاق
- [ ] Reports Agent (تقارير أسبوعية)
- [ ] Salla + Zid integrations
- [ ] Customer Match (رفع قوائم العملاء)
- [ ] متعدد المستخدمين / Team accounts
- [ ] Meta Ads + TikTok Ads (Q4 2026)

---

## 📚 الوثائق المرفقة

- `README.md` (هذا الملف)
- `docs/01-GOOGLE-CLOUD-SETUP.md` - دليل الإعدادات السحابية
- `db/schema.sql` - schema قاعدة البيانات

في فولدر `modaaif/` (الحزمة السابقة) موجود:
- `index.html` - صفحة الهبوط (للتحويل لـ Next.js page)
- `app.html` - الواجهة (للتحويل لـ React components)
- `ARCHITECTURE.md` - الوثيقة المعمارية الشاملة
- `Modaafa-Design-Document-final.pdf` - وثيقة التصميم اللي رفعناها لـ Google

---

**🎯 الخطوة الأولى:** افتح `docs/01-GOOGLE-CLOUD-SETUP.md` وابدأ.
