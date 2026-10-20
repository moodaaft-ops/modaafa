import type { FetchFailureCode } from './fetch';
import type { MessageMatch, PageTags, TagState } from './analyze';
import { tagState } from './analyze';

/**
 * Findings in Najdi Arabic. Every finding says what we saw and «وش الخطوة».
 * Numbers come only from the measurement; nothing here is a benchmark made up
 * for the occasion. The only thresholds are the ones the Google Ads knowledge
 * base states (load in two seconds or less, one hop to the page, tag on every
 * page without duplicates) and Google's own server response guidance.
 */

export type FindingSeverity = 'high' | 'medium' | 'low' | 'info' | 'good';

export type Finding = {
  code: string;
  severity: FindingSeverity;
  text_ar: string;
  step_ar: string;
};

export const SEVERITY_ORDER: Record<FindingSeverity, number> = { high: 0, medium: 1, low: 2, info: 3, good: 4 };

/** Server response above this is slow by Google's web.dev guidance (800 ms). */
export const SLOW_TTFB_MS = 800;
/** The knowledge base: the page should load in two seconds or less. */
export const SLOW_TOTAL_MS = 2000;
export const HEAVY_HTML_BYTES = 500_000;
export const MESSAGE_MATCH_WEAK = 40;
export const MESSAGE_MATCH_OK = 70;

export type PageFacts = {
  fetchError: FetchFailureCode | null;
  status: number | null;
  redirects: number;
  ttfbMs: number | null;
  totalMs: number | null;
  htmlBytes: number | null;
  truncated: boolean;
  isHtml: boolean;
  title: string;
  h1: string;
  viewport: { present: boolean; deviceWidth: boolean } | null;
  tags: PageTags | null;
  whatsappLinks: number;
  telLinks: number;
  smartLink: boolean;
  match: MessageMatch | null;
};

const FETCH_REASON_AR: Record<FetchFailureCode, string> = {
  bad_url: 'الرابط مكتوب غلط',
  not_https: 'الرابط مو https',
  credentials_in_url: 'الرابط فيه اسم مستخدم وكلمة سر',
  bad_port: 'الرابط على بورت غير عادي',
  ip_literal: 'الرابط رقم IP مو دومين',
  blocked_host: 'الرابط مو لصفحة عامة',
  dns_failed: 'الدومين ما يرد',
  no_address: 'الدومين ما له عنوان',
  private_address: 'الرابط يشير لشبكة داخلية',
  too_many_redirects: 'الرابط يلف على أكثر من 3 تحويلات',
  redirect_without_location: 'التحويل ما يوصل لصفحة',
  timeout: 'الصفحة ما ردت خلال 5 ثواني',
  network: 'ما قدرنا نتصل بالموقع',
};

function listShort(items: string[], max = 3) {
  const shown = items.slice(0, max).map((item) => `«${item}»`);
  return items.length > max ? `${shown.join('، ')} وغيرها` : shown.join('، ');
}

function kb(bytes: number) {
  return Math.round(bytes / 1000);
}

export function googleTagState(tags: PageTags): { state: 'visible' | 'maybe_in_gtm' | 'not_visible'; direct: boolean } {
  const direct = tags.googleAds.present || tags.ga4.present;
  if (direct) return { state: 'visible', direct: true };
  if (tags.gtm.present) return { state: 'maybe_in_gtm', direct: false };
  return { state: 'not_visible', direct: false };
}

export function tagStates(tags: PageTags): Record<keyof PageTags, TagState> {
  return {
    ga4: tagState(tags, 'ga4'),
    googleAds: tagState(tags, 'googleAds'),
    gtm: tagState(tags, 'gtm'),
    clarity: tagState(tags, 'clarity'),
    metaPixel: tagState(tags, 'metaPixel'),
    tiktokPixel: tagState(tags, 'tiktokPixel'),
    snapPixel: tagState(tags, 'snapPixel'),
  };
}

