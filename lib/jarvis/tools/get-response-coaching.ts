import type { JarvisReadTool } from './types';
import { cleanText, okResult, parseArgs } from './shared';
import { createAdminClient } from '@/lib/supabase/server';
import { detectCoaching } from '@/lib/coaching/response-coaching';
import { loadCoachingInput } from '@/lib/coaching/load';
import { offerCoachingEnabled } from '@/lib/coaching/flag';

export const getResponseCoachingTool: JarvisReadTool = {
  name: 'get_response_coaching',
  description:
    "Looks for a problem that is probably OUTSIDE the ad account: good click-through and many WhatsApp clicks but few leads that became customers (offer or response speed), or a conversion rate that fell while the click-through stayed the same (page, price or offer changed). Rule based, honest about uncertainty. Use it when the merchant asks why leads do not turn into sales, or before blaming the ads for weak results.",
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(input, ctx) {
    if (!offerCoachingEnabled()) return { ok: false, error: 'disabled', message_ar: 'ملاحظات العرض والرد مو مفعّلة الحين' };
    parseArgs(input, []);
    let admin: any = null;
    try {
      admin = createAdminClient();
    } catch {
      admin = null;
    }
    const data = await loadCoachingInput({ customer: ctx.customer, admin, accountId: ctx.accountId, now: ctx.now });
    const insights = detectCoaching(data);
    return okResult(
      {
        window_days: data.windowDays,
        has_lead_data: data.leads !== null,
        insights: insights.map((insight) => ({
          code: insight.code,
          where: insight.where,
          text_ar: cleanText(insight.text_ar),
          step_ar: cleanText(insight.step_ar),
        })),
        note_ar:
          insights.length === 0
            ? 'ما لقينا شي يدل إن المشكلة برا الحساب. الأرقام اللي عندنا ما تكفي أو ما فيها خلل واضح.'
            : 'هذي استنتاجات من الأرقام وليست إثباتاً. قلها للتاجر بصراحة وبدون جزم.',
      },
      []
    );
  },
};
