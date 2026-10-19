/**
 * «ما عندي موقع أو متجر» in the website step of the setup chat.
 *
 * A Google ad needs a page to send the click to. Plenty of people who sign up
 * (clinics, contractors, salons, new shops) have none, and until now the
 * answer only wrote a fact and the chat moved on, so the person left with
 * nothing to do next. This turns that answer into a conversation with the
 * team on WhatsApp: the offer is worded for the kind of business, and the
 * prefilled message already says what they need.
 *
 * Pure on purpose: copy and link only, no network, no database. The click is
 * recorded through the normal `website` answer (choice `build`), so it needs
 * no migration and shows up in the business memory the team already reads.
 *
 * Copy rules (Ayman's): no promised results, no price (the offer is not
 * priced yet), Google Ads only, one concrete detail and one honest limit in
 * each audience's text.
 */

import { SUPPORT_WHATSAPP_NUMBER } from '@/lib/support/contact';

export type NoSiteAudience = 'store' | 'clinic' | 'services' | 'real_estate' | 'restaurant' | 'local' | 'education' | 'general';

export type NoSiteOffer = {
  audience: NoSiteAudience;
  /** The tile that starts it, in the customer's own words. */
  tileLabel: string;
  /** What «مُضاعِف» says once the tile is tapped: the first line. */
  title: string;
  /** Why it matters for this kind of business, with one concrete detail. */
  body: string;
  /** What we need from them, or what stops us: the honest limit. */
  limit: string;
  /** The green button. */
  button: string;
  /** The customer's first line on WhatsApp. */
  opener: string;
  /** The bubble the chat shows after they tap the button. */
  bubble: string;
};

