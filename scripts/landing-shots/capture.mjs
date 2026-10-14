// Captures the signed-in product screens of «مُضاعِف» for the landing page, against the FAKE backend only.
//   node scripts/landing-shots/capture.mjs [home|chat|onboarding|voice|crops ...]    (no argument = everything)
// Needs the mock on 54331 and the built app on localhost:3100 (see scripts/landing-shots/run.sh).
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const OUT = process.env.OUT || 'landing-shots-out';
const BASE = 'http://localhost:3100';
const MOCK = 'http://127.0.0.1:54331';
mkdirSync(OUT, { recursive: true });

const SESSION = JSON.stringify({
  access_token: 'a.b.c', refresh_token: 'r', token_type: 'bearer', expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'demo@example.com', aud: 'authenticated', role: 'authenticated' },
});

const PROFILES = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 },
  tall: { viewport: { width: 1440, height: 1400 }, deviceScaleFactor: 2 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
};

// What the real assistant would say to the question below, written to match the demo account:
// 4 orders yesterday against about 6 a day (41 in 7 days), «أداء أقصى - عطور» ends its 150 SAR budget early,
// and the fix is a budget change that needs the owner's approval. No promise about sales.
const QUESTION = 'ليش الطلبات أمس قليلة؟';
const TURN = {
  intent: 'explain',
  reply:
    'أمس جاك 4 طلبات، ومتوسطك آخر 7 أيام قرابة 6 في اليوم.\n' +
    'أقرب سبب إن ميزانية «أداء أقصى - عطور» خلصت الساعة 1:40 العصر، وأغلب طلباتك تجي بعد العصر.\n' +
    'جهزت لك رفعها من 150 إلى 180 ريال في اليوم، وما أغيّر شي قبل اعتمادك.',
  cards: [
    {
      kind: 'proposal',
      recommendationId: '66666666-6666-4666-8666-666666666801',
      title: 'رفع ميزانية «أداء أقصى - عطور»',
      why: 'الميزانية تخلص قبل العصر، والحملة وقتها تفوتها طلبات المساء.',
      changes: ['الميزانية اليومية: من 150 إلى 180 ريال'],
      warnings: [],
      size: 'large',
      evidence: [
        { label: 'طلبات أمس', value: '4' },
        { label: 'متوسط آخر 7 أيام', value: 'قرابة 6 طلبات في اليوم' },
        { label: 'وقت خلص الميزانية أمس', value: '1:40 العصر' },
      ],
      created: true,
      canApprove: true,
    },
  ],
  actions: [
    { label: 'وين تروح فلوسي؟', action: { type: 'say', text: 'وين تروح فلوسي في الإعلانات؟' } },
    { label: 'وش القرارات الباقية؟', action: { type: 'say', text: 'وش القرارات الباقية اليوم؟' } },
  ],
};

async function scenario(name) {
  const res = await fetch(`${MOCK}/__scenario?name=${name}`, { method: 'POST' });
  if (!res.ok) throw new Error(`mock scenario ${name}: ${res.status}`);
}

