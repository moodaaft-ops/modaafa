# عقد الإجراءات بين المحادثة والصوت

يخص PR59 (المدخل بالمحادثة) وPR60 (المساعد الصوتي). الهدف: الصوت يستعمل نفس العقل ونفس الأزرار، وما يعيد كتابة أي منطق.

## القاعدة الأساسية

الكلام، مكتوباً أو منطوقاً، يقرأ ويشرح ويقترح فقط. أي تغيير في حساب Google Ads يمر بمسار واحد: معاينة، ثم زر «أوافق على التغيير»، ثم زر «نفّذ الحين». لا كلمة «أوافق» ولا «نفّذ» ولا «أيوه» تقوم مقام الزر، مكتوبة كانت أو منطوقة.

## نقطة الدخول

`POST /api/chat/start` (خلف `CHAT_FIRST_ENTRY=true`، وإلا 404).

الطلب:

```json
{ "message": "نص حر حتى 1000 حرف", "sessionId": "uuid اختياري", "customerId": "اختياري" }
```

أو إجراء من زر: `{ "action": { "type": "request_apply" | "show_recommendation", "recommendationId": "..." } }`.

الاستجابة:

```json
{
  "sessionId": "uuid",
  "turn": { "intent": "...", "reply": "نص عربي", "cards": [], "actions": [] },
  "saved": true,
  "language": { "source": "rules" | "model", "limited": { "scope": "free" | "subscriber", "resetsAt": "..." }, "degraded": true }
}
```

الأنواع كلها في `lib/chat-first/contracts.ts`. الصوت ينطق `turn.reply` ويعرض `turn.cards` و`turn.actions` كما هي.

## ما يسمح به الصوت

| الفعل | الصوت |
|---|---|
| إرسال النص المفرّغ كـ`message` | نعم |
| نطق `turn.reply` | نعم |
| `say` و`show_recommendation` و`request_apply` و`run_audit` | نعم، بزر أو لمس |
| `approve` و`execute` | لا. نموذج HTML بزر فقط (`/api/recommendations/action`) |
| «أوافق» منطوقة كتأكيد | لا. الرد يقول إن الموافقة بالزر |

## الحد اللغوي

الأسئلة الحرة (اللي تحتاج فهماً) تستهلك حصة لكل مستخدم كل 24 ساعة: 12 للمجاني و80 للمشترك (`LANGUAGE_ALLOWANCE`). الأوامر القصيرة (ثلاث كلمات أو أقل ومعناها محسوم) تُجاب بالقواعد بدون حصة. عند الانتهاء يبقى كل شيء شغالاً بالقواعد والأزرار، ويظهر في `language.limited` وقت التجديد. الصوت يشارك نفس العدّاد إذا مرّ من هذه النقطة.

## حصة الفحص (PR57)

الفحص عبر `POST /api/audit/run`. الأكواد من `docs/free-audit-contract.md`: 402 `free_audits_exhausted`، 409 `audit_in_progress`، 429 `quota_exceeded`، 503 `usage_storage_unavailable`. عند النجاح `usage: { source, remaining, resets_at }`. المحادثة تعرض الرسالة المناسبة لكل كود ولا تفترض عدداً ثابتاً.

## ما لا يلمسه PR59

لا يعدّل `VoiceCallPanel` ولا `/api/voice/speak` ولا `/api/chat/assistant`. لو بقي PR60 على `/api/chat/assistant` للمحادثة المفتوحة فهذا سليم، والعقد يلزمه فقط إذا مرّ بالمدخل الجديد.

## المدخل

مع `CHAT_FIRST_ENTRY=true`: `/assistant?from=onboarding` يحوّل إلى `/start`، ويظهر بند «ابدأ بمحادثة» واحد في الشريط الجانبي (وفي شريط الجوال بدل «المساعد»). مع الفلاغ مطفأ لا شيء يتغير.