export function buildPageFindings(facts: PageFacts): Finding[] {
  const out: Finding[] = [];
  const add = (finding: Finding) => out.push(finding);

  if (facts.fetchError) {
    add({
      code: facts.fetchError === 'not_https' ? 'not_https' : 'unreachable',
      severity: 'high',
      text_ar: `ما قدرنا نفتح صفحة الهبوط: ${FETCH_REASON_AR[facts.fetchError]}`,
      step_ar:
        facts.fetchError === 'not_https'
          ? 'خل رابط الإعلان https. الصفحة اللي بدون تشفير تخوّف الزائر وتنزل جودتها.'
          : 'افتح الرابط من جوالك. لو ما يفتح صحّحه في الإعلان اليوم، لأن كل نقرة تنصرف على صفحة ميتة.',
    });
    return sortFindings(out);
  }

  if (facts.status !== null && facts.status >= 400) {
    add({
      code: 'http_error',
      severity: 'high',
      text_ar: `صفحة الهبوط ترجع خطأ ${facts.status}`,
      step_ar: 'صحّح الرابط النهائي في الإعلان أو شغّل الصفحة. وإلا وقّف الإعلان لين تنحل، تدفع على نقرات ما تشوف شي.',
    });
    return sortFindings(out);
  }

  if (facts.redirects >= 2) {
    add({
      code: 'redirect_chain',
      severity: 'medium',
      text_ar: `الرابط يمر على ${facts.redirects} تحويلات قبل ما يوصل الصفحة`,
      step_ar: 'حط الرابط النهائي مباشرة في الإعلان. كل تحويل يبطّئ الصفحة وممكن يضيّع معرّف النقرة فتخسر التتبع.',
    });
  }

  if (facts.ttfbMs !== null && facts.ttfbMs > SLOW_TTFB_MS) {
    add({
      code: 'slow_server',
      severity: 'medium',
      text_ar: `السيرفر يرد بعد ${Math.round(facts.ttfbMs)} ملي ثانية`,
      step_ar: 'كلّم مزود الاستضافة أو شغّل الكاش. القياس من سيرفرنا، جرّب الصفحة من جوالك على شبكة عادية وقارن.',
    });
  }
  if (facts.totalMs !== null && facts.totalMs > SLOW_TOTAL_MS) {
    add({
      code: 'slow_page',
      severity: 'medium',
      text_ar: `كود الصفحة تحمّل في ${(facts.totalMs / 1000).toFixed(1)} ثانية`,
      step_ar: 'الهدف ثانيتين أو أقل. خفّف السكربتات والإضافات، وافحص الصور بـPageSpeed لأننا هنا نقيس الكود بس.',
    });
  }
  if (facts.truncated) {
    add({
      code: 'html_too_big',
      severity: 'high',
      text_ar: 'كود الصفحة أكبر من 1.5 ميجا',
      step_ar: 'الصفحة ثقيلة بشكل غير عادي. اطلب من المطوّر يشيل المحتوى والسكربتات اللي ما تحتاجها.',
    });
  } else if (facts.htmlBytes !== null && facts.htmlBytes > HEAVY_HTML_BYTES) {
    add({
      code: 'html_heavy',
      severity: 'low',
      text_ar: `كود الصفحة ${kb(facts.htmlBytes)} كيلوبايت`,
      step_ar: 'ثقيل شوي. هذا وزن الكود بس بدون الصور، فافحص الصفحة كاملة بـPageSpeed.',
    });
  }

  if (!facts.isHtml) {
    add({
      code: 'not_html',
      severity: 'medium',
      text_ar: 'الرابط ما يفتح صفحة ويب عادية',
      step_ar: 'تأكد إن رابط الإعلان يودّي لصفحة هبوط مو لملف أو صورة.',
    });
    return sortFindings(out);
  }

  if (facts.viewport) {
    if (!facts.viewport.present) {
      add({
        code: 'no_viewport',
        severity: 'high',
        text_ar: 'الصفحة ما فيها إعداد الجوال (viewport)',
        step_ar: 'اطلب من مطوّر الموقع يضيف وسم viewport، وإلا ممكن تطلع الصفحة مصغّرة وصعبة القراءة على الجوال.',
      });
    } else if (!facts.viewport.deviceWidth) {
      add({
        code: 'viewport_fixed',
        severity: 'low',
        text_ar: 'إعداد الجوال في الصفحة ما يتبع عرض الشاشة',
        step_ar: 'خل viewport على width=device-width عشان الصفحة تتكيّف مع الجوال.',
      });
    }
  }

  if (!facts.title && !facts.h1) {
    add({
      code: 'no_headline',
      severity: 'medium',
      text_ar: 'الصفحة ما فيها عنوان ولا H1 نقدر نقراه',
      step_ar: 'حط عنوان رئيسي واضح فوق الصفحة يذكر اللي يبحث عنه الزائر.',
    });
  } else if (facts.match && facts.match.score !== null) {
    const { score, missing, bodyOnly } = facts.match;
    if (score < MESSAGE_MATCH_WEAK) {
      const gap = missing.length > 0 ? missing : bodyOnly;
      add({
        code: 'message_mismatch',
        severity: 'high',
        text_ar: `عنوان الصفحة ما يطابق كلمات الإعلان، التطابق ${score} من 100`,
        step_ar:
          gap.length > 0
            ? `خل العنوان الرئيسي يذكر ${listShort(gap)}. اللي يبحث عن شي ويشوف غيره يطلع.`
            : 'خل العنوان الرئيسي يذكر اللي تشتريه من كلمات في الإعلان.',
      });
    } else if (score < MESSAGE_MATCH_OK) {
      add({
        code: 'message_partial',
        severity: 'medium',
        text_ar: `عنوان الصفحة يطابق جزء من كلمات الإعلان، التطابق ${score} من 100`,
        step_ar:
          missing.length + bodyOnly.length > 0
            ? `جرّب تدخل ${listShort([...missing, ...bodyOnly])} في العنوان الرئيسي.`
            : 'قرّب العنوان الرئيسي من كلمات الإعلان.',
      });
    } else {
      add({
        code: 'message_match_good',
        severity: 'good',
        text_ar: `عنوان الصفحة يطابق كلمات الإعلان، التطابق ${score} من 100`,
        step_ar: 'ما تحتاج شي هنا.',
      });
    }
  }

  if (facts.tags) {
    const google = googleTagState(facts.tags);
    if (google.state === 'not_visible') {
      add({
        code: 'no_google_tag',
        severity: 'high',
        text_ar: 'ما لقينا وسم قوقل (AW أو gtag) في كود الصفحة',
        step_ar:
          'ركّب وسم قوقل أدس على كل الصفحات. لو منصتك مثل سلة أو شوبيفاي تركّبه من إعداداتها فتأكد بـTag Assistant، لأننا ما نشوف الوسم اللي ينحقن بعد التحميل.',
      });
    } else if (google.state === 'maybe_in_gtm') {
      add({
        code: 'gtm_only',
        severity: 'info',
        text_ar: 'فيه حاوية GTM في الصفحة وما نقدر نشوف الوسوم اللي داخلها',
        step_ar: 'افتح Tag Assistant وتأكد إن وسم التحويل يشتغل على الصفحة وما يتكرر.',
      });
    } else {
      add({
        code: 'google_tag_visible',
        severity: 'good',
        text_ar: 'وسم قوقل موجود في كود الصفحة',
        step_ar: 'ما تحتاج شي هنا.',
      });
    }
    if (facts.tags.googleAds.present && facts.tags.gtm.present) {
      add({
        code: 'possible_duplicate_tag',
        severity: 'low',
        text_ar: 'وسم قوقل أدس مركّب مباشرة وفيه GTM بعد',
        step_ar: 'تأكد إن التحويل ما ينعدّ مرتين. وسم واحد لكل تحويل بس.',
      });
    }
    const others: string[] = [];
    if (facts.tags.metaPixel.present) others.push('بكسل ميتا');
    if (facts.tags.tiktokPixel.present) others.push('بكسل تيك توك');
    if (facts.tags.snapPixel.present) others.push('بكسل سناب');
    if (facts.tags.clarity.present) others.push('Clarity');
    if (facts.tags.ga4.present) others.push('GA4');
    if (others.length > 0) {
      add({
        code: 'other_tags',
        severity: 'info',
        text_ar: `وسوم ثانية موجودة: ${others.join('، ')}`,
        step_ar: 'للعلم. تأكد إن تحويل قوقل الأساسي واحد بس، وإن GA4 مستورد كتحويل ثانوي.',
      });
    }
  }

  if (facts.whatsappLinks === 0 && facts.telLinks === 0) {
    add({
      code: 'no_contact_button',
      severity: 'medium',
      text_ar: 'ما لقينا رابط واتساب ولا رقم اتصال في كود الصفحة',
      step_ar: 'حط زر واتساب أو اتصال واضح فوق الصفحة. لو عندك ويدجت يتحمل بعد التحميل ما نشوفه، فجرّب الزر بنفسك من الجوال.',
    });
  } else if (facts.smartLink) {
    add({
      code: 'smart_link_used',
      severity: 'good',
      text_ar: 'زر الواتساب يمر على رابط مُضاعِف الذكي',
      step_ar: 'ما تحتاج شي هنا.',
    });
  } else if (facts.whatsappLinks > 0) {
    add({
      code: 'plain_whatsapp_link',
      severity: 'info',
      text_ar: 'رابط الواتساب في الصفحة عادي',
      step_ar: 'بدّله برابط مُضاعِف الذكي عشان تعلّم مين من اللي تواصل صار زبون فعلاً، وتتعلم الحملة على الزبون مو على الضغطة.',
    });
  }

  return sortFindings(out);
}

export function sortFindings(findings: Finding[]) {
  return [...findings].sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
