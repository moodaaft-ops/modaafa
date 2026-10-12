/**
 * DRAFT follow-up texts, one per step in config/stage-followups.ts.
 *
 * Nothing here is sent until Ayman has read it and the step's `approved` flag
 * is flipped to true. Edit the wording freely; keep the keys unchanged (they
 * are stored in message_log) and keep the facts true:
 *   - the audit is free, two per Google Ads account (FREE_AUDITS_PER_ACCOUNT)
 *   - nothing changes in a campaign without the owner's approval
 *   - applying recommendations needs a subscription
 *   - free help opening a Google Ads account is on WhatsApp 0541004029
 */
import { appBaseUrl, buildOptOutUrl } from '@/lib/messaging/opt-out';
import type { RenderedEmail, TemplateUser } from '@/lib/messaging/templates';

export const SUPPORT_WHATSAPP_DISPLAY = '0541004029';

type Draft = {
  subject: string;
  /** Paragraphs in order. `{{name}}` is replaced by the greeting name. */
  paragraphs: string[];
  button?: { label: string; path: string };
  /** Shown after the button. */
  after?: string[];
};

export const STAGE_MESSAGE_DRAFTS = {
  registered_1h: {
    subject: 'حسابك في مُضاعِف ناقصه ربط واحد',
    paragraphs: [
      'هلا {{name}}،',
      'سجلت في مُضاعِف وما ربطت حساب إعلانات قوقل للحين. هذي الخطوة الوحيدة بينك وبين أول فحص لحسابك، والفحص الأول مجاني.',
      'في شاشة قوقل اختر الإيميل اللي عليه حساب الإعلانات. وأي تعديل على حملاتك بعدها ما ينفذ إلا بموافقتك.',
    ],
    button: { label: 'ابدأ الربط', path: '/onboarding/connect' },
    after: [
      `وإذا ما عندك حساب إعلانات في قوقل أصلاً، راسلنا واتساب على ${SUPPORT_WHATSAPP_DISPLAY} ونفتحه معك بدون مقابل.`,
    ],
  },
  registered_1d: {
    subject: 'وقفت عند الربط؟ جرّب هذا',
    paragraphs: [
      'هلا {{name}}،',
      'في شاشة قوقل اختر الإيميل اللي عليه حساب الإعلانات، وهو قد يكون غير إيميل دخولك لمُضاعِف. عند هذي النقطة بالذات وقفت ناس قبلك.',
      `لو ظهرت لك رسالة تقول إن حسابك ما عنده إعلانات، تواصل معنا واتساب ${SUPPORT_WHATSAPP_DISPLAY} ونساعدك بدون مقابل.`,
    ],
    button: { label: 'جرّب الربط مرة ثانية', path: '/onboarding/connect' },
  },
  registered_3d: {
    subject: 'آخر رسالة عن الربط',
    paragraphs: [
      'هلا {{name}}،',
      'ما بكرر عليك بعد هالرسالة. حسابك في مُضاعِف باقي، وتربط في أي وقت.',
      `وإذا كان السبب شي ما ذكرناه، قل لنا على واتساب ${SUPPORT_WHATSAPP_DISPLAY}. يهمنا نعرفه.`,
    ],
    button: { label: 'ربط الحساب', path: '/onboarding/connect' },
  },
  connected_15m: {
    subject: 'انربط حسابك، وفحصه الأول ينتظرك',
    paragraphs: [
      'هلا {{name}}،',
      'حساب إعلانات قوقل انربط. الفحص الأول يمر على حملاتك ويوريك وين تتسرب الميزانية، وهو مجاني.',
    ],
    button: { label: 'افتح الفحص', path: '/audit' },
  },
  connected_1d: {
    subject: 'فحص حسابك ما انفتح للحين',
    paragraphs: [
      'هلا {{name}}،',
      'ربطت حسابك قبل يوم وما فتحت نتيجة الفحص. الفحص مجاني، لكل حساب فحصان، فما عليك شي لو جربته.',
    ],
    button: { label: 'افتح الفحص', path: '/audit' },
  },
  analysis_viewed_1d: {
    subject: 'التوصيات اللي طلعت لحسابك تنتظر قرارك',
    paragraphs: [
      'هلا {{name}}،',
      'شفت نتيجة فحص حسابك، وفيها توصيات ما انطبقت للحين. كل توصية تقرأها وتوافق عليها بنفسك قبل التنفيذ، وما يتغير شي في حملاتك بدونك.',
      'تطبيقها يحتاج اشتراك.',
    ],
    button: { label: 'شوف الخطط', path: '/billing' },
  },
  analysis_viewed_3d: {
    subject: 'سؤال عن فحص حسابك',
    paragraphs: [
      'هلا {{name}}،',
      'مرت ثلاثة أيام على فحصك وما اشتركت. ما نعرف السبب: السعر، أو إنك تبي تتأكد أول، أو شي ثاني.',
      `قل لنا على واتساب ${SUPPORT_WHATSAPP_DISPLAY}. ما نقدر نعدك بنتيجة محددة في حملاتك، بس نقدر نوريك وش في حسابك قبل ما تدفع.`,
    ],
    button: { label: 'شوف الخطط', path: '/billing' },
  },
} satisfies Record<string, Draft>;

export type StageTemplateId = keyof typeof STAGE_MESSAGE_DRAFTS;

export const STAGE_TEMPLATE_IDS = Object.keys(STAGE_MESSAGE_DRAFTS) as StageTemplateId[];

export function isStageTemplateId(key: string): key is StageTemplateId {
  return Object.prototype.hasOwnProperty.call(STAGE_MESSAGE_DRAFTS, key);
}

/**
 * Renders one follow-up in the same envelope as the welcome email: a signed
 * opt-out link in the footer and the one-click List-Unsubscribe header.
 * Returns null when no opt-out link can be signed, because a follow-up with no
 * working way to stop it must not go out.
 */
export function renderStageEmail(key: StageTemplateId, user: TemplateUser): RenderedEmail | null {
  const draft: Draft | undefined = STAGE_MESSAGE_DRAFTS[key];
  const optOutUrl = buildOptOutUrl(user.id);
  if (!draft || !optOutUrl) return null;

  const name = cleanName(user.name);
  const paragraph = (text: string) =>
    `<p style="margin:0 0 14px">${escapeHtml(text.replaceAll(' {{name}}', name ? ` ${name}` : ''))}</p>`;

  const button = draft.button
    ? `<p style="margin:22px 0"><a href="${escapeHtml(appBaseUrl() + draft.button.path)}" style="display:inline-block;background:#0E1426;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:6px;font-weight:700">${escapeHtml(draft.button.label)}</a></p>`
    : '';

  const html =
    draft.paragraphs.map(paragraph).join('') +
    button +
    (draft.after ?? []).map(paragraph).join('') +
    `<p style="margin:22px 0 0">فريق مُضاعِف</p>`;

  return {
    subject: draft.subject,
    html,
    footer: `ما تبي رسائل المتابعة؟ <a href="${escapeHtml(optOutUrl)}" style="color:#586174">أوقفها من هنا</a>`,
    headers: {
      'List-Unsubscribe': `<${optOutUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

function cleanName(name?: string | null): string {
  const first = (name ?? '').trim().split(/\s+/)[0] ?? '';
  // A name from a Google profile can be anything; keep it short and plain.
  return first.length > 0 && first.length <= 30 ? first : '';
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
