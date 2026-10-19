import { FAQ_CATEGORIES, FAQ_ITEMS, type FaqItem } from '@/lib/faq/data';

/**
 * What the customer-service bot is allowed to know.
 *
 * The questions and answers are not copied here: they come from
 * lib/faq/data.ts, the same list that renders /faq and its FAQPage schema, so
 * a price or a rule fixed there is fixed in the bot on the next deploy. Only
 * facts that the page does not state in a question of their own live in
 * SUPPORT_EXTRA_FACTS, and each of them must be traceable to code, the plans
 * or a written decision of the owner.
 */
export const SUPPORT_EXTRA_FACTS: string[] = [
  'السعر المعلن لكل باقة هو اللي يدفعه العميل، وما تنضاف عليه ضريبة.',
  'الفحص الأول لحساب إعلانات قوقل مجاني وبدون بطاقة، وصفحته /google-ads-audit.',
];

let cached: string | null = null;

function describeLink(item: FaqItem): string | null {
  const link = item.link;
  if (!link) return null;
  if (link.kind === 'internal') return `رابط مرفق مع هذا الجواب: ${link.label}`;
  return 'بعد هذا الجواب يتحول العميل للواتساب مع فريق مُضاعفة (handoff=true)';
}

/** The full knowledge text, built once per server instance. */
export function buildSupportKnowledge(): string {
  if (cached) return cached;
  const blocks: string[] = [];
  for (const category of FAQ_CATEGORIES) {
    const lines: string[] = [`## ${category.title}`];
    for (const item of category.items) {
      lines.push(`[${item.id}]`);
      lines.push(`س: ${item.q}`);
      lines.push(`ج: ${item.a.join('\n')}`);
      if (item.alsoCalled?.length) lines.push(`كلمات يكتبها الناس لهذا السؤال: ${item.alsoCalled.join('، ')}`);
      const link = describeLink(item);
      if (link) lines.push(link);
      lines.push('');
    }
    blocks.push(lines.join('\n'));
  }
  blocks.push(['## معلومات إضافية', ...SUPPORT_EXTRA_FACTS.map((fact) => `- ${fact}`)].join('\n'));
  cached = blocks.join('\n');
  return cached;
}

/** Ids the model may cite as the source of its answer. */
export function supportSourceIds(): string[] {
  return FAQ_ITEMS.map((item) => item.id);
}

export function findFaqItem(id: string): FaqItem | undefined {
  return FAQ_ITEMS.find((item) => item.id === id);
}
