import { expect, test, type Page } from '@playwright/test';

/**
 * The simple experience end to end: the setup chat with «مُضاعِف» and the home
 * screen, on a fake backend with synthetic data.
 *
 *   node tests/e2e/support/mock-supabase-simple.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   CHAT_FIRST_ENTRY=true SUPABASE_SERVICE_ROLE_KEY=service \
 *     VOICE_ASSISTANT_ENABLED=true VOICE_PROVIDER=mock VOICE_TICKET_SECRET=local-test-secret-0123456789abcdefghijklmnop \
 *     NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm start &
 *   MODAAFA_E2E_SIMPLE=1 PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm exec playwright test simple-experience --workers=1
 *
 * Use localhost, not 127.0.0.1: the answer route checks the Origin against the
 * host the server sees. Skipped unless MODAAFA_E2E_SIMPLE=1. The specs switch the fake backend's
 * scenario, so they run one at a time.
 */

const ON = process.env.MODAAFA_E2E_SIMPLE === '1';
const MOCK = 'http://127.0.0.1:54321';

const SESSION = JSON.stringify({
  access_token: 'a.b.c',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'qa-tester@example.com', aud: 'authenticated', role: 'authenticated' },
});

test.describe.configure({ mode: 'serial' });
test.skip(!ON, 'needs the fake backend: see the comment at the top');

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

test('a new customer meets «مُضاعِف» and one connect button', async ({ page, baseURL }) => {
  await scenario('connect');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');
  await expect(page.getByText('أنا مُضاعِف', { exact: false })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'اربط حساب إعلانات قوقل' })).toBeVisible({ timeout: 15_000 });
  await noSidewaysOverflow(page);
  await pick(page, 'ما عندي حساب إعلانات');
  await expect(page.getByRole('link', { name: /افتحه معي على الواتساب/ })).toBeVisible({ timeout: 15_000 });
});

test('the questions are one tap each and end on the audit result', async ({ page, baseURL }) => {
  await scenario('questions');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');
  await pick(page, 'متجر إلكتروني');
  await pick(page, /^إيه،/);
  await pick(page, 'يشترون من متجري أو موقعي');
  await pick(page, 'من 100 إلى 500 ريال');
  // Built from the account's real 30-day spend (4,320 in the fake backend).
  await pick(page, 'نفسه تقريباً، 4,300 ريال');
  await pick(page, 'مدن معيّنة');
  await pick(page, 'الرياض');
  await pick(page, /^تم،/);
  await pick(page, 'أنا بنفسي');
  await pick(page, 'الطلبات تجي بس غالية');
  await pick(page, 'بكتبه بعدين');
  await pick(page, 'استأذني في كل شي');
  await expect(page.getByText('خلصت الفحص. صحة حسابك 58 من 100.')).toBeVisible({ timeout: 20_000 });
  // This customer is on a live trial, so there is no paywall: straight into their page.
  await expect(page.getByRole('link', { name: 'يلا ندخل صفحتك' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('خطتك جاهزة')).toHaveCount(0);
  await noSidewaysOverflow(page);
});

test('home opens with the day in words and today\'s decisions as the first message', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/dashboard');
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByText('آخر 7 أيام صرفت', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'قرارات اليوم' })).toBeVisible();
  // «اعتمد» asks once more before anything reaches the live account.
  await pick(page, 'اعتمد');
  await expect(page.getByRole('button', { name: 'إيه، نفّذ' })).toBeVisible();
  await expect(page.getByPlaceholder('اكتب لـمُضاعِف…')).toBeVisible();
});

test('on a phone home is the conversation, and the menu holds chats and sections', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await noSidewaysOverflow(page);
  await expect(page.getByPlaceholder('اكتب لـمُضاعِف…')).toBeVisible();
  await pick(page, 'القائمة');
  const menu = page.getByRole('dialog');
  await expect(menu.getByRole('button', { name: 'محادثة جديدة' })).toBeVisible();
  for (const item of ['حملاتي', 'التقارير', 'الاشتراك', 'الإعدادات']) {
    await expect(menu.getByRole('link', { name: item })).toBeVisible();
  }
  await expect(menu.getByRole('link', { name: 'وين تروح فلوسي في الإعلانات؟' })).toBeVisible();
  // A past chat reopens with its own messages, not today's briefing.
  await menu.getByRole('link', { name: 'وين تروح فلوسي في الإعلانات؟' }).click();
  await expect(page).toHaveURL(/\?c=99999999-9999-4999-8999-999999999901$/);
  await expect(page.getByText('صرفت عليها 412 ريال', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'قرارات اليوم' })).toHaveCount(0);
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('a quiet account gets one next step instead of a page of zeros', async ({ page, baseURL }) => {
  await scenario('quiet');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  await expect(page.getByText('ما شفت صرف في حسابك', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'افحص حسابي' })).toBeVisible();
  await expect(page.getByText('الصرف، 7 أيام')).toHaveCount(0);
});

