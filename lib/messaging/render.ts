import type { Block, BuiltEmail, EmailCategory, RenderInput, RenderedMessage } from '@/lib/lifecycle/types';
import { firstName } from '@/lib/lifecycle/format';
import { isSafeInternalPath, trackedUrl, withUtm } from './links';
import { appBaseUrl, buildOptOutUrl } from './opt-out';
import { buildPreferencesUrl } from './prefs';

/**
 * The brand shell every lifecycle and transactional email goes through.
 *
 * Identity v1.0: navy on paper, one signal-yellow 4px bar, 2px corners, no
 * gradients, no shadows, no images (the wordmark is text in v1). The layout is
 * tables with inline styles so Gmail, Outlook and Apple Mail draw the same
 * thing; the only <style> block is a small-screen padding tweak that mail
 * clients are free to ignore.
 */
export const BRAND = {
  navy: '#0E1426',
  paper: '#F4F2EC',
  card: '#FFFFFF',
  grey: '#586174',
  signal: '#FBBC04',
  hairline: '#E4E1D6',
} as const;

/** Never Inter, never Reem Kufi. */
export const FONT_STACK = "'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif";

export const WORDMARK = 'مُضاعِف';

const SIGNATURE = {
  team: ['فريق مُضاعِف'],
  ayman: ['أيمن أمين', 'مؤسس مُضاعِف'],
} as const;

/** Why the person got this mail, by category. Saudi dialect, no long dashes. */
export const FOOTER_WHY: Record<EmailCategory, string> = {
  transactional: 'هذي رسالة عن حسابك واشتراكك في مُضاعِف، وتوصلك حتى لو أوقفت الرسائل الاختيارية.',
  onboarding: 'وصلتك هذي الرسالة لأنك سجلت في مُضاعِف.',
  lifecycle: 'وصلتك هذي الرسالة لأنك سجلت في مُضاعِف، ونرسل لك نصايح ومتابعة تساعدك تستفيد من حسابك الإعلاني.',
  weekly_report: 'وصلتك هذي الرسالة لأن حسابك في مُضاعِف يوصله ملخص أسبوعي عن أداء حملاتك.',
  product_news: 'وصلتك هذي الرسالة لأنك سجلت في مُضاعِف، ونرسل لك أخبار المنصة وجديدها.',
};

export const FOOTER_PREFS_LEAD = 'تبي تغيّر اللي يوصلك؟';
export const FOOTER_PREFS_LABEL = 'تفضيلات الإيميل';
export const FOOTER_STOP_LEAD = 'ما تبي هالرسائل؟';
export const FOOTER_STOP_LABEL = 'أوقف الرسائل الاختيارية';
export const FOOTER_LEGAL = 'مُضاعِف · مؤسسة تقنيات أيمن للتسويق الإلكتروني';

