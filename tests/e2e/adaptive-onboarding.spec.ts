import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/**
 * The adaptive onboarding end to end: the setup chat with «مُضاعِف» when the tree
 * is on (ADAPTIVE_ONBOARDING=true), on the fake backend with synthetic data. Five
 * customers, five journeys: a dental clinic, a Salla store, an account an agency
 * manages, a new account with no campaigns, and someone with no ads account at all.
 *
 *   node tests/e2e/support/mock-supabase-simple.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   ADAPTIVE_ONBOARDING=true CHAT_FIRST_ENTRY=true SUPABASE_SERVICE_ROLE_KEY=service \
 *     VOICE_ASSISTANT_ENABLED=true VOICE_PROVIDER=mock VOICE_TICKET_SECRET=local-test-secret-0123456789abcdefghijklmnop \
 *     NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm start &
 *   MODAAFA_E2E_ADAPTIVE=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm exec playwright test adaptive-onboarding --workers=1
 *
 * Same server setup as simple-experience.spec.ts plus ADAPTIVE_ONBOARDING=true. That flag changes /onboarding
 * for everyone, so the two specs need their own server run: this one is skipped unless MODAAFA_E2E_ADAPTIVE=1,
 * and simple-experience.spec.ts (the ten fixed questions) must run with the flag off. Use localhost, not
 * 127.0.0.1: the answer route checks the Origin against the host the server sees.
 *
 * Screenshots at 390 by 844 (the opener when there is one, the ending from its top and from its end) go to /home/claude/adaptive-shots/.
 */

const ON = process.env.MODAAFA_E2E_ADAPTIVE === '1';
const MOCK = 'http://127.0.0.1:54321';
const SHOTS = '/home/claude/adaptive-shots';

const SESSION = JSON.stringify({
  access_token: 'a.b.c',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'qa-tester@example.com', aud: 'authenticated', role: 'authenticated' },
});

// Each journey is ten or so answers with the assistant typing between them: a minute and a half is room enough.
test.describe.configure({ mode: 'serial', timeout: 90_000 });
test.skip(!ON, 'needs the fake backend and ADAPTIVE_ONBOARDING=true: see the comment at the top');

async function signIn(page: Page, baseURL: string | undefined) {
  await page.context().addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL! }]);
}

async function scenario(name: string) {
  await fetch(`${MOCK}/__scenario?name=${name}`, { method: 'POST' });
}

async function noSidewaysOverflow(page: Page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(extra).toBeLessThanOrEqual(1);
}

async function pick(page: Page, label: string | RegExp) {
  const button = page.getByRole('button', { name: label }).first();
  await expect(button).toBeVisible({ timeout: 15_000 });
  await button.click();
}

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  // Let the bubble animation and the smooth scroll settle first.
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** The transcript scrolls inside <main>, not the page: this shows its end, the way a customer scrolling down would. */
async function shotEnd(page: Page, name: string) {
  await page.locator('main').evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await shot(page, name);
}

/** The requests the adaptive flow must not make unless the state allows them. */
function watchRequests(page: Page) {
  const auditRuns: string[] = [];
  const signalReads: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('/api/audit/run')) auditRuns.push(`${request.method()} ${url}`);
    if (url.includes('/api/setup/signals')) signalReads.push(`${request.method()} ${url}`);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return { auditRuns, signalReads, errors };
}

/** What the answer dock offers, in DOM order. */
async function dockActions(page: Page) {
  const actions = page.getByRole('region', { name: 'جوابك' }).locator('a, button');
  // The dock appears after the line is typed: wait for it, then read it whole.
  await expect(actions.first()).toBeVisible({ timeout: 15_000 });
  const texts = await actions.allInnerTexts();
  return texts.map((text) => text.trim());
}