test('voice opens as one bar in place of the composer, and «إنهاء» brings the composer back', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  const composer = page.getByPlaceholder('اكتب لـمُضاعِف…');
  await expect(composer).toBeVisible();
  // One tap: no «ابدأ المكالمة» step, the bar replaces the composer straight away.
  await page.getByRole('button', { name: 'مكالمة صوتية' }).click();
  const bar = page.getByRole('region', { name: 'مكالمة صوتية مع مُضاعِف' });
  await expect(bar).toBeVisible();
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ابدأ المكالمة' })).toHaveCount(0);
  await noSidewaysOverflow(page);
  await bar.getByRole('button', { name: 'إنهاء المكالمة' }).click();
  await expect(bar).toHaveCount(0);
  await expect(composer).toBeVisible();
});

test('the account row opens one menu above it to switch accounts, add one, or sign out', async ({ page, baseURL }) => {
  await scenario('multi');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  const trigger = page.getByRole('button', { name: /بدّل بين 4 حسابات/ });
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'حساباتك' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(4);
  await expect(menu.getByRole('menuitemradio', { name: /متجر الريم للعطور/ })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem', { name: 'أضف حساب إعلاني' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'تسجيل الخروج' })).toBeVisible();
  // It opens upward, fully on screen, not cut off below the fold.
  const box = await menu.boundingBox();
  expect(box && box.y >= 0 && box.y + box.height <= 900).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await scenario('home');
});

// ---------------------------------------------------------------------------
// «خطتك جاهزة»: no subscription, no trial, no AI spend
// ---------------------------------------------------------------------------

const FIRST_DECISION = 'أوقف عبارة «عطور رخيصة»: صرفت 412 ريال بدون ولا طلب';
const LOCKED_TITLES = [
  'حملة «الأداء الأقصى» توقف قبل الظهر كل يوم لأن ميزانيتها تخلص',
  'أضف عبارة «عطر عود فاخر» لحملة البحث',
  'إعلانك ما فيه سعر، والمنافسين كلهم كاتبين أسعارهم',
];

/** Answers every setup question, one tap each, the way the second spec does. */
async function answerAllQuestions(page: Page) {
  await pick(page, 'متجر إلكتروني');
  await pick(page, /^إيه،/);
  await pick(page, 'يشترون من متجري أو موقعي');
  await pick(page, 'من 100 إلى 500 ريال');
  await pick(page, 'نفسه تقريباً، 4,300 ريال');
  await pick(page, 'مدن معيّنة');
  await pick(page, 'الرياض');
  await pick(page, /^تم،/);
  await pick(page, 'أنا بنفسي');
  await pick(page, 'الطلبات تجي بس غالية');
  await pick(page, 'بكتبه بعدين');
  await pick(page, 'استأذني في كل شي');
}

/** Any request to the chat or the voice endpoints, from the page itself. */
function watchSpendRequests(page: Page) {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (/\/api\/(chat\/start|chat\/assistant|chat\/builder|voice\/)/.test(url)) seen.push(`${request.method()} ${url}`);
  });
  return seen;
}

