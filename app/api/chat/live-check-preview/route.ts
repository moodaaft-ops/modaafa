import { createHash, timingSafeEqual } from 'node:crypto';
import { createMessageForAgent } from '@/lib/ai/client';
import { planTurn } from '@/lib/chat-first/orchestrator';
import { understandMessage, type ModelCall } from '@/lib/chat-first/understand';
import type { ChatState } from '@/lib/chat-first/contracts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;
const TOKEN_HASH = 'faab7fd81e383da39abfacf56192c96be54dca85ed5ffc149ae1d84503737f49';

const state: ChatState = {
  accountLinked: true,
  accountName: 'متجر تجريبي',
  customerId: '0000000000',
  latestAudit: { id: 'demo', healthScore: 62, findingsCount: 7, estimatedMonthlyWaste: 340, ranAt: '2026-10-08T10:00:00Z' },
  recommendations: [
    { id: 'demo-1', title: 'أوقف كلمة تصرف ولا تبيع', description: 'الكلمة صرفت 90 دولار ولا جابت تحويل', severity: 'critical', status: 'pending', executable: true },
    { id: 'demo-2', title: 'قلل ميزانية حملة ضعيفة', description: 'تصرف 40% من الميزانية وتجيب 8% من التحويلات', severity: 'medium', status: 'pending', executable: true },
  ],
  subscriptionActive: false,
};

const SENTENCES = [
  'انا جديد وما اعرف من وين ابدا',
  'ليش اعلاناتي تصرف وما تجيب مبيعات',
  'وش اهم شي لازم اصلحه اول',
  'خلاص سوها بدالي كلها',
  'كيف اعرف اني اخسر فلوس على الاعلانات',
];

export async function GET(request: Request) {
  if (process.env.VERCEL_ENV !== 'preview') return new Response(null, { status: 404 });
  const token = request.headers.get('x-live-check-token');
  if (!token || !timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(TOKEN_HASH, 'hex'))) {
    return new Response(null, { status: 404 });
  }
  const results = [];
  for (const sentence of SENTENCES) {
    let failed = false;
    const call: ModelCall = async ({ system, user, maxTokens }) => {
      try {
        const response = await createMessageForAgent('assistant', {
          max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
        });
        return response.content.filter((part) => part.type === 'text').map((part) => part.type === 'text' ? part.text : '').join('\n').trim() || null;
      } catch {
        failed = true;
        return null;
      }
    };
    const understood = await understandMessage(sentence, state, call);
    if (failed) return Response.json({ error: 'LIVE_CHECK_FAILED', results }, { status: 502, headers: { 'Cache-Control': 'no-store' } });
    const turn = planTurn(sentence, state, understood);
    results.push({ sentence, understood: understood?.intent ?? 'null(fallback to rules)', turnIntent: turn.intent,
      actions: turn.actions.map((action) => action.action.type),
      executesDirectly: turn.actions.some((action) => action.action.type === 'execute'), reply: turn.reply });
  }
  return Response.json(results, { headers: { 'Cache-Control': 'no-store' } });
}