const OFFERS: Record<NoSiteAudience, Omit<NoSiteOffer, 'audience'>> = {
  store: {
    tileLabel: 'ما عندي متجر',
    title: 'تبيع بدون متجر؟ نجهزه لك',
    body: 'إعلان قوقل يوصّل الزبون لصفحة المنتج، وإذا ما فيه متجر ما فيه وين يطلب. فريق مُضاعفة يبني لك متجر إلكتروني بمنتجاتك ويربطه بحملتك. تكلمنا واتساب وتقول لنا وش تبيع وكم منتج عندك.',
    limit: 'الحملة ما تنزل لين المتجر يجهز.',
    button: 'كلمنا واتساب عن متجري',
    opener: 'سجلت في مضاعف وما عندي متجر الكتروني، ابي تسوون لي متجر عشان اعلن في قوقل',
    bubble: 'ما عندي متجر، ابي مضاعف يسوي لي',
  },
  clinic: {
    tileLabel: 'ما عندي موقع للعيادة',
    title: 'العيادة تحتاج صفحة قبل الإعلان',
    body: 'اللي يكتب «تقويم أسنان الرياض» في قوقل يبي صفحة فيها الخدمة وموقع العيادة وزر اتصال أو حجز. نجهز لك صفحة للعيادة بهالشكل ونربطها بالإعلان.',
    limit: 'نحتاج منك الخدمات والصور وبيانات الترخيص، ونجمعها معك في الواتساب.',
    button: 'كلمنا واتساب عن صفحة العيادة',
    opener: 'سجلت في مضاعف وعيادتي ما عندها موقع، ابي صفحة للعيادة عشان اعلن في قوقل',
    bubble: 'ما عندي موقع للعيادة، ابي مضاعف يسوي لي',
  },
  services: {
    tileLabel: 'ما عندي موقع لخدماتي',
    title: 'صفحة وحدة تكفي للبداية',
    body: 'اللي يدور على «نقل عفش جدة» ما يقرأ موقع كامل، يبي يعرف وش تسوي وهل تخدم منطقته وكيف يتصل. نجهز لك صفحة وحدة بهالمعلومات وزر اتصال وواتساب.',
    limit: 'صور أعمالك السابقة تحتاجها منك، وبدونها الصفحة تطلع أضعف.',
    button: 'كلمنا واتساب عن صفحة خدماتي',
    opener: 'سجلت في مضاعف وما عندي موقع لخدماتي، ابي صفحة اعلن فيها في قوقل',
    bubble: 'ما عندي موقع لخدماتي، ابي مضاعف يسوي لي',
  },
  real_estate: {
    tileLabel: 'ما عندي موقع لمشاريعي',
    title: 'اللي يشتري عقار أو يطلب مقاول يفتش عن موقع',
    body: 'من يبحث عن «ترميم فلل الرياض» أو «شقق للبيع شمال جدة» يفتح نتيجتين أو ثلاث ويقارن. بدون صفحة فيها مشاريعك وصور من الموقع ورقم تتواصل منه، إعلانك ما يلقى وين يوصّل. نجهزها لك.',
    limit: 'نحتاج صور مشاريع حقيقية من عندك، ما نحط صور جاهزة.',
    button: 'كلمنا واتساب عن موقع مشاريعي',
    opener: 'سجلت في مضاعف وما عندي موقع لمشاريعي (عقار او مقاولات)، ابي صفحة اعلن فيها في قوقل',
    bubble: 'ما عندي موقع لمشاريعي، ابي مضاعف يسوي لي',
  },
  restaurant: {
    tileLabel: 'ما عندي موقع للمطعم',
    title: 'اللي يبحث «مشويات قريب مني» يبي القائمة والموقع',
    body: 'قوقل يعرض له أقرب مطعم، وإذا ما لقى عندك صفحة فيها القائمة وموقع الفرع ورقم الاتصال يروح للي بعدك. نجهز لك صفحة بهالأشياء ونربطها بالإعلان.',
    limit: 'القائمة وصور المكان تجيبها منك.',
    button: 'كلمنا واتساب عن صفحة المطعم',
    opener: 'سجلت في مضاعف وما عندي موقع للمطعم او الكافيه، ابي صفحة فيها القائمة واعلن في قوقل',
    bubble: 'ما عندي موقع للمطعم، ابي مضاعف يسوي لي',
  },
  local: {
    tileLabel: 'ما عندي موقع للمحل',
    title: 'المحل القريب يحتاج صفحة يوصلها الناس',
    body: 'اللي يبحث عن محل قريب منه يبي يشوف وش عندك وين مكانك ومتى تفتح. نجهز لك صفحة فيها هذا كله وزر اتجاهات واتصال، ونربطها بإعلانك.',
    limit: 'ساعات الدوام وصور المحل تجيبها منك.',
    button: 'كلمنا واتساب عن صفحة المحل',
    opener: 'سجلت في مضاعف وما عندي موقع للمحل، ابي صفحة اعلن فيها في قوقل',
    bubble: 'ما عندي موقع للمحل، ابي مضاعف يسوي لي',
  },
  education: {
    tileLabel: 'ما عندي موقع للدورات',
    title: 'التسجيل يبدأ من صفحة تشرح الدورة',
    body: 'اللي يقارن بين دورتين يبي يعرف وش المحتوى وكم المدة ومتى تبدأ وكيف يسجل. نجهز لك صفحة بهالمعلومات وزر تسجيل، ونربطها بإعلانك.',
    limit: 'جدول الدورات الحالي يجي منك.',
    button: 'كلمنا واتساب عن صفحة الدورات',
    opener: 'سجلت في مضاعف وما عندي موقع للدورات والتدريب، ابي صفحة اعلن فيها في قوقل',
    bubble: 'ما عندي موقع للدورات، ابي مضاعف يسوي لي',
  },
  general: {
    tileLabel: 'ما عندي موقع أو متجر',
    title: 'نجهز لك صفحة تبدأ فيها الإعلان',
    body: 'إعلان قوقل يوصّل الناس لصفحة تشرح نشاطك وفيها طريقة يتواصلون فيها معك. إذا ما عندك، فريق مُضاعفة يجهزها لك. تكلمنا واتساب وتقول لنا وش نشاطك.',
    limit: 'الحملة ما تنزل لين الصفحة تجهز.',
    button: 'كلمنا واتساب عن موقعي',
    opener: 'سجلت في مضاعف وما عندي موقع او متجر، ابي تسوون لي واحد عشان اعلن في قوقل',
    bubble: 'ما عندي موقع أو متجر، ابي مضاعف يسوي لي',
  },
};