test('onboarding ends on «خطتك جاهزة»: one decision open, the rest locked, one way forward', async ({ page, baseURL }) => {
  await scenario('unpaid');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');
  await answerAllQuestions(page);

  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('خلصت الفحص.', { exact: true })).toBeVisible();
  // The old result bubbles and the old «نفّذها لي» step are gone.
  await expect(page.getByText('خلصت الفحص. صحة حسابك 58 من 100.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: /نفّذها لي/ })).toHaveCount(0);

  await expect(plan.getByText('فحصت حسابك وطلعت لك 4 قرارات. أول واحد قدامك، والباقي ينفتح مع تجربتك المجانية.')).toBeVisible();
  // Real audit data: the health score, and the waste with its «تقدير» label.
  await expect(plan.getByRole('img', { name: /صحة حسابك 58 من 100/ })).toBeVisible();
  await expect(plan.getByText('تقدير', { exact: true })).toBeVisible();
  await expect(plan.getByText(/1,840/)).toBeVisible();
  // The first decision is open, with its reason.
  await expect(plan.getByText(FIRST_DECISION)).toBeVisible();
  await expect(plan.getByText('العبارة جابت 96 ضغطة في 30 يوم', { exact: false })).toBeVisible();
  // The others: titles only, locked, and nothing to click.
  const locked = plan.getByRole('listitem');
  await expect(locked).toHaveCount(LOCKED_TITLES.length);
  for (const title of LOCKED_TITLES) await expect(plan.getByText(title)).toBeVisible();
  await expect(plan.getByRole('link')).toHaveCount(0);
  await expect(plan.getByRole('button')).toHaveCount(0);
  await expect(plan.getByText('جابت 4 طلبات من حملة ثانية')).toHaveCount(0);

  // One way forward, with the owner's words.
  const cta = page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/onboarding/trial');
  await expect(page.getByText('تلغي بضغطة من داخل التطبيق قبل ما تنتهي')).toBeVisible();
  await expect(page.getByText('ولا شي يتغير في حسابك إلا باعتمادك، وتقدر ترجّع أي تعديل خلال 30 يوم.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'أشوف الخطة بعدين' })).toHaveAttribute('href', '/home');
  await noSidewaysOverflow(page);
});

test('«أشوف الخطة بعدين» lands on /home, which is the same plan with a locked bar', async ({ page, baseURL }) => {
  await scenario('unpaid_home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible();
  await expect(plan.getByText(FIRST_DECISION)).toBeVisible();
  await expect(plan.getByRole('listitem')).toHaveCount(LOCKED_TITLES.length);
  // The conversation is not there: no composer, no briefing.
  await expect(page.getByPlaceholder('اكتب لـمُضاعِف…')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'قرارات اليوم' })).toHaveCount(0);
  await expect(page.getByText('المحادثة مع مُضاعِف تنفتح مع تجربتك المجانية')).toBeVisible();
  const cta = page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' });
  await expect(cta).toBeVisible();
  await expect(cta).toHaveAttribute('href', '/onboarding/trial');
  await noSidewaysOverflow(page);
});

test('on /home the voice button, the chat bar and «اعتمد» open the paywall, and nothing reaches the chat or voice endpoints', async ({ page, baseURL }) => {
  await scenario('unpaid_home');
  await signIn(page, baseURL);
  const spend = watchSpendRequests(page);
  const errors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();

  const sheet = page.getByRole('dialog', { name: 'خطتك جاهزة' });
  // Voice
  await page.getByRole('button', { name: 'مكالمة صوتية' }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('المكالمة الصوتية مع مُضاعِف تنفتح مع تجربتك المجانية.')).toBeVisible();
  await expect(sheet.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toHaveAttribute('href', '/onboarding/trial');
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'مكالمة صوتية' })).toBeFocused();
  // The locked bar
  await page.getByRole('button', { name: /المحادثة مع مُضاعِف تنفتح/ }).click();
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'مو الحين' }).click();
  await expect(sheet).toHaveCount(0);
  // «اعتمد» on the open decision
  await page.getByRole('button', { name: 'اعتمد' }).click();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('اعتماد القرار وتنفيذه ينفتحون مع تجربتك المجانية.')).toBeVisible();
  await page.getByRole('button', { name: 'سكّر' }).click();
  await expect(sheet).toHaveCount(0);
  await noSidewaysOverflow(page);

  // Not one request to the chat or the voice endpoints, however the page was used.
  expect(spend).toEqual([]);
  expect(errors).toEqual([]);
});

test('/home makes zero requests to /api/chat/start on a fresh load, a new chat and a reload', async ({ page, baseURL }) => {
  await scenario('unpaid_home');
  await signIn(page, baseURL);
  const spend = watchSpendRequests(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
  await page.goto('/home?new=abc');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
  // Settle: anything the page would fire on mount has fired by now.
  await page.waitForTimeout(1500);
  expect(spend).toEqual([]);
});

test('with a live trial /home is the conversation again, and an active subscription too', async ({ page, baseURL }) => {
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['home', 'active']) {
    await scenario(name);
    await page.goto('/home');
    await expect(page.getByPlaceholder('اكتب لـمُضاعِف…')).toBeVisible();
    await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toHaveCount(0);
    await expect(page.getByText('المحادثة مع مُضاعِف تنفتح')).toHaveCount(0);
  }
  await scenario('home');
});

