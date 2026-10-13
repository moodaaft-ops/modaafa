import { expect, test, type Page } from '@playwright/test';

/**
 * The simple experience end to end: the setup chat with «زياد» and the home
 * screen, on a fake backend with synthetic data.
 *
 *   node tests/e2e/support/mock-supabase-simple.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   CHAT_FIRST_ENTRY=true SUPABASE_SERVICE_ROLE_KEY=service \
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

test('a new customer meets «زياد» and one connect button', async ({ page, baseURL }) => {
  await scenario('connect');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');
  await expect(page.getByText('أنا زياد', { exact: false })).toBeVisible({ timeout: 15_000 });
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

test('home leads with the day in words, today\'s decisions and the chat', async ({ page, baseURL }) => {
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
  await expect(page.getByPlaceholder('اكتب لـزياد…')).toBeVisible();
});

test('on a phone the chat waits behind one bar and opens full screen', async ({ page, baseURL }) => {
  await scenario('home');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/home');
  await noSidewaysOverflow(page);
  await pick(page, /اكتب لـزياد أو اسأله/);
  await expect(page.getByRole('button', { name: 'سكّر المحادثة' })).toBeVisible();
  await pick(page, 'سكّر المحادثة');
  await pick(page, 'القائمة');
  for (const item of ['الرئيسية', 'حملاتي', 'التقارير', 'الاشتراك', 'الإعدادات']) {
    await expect(page.getByRole('dialog').getByRole('link', { name: item })).toBeVisible();
  }
});
