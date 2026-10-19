import { FAQ_ITEMS } from '@/lib/faq/data';
import { whatsappHelpUrl } from '@/lib/support/contact';
import { isSupportBotEnabled } from '@/lib/support/flag';
import { SupportWidget, type QuickQuestion } from '@/lib/support/support-widget';

/**
 * Questions shown as buttons. Their answers are the /faq text itself, so the
 * zero-cost layer can never say something the page does not.
 */
const QUICK_IDS = [
  'subscription-price',
  'trial-14-days',
  'no-ads-account',
  'cancel-refund',
  'no-change-without-me',
  'other-platforms',
];

function quickQuestions(): QuickQuestion[] {
  const out: QuickQuestion[] = [];
  for (const id of QUICK_IDS) {
    const item = FAQ_ITEMS.find((candidate) => candidate.id === id);
    if (!item) continue;
    const link = item.link;
    out.push({
      id: item.id,
      q: item.q,
      a: item.a.join('\n\n'),
      link: link?.kind === 'internal' && link.href ? { label: link.label, href: link.href } : null,
      whatsappUrl:
        link?.kind === 'whatsapp-no-account'
          ? whatsappHelpUrl('no_ads_account')
          : link?.kind === 'whatsapp-agency'
            ? whatsappHelpUrl('full_management')
            : null,
    });
  }
  return out;
}

/** Renders nothing unless SUPPORT_BOT_ENABLED=true. */
export function SupportWidgetGate() {
  if (!isSupportBotEnabled()) return null;
  return <SupportWidget quick={quickQuestions()} />;
}