test('the servers refuse the chat and the voice with 402 when there is no access, and answer when there is', async ({ page, baseURL }) => {
  await signIn(page, baseURL);
  const origin = new URL(baseURL!).origin;
  const post = (path: string, data: unknown = {}) =>
    page.request.post(path, { data, headers: { origin, 'content-type': 'application/json' } });

  await scenario('unpaid_home');
  for (const path of ['/api/chat/start', '/api/voice/session', '/api/voice/transcribe', '/api/voice/speak']) {
    const response = await post(path, { message: 'مرحبا', ticket: 'x', text: 'مرحبا' });
    expect(response.status(), path).toBe(402);
    expect(await response.json(), path).toEqual({ error: 'subscription_required' });
  }
  // Applying a change needs access too: the row stays pending and the redirect says why.
  const approve = await page.request.post('/api/recommendations/action', {
    form: { recommendation_id: '66666666-6666-4666-8666-666666666600', intent: 'approve_execute', next: '/home' },
    headers: { origin },
    maxRedirects: 0,
  });
  expect(approve.status()).toBe(303);
  expect(approve.headers()['location']).toContain('/home?error=subscription_required');

  await scenario('suspended');
  const suspended = await post('/api/chat/start', { message: 'مرحبا' });
  expect(suspended.status()).toBe(403);
  expect((await suspended.json()).error).toBe('account_suspended');
  const suspendedVoice = await post('/api/voice/session');
  expect(suspendedVoice.status()).not.toBe(200);

  for (const name of ['home', 'active']) {
    await scenario(name);
    const voice = await post('/api/voice/session');
    expect(voice.status(), `${name} voice`).toBe(200);
    expect((await voice.json()).tier).toBe('paid');
  }
  await scenario('home');
});

test('the plan and the sheet at 390px and at desktop width have no sideways scroll', async ({ page, baseURL }) => {
  await scenario('unpaid_home');
  await signIn(page, baseURL);
  for (const [width, height] of [[390, 844], [320, 640], [1440, 900]] as const) {
    await page.setViewportSize({ width, height });
    await page.goto('/home');
    await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
    await noSidewaysOverflow(page);
    await page.getByRole('button', { name: /المحادثة مع مُضاعِف تنفتح/ }).click();
    await expect(page.getByRole('dialog', { name: 'خطتك جاهزة' })).toBeVisible();
    await noSidewaysOverflow(page);
    await page.keyboard.press('Escape');
  }
  await scenario('home');
});

// Chat management in the sidebar: rename, delete and search (api: /api/chat/sessions/[id]).
const CHAT_ONE = 'وين تروح فلوسي في الإعلانات؟';
const CHAT_ONE_ID = '99999999-9999-4999-8999-999999999901';
const CHAT_TWO = 'ليش الطلبات قليلة في الويكند؟';

function chatRow(page: Page, title: string) {
  return page.getByRole('listitem').filter({ has: page.getByRole('link', { name: title }) });
}

test('a chat is renamed from its «⋯» menu, Enter saves, and the new name survives a reload', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  const row = chatRow(page, CHAT_ONE);
  await row.hover();
  await row.getByRole('button', { name: 'خيارات المحادثة' }).click();
  const menu = page.getByRole('menu', { name: 'خيارات المحادثة' });
  await expect(menu.getByRole('menuitem', { name: 'إعادة تسمية' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'حذف' })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'إعادة تسمية' }).click();
  const input = page.getByRole('textbox', { name: 'اسم المحادثة' });
  await expect(input).toBeFocused();
  await input.fill('ميزانية نوفمبر');
  await input.press('Enter');
  await expect(page.getByRole('link', { name: 'ميزانية نوفمبر' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: CHAT_ONE })).toHaveCount(0);
  await expect(page.getByRole('link', { name: CHAT_TWO })).toBeVisible();
  // Saved on the server, not only on screen.
  await page.reload();
  await expect(page.getByRole('link', { name: 'ميزانية نوفمبر' })).toBeVisible();
  await expect(page.getByRole('link', { name: CHAT_ONE })).toHaveCount(0);
});