/** Resend tag names and values allow only ASCII letters, digits, underscore and dash. */
export function resendTag(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
  return cleaned || 'unknown';
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

/** Escaped text with line breaks kept. */
function html(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function hasArabic(value: string) {
  return /[؀-ۿ]/.test(value);
}

const TEXT_STYLE = `font-family:${FONT_STACK};font-size:16px;line-height:1.9;color:${BRAND.navy};text-align:right;`;
const SMALL_STYLE = `font-family:${FONT_STACK};font-size:13px;line-height:1.8;color:${BRAND.grey};text-align:right;`;

function row(inner: string, padding = '0 0 16px', style = TEXT_STYLE) {
  return `<tr><td dir="rtl" align="right" style="${style}padding:${padding};">${inner}</td></tr>`;
}

function renderStatValue(value: string) {
  const safe = escapeHtml(value);
  // A pure Latin value ("12,400", "-8%") is isolated left to right so the sign and
  // the percent stay where they belong; a value with Arabic in it (a unit) flows
  // with the line instead.
  return hasArabic(value)
    ? safe
    : `<span dir="ltr" style="display:inline-block;unicode-bidi:isolate;">${safe}</span>`;
}

function renderBlockHtml(block: Block): string {
  switch (block.type) {
    case 'p':
      return row(html(block.text));
    case 'stat': {
      const note = block.note
        ? `<div style="font-size:13px;line-height:1.7;color:${BRAND.grey};padding-top:2px;">${html(block.note)}</div>`
        : '';
      return (
        `<tr><td style="padding:0 0 12px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.paper}" style="background:${BRAND.paper};border-radius:2px;">` +
        `<tr><td dir="rtl" align="right" style="font-family:${FONT_STACK};padding:16px 20px;text-align:right;">` +
        `<div style="font-size:32px;line-height:1.3;font-weight:700;color:${BRAND.navy};">${renderStatValue(block.value)}</div>` +
        `<div style="font-size:15px;line-height:1.7;color:${BRAND.grey};padding-top:4px;">${html(block.label)}</div>` +
        note +
        `</td></tr></table></td></tr>`
      );
    }
    case 'list': {
      const items = block.items
        .map((item) => `<li style="margin:0 0 8px;padding:0;">${html(item)}</li>`)
        .join('');
      return row(`<ul dir="rtl" style="margin:0;padding:0 22px 0 0;">${items}</ul>`);
    }
    case 'note':
      return row(html(block.text), '0 0 16px', SMALL_STYLE);
  }
}

function renderBlockText(block: Block): string {
  switch (block.type) {
    case 'p':
      return block.text;
    case 'stat':
      return `${block.label}: ${block.value}${block.note ? `\n${block.note}` : ''}`;
    case 'list':
      return block.items.map((item) => `- ${item}`).join('\n');
    case 'note':
      return block.text;
  }
}

function signatureLines(signer: BuiltEmail['signer']): readonly string[] {
  return SIGNATURE[signer];
}

function renderSignatureHtml(signer: BuiltEmail['signer']) {
  const [first, second] = signatureLines(signer);
  const lines =
    `<div style="font-weight:700;">${escapeHtml(first)}</div>` +
    (second ? `<div style="font-size:14px;line-height:1.7;color:${BRAND.grey};">${escapeHtml(second)}</div>` : '');
  return row(lines, '8px 0 0');
}

type FooterLinks = {
  preferencesUrl: string | null;
  stopUrl: string | null;
};

function renderFooterHtml(category: EmailCategory, links: FooterLinks) {
  const link = (href: string, label: string) =>
    `<a href="${escapeHtml(href)}" style="color:${BRAND.grey};text-decoration:underline;">${escapeHtml(label)}</a>`;
  const lines = [`<p style="margin:0 0 10px;">${escapeHtml(FOOTER_WHY[category])}</p>`];
  if (links.preferencesUrl) {
    lines.push(
      `<p style="margin:0 0 10px;">${escapeHtml(FOOTER_PREFS_LEAD)} ${link(links.preferencesUrl, FOOTER_PREFS_LABEL)}</p>`
    );
  }
  if (links.stopUrl) {
    lines.push(`<p style="margin:0 0 10px;">${escapeHtml(FOOTER_STOP_LEAD)} ${link(links.stopUrl, FOOTER_STOP_LABEL)}</p>`);
  }
  lines.push(`<p style="margin:0;">${escapeHtml(FOOTER_LEGAL)}</p>`);
  return lines.join('');
}

function renderFooterText(category: EmailCategory, links: FooterLinks) {
  const lines = [FOOTER_WHY[category]];
  if (links.preferencesUrl) lines.push(`${FOOTER_PREFS_LEAD} ${FOOTER_PREFS_LABEL}:\n${links.preferencesUrl}`);
  if (links.stopUrl) lines.push(`${FOOTER_STOP_LEAD} ${FOOTER_STOP_LABEL}:\n${links.stopUrl}`);
  lines.push(FOOTER_LEGAL);
  return lines.join('\n\n');
}

/** Pads the hidden preheader so mail clients do not pull body text into the inbox preview. */
function hiddenPreheader(preheader: string) {
  const filler = '&#8204;&nbsp;'.repeat(60);
  return (
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;visibility:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${BRAND.paper};">` +
    `${escapeHtml(preheader)}${filler}</div>`
  );
}

/** The button target: tracked when it can be, otherwise a plain internal link (transactional only). */
function ctaHref(input: RenderInput, path: string, transactional: boolean): string | null {
  if (!isSafeInternalPath(path)) {
    console.error('email cta rejected: not an internal path', { template: input.templateKey });
    return null;
  }
  const tracked = trackedUrl(input.user.id, input.templateKey, path);
  if (tracked) return tracked;
  if (!transactional) return null;
  const direct = withUtm(path, input.templateKey);
  return direct ? `${appBaseUrl()}${direct}` : null;
}

/**
 * Turns a copy plus the user's facts into a finished email.
 *
 * Returns null when there is nothing to send: the copy chose to skip this user,
 * or an optional mail cannot carry a working preferences and stop link (no
 * signing key), or the copy's button path is not an internal path. Transactional
 * mail never needs a stop link, so it is rendered even without a signing key
 * (it just loses the preferences link and click tracking).
 */
export function renderTemplate(input: RenderInput): RenderedMessage | null {
  const { copy, user, facts, templateKey } = input;
  const built = copy.build(facts);
  if (!built) return null;

  const category = copy.category;
  const transactional = category === 'transactional';

  const preferencesUrl = buildPreferencesUrl(user.id);
  const stopUrl = transactional ? null : buildOptOutUrl(user.id);
  if (!transactional && (!preferencesUrl || !stopUrl)) return null;

  let cta: { label: string; href: string } | null = null;
  if (built.cta) {
    const href = ctaHref(input, built.cta.path, transactional);
    if (!href) return null;
    cta = { label: built.cta.label, href };
  }

  const name = firstName(facts.firstName) || firstName(user.name);
  const greeting = name ? `هلا ${name}،` : 'هلا،';
  const subject = built.subject.replace(/[\r\n]+/g, ' ').trim();
  const footerLinks: FooterLinks = { preferencesUrl, stopUrl };

  const bodyRows = [
    `<tr><td dir="rtl" align="right" style="font-family:${FONT_STACK};font-size:22px;line-height:1.4;font-weight:700;color:${BRAND.navy};text-align:right;padding:0 0 18px;">${escapeHtml(WORDMARK)}</td></tr>`,
    `<tr><td style="padding:0 0 22px;"><div style="height:1px;line-height:1px;font-size:0;background:${BRAND.hairline};">&nbsp;</div></td></tr>`,
    row(`<span style="font-size:18px;font-weight:700;">${escapeHtml(greeting)}</span>`),
    ...built.blocks.map(renderBlockHtml),
  ];
  if (cta) {
    bodyRows.push(
      `<tr><td dir="rtl" align="right" style="padding:8px 0 24px;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>` +
        `<td bgcolor="${BRAND.navy}" style="background:${BRAND.navy};border-radius:2px;padding:14px 28px;text-align:center;">` +
        `<a href="${escapeHtml(cta.href)}" target="_blank" style="font-family:${FONT_STACK};font-size:16px;font-weight:700;line-height:1.4;color:#FFFFFF;text-decoration:none;display:block;">${escapeHtml(cta.label)}</a>` +
        `</td></tr></table></td></tr>`
    );
  }
  bodyRows.push(renderSignatureHtml(built.signer));
  if (built.ps) bodyRows.push(row(html(built.ps), '16px 0 0'));

  const document =
    `<!doctype html>` +
    `<html lang="ar" dir="rtl" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">` +
    `<head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Type" content="text/html; charset=utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<meta name="color-scheme" content="light only">` +
    `<meta name="supported-color-schemes" content="light only">` +
    `<title>${escapeHtml(subject)}</title>` +
    `<!--[if mso]><style>td,p,a,li,div,span{font-family:Tahoma,Arial,sans-serif !important;}</style><![endif]-->` +
    `<style>@media only screen and (max-width:620px){.card-pad{padding:24px 20px 28px !important;}.outer-pad{padding:12px 8px !important;}}</style>` +
    `</head>` +
    `<body dir="rtl" style="margin:0;padding:0;background:${BRAND.paper};">` +
    hiddenPreheader(built.preheader) +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${BRAND.paper}" style="background:${BRAND.paper};">` +
    `<tr><td align="center" class="outer-pad" style="padding:24px 12px;">` +
    `<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;">` +
    // The card: signal bar, then the white body.
    `<tr><td style="border-radius:2px;border:1px solid ${BRAND.hairline};background:${BRAND.card};" bgcolor="${BRAND.card}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">` +
    `<tr><td height="4" bgcolor="${BRAND.signal}" style="height:4px;line-height:4px;font-size:0;background:${BRAND.signal};">&nbsp;</td></tr>` +
    `<tr><td class="card-pad" dir="rtl" align="right" style="padding:28px 32px 32px;background:${BRAND.card};" bgcolor="${BRAND.card}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${bodyRows.join('')}</table>` +
    `</td></tr></table></td></tr>` +
    // The footer sits on the paper, outside the card.
    `<tr><td dir="rtl" align="right" style="${SMALL_STYLE}padding:18px 8px 0;">${renderFooterHtml(category, footerLinks)}</td></tr>` +
    `</table>` +
    `<!--[if mso]></td></tr></table><![endif]-->` +
    `</td></tr></table></body></html>`;

  const textParts = [greeting, ...built.blocks.map(renderBlockText)];
  if (cta) textParts.push(`${cta.label}:\n${cta.href}`);
  textParts.push(signatureLines(built.signer).join('\n'));
  if (built.ps) textParts.push(built.ps);
  const text = `${textParts.join('\n\n')}\n\n--\n${renderFooterText(category, footerLinks)}\n`;

  const headers: Record<string, string> = {};
  if (stopUrl) {
    headers['List-Unsubscribe'] = `<${stopUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  return {
    subject,
    html: document,
    text,
    headers,
    tags: [
      { name: 'template', value: resendTag(templateKey) },
      { name: 'category', value: resendTag(category) },
    ],
  };
}
