# لقطات QA للجوال (PR #63)

كل اللقطات من Chromium حقيقي على نسخة مبنية بعد دمج main (b341b8e، الخط Plex Sans Arabic). البيانات اصطناعية بالكامل: الخلفية `tests/e2e/support/mock-supabase.mjs`، حساب `qa-tester@example.com`، رقم عميل 123-456-7890. ما فيه بيانات عميل حقيقية.

الملفات: `screenshots/<الصفحة>-<العرض>x<الارتفاع>.png` لصفحات dashboard وcampaigns وassistant وbilling، بعروض 320 و360 و390 و430 وارتفاعين 640 و800، اتجاه RTL، الجولة التعريفية مخفية.

## إعادة التوليد
```
node tests/e2e/support/mock-supabase.mjs &
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
pnpm start --hostname 127.0.0.1 --port 3000 &
MODAAFA_E2E_AUTH=1 pnpm exec playwright test mobile-layout
```

## قياس صندوق الكتابة (assistant) بعد الخط الجديد
قبل التعديل: `h-[calc(100dvh-17.5rem)] min-h-[440px]`. عند ارتفاع 700 وأقل كان الحد الأدنى 440 يدفع صندوق الكتابة تحت الشريط السفلي (تغطية 71px عند 360x640 و91px عند 320x640)، وعند 320x800 تغطية 11px لأن ترويسة الصفحة تلتف سطرين.
بعد التعديل: `h-[calc(100dvh-21rem-env(safe-area-inset-bottom))] min-h-[240px]`. الصندوق فوق الشريط في 16 مقاس مقاسة (568 و640 و700 و800 × 4 عروض)، أضيق هامش 37px عند ارتفاع 568. الاختبار الآلي يغطي 640 و800 على 4 عروض.

حد معروف: عند ارتفاع 568 المحادثة 240px فقط، تكفي الترويسة والصندوق وسطرين رسائل. الأمثل أن تكون ترويسة الصفحة أقصر على الجوال، وهذا خارج نطاق هذا الـ PR.

## محاكاة لوحة المفاتيح وsafe-area (Chromium، ليست جهازاً حقيقياً)
محاكاة نموذج «resizes-content» فقط: تقليص ارتفاع الـ viewport 300px ثم focus حقيقي على صندوق الكتابة. صندوق الكتابة بقي ظاهراً فوق شريط التبويب في 5 مقاسات (320x568 و360x640 و390x844 و430x932 و390x664)، بهامش من 21px إلى 69px. لهذا ما عدّلت CSS، وأضفت حارس اختبار على 3 مقاسات.
جرّبت `scroll-padding-bottom` على `<main>` فرفع الصندوق 36px زيادة، بدون عيب يبرره، فما طبّقته.
محاكاة safe-area (CDP، أعلى 47 وأسفل 34): شريط التبويب يحسب السفلي (63 + 34 = 97). الترويسة العلوية لا تحسب العلوي، أزرارها عند y=8، فلو فُعّل `viewport-fit=cover` ستقع تحت الـ status bar. أي تفعيل لـ cover يحتاج `padding-top: env(safe-area-inset-top)` للترويسة أولاً.
ما تقدر Playwright تحاكيه: نموذج «resizes-visual» (آيفون وأندرويد Chrome الحديث) حيث يبقى الـ layout viewport ويتحرك الـ visual viewport فقط.

## لم يتحقق منه
لوحة المفاتيح الفعلية (visual viewport) وsafe-area على جهاز حقيقي. `viewport-fit=cover` ما انغيّر ولن يتغير قبل هذا التحقق.