test('Escape drops a rename, and a failed save says so and keeps the old name', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  const open = async () => {
    const row = chatRow(page, CHAT_ONE);
    await row.hover();
    await row.getByRole('button', { name: 'خيارات المحادثة' }).click();
    await page.getByRole('menuitem', { name: 'إعادة تسمية' }).click();
    return page.getByRole('textbox', { name: 'اسم المحادثة' });
  };
  let input = await open();
  await input.fill('اسم ما ينحفظ');
  await input.press('Escape');
  await expect(input).toHaveCount(0);
  await expect(page.getByRole('link', { name: CHAT_ONE })).toBeVisible();

  await page.route('**/api/chat/sessions/*', (route) =>
    route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'update_failed' }) })
  );
  input = await open();
  await input.fill('اسم ثاني');
  await input.press('Enter');
  await expect(page.getByText('ما قدرت أحفظ الاسم. جرّب مرة ثانية.')).toBeVisible({ timeout: 15_000 });
  await expect(input).toHaveValue('اسم ثاني');
  await input.press('Escape');
  await expect(page.getByRole('link', { name: CHAT_ONE })).toBeVisible();
  await page.unroute('**/api/chat/sessions/*');
});

test('deleting the open chat asks first, then lands on a new chat and the chat is gone from the list', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/home?c=${CHAT_ONE_ID}`);
  await expect(page.getByText('صرفت عليها 412 ريال', { exact: false })).toBeVisible();
  const row = chatRow(page, CHAT_ONE);
  await row.hover();
  await row.getByRole('button', { name: 'خيارات المحادثة' }).click();
  await page.getByRole('menuitem', { name: 'حذف' }).click();
  const confirm = page.getByRole('alertdialog');
  await expect(confirm.getByText('تحذف المحادثة؟ ما تقدر ترجعها.')).toBeVisible();
  // «إلغاء» leaves everything as it was.
  await confirm.getByRole('button', { name: 'إلغاء' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`\\?c=${CHAT_ONE_ID}$`));
  await row.hover();
  await row.getByRole('button', { name: 'خيارات المحادثة' }).click();
  await page.getByRole('menuitem', { name: 'حذف' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'حذف' }).click();
  await expect(page).toHaveURL(/\/home\?new=1$/, { timeout: 15_000 });
  await expect(page.getByRole('link', { name: CHAT_ONE })).toHaveCount(0);
  await expect(page.getByRole('link', { name: CHAT_TWO })).toBeVisible();
  await expect(page.getByText('صرفت عليها 412 ريال', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'قرارات اليوم' })).toBeVisible({ timeout: 15_000 });
});

test('with more than 8 chats a search box appears above «محادثاتك» and filters by title', async ({ page, baseURL }) => {
  await scenario('home');
  // Eight more chats on top of the two the scenario has.
  const extra = Array.from({ length: 8 }, (_, i) => ({
    id: `99999999-9999-4999-8999-9999999999${String(10 + i)}`,
    user_id: '11111111-1111-4111-8111-111111111111',
    account_id: '33333333-3333-4333-8333-333333333333',
    title: i === 3 ? 'خطة ميزانية رمضان' : `تقرير الأسبوع ${i + 1}`,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }));
  await fetch(`${MOCK}/rest/v1/chat_sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(extra),
  });
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home');
  const search = page.getByRole('textbox', { name: 'دوّر في محادثاتك' });
  await expect(search).toBeVisible();
  await expect(page.getByRole('link', { name: /^تقرير الأسبوع/ })).toHaveCount(7);
  await search.fill('ميزانيه');
  await expect(page.getByRole('link', { name: 'خطة ميزانية رمضان' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^تقرير الأسبوع/ })).toHaveCount(0);
  await search.fill('ما له وجود');
  await expect(page.getByText('ما لقيت محادثة بهالاسم.')).toBeVisible();
  await page.getByRole('button', { name: 'امسح البحث' }).click();
  await expect(page.getByRole('link', { name: /^تقرير الأسبوع/ })).toHaveCount(7);
  await scenario('home');
});

test('on a phone the chat menu opens inside the drawer and Escape closes only the menu', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await pick(page, 'القائمة');
  const drawer = page.getByRole('dialog');
  const trigger = drawer.getByRole('button', { name: 'خيارات المحادثة' }).first();
  await trigger.click();
  const menu = page.getByRole('menu', { name: 'خيارات المحادثة' });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 390).toBeTruthy();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(trigger).toBeFocused();
  await noSidewaysOverflow(page);
});

// ---------------------------------------------------------------------------
// Review fixes: the undo on /home, a stopped subscription, the chat that loses
// access mid-conversation, and the locked /audit and /optimizer
// ---------------------------------------------------------------------------

