/**
 * Live check of the chat-first language layer on 5 beginner sentences.
 *
 * Synthetic account data only. No campaign, no account id, no secrets, no
 * database. It goes through the platform's own model path
 * (createMessageForAgent with the assistant role) and nothing else.
 *
 * Run where the approved backend key exists:  npx tsx scripts/chat-first-live-check.ts
 * Without the key it prints the real reason and exits 2 (it never fakes output).
 */
import { createMessageForAgent, hasAIBackend } from '../lib/ai/client';
import { planTurn } from '../lib/chat-first/orchestrator';
import { understandMessage, type ModelCall } from '../lib/chat-first/understand';
import type { ChatState } from '../lib/chat-first/contracts';

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

async function main() {
  if (!hasAIBackend()) {
    console.log('BACKEND_UNAVAILABLE: ANTHROPIC_API_KEY is not set in this environment (hasAIBackend() = false). Nothing was called.');
    process.exit(2);
  }
  const call: ModelCall = async ({ system, user, maxTokens }) => {
    const r = await createMessageForAgent('assistant', { max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] });
    return r.content?.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n').trim() ?? null;
  };
  for (const s of SENTENCES) {
    const u = await understandMessage(s, state, call);
    const turn = planTurn(s, state, u);
    console.log(JSON.stringify({ sentence: s, understood: u?.intent ?? 'null(fallback to rules)', turnIntent: turn.intent, actions: turn.actions.map((a) => a.action.type), executesDirectly: turn.actions.some((a) => a.action.type === 'execute'), reply: turn.reply.slice(0, 220) }));
  }
}
main().catch((e) => {
  console.log('LIVE_CHECK_FAILED:', e instanceof Error ? e.name : 'error', (e as any)?.status ?? '');
  process.exit(1);
});
