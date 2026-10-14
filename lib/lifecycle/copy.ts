/**
 * STUB. The coordinator replaces this file with the real texts. Agents: do not
 * edit; build against the shape. Categories and `requires` here are final.
 */
import type { BuiltEmail, CopyKey, EmailCategory, EmailCopy, FactNeed } from './types';

function stub(key: CopyKey, category: EmailCategory, requires?: FactNeed[]): EmailCopy {
  return {
    key,
    category,
    approved: false,
    requires,
    build: (): BuiltEmail => ({
      subject: `stub ${key}`,
      preheader: `stub ${key}`,
      blocks: [{ type: 'p', text: `stub ${key}` }],
      cta: { label: 'افتح مُضاعِف', path: '/home' },
      signer: 'team',
    }),
  };
}

export const EMAIL_COPY: Record<CopyKey, EmailCopy> = {
  welcome_ads_connect: stub('welcome_ads_connect', 'onboarding'),
  registered_1d: stub('registered_1d', 'lifecycle'),
  registered_3d: stub('registered_3d', 'lifecycle'),
  registered_7d: stub('registered_7d', 'lifecycle'),
  connected_3h: stub('connected_3h', 'lifecycle'),
  connected_1d: stub('connected_1d', 'lifecycle'),
  plan_ready_1d: stub('plan_ready_1d', 'lifecycle', ['plan']),
  plan_ready_3d: stub('plan_ready_3d', 'lifecycle'),
  plan_ready_7d: stub('plan_ready_7d', 'lifecycle'),
  trial_d1: stub('trial_d1', 'lifecycle', ['trial']),
  trial_d4: stub('trial_d4', 'lifecycle', ['trial']),
  trial_d9: stub('trial_d9', 'lifecycle', ['trial']),
  trial_lapsed_2d: stub('trial_lapsed_2d', 'lifecycle'),
  trial_lapsed_14d: stub('trial_lapsed_14d', 'lifecycle'),
  canceled_1d: stub('canceled_1d', 'lifecycle'),
  canceled_30d: stub('canceled_30d', 'lifecycle'),
  past_due_3d: stub('past_due_3d', 'lifecycle'),
  weekly_report: stub('weekly_report', 'weekly_report', ['weekly']),
  tx_subscription_welcome: stub('tx_subscription_welcome', 'transactional'),
  tx_trial_ending: stub('tx_trial_ending', 'transactional', ['billing']),
  tx_payment_failed: stub('tx_payment_failed', 'transactional'),
  broadcast_chat_relaunch: stub('broadcast_chat_relaunch', 'product_news'),
};