const UNDO_FIRST = 'منعت إعلانك يطلع لعبارة «عطور رخيصة»';
const UNDO_SECOND = 'أوقفت كلمة «عود مجاني» لأنها صرفت بدون طلبات';
const NOT_UNDOABLE = ['غيّرت ميزانية حملة العلامة', 'أوقفت إعلان قديم', 'منعت عبارة من أكثر من شهر', 'تغيير على حساب ثاني'];
/** Text that exists only behind the lock: the reasons of the locked decisions and the AI narrative. */
const LOCKED_SECRETS = [
  'آخر 7 أيام خلصت الميزانية قبل الساعة 12',
  'جابت 4 طلبات من حملة ثانية بتكلفة أقل',
  'إضافة السعر في الإعلان تقلل الضغطات',
  'العنوان السري للقراءة الذكية',
  'ملخص سري للقراءة الذكية',
  'أولوية سرية للقراءة الذكية',
];

function watchConsoleErrors(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

/** The rollback route needs the real Google Ads API; here the form's request is caught and answered the way the route answers. */
async function interceptRollback(page: Page, location: string) {
  const posted: string[] = [];
  await page.route('**/api/actions/rollback', async (route) => {
    posted.push(route.request().postData() ?? '');
    await route.fulfill({ status: 303, headers: { location } });
  });
  return posted;
}

test('«التغييرات الأخيرة» lists what can still be undone, newest first, and «رجّعه» asks first, then posts to the rollback route', async ({ page, baseURL }) => {
  await scenario('undo');
  await signIn(page, baseURL);
  const errors = watchConsoleErrors(page);
  const posted = await interceptRollback(page, '/home?reverted=1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');

  const recent = page.getByRole('region', { name: 'التغييرات الأخيرة' });
  await expect(recent).toBeVisible();
  const rows = recent.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText(UNDO_FIRST);
  await expect(rows.nth(1)).toContainText(UNDO_SECOND);
  await expect(rows.nth(0)).toContainText('قبل');
  // Only what the rollback route would accept: not reversible, already undone, over 30 days, another account.
  for (const text of NOT_UNDOABLE) await expect(page.getByText(text)).toHaveCount(0);
  await expect(recent.getByRole('link', { name: 'شوف كل التغييرات' })).toHaveCount(0);
  await expect(recent.getByRole('button', { name: 'رجّعه' })).toHaveCount(2);
  await expect(recent.getByText('تقدر ترجّع أي تغيير خلال 30 يوم.')).toBeVisible();
  await noSidewaysOverflow(page);

  // «رجّعه» asks once more, and «لا، خلّه» drops the question.
  await recent.getByRole('button', { name: 'رجّعه' }).first().click();
  await expect(recent.getByText('ترجّع هذا التعديل؟')).toBeVisible();
  await recent.getByRole('button', { name: 'لا، خلّه' }).click();
  await expect(recent.getByText('ترجّع هذا التعديل؟')).toHaveCount(0);

  await recent.getByRole('button', { name: 'رجّعه' }).first().click();
  await recent.getByRole('button', { name: 'إيه، رجّعه' }).click();
  await expect(page).toHaveURL(/\/home\?reverted=1$/);
  expect(posted).toHaveLength(1);
  const form = new URLSearchParams(posted[0]);
  expect(form.get('action_id')).toBe('77777777-7777-4777-8777-777777777711');
  expect(form.get('next')).toBe('/home');
  await expect(page.getByText('رجّعت التغيير مثل ما كان.')).toBeVisible();
  expect(errors).toEqual([]);
  await scenario('home');
});

test('with more than five undoable changes the list shows five and links to the whole log', async ({ page, baseURL }) => {
  await scenario('undo_many');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  const recent = page.getByRole('region', { name: 'التغييرات الأخيرة' });
  await expect(recent.getByRole('listitem')).toHaveCount(5);
  const all = recent.getByRole('link', { name: 'شوف كل التغييرات' });
  await expect(all).toHaveAttribute('href', '/optimizer#execution-log');
  await noSidewaysOverflow(page);
  await scenario('home');
});

test('right after an apply (/home?executed=1) the undo list is there, above the day\'s decisions', async ({ page, baseURL }) => {
  await scenario('undo');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/home?executed=1');
  const recent = page.getByRole('region', { name: 'التغييرات الأخيرة' });
  await expect(recent).toBeVisible();
  await expect(recent.getByRole('button', { name: 'رجّعه' }).first()).toBeVisible();
  const decisions = page.getByRole('heading', { name: 'قرارات اليوم' });
  await expect(decisions).toBeVisible();
  const recentTop = (await recent.boundingBox())!.y;
  const decisionsTop = (await decisions.boundingBox())!.y;
  expect(recentTop).toBeLessThan(decisionsTop);
  await scenario('home');
});

test('without a plan the undo list is on /home too, under the plan, and «رجّعه» works from there', async ({ page, baseURL }) => {
  await scenario('undo_unpaid');
  await signIn(page, baseURL);
  const errors = watchConsoleErrors(page);
  const posted = await interceptRollback(page, '/home?reverted=1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
  const recent = page.getByRole('region', { name: 'التغييرات الأخيرة' });
  await expect(recent.getByRole('listitem')).toHaveCount(2);
  await expect(recent.getByRole('listitem').first()).toContainText(UNDO_FIRST);
  await noSidewaysOverflow(page);

  await recent.getByRole('button', { name: 'رجّعه' }).first().click();
  await expect(recent.getByText('ترجّع هذا التعديل؟')).toBeVisible();
  await recent.getByRole('button', { name: 'إيه، رجّعه' }).click();
  await expect(page).toHaveURL(/\/home\?reverted=1$/);
  expect(new URLSearchParams(posted[0]).get('next')).toBe('/home');
  // The locked home answers an undo with the same words as the full home.
  await expect(page.getByText('رجّعت التغيير مثل ما كان.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();

  await page.goto('/home?executed=1');
  await expect(page.getByRole('region', { name: 'التغييرات الأخيرة' })).toBeVisible();
  expect(errors).toEqual([]);
  await scenario('home');
});

test('a subscription whose payment failed gets «حدّث بطاقتك وكمّل» to /billing, not a checkout that refuses it', async ({ page, baseURL }) => {
  await scenario('past_due');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible();
  const cta = page.getByRole('link', { name: 'حدّث بطاقتك وكمّل' });
  await expect(cta).toHaveAttribute('href', '/billing');
  await expect(page.getByText('اشتراكك موقوف لأن آخر دفعة ما مرت.').first()).toBeVisible();
  // Nothing on the page still sends this person to the trial checkout.
  await expect(page.getByRole('link', { name: /ابدأ 14 يوم مجاناً|فعّل اشتراكك/ })).toHaveCount(0);
  await expect(page.locator('a[href="/onboarding/trial"]')).toHaveCount(0);
  await noSidewaysOverflow(page);

  // The same button in the sheet the chat bar opens.
  await page.getByRole('button', { name: /اشتراكك موقوف لأن آخر دفعة ما مرت/ }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('link', { name: 'حدّث بطاقتك وكمّل' })).toHaveAttribute('href', '/billing');
  await page.keyboard.press('Escape');

  // The checkout entry sends this person on to /billing instead of rendering a dead end.
  await page.goto('/onboarding/trial');
  await expect(page).toHaveURL(/\/billing(\?|$)/, { timeout: 15_000 });
  await scenario('home');
});

test('a paused subscription says so and also goes to /billing', async ({ page, baseURL }) => {
  await scenario('paused');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByText('اشتراكك موقوف. فعّله من صفحة الاشتراك.').first()).toBeVisible();
  await expect(page.getByText('آخر دفعة ما مرت')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'فعّل اشتراكك' }).first()).toHaveAttribute('href', '/billing');
  await expect(page.locator('a[href="/onboarding/trial"]')).toHaveCount(0);
  await scenario('home');
});

test('when the chat route answers 402 the thread says the plan stopped, with the way forward and no retry', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.route('**/api/chat/start', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 402, contentType: 'application/json', body: JSON.stringify({ error: 'subscription_required' }) })
      : route.continue()
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await page.getByPlaceholder('اكتب لـمُضاعِف…').fill('وش وضع حسابي');
  await page.getByRole('button', { name: 'إرسال' }).click();
  await expect(page.getByText('اشتراكك واقف. فعّله أو حدّث بطاقتك عشان تكمل المحادثة.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'فعّل اشتراكك' })).toHaveAttribute('href', '/billing');
  await expect(page.getByText('صار خلل عندنا')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /أعد المحاولة/ })).toHaveCount(0);
  await noSidewaysOverflow(page);
});