/** The new and no-account customers answer the same way: a Riyadh online store that sells perfume. */
async function answerFirstCampaignQuestions(page: Page) {
  await pick(page, 'متجر إلكتروني');
  await expect(page.getByText('وش تبيع بالضبط؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, 'عطور');
  await pick(page, 'مدن معيّنة');
  await pick(page, 'الرياض');
  await pick(page, /^تم،/);
  // The goal is asked in the store's words, even though the type answer wrote the sector.
  await expect(page.getByText('متى تقول إن الإعلان نجح؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, 'طلبات شراء من المتجر');
  await expect(page.getByText('كم تبي تصرف على إعلانات قوقل بالشهر؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, 'من 3,000 إلى 10,000 ريال');
  await pick(page, 'بكتبه بعدين');
}

// ---------------------------------------------------------------------------
// A dental clinic in Jeddah: calls first, an audit on record, no subscription
// ---------------------------------------------------------------------------

test('a clinic: the opener shows what was read, the answers lead to «فهمت عليك», and the plan opens with the call-hours decision', async ({ page, baseURL }) => {
  await scenario('adaptive_clinic');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  // The opener: a greeting, «اللي شفته», the guess, and two tiles. The stored read is fresh, so nothing is read again.
  await expect(page.getByText('هلا أيمن، ربطت حسابك وقريته.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('اللي شفته', { exact: true })).toBeVisible();
  await expect(page.getByText('حملتين بحث شغّالة على الزراعة والتقويم', { exact: false })).toBeVisible();
  await expect(page.getByText('وتطلع في جدة بس', { exact: false })).toBeVisible();
  await expect(page.getByText('يعني عيادة أسنان في جدة، وشغلك على الاتصالات.')).toBeVisible();
  await expect(page.getByText('صح كذا؟', { exact: true })).toBeVisible();
  expect(await dockActions(page)).toEqual(['إي صح', 'لا، غير كذا']);
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-opener');

  await pick(page, 'إي صح');
  // The question carries the services the campaigns already name.
  await expect(page.getByText('وش الخدمة اللي تبي تكثر حجوزاتها؟')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder('مثلاً: تقويم شفاف')).toBeVisible();
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-service-tiles');
  await pick(page, /^زراعة/);
  await pick(page, 'من 100 إلى 500 ريال');
  await pick(page, 'الاتصالات قليلة');
  await expect(page.getByText('متى أحد يرد على اتصالات العيادة؟')).toBeVisible({ timeout: 15_000 });
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-call-hours');
  await pick(page, /^فترتين/);
  await pick(page, /^إي$/);
  await pick(page, /^نفسه تقريباً/);
  await pick(page, 'استأذني في كل شي');

  // «فهمت عليك»: in the customer's words, each row with where it came from. The plan waits for «صح».
  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  const understood = page.getByRole('region', { name: 'فهمت عليك' });
  await expect(understood).toBeVisible();
  await expect(understood.getByText('عيادة أسنان في جدة')).toBeVisible();
  await expect(understood.getByText('من حسابك').first()).toBeVisible();
  await expect(understood.getByText('أكدته').first()).toBeVisible();
  await expect(understood.getByText('قلته').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'عدّل شي' })).toHaveAttribute('href', '/onboarding?edit=1');
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-understood');

  await pick(page, 'صح، وريني الخطة');
  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible({ timeout: 20_000 });
  // The rules decision is open and first: its numbers, why it comes first, and manual steps behind «كيف أسويه؟».
  await expect(plan.getByText('وقّف الإعلان من 10 الليل لين 9 الصبح')).toBeVisible();
  await expect(plan.getByText('آخر 30 يوم صرفت 420 ريال', { exact: false })).toBeVisible();
  await expect(plan.getByText('ليش أول شي', { exact: false })).toBeVisible();
  await expect(plan.getByText('لأنك قلت إن الرد فترتين', { exact: false })).toBeVisible();
  await expect(plan.getByText('افتح حسابك في قوقل أدس', { exact: false })).toBeHidden();
  await plan.getByText('كيف أسويه؟').click();
  await expect(plan.getByText('افتح حسابك في قوقل أدس', { exact: false })).toBeVisible();
  // No «اعتمد» for it, and the audit's own first decision moved down to the locked rows.
  await expect(page.getByRole('button', { name: 'اعتمد' })).toHaveCount(0);
  await expect(plan.getByText('القرارات الباقية').first()).toBeVisible();
  await expect(plan.getByText('أوقف عبارة «تقويم أسنان رخيص»: صرفت 380 ريال بدون ولا حجز')).toBeVisible();
  // The paywall is the one it always was.
  const cta = page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' });
  await expect(page.getByText('ولا شي يتغير في حسابك إلا باعتمادك', { exact: false })).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/onboarding/trial');
  await expect(page.getByRole('link', { name: 'أشوف الخطة بعدين' })).toHaveAttribute('href', '/home');
  await noSidewaysOverflow(page);
  await page.evaluate(() => document.getElementById('plan-card')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'clinic-ending');
  await shotEnd(page, 'clinic-ending-bottom');

  // An audit is on record and the read was fresh: no audit run, no new read.
  expect(seen.auditRuns).toEqual([]);
  expect(seen.signalReads).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// A Salla perfume store: the average order read from the account, then the products
// ---------------------------------------------------------------------------

test('a store: the average order is asked with the read number, the products are chips, and the plan opens with the idle-products decision', async ({ page, baseURL }) => {
  await scenario('adaptive_store');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await expect(page.getByText('هلا أيمن، ربطت حسابك وقريته.')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('المتجر على سلة', { exact: false })).toBeVisible();
  await expect(page.getByText('آخر 30 يوم صرفت 3,200 ريال وجاك منها 41 طلب.')).toBeVisible();
  await expect(page.getByText('صح إن اللي يهمك الطلبات من المتجر؟')).toBeVisible();
  expect(await dockActions(page)).toEqual(['إي صح', 'لا، غير كذا']);
  await noSidewaysOverflow(page);
  await shot(page, 'store-opener');

  await pick(page, 'إي صح');
  // Not «كم متوسط طلبك؟» from zero: the number the account gave, to confirm.
  await expect(page.getByText('متوسط طلبك من قوقل طلع قرابة 186 ريال. قريب من الصح؟')).toBeVisible({ timeout: 15_000 });
  await noSidewaysOverflow(page);
  await shot(page, 'store-aov');
  await pick(page, 'إي قريب');
  await pick(page, 'أقل من 20 ريال');

  // The products the account spends on, as chips with «تم» that waits for a choice.
  await expect(page.getByText('فيه منتجات تبيها تبيع أكثر؟')).toBeVisible({ timeout: 15_000 });
  const done = page.getByRole('button', { name: 'تم', exact: true });
  await expect(done).toBeDisabled();
  const chip = page.getByRole('button', { name: 'عطر العود الملكي' });
  await expect(chip).toHaveAttribute('aria-pressed', 'false');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(done).toBeEnabled();
  await expect(page.getByRole('button', { name: 'لا، كلها سوا' })).toBeVisible();
  await noSidewaysOverflow(page);
  await shot(page, 'store-chips');
  await done.click();

  await pick(page, 'لا، كلها تطلع');
  await pick(page, 'الطلبات قليلة');
  await pick(page, /^نفسه تقريباً/);
  await pick(page, 'استأذني في كل شي');

  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  const understood = page.getByRole('region', { name: 'فهمت عليك' });
  await expect(understood.getByText('متجر إلكتروني على سلة')).toBeVisible();
  await expect(understood.getByText('قرابة 186 ريال')).toBeVisible();
  await expect(understood.getByText('عطر العود الملكي')).toBeVisible();
  await noSidewaysOverflow(page);

  await pick(page, 'صح، وريني الخطة');
  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(plan.getByText('أوقف 4 منتجات تصرف وما تبيع')).toBeVisible();
  await expect(plan.getByText('بخور فاخر', { exact: false }).first()).toBeVisible();
  await expect(plan.getByText('ليش أول شي', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'اعتمد' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toHaveAttribute('href', '/onboarding/trial');
  await noSidewaysOverflow(page);
  await page.evaluate(() => document.getElementById('plan-card')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'store-ending');
  await shotEnd(page, 'store-ending-bottom');

  expect(seen.auditRuns).toEqual([]);
  expect(seen.signalReads).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// An account an agency manages: questions to put to the agency, and one line to the team
// ---------------------------------------------------------------------------

test('an agency-managed account: the plan comes with questions for the agency and a WhatsApp card, with nothing to execute', async ({ page, baseURL }) => {
  await scenario('adaptive_agency');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await expect(page.getByText('هلا أيمن، ربطت حسابك وقريته.')).toBeVisible({ timeout: 20_000 });
  await pick(page, 'إي صح');
  // The account is linked to an outside manager: «مُضاعِف» asks who it is, before anything else.
  await expect(page.getByText('شفت إن حسابك مربوط بحساب إدارة من برا. مين يديره؟')).toBeVisible({ timeout: 15_000 });
  await noSidewaysOverflow(page);
  await pick(page, 'وكالة أو مسوّق');
  await expect(page.getByText('وش الخدمة اللي تبي تكثر حجوزاتها؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, /^زراعة/);
  await pick(page, 'من 100 إلى 500 ريال');
  await pick(page, 'الاتصالات قليلة');
  await pick(page, /^فترتين/);
  await pick(page, /^إي$/);
  await pick(page, /^نفسه تقريباً/);
  // Somebody else runs the account: there is nothing for «مُضاعِف» to ask permission for, so no consent question.

  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  await noSidewaysOverflow(page);
  await pick(page, 'صح، وريني الخطة');

  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible({ timeout: 20_000 });
  const questions = page.getByRole('region', { name: 'أسئلة تسألها وكالتك' });
  await expect(questions).toBeVisible();
  // One question per audit category, in the order the decisions came (keywords, budget, ads).
  await expect(questions.getByRole('listitem')).toHaveCount(3);
  await expect(questions.getByText('كيف تراجعون الكلمات اللي تصرف بلا نتيجة', { exact: false })).toBeVisible();
  const management = page.getByRole('region', { name: 'خل فريق مُضاعفة يديرها عنك' });
  await expect(management).toBeVisible();
  await expect(management.getByRole('link', { name: 'كلمنا على الواتساب' })).toHaveAttribute('href', /^https:\/\/wa\.me\/966541004029\?text=/);
  // Nothing to execute: the lead has manual steps only, there is no approve button, and the trust line about
  // what «مُضاعِف» changes in the account is not on this ending.
  await expect(page.getByRole('button', { name: 'اعتمد' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toBeVisible();
  await expect(page.getByText('ولا شي يتغير في حسابك إلا باعتمادك', { exact: false })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await page.evaluate(() => document.getElementById('plan-card')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'agency-ending');
  await questions.scrollIntoViewIfNeeded();
  await shot(page, 'agency-cards');
  // At the very bottom the last card clears the dock: nothing the customer needs hides behind the trial button.
  await page.locator('main').evaluate((element) => element.scrollTo(0, element.scrollHeight));
  await expect(management.getByRole('link', { name: 'كلمنا على الواتساب' })).toBeInViewport({ ratio: 1 });
  const link = await management.getByRole('link', { name: 'كلمنا على الواتساب' }).boundingBox();
  const dock = await page.getByRole('region', { name: 'جوابك' }).boundingBox();
  expect(link && dock && link.y + link.height <= dock.y + 1).toBeTruthy();
  await shot(page, 'agency-bottom');

  expect(seen.auditRuns).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// A new account: linked, no campaigns. It never uses the free audit.
// ---------------------------------------------------------------------------

test('a new account is asked about the business, never runs the audit, and ends on «خطة أول حملة» with the trial button', async ({ page, baseURL }) => {
  await scenario('adaptive_new');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  // Nothing was read to guess from, so there is no opener: «مُضاعِف» introduces himself and asks the type.
  await expect(page.getByText('أنا مُضاعِف', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('اللي شفته', { exact: true })).toHaveCount(0);
  await expect(page.getByText('وش نوع نشاطك؟')).toBeVisible({ timeout: 15_000 });
  await answerFirstCampaignQuestions(page);

  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole('region', { name: 'فهمت عليك' }).getByText('متجر إلكتروني')).toBeVisible();
  await expect(page.getByRole('region', { name: 'خطة أول حملة' })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await pick(page, 'صح، وريني الخطة');

  const campaign = page.getByRole('region', { name: 'خطة أول حملة' });
  await expect(campaign).toBeVisible({ timeout: 20_000 });
  await expect(campaign.getByText('حملة بحث على العطور في الرياض')).toBeVisible();
  await expect(campaign.getByText('الميزانية', { exact: true })).toBeVisible();
  await expect(campaign.getByText('الهيكل', { exact: true })).toBeVisible();
  // The trial button and «بعدين»: the same two the audit plan ends on.
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toHaveAttribute('href', '/onboarding/trial');
  await expect(page.getByRole('link', { name: 'أشوف الخطة بعدين' })).toHaveAttribute('href', '/home');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'فتحته، خلني أربطه' })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await page.evaluate(() => document.getElementById('plan-card')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'new-ending');
  await shotEnd(page, 'new-ending-bottom');

  // The audit belongs to accounts that already run ads: not one request to it, and no read either (the stored one was fresh).
  expect(seen.auditRuns).toEqual([]);
  expect(seen.signalReads).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// No ads account at all: «كمّل بدون حساب» and a plan that ends on the way to an account
// ---------------------------------------------------------------------------

test('no ads account: «كمّل بدون حساب» runs the questions, and the plan ends on the WhatsApp tile first', async ({ page, baseURL }) => {
  await scenario('adaptive_no_account');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await expect(page.getByRole('link', { name: 'اربط حساب إعلانات قوقل' })).toBeVisible({ timeout: 20_000 });
  await pick(page, 'ما عندي حساب إعلانات');
  // The WhatsApp tile stays first, the new tile is right under it.
  await expect(page.getByRole('link', { name: /افتحه معي على الواتساب/ })).toBeVisible({ timeout: 15_000 });
  const tile = page.getByRole('button', { name: 'كمّل بدون حساب، وأجهز لك خطة أول حملة' });
  await expect(tile).toBeVisible();
  const actions = await dockActions(page);
  expect(actions[0]).toContain('افتحه معي على الواتساب');
  expect(actions[1]).toContain('كمّل بدون حساب، وأجهز لك خطة أول حملة');
  await noSidewaysOverflow(page);
  await shot(page, 'no-account-dock');

  await tile.click();
  await expect(page.getByText('وش نوع نشاطك؟')).toBeVisible({ timeout: 20_000 });
  await answerFirstCampaignQuestions(page);

  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  await noSidewaysOverflow(page);
  await pick(page, 'صح، وريني الخطة');

  const campaign = page.getByRole('region', { name: 'خطة أول حملة' });
  await expect(campaign).toBeVisible({ timeout: 20_000 });
  await expect(campaign.getByText('حملة بحث على العطور في الرياض')).toBeVisible();
  // The way to an account, in this order. No trial button (there is no account to run a plan on), no second «كمّل بدون حساب».
  const dock = await dockActions(page);
  expect(dock).toHaveLength(3);
  expect(dock[0]).toContain('افتحه معي على الواتساب');
  expect(dock[1]).toContain('أفتحه بنفسي بالخطوات');
  expect(dock[2]).toContain('فتحته، خلني أربطه');
  await expect(page.getByRole('link', { name: /افتحه معي على الواتساب/ })).toHaveAttribute('href', /^https:\/\/wa\.me\/966541004029\?text=/);
  await expect(page.getByRole('link', { name: 'أفتحه بنفسي بالخطوات' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /كمّل بدون حساب/ })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await page.evaluate(() => document.getElementById('plan-card')?.scrollIntoView({ block: 'start' }));
  await shot(page, 'no-account-ending');
  await shotEnd(page, 'no-account-ending-bottom');

  expect(seen.auditRuns).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// «عدّل شي» without an account: the questions again with the current answers marked, and back to «فهمت عليك»
// ---------------------------------------------------------------------------

test('no ads account: «عدّل شي» reopens the questions with the current answers marked, and the edit ends on «فهمت عليك» and the plan', async ({ page, baseURL }) => {
  await scenario('adaptive_no_account');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await pick(page, 'ما عندي حساب إعلانات');
  await pick(page, 'كمّل بدون حساب، وأجهز لك خطة أول حملة');
  await answerFirstCampaignQuestions(page);
  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });

  // «عدّل شي» is a page of its own: the questions start over, the answers on record marked.
  await page.getByRole('link', { name: 'عدّل شي' }).click();
  await expect(page).toHaveURL(/\/onboarding\?edit=1/, { timeout: 20_000 });
  await expect(page.getByText('نعدّل معلومات نشاطك', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('وش نوع نشاطك؟')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /متجر إلكتروني/ })).toContainText('الحالي');
  // There is no page of theirs to go back to without an account.
  await expect(page.getByRole('link', { name: 'رجوع لصفحتك' })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await shot(page, 'no-account-edit-type');
  await pick(page, 'متجر إلكتروني');
  await expect(page.getByText('وش تبيع بالضبط؟')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /عطور/ }).first()).toContainText('الحالي');
  await pick(page, 'عطور');
  // The rest is answered again, one tap each, and the budget is the one that changes. The city picker opens with
  // the city on record already chosen.
  await pick(page, 'مدن معيّنة');
  await expect(page.getByRole('button', { name: 'الرياض' })).toHaveAttribute('aria-pressed', 'true');
  await pick(page, /^تم،/);
  await expect(page.getByText('متى تقول إن الإعلان نجح؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, 'طلبات شراء من المتجر');
  await expect(page.getByText('كم تبي تصرف على إعلانات قوقل بالشهر؟')).toBeVisible({ timeout: 15_000 });
  await pick(page, 'أكثر من 30,000 ريال');
  await pick(page, 'بكتبه بعدين');

  // Nothing to go back to (there is no /home without an account): the edit ends where the first run ends.
  await expect(page).toHaveURL(/\/onboarding$/, { timeout: 20_000 });
  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  const understood = page.getByRole('region', { name: 'فهمت عليك' });
  // The tile «أكثر من 30,000 ريال» is booked as 40,000 a month; the first run said 6,000.
  await expect(understood.getByText('40,000 ريال بالشهر')).toBeVisible();
  await noSidewaysOverflow(page);
  await shot(page, 'no-account-edit-understood');
  await pick(page, 'صح، وريني الخطة');
  const campaign = page.getByRole('region', { name: 'خطة أول حملة' });
  await expect(campaign).toBeVisible({ timeout: 20_000 });
  await expect(campaign.getByText('حملة بحث على العطور في الرياض')).toBeVisible();
  const dock = await dockActions(page);
  expect(dock).toHaveLength(3);
  expect(dock[0]).toContain('افتحه معي على الواتساب');
  await noSidewaysOverflow(page);

  expect(seen.auditRuns).toEqual([]);
  expect(seen.errors).toEqual([]);
});

// ---------------------------------------------------------------------------
// After the clinic's plan: /home says the same thing, and «عدّل شي» opens with the type and the goal
// ---------------------------------------------------------------------------

test('a clinic: /home shows the same plan (the call-hours decision open, the audit one a locked title), and editing starts with the type and the goal', async ({ page, baseURL }) => {
  await scenario('adaptive_clinic');
  await signIn(page, baseURL);
  const seen = watchRequests(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await expect(page.getByText('هلا أيمن، ربطت حسابك وقريته.')).toBeVisible({ timeout: 20_000 });
  await pick(page, 'إي صح');
  await pick(page, /^زراعة/);
  await pick(page, 'من 100 إلى 500 ريال');
  await pick(page, 'الاتصالات قليلة');
  await pick(page, /^فترتين/);
  await pick(page, /^إي$/);
  await pick(page, /^نفسه تقريباً/);
  await pick(page, 'استأذني في كل شي');
  await expect(page.getByText('خلصنا. هذا اللي فهمته عنك:')).toBeVisible({ timeout: 20_000 });
  await pick(page, 'صح، وريني الخطة');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible({ timeout: 20_000 });

  // «أشوف الخطة بعدين»: /home is the plan the chat just showed, not the audit's own order.
  await page.getByRole('link', { name: 'أشوف الخطة بعدين' }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
  const lock = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(lock).toBeVisible({ timeout: 20_000 });
  await expect(lock.getByText('وقّف الإعلان من 10 الليل لين 9 الصبح')).toBeVisible();
  await expect(lock.getByText('ليش أول شي', { exact: false })).toBeVisible();
  await expect(lock.getByText('كيف أسويه؟')).toBeVisible();
  // The audit's own first decision is a title among the locked ones: no second open decision, no reason, no button.
  const locked = lock.getByRole('listitem').filter({ hasText: 'تقويم أسنان رخيص' });
  await expect(locked).toHaveCount(1);
  await expect(lock.getByText('العبارة جابت 80 ضغطة', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'اعتمد' })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-home-lock');

  // «عدّل معلومات نشاطك»: the business type and the goal come first, with the current answers marked.
  await page.goto('/onboarding?edit=1');
  await expect(page.getByText('نعدّل معلومات نشاطك', { exact: false })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('وش نوع نشاطك؟')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('button', { name: /عيادة أو مركز طبي/ })).toContainText('الحالي');
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-edit-type');
  await pick(page, /عيادة أو مركز طبي/);
  await expect(page.getByText('متى تقول إن الإعلان نجح؟')).toBeVisible({ timeout: 15_000 });
  await noSidewaysOverflow(page);
  await shot(page, 'clinic-edit-goal');

  expect(seen.auditRuns).toEqual([]);
  expect(seen.errors).toEqual([]);
});
