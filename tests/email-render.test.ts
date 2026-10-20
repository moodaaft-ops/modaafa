import assert from 'node:assert/strict';
import test from 'node:test';
import { renderTemplate, resendTag, escapeHtml, BRAND, FONT_STACK } from '../lib/messaging/render';
import { EMPTY_FACTS, type Block, type EmailCopy, type RenderInput } from '../lib/lifecycle/types';
import { FIXTURE_USER, WEEKLY_FACTS, statCopy, transactionalCopy } from './support/email-fixtures';
import { withEnv } from './support/with-env';

const env = { UNSUBSCRIBE_SECRET: 'test-secret-value', NEXT_PUBLIC_APP_URL: 'https://ai.modaafa.com' };

function render(copy: EmailCopy = statCopy, facts = WEEKLY_FACTS, user: RenderInput['user'] = FIXTURE_USER, templateKey = 'weekly_report_2026-W42') {
  const out = renderTemplate({ copy, templateKey, user, facts });
  assert.ok(out, 'expected a rendered message');
  return out;
}

const withBlocks = (blocks: Block[], extra: Record<string, unknown> = {}): EmailCopy => ({
  key: 'registered_1d',
  category: 'lifecycle',
  approved: true,
  build: () => ({ subject: 'عنوان', preheader: 'سطر المعاينة', blocks, signer: 'team', ...extra }),
});