test('when the chat route answers 403 account_suspended the thread shows the suspension and no button', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  const message = 'حسابك موقوف مؤقتاً، ولن تُنفذ أي عملية عليه حتى يُعاد تفعيله. تواصل معنا على واتساب 0554235720.';
  await page.route('**/api/chat/start', (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'account_suspended', message }) })
      : route.continue()
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await page.getByPlaceholder('اكتب لـمُضاعِف…').fill('وش وضع حسابي');
  await page.getByRole('button', { name: 'إرسال' }).click();
  await expect(page.getByText(message)).toBeVisible();
  await expect(page.getByRole('link', { name: 'فعّل اشتراكك' })).toHaveCount(0);
  await expect(page.getByText('صار خلل عندنا')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /أعد المحاولة/ })).toHaveCount(0);
});

test('if the plan really ended while /home was open, the next message ends on the paywall', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await expect(page.getByPlaceholder('اكتب لـمُضاعِف…')).toBeVisible();
  // The trial ends behind the open page.
  await scenario('unpaid_home');
  await page.getByPlaceholder('اكتب لـمُضاعِف…').fill('وش وضع حسابي');
  await page.getByRole('button', { name: 'إرسال' }).click();
  // The refresh re-reads the page, which is now «خطتك جاهزة» with its CTA.
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toBeVisible();
  await scenario('home');
});

