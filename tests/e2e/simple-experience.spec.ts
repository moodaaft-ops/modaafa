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
  await expect(page.getByRole('link', { name: /أول 14 يوم مجاناً/ })).toBeVisible({ timeout: 20_000 });
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