test('brand shell: RTL, 600px, paper outside, white card, navy, grey, one yellow bar', () =>
  withEnv(env, () => {
    const { html } = render();
    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="ar" dir="rtl"/);
    assert.match(html, /<body dir="rtl"/);
    assert.match(html, /max-width:600px/);
    assert.ok(html.includes(BRAND.paper), 'paper');
    assert.ok(html.includes(BRAND.card), 'white card');
    assert.ok(html.includes(BRAND.navy), 'navy');
    assert.ok(html.includes(BRAND.grey), 'grey');
    assert.ok(html.includes(FONT_STACK));
    assert.equal(FONT_STACK, "'IBM Plex Sans Arabic', Tahoma, Arial, sans-serif");
    // Signal yellow is a single 4px bar: one cell, named once as an attribute and once in its style.
    assert.equal((html.match(/#FBBC04/gi) ?? []).length, 2);
    assert.match(html, /<td height="4" bgcolor="#FBBC04" style="height:4px;/);
  }));

test('brand shell: no forbidden fonts, gradients, shadows, extra images or flex/grid', () =>
  withEnv(env, () => {
    const { html } = render();
    assert.doesNotMatch(html, /Inter|Reem|Kufi/i);
    assert.doesNotMatch(html, /gradient/i);
    assert.doesNotMatch(html, /box-shadow|text-shadow/i);
    assert.doesNotMatch(html, /url\(|@import|@font-face/i);
    // The lockup is the only image in the whole mail.
    assert.equal((html.match(/<img/gi) ?? []).length, 1);
    assert.doesNotMatch(html, /display:\s*(flex|grid)/i);
    // Every corner radius is 2px.
    const radii = [...html.matchAll(/border-radius:\s*([^;"]+)/g)].map((m) => m[1].trim());
    assert.ok(radii.length > 0);
    assert.deepEqual([...new Set(radii)], ['2px']);
  }));

test('layout is tables with presentation roles so Gmail and Outlook draw it', () =>
  withEnv(env, () => {
    const { html } = render();
    assert.ok((html.match(/<table role="presentation"/g) ?? []).length >= 5);
    assert.match(html, /<!--\[if mso\]>/);
    assert.match(html, /<meta name="viewport"/);
    assert.match(html, /<meta charset="utf-8">/);
  }));

test('lockup logo at the top with alt text, hosted PNG, sized for retina', () =>
  withEnv(env, () => {
    const { html } = render();
    assert.ok(html.indexOf('<img') < html.indexOf('هلا سارة،'));
    assert.match(html, /<img src="[^"]+\/brand\/email\/modaafa-lockup-email\.png" width="150" height="35" alt="مُضاعِف"/);
    assert.doesNotMatch(html, /\.svg/i);
  }));

test('greeting uses the first name, or a bare greeting when there is none', () =>
  withEnv(env, () => {
    const named = render();
    assert.match(named.html, /هلا سارة،/);
    assert.ok(named.text.startsWith('هلا سارة،'));

    const fromUser = render(statCopy, { ...WEEKLY_FACTS, firstName: null });
    assert.match(fromUser.html, /هلا سارة،/);

    const bare = render(statCopy, { ...WEEKLY_FACTS, firstName: null }, { ...FIXTURE_USER, name: null });
    assert.match(bare.html, />هلا،</);
    assert.ok(bare.text.startsWith('هلا،'));
  }));

test('hidden preheader sits before the card and carries the copy preheader', () =>
  withEnv(env, () => {
    const { html } = render();
    const at = html.indexOf('display:none;max-height:0;overflow:hidden');
    assert.ok(at > 0 && at < html.indexOf('هلا سارة،'));
    assert.match(html.slice(at, at + 400), /صرفت 12,400 ر\.س وجاك 86 تحويل/);
    assert.match(html, /mso-hide:all/);
  }));

test('stat blocks: big Latin number, label under it, optional note', () =>
  withEnv(env, () => {
    const { html, text } = render();
    assert.equal((html.match(/font-size:32px/g) ?? []).length, 3);
    // Pure Latin values are isolated left to right, a value with Arabic in it is not.
    assert.match(html, /<span dir="ltr"[^>]*>86<\/span>/);
    assert.match(html, /font-size:32px[^>]*>12,400 ر\.س<\/div>/);
    assert.ok(html.indexOf('>86</span>') < html.indexOf('التحويلات</div>'), 'value above label');
    assert.match(html, /الأسبوع اللي قبله 11,800 ر\.س/);
    assert.match(text, /الصرف: 12,400 ر\.س\nالأسبوع اللي قبله 11,800 ر\.س/);
    assert.match(text, /التحويلات: 86/);
  }));

test('list and note blocks', () =>
  withEnv(env, () => {
    const { html, text } = render();
    assert.equal((html.match(/<li /g) ?? []).length, 2);
    assert.match(html, /<ul dir="rtl"/);
    assert.match(text, /- كلمات الشبكة الواسعة أخذت ثلث الصرف بدون نتيجة\n- حملة العروض أحسن أداء هذا الأسبوع/);
    assert.match(html, /font-size:13px[^"]*color:#586174[^"]*"[^>]*>فيه 3 توصيات/);
  }));

test('CTA is a navy block with white text on a tracked link, and the text version carries the full URL', () =>
  withEnv(env, () => {
    const { html, text } = render();
    assert.match(html, /<td bgcolor="#0E1426" style="background:#0E1426;border-radius:2px;padding:14px 28px/);
    assert.match(html, /<a href="https:\/\/ai\.modaafa\.com\/m\/c\?u=8f3b1c52[^"]*&amp;k=weekly_report_2026-W42&amp;p=%2Fhome&amp;s=[^"]+"[^>]*color:#FFFFFF[^>]*>افتح التوصيات<\/a>/);
    assert.match(text, /افتح التوصيات:\nhttps:\/\/ai\.modaafa\.com\/m\/c\?u=8f3b1c52-9d4e-4a6b-8c1d-2e7f5a9b0c33&k=weekly_report_2026-W42&p=%2Fhome&s=/);
  }));

test('signatures: team and Ayman', () =>
  withEnv(env, () => {
    const ayman = render(statCopy);
    assert.match(ayman.html, />أيمن أمين<\/div><div[^>]*>مؤسس مُضاعِف<\/div>/);
    assert.match(ayman.text, /\n\nأيمن أمين\nمؤسس مُضاعِف\n\n/);

    const team = render(transactionalCopy, EMPTY_FACTS);
    assert.match(team.html, />فريق مُضاعِف<\/div>/);
    assert.doesNotMatch(team.html, /أيمن أمين/);
    assert.match(team.text, /\n\nفريق مُضاعِف\n\n--\n/);
  }));

test('the ps line comes after the signature', () =>
  withEnv(env, () => {
    const { html, text } = render();
    assert.ok(html.indexOf('مؤسس مُضاعِف') < html.indexOf('لو شفت رقم ما فهمته'));
    assert.ok(text.indexOf('مؤسس مُضاعِف') < text.indexOf('لو شفت رقم ما فهمته'));
  }));

test('optional mail: why line, preferences link, one-click stop link and List-Unsubscribe headers', () =>
  withEnv(env, () => {
    const out = render();
    assert.match(out.html, /وصلتك هذي الرسالة لأن حسابك في مُضاعِف يوصله ملخص أسبوعي/);
    assert.match(out.html, /href="https:\/\/ai\.modaafa\.com\/email-preferences\?u=[^"]+"[^>]*>تفضيلات الإيميل<\/a>/);
    assert.match(out.html, /href="https:\/\/ai\.modaafa\.com\/api\/messages\/opt-out\?u=[^"]+"[^>]*>أوقف الرسائل الاختيارية<\/a>/);
    assert.match(out.headers['List-Unsubscribe'], /^<https:\/\/ai\.modaafa\.com\/api\/messages\/opt-out\?u=/);
    assert.equal(out.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    assert.match(out.text, /\n--\nوصلتك هذي الرسالة/);
    assert.match(out.text, /تفضيلات الإيميل:\nhttps:\/\/ai\.modaafa\.com\/email-preferences\?u=/);
    assert.match(out.text, /أوقف الرسائل الاختيارية:\nhttps:\/\/ai\.modaafa\.com\/api\/messages\/opt-out\?u=/);
  }));

test('transactional mail: preferences link but no stop link and no List-Unsubscribe', () =>
  withEnv(env, () => {
    const out = render(transactionalCopy, EMPTY_FACTS, FIXTURE_USER, 'tx_payment_failed');
    assert.match(out.html, /تفضيلات الإيميل<\/a>/);
    assert.doesNotMatch(out.html, /opt-out/);
    assert.doesNotMatch(out.html, /أوقف الرسائل الاختيارية/);
    assert.match(out.html, /توصلك حتى لو أوقفت الرسائل الاختيارية/);
    assert.deepEqual(out.headers, {});
    assert.doesNotMatch(out.text, /opt-out/);
  }));

test('every category has its own why line', () =>
  withEnv(env, () => {
    const lines = new Set<string>();
    for (const category of ['onboarding', 'lifecycle', 'weekly_report', 'product_news', 'transactional'] as const) {
      const copy: EmailCopy = { ...withBlocks([{ type: 'p', text: 'نص' }]), category };
      const out = render(copy, EMPTY_FACTS, FIXTURE_USER, 'registered_1d');
      const why = out.text.split('\n--\n')[1].split('\n\n')[0];
      assert.match(why, /^(وصلتك|هذي رسالة)/);
      lines.add(why);
    }
    assert.equal(lines.size, 5);
  }));

test('plain text mirrors the html: no markup, same blocks, links in full', () =>
  withEnv(env, () => {
    const { html, text } = render();
    assert.doesNotMatch(text, /<[a-z/!]/i);
    assert.doesNotMatch(text, /&amp;|&lt;|&quot;|&#039;/);
    for (const needle of ['هذا ملخص الفترة من 5 أكتوبر 2026 إلى 12 أكتوبر 2026.', 'اللي لفت انتباهنا:', 'لو شفت رقم ما فهمته رد على هذا الإيميل.']) {
      assert.ok(text.includes(needle), needle);
      assert.ok(html.includes(needle), needle);
    }
    assert.ok(text.endsWith('\n'));
  }));

test('every text value is escaped, in html and in attributes', () =>
  withEnv(env, () => {
    const evil = '<script>alert(1)</script> "x" & \'y\'';
    const copy: EmailCopy = {
      key: 'registered_1d',
      category: 'lifecycle',
      approved: true,
      build: () => ({
        subject: `${evil}\nsecond line`,
        preheader: evil,
        blocks: [
          { type: 'p', text: evil },
          { type: 'stat', label: evil, value: evil, note: evil },
          { type: 'list', items: [evil] },
          { type: 'note', text: evil },
        ],
        cta: { label: evil, path: '/home' },
        ps: evil,
        signer: 'team',
      }),
    };
    const out = render(copy, { ...EMPTY_FACTS, firstName: evil }, { ...FIXTURE_USER, name: evil }, 'registered_1d');
    assert.doesNotMatch(out.html, /<script/i);
    assert.doesNotMatch(out.html, /alert\(1\)<\/script>/);
    assert.ok(out.html.includes('&lt;script&gt;alert(1)&lt;/script&gt; &quot;x&quot; &amp; &#039;y&#039;'));
    assert.equal(out.subject.includes('\n'), false);
    assert.ok(out.subject.startsWith('<script>'), 'the subject header is plain text, not html');
    assert.ok(out.html.includes('<title>&lt;script&gt;'));
    // The greeting name is escaped too (a name that long is dropped, a short odd one is escaped).
    assert.equal(escapeHtml('<b>&"\''), '&lt;b&gt;&amp;&quot;&#039;');
  }));

test('line breaks in a paragraph become <br>', () =>
  withEnv(env, () => {
    const out = render(withBlocks([{ type: 'p', text: 'سطر أول\nسطر ثاني' }]), EMPTY_FACTS, FIXTURE_USER, 'registered_1d');
    assert.match(out.html, /سطر أول<br>سطر ثاني/);
  }));

test('Latin digits only, and no long dashes or Latin commas in the Arabic around the copy', () =>
  withEnv(env, () => {
    for (const out of [render(), render(transactionalCopy, EMPTY_FACTS, FIXTURE_USER, 'tx_payment_failed')]) {
      const visible = `${out.subject}\n${out.text}\n${out.html.replace(/<[^>]+>/g, ' ')}`;
      assert.doesNotMatch(visible, /[٠-٩۰-۹]/, 'Arabic-Indic digits');
      assert.doesNotMatch(out.html + out.text + out.subject, /[–—]/, 'en or em dash');
      assert.doesNotMatch(out.text, /[؀-ۿ],/, 'Latin comma after Arabic');
      assert.doesNotMatch(out.text, /,\s*[؀-ۿ]/, 'Latin comma before Arabic');
    }
  }));

test('returns null when the copy has nothing for this user', () =>
  withEnv(env, () => {
    const out = renderTemplate({ copy: statCopy, templateKey: 'weekly_report_2026-W42', user: FIXTURE_USER, facts: EMPTY_FACTS });
    assert.equal(out, null);
  }));

test('an optional mail without a signing key is not rendered (it could not carry a working stop link)', () =>
  withEnv({ ...env, UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    const out = renderTemplate({ copy: statCopy, templateKey: 'weekly_report_2026-W42', user: FIXTURE_USER, facts: WEEKLY_FACTS });
    assert.equal(out, null);
  }));

test('a transactional mail still renders without a signing key: direct link, no preferences link', () =>
  withEnv({ ...env, UNSUBSCRIBE_SECRET: undefined, CRON_SECRET: undefined }, () => {
    const out = render(transactionalCopy, EMPTY_FACTS, FIXTURE_USER, 'tx_payment_failed');
    assert.match(out.html, /href="https:\/\/ai\.modaafa\.com\/billing\?utm_source=email&amp;utm_medium=lifecycle&amp;utm_campaign=tx_payment_failed"/);
    assert.doesNotMatch(out.html, /email-preferences/);
    assert.doesNotMatch(out.html, /\/m\/c/);
  }));

test('a button path that leaves the site is never rendered', () =>
  withEnv(env, () => {
    const log = console.error;
    console.error = () => {};
    try {
      for (const path of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)']) {
        const copy = withBlocks([{ type: 'p', text: 'نص' }], { cta: { label: 'افتح', path } });
        assert.equal(renderTemplate({ copy, templateKey: 'registered_1d', user: FIXTURE_USER, facts: EMPTY_FACTS }), null, path);
        const tx: EmailCopy = { ...copy, category: 'transactional' };
        assert.equal(renderTemplate({ copy: tx, templateKey: 'tx_payment_failed', user: FIXTURE_USER, facts: EMPTY_FACTS }), null, path);
      }
    } finally {
      console.error = log;
    }
  }));

test('a mail without a button renders without one', () =>
  withEnv(env, () => {
    const out = render(withBlocks([{ type: 'p', text: 'نص' }]), EMPTY_FACTS, FIXTURE_USER, 'registered_1d');
    assert.doesNotMatch(out.html, /\/m\/c/);
    assert.doesNotMatch(out.html, /<a href="https:\/\/ai\.modaafa\.com\/m\/c/);
  }));

test('tags: template and category, ASCII only', () =>
  withEnv(env, () => {
    const out = render();
    assert.deepEqual(out.tags, [
      { name: 'template', value: 'weekly_report_2026-W42' },
      { name: 'category', value: 'weekly_report' },
    ]);
    assert.equal(resendTag('a b/ç.ع'), 'a_b____');
    assert.equal(resendTag(''), 'unknown');
    assert.equal(resendTag('x'.repeat(300)).length, 256);
    for (const tag of out.tags) assert.match(tag.value, /^[A-Za-z0-9_-]+$/);
  }));

test('a copy with unusual characters in its key still produces valid tags', () =>
  withEnv(env, () => {
    // A key like this never reaches sendTemplate (it is rejected there), but the renderer must not emit an invalid tag.
    const out = renderTemplate({ copy: transactionalCopy, templateKey: 'weird key/ع', user: FIXTURE_USER, facts: EMPTY_FACTS });
    // Transactional with an untrackable key falls back to no CTA link, so the mail is dropped rather than sent with a wrong tag.
    assert.equal(out, null);
  }));