async function open(browser, profile, { path, voice = false } = {}) {
  const ctx = await browser.newContext({ ...PROFILES[profile], locale: 'ar-SA', timezoneId: 'Asia/Riyadh', permissions: voice ? ['microphone'] : [] });
  await ctx.addCookies([
    { name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: BASE },
    { name: 'modaafa_tour_seen', value: '1', url: BASE },
  ]);
  // No install banner, and nothing that is not the product itself.
  await ctx.addInitScript(() => {
    try { localStorage.setItem('modaafa-install', JSON.stringify({ installed: true })); } catch {}
  });
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`));
  await page.addStyleTag({ content: 'nextjs-portal,#__next-build-watcher{display:none!important}' }).catch(() => {});
  if (path) {
    await page.goto(BASE + path, { waitUntil: 'networkidle' });
    await page.addStyleTag({ content: 'nextjs-portal,#__next-build-watcher{display:none!important}' });
    await page.evaluate(() => document.fonts.ready);
  }
  return { ctx, page, problems };
}

const shot = async (page, name, opts = {}) => {
  await page.waitForTimeout(opts.wait ?? 700);
  await page.screenshot({ path: `${OUT}/${name}.png`, ...opts.clip && { clip: opts.clip } });
  console.log('saved', name);
};

// ---------------------------------------------------------------- a. /home, the opening message
async function home(browser) {
  await scenario('demo_home');
  for (const profile of ['desktop', 'mobile']) {
    const { ctx, page, problems } = await open(browser, profile, { path: '/home' });
    await page.getByText('قرارات اليوم').first().waitFor();
    await shot(page, `a-home-opening-${profile}`);
    if (problems.length) console.log(profile, 'PROBLEMS', problems);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- b. one exchange
// Two ways to the same exchange, both typed into the real composer with only /api/chat/start answered by Playwright:
//   clean          a new, empty conversation (/home?c=<id>): the app's own greeting, then the question and the answer
//   after-briefing «محادثة جديدة» (/home): the day's briefing is the first message and the exchange follows it
async function exchange(browser, profile, mode) {
  await scenario(mode === 'clean' ? 'demo_chat' : 'demo_home');
  const { ctx, page, problems } = await open(browser, profile, {});
  await page.route('**/api/chat/start', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await new Promise((r) => setTimeout(r, 500));
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ turn: TURN }) });
  });
  await page.goto(BASE + (mode === 'clean' ? '/home?c=99999999-9999-4999-8999-999999999903' : '/home'), { waitUntil: 'networkidle' });
  await page.getByText(mode === 'clean' ? 'اسألني عن إعلاناتك' : 'قرارات اليوم').first().waitFor();
  const box = page.getByPlaceholder('اكتب لـمُضاعِف…');
  await box.click();
  await box.pressSequentially(QUESTION, { delay: 25 });
  await page.waitForTimeout(300);
  await box.press('Enter');
  await page.getByText('جهزت لك رفعها من 150 إلى 180 ريال').waitFor();
  await page.getByRole('button', { name: 'اعتمد' }).last().waitFor();
  await page.waitForTimeout(900);
  if (mode !== 'clean') {
    // Show the exchange from the question down, the way someone reads it.
    await page.evaluate((q) => {
      const bubble = [...document.querySelectorAll('p')].find((p) => p.textContent.trim() === q);
      const scroller = bubble.closest('.overflow-y-auto');
      const top = bubble.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTo({ top: top - 28, behavior: 'instant' });
    }, QUESTION);
  }
  await shot(page, mode === 'clean' ? `b-chat-exchange-${profile}` : `b2-chat-exchange-after-briefing-${profile}`, { wait: 900 });
  if (mode === 'clean' && profile === 'desktop') {
    // The proposal card alone, for overlays.
    await page.locator('[id^="card-"]').first().screenshot({ path: `${OUT}/crop-proposal-card.png` });
    console.log('saved crop-proposal-card');
  }
  if (problems.length) console.log(profile, mode, 'PROBLEMS', problems);
  await ctx.close();
}

async function chat(browser) {
  for (const mode of ['clean', 'briefing']) for (const profile of ['desktop', 'mobile']) await exchange(browser, profile, mode);
}

// ---------------------------------------------------------------- c. adaptive onboarding
async function pick(page, label) {
  const button = page.getByRole('button', { name: label }).first();
  await button.waitFor({ timeout: 20000 });
  await button.click();
}


// Scrolls the nearest scrolling ancestor so the element's top sits `offset` px below the viewport top (clear of the sticky header).
async function scrollToTop(locator, offset = 76) {
  await locator.evaluate((el, offset) => {
    let scroller = el.parentElement;
    while (scroller && scroller.scrollHeight <= scroller.clientHeight + 2) scroller = scroller.parentElement;
    scroller = scroller || document.scrollingElement;
    const base = scroller === document.scrollingElement ? 0 : scroller.getBoundingClientRect().top;
    scroller.scrollTo({ top: scroller.scrollTop + el.getBoundingClientRect().top - base - offset, behavior: 'instant' });
  }, offset);
}

async function onboarding(browser) {
  for (const profile of ['desktop', 'mobile']) {
    await scenario('demo_onboarding');
    const { ctx, page, problems } = await open(browser, profile, { path: '/onboarding' });
    await page.getByText('ربطت حسابك وقريته').waitFor({ timeout: 25000 });
    await page.getByText('صح إن اللي يهمك الطلبات من المتجر؟').waitFor();
    await page.getByRole('button', { name: 'إي صح' }).waitFor();
    await shot(page, `c1-onboarding-confirm-${profile}`, { wait: 1500 });

    await pick(page, 'إي صح');
    await page.getByText('متوسط طلبك من قوقل طلع').waitFor({ timeout: 15000 });
    await pick(page, 'إي قريب');
    await pick(page, 'أقل من 20 ريال');
    await page.getByText('فيه منتجات تبيها تبيع أكثر؟').waitFor({ timeout: 15000 });
    await page.getByRole('button', { name: 'عطر العود الملكي' }).click();
    await page.getByRole('button', { name: 'تم', exact: true }).click();
    await pick(page, 'لا، كلها تطلع');
    await pick(page, 'الطلبات قليلة');
    await pick(page, /^نفسه تقريباً/);
    await pick(page, 'استأذني في كل شي');
    await page.getByText('خلصنا. هذا اللي فهمته عنك:').waitFor({ timeout: 25000 });
    await page.waitForTimeout(1500); // let the thread's own smooth scroll to the bottom finish first
    await scrollToTop(page.getByRole('region', { name: 'فهمت عليك' }), 54);
    await shot(page, `c2-onboarding-understood-${profile}`, { wait: 1200 });
    await pick(page, 'صح، وريني الخطة');
    await page.getByRole('region', { name: 'خطتك جاهزة' }).waitFor({ timeout: 25000 });
    await page.waitForTimeout(1500);
    await scrollToTop(page.locator('#plan-card'));
    await shot(page, `c3-onboarding-plan-${profile}`, { wait: 1200 });
    if (problems.length) console.log(profile, 'PROBLEMS', problems);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- d. voice call bar
async function voice(browser) {
  await scenario('demo_home');
  for (const profile of ['desktop', 'mobile']) {
    const { ctx, page, problems } = await open(browser, profile, { voice: true });
    // The mock voice provider adds a «وضع تجريبي» banner; the real provider does not. Same session, provider relabelled.
    // The fake microphone beeps, so nothing may reach the transcribe or chat endpoints during the shot.
    await page.route('**/api/voice/session', async (route) => {
      const res = await route.fetch();
      const data = await res.json();
      await route.fulfill({ response: res, json: { ...data, provider: 'elevenlabs' } });
    });
    await page.route(/\/api\/(voice\/transcribe|voice\/speak|chat\/start)/, (route) => route.abort());
    await page.goto(BASE + '/home', { waitUntil: 'networkidle' });
    await page.getByText('قرارات اليوم').first().waitFor();
    await page.getByRole('button', { name: 'مكالمة صوتية' }).click();
    const bar = page.getByRole('region', { name: 'مكالمة صوتية مع مُضاعِف' });
    await bar.waitFor();
    await page.waitForTimeout(2500);
    await shot(page, `d-voice-bar-${profile}`, { wait: 500 });
    console.log(profile, 'voice bar text:', (await bar.innerText()).replace(/\s+/g, ' '));
    if (problems.length) console.log(profile, 'PROBLEMS', problems);
    await ctx.close();
  }
}

// ---------------------------------------------------------------- crops from the home shot (tall, so nothing scrolls)
async function crops(browser) {
  await scenario('demo_home');
  const { ctx, page } = await open(browser, 'tall', { path: '/home' });
  await page.getByText('قرارات اليوم').first().waitFor();
  await page.waitForTimeout(800);
  await shot(page, 'a-home-opening-desktop-tall', { wait: 300 });
  const pad = 14;
  const clipOf = async (locator, p = pad) => {
    const b = await locator.boundingBox();
    return { x: Math.max(0, b.x - p), y: Math.max(0, b.y - p), width: b.width + p * 2, height: b.height + p * 2 };
  };
  // 1. The whole opening message (avatar column excluded): greeting, summary, numbers, decisions, recent changes.
  const intro = page.locator('div.min-w-0.flex-1.space-y-3').first();
  const ib = await intro.boundingBox();
  // 20px around, but only 6px on the start side so the avatar column next to it stays out of the crop.
  await shot(page, 'crop-opening-message', { clip: { x: ib.x - 20, y: ib.y - 20, width: ib.width + 20 + 6, height: ib.height + 40 }, wait: 100 });
  // 2. One decision row with its buttons.
  const decision = page.locator('ol > li').first();
  await shot(page, 'crop-decision-row', { clip: await clipOf(decision, 8), wait: 100 });
  // 3. The three numbers.
  const stats = page.locator('dl').first();
  await shot(page, 'crop-week-numbers', { clip: await clipOf(stats, 8), wait: 100 });
  await ctx.close();
}

const steps = { home, chat, onboarding, voice, crops };
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(steps);
const browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'] });
for (const name of wanted) {
  try { await steps[name](browser); } catch (e) { console.log(`STEP ${name} FAILED:`, e.message.split('\n')[0]); }
}
await browser.close();