test('/audit without a plan is the same lock as /home: one decision open, the rest titles, no reasons or narrative anywhere', async ({ page, baseURL }) => {
  await scenario('unpaid_audit');
  await signIn(page, baseURL);
  const errors = watchConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/audit');
  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible();
  await expect(plan.getByText(FIRST_DECISION)).toBeVisible();
  await expect(plan.getByText('العبارة جابت 96 ضغطة في 30 يوم', { exact: false })).toBeVisible();
  await expect(plan.getByRole('listitem')).toHaveCount(LOCKED_TITLES.length);
  for (const title of LOCKED_TITLES) await expect(plan.getByText(title)).toBeVisible();
  const cta = page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' });
  await expect(cta).toHaveAttribute('href', '/onboarding/trial');
  // The full page's pieces are gone.
  await expect(page.getByText('ليش هذا مهم؟')).toHaveCount(0);
  await expect(page.getByText('عرض دليل الحساب والتفاصيل الفنية')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /تجهيز/ })).toHaveCount(0);
  await expect(page.getByText('خطة التحسين')).toHaveCount(0);
  for (const secret of LOCKED_SECRETS) await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  await noSidewaysOverflow(page);

  // Not only hidden: the secrets are not in the page the server sent at all.
  const html = await (await page.request.get('/audit')).text();
  for (const secret of LOCKED_SECRETS) expect(html.includes(secret), secret).toBe(false);
  expect(html.includes('412'), 'the first decision is open').toBe(true);
  expect(errors).toEqual([]);
  await scenario('home');
});

test('/optimizer without a plan locks the recommendations but keeps the execution log and its undo', async ({ page, baseURL }) => {
  await scenario('undo_unpaid');
  await signIn(page, baseURL);
  const errors = watchConsoleErrors(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/optimizer');
  const plan = page.getByRole('region', { name: 'خطتك جاهزة' });
  await expect(plan).toBeVisible();
  await expect(plan.getByText(FIRST_DECISION)).toBeVisible();
  for (const title of LOCKED_TITLES) await expect(plan.getByText(title)).toBeVisible();
  await expect(page.getByRole('link', { name: 'ابدأ 14 يوم مجاناً' })).toHaveAttribute('href', '/onboarding/trial');
  await expect(page.getByRole('button', { name: /^(اعتماد|تنفيذ|تجاهل)$/ })).toHaveCount(0);
  await expect(page.getByText('التعديل الفعلي عند التنفيذ')).toHaveCount(0);
  for (const secret of LOCKED_SECRETS) await expect(page.getByText(secret, { exact: false })).toHaveCount(0);
  // Undoing is never behind the paywall: the log and its button are still there.
  const log = page.locator('#execution-log');
  await expect(log).toContainText(UNDO_FIRST);
  // (The fake backend ignores the account filter, so it also hands back the other account's row.)
  await expect(log.getByRole('button', { name: 'التراجع عن التنفيذ' }).first()).toBeVisible();
  await noSidewaysOverflow(page);

  const html = await (await page.request.get('/optimizer')).text();
  for (const secret of LOCKED_SECRETS) expect(html.includes(secret), secret).toBe(false);
  expect(errors).toEqual([]);
  await scenario('home');
});

test('with a plan /audit and /optimizer are unchanged: the reasons and the actions are there', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/optimizer');
  await expect(page.getByRole('region', { name: 'خطتك جاهزة' })).toHaveCount(0);
  await expect(page.getByText('العبارة جابت 96 ضغطة في 30 يوم', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'اعتماد' }).first()).toBeVisible();
});