const CHOICE_TO_AUDIENCE: Record<string, NoSiteAudience> = {
  ecommerce: 'store',
  services: 'services',
  clinic: 'clinic',
  real_estate: 'real_estate',
  restaurant: 'restaurant',
  local_store: 'local',
  education: 'education',
};

const KIND_TO_AUDIENCE: Record<string, NoSiteAudience> = {
  ecommerce: 'store',
  clinic: 'clinic',
  services: 'services',
  local: 'local',
};

const SECTOR_WORDS: Array<[RegExp, NoSiteAudience]> = [
  [/متجر|سلة|زد|شوبيفاي|اون\s?لاين|أونلاين/, 'store'],
  [/عياد|طبي|اسنان|أسنان|جلد|ليزر|مستشفى|مجمع/, 'clinic'],
  [/مطعم|كافيه|كوفي|قهوة|مشوي|حلويات|مخبز/, 'restaurant'],
  [/عقار|مقاول|ترميم|بناء|تطوير\s?عقاري/, 'real_estate'],
  [/تعليم|تدريب|دورات|اكاديمي|أكاديمي|معهد|مدرسة/, 'education'],
  [/محل|فرع|صالون|مغسلة|ورشة/, 'local'],
  [/خدمات|شركة|صيانة|تنظيف|نقل|مكافحة|تكييف/, 'services'],
];

/**
 * Which wording fits. The customer's own answer to the type question wins,
 * then the kind the account (or the opener they confirmed) showed, then the
 * words of the sector saved on the business. Anything else gets the general
 * wording, which promises nothing specific.
 */
export function resolveNoSiteAudience(input: {
  /** The `type` answer's choice id, when they answered it in this chat. */
  typeChoice?: string | null;
  /** The adaptive scenario's kind, only when it is trusted (stated or confident). */
  kind?: string | null;
  /** `businesses.sector`: a label from the type tiles or free text. */
  sector?: string | null;
}): NoSiteAudience {
  const fromChoice = input.typeChoice ? CHOICE_TO_AUDIENCE[input.typeChoice] : undefined;
  if (fromChoice) return fromChoice;

  const sector = (input.sector ?? '').trim();
  const fromSector = SECTOR_WORDS.find(([pattern]) => pattern.test(sector))?.[1];
  const fromKind = input.kind ? KIND_TO_AUDIENCE[input.kind] : undefined;

  // «local» is the adaptive tree's bucket for restaurants and shops alike: the sector words split it.
  if (fromKind === 'local') return fromSector === 'restaurant' ? 'restaurant' : 'local';
  if (fromKind) return fromKind;
  return fromSector ?? 'general';
}

export function noSiteOffer(audience: NoSiteAudience): NoSiteOffer {
  return { audience, ...OFFERS[audience] };
}

/** The WhatsApp link: the opener for this audience and, when known, the email they signed up with. */
export function noSiteWhatsappUrl(audience: NoSiteAudience, email?: string | null): string {
  const lines = ['السلام عليكم', OFFERS[audience].opener];
  const cleanEmail = email?.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (cleanEmail) lines.push(`ايميلي في المنصة: ${cleanEmail}`);
  return `https://wa.me/${SUPPORT_WHATSAPP_NUMBER}?text=${encodeURIComponent(lines.join('\n'))}`;
}

export const NO_SITE_AUDIENCES = Object.keys(OFFERS) as NoSiteAudience[];
