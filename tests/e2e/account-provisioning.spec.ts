import { expect, test, type Page } from '@playwright/test';

/**
 * «افتحه لي» end to end, on the fake backend. Google is never called: the stored
 * manager token in the fake backend is not a real one, so a press must end on the
 * quiet fallback, and nothing may be created.
 *
 *   node tests/e2e/support/mock-supabase-simple.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   ACCOUNT_PROVISIONING=true PROVISIONING_MCC_ID=1234567890 ADAPTIVE_ONBOARDING=true CHAT_FIRST_ENTRY=true SUPABASE_SERVICE_ROLE_KEY=service \
 *     VOICE_ASSISTANT_ENABLED=true VOICE_PROVIDER=mock VOICE_TICKET_SECRET=local-test-secret-0123456789abcdefghijklmnop \
 *     NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm start &
 *   MODAAFA_E2E_PROVISIONING=chat PLAYWRIGHT_BASE_URL=http://localhost:3000 pnpm exec playwright test account-provisioning --workers=1
 *
 * That is the chat screen: run it with MODAAFA_E2E_PROVISIONING=chat. The two older pages
 * (/onboarding/connect and /onboarding/ads-guide) only render when the chat-first entry is off,
 * so they need their own server: the same command without ADAPTIVE_ONBOARDING and CHAT_FIRST_ENTRY,
 * and MODAAFA_E2E_PROVISIONING=legacy.
 *
 * The flag-off screen (the WhatsApp tile first) is what adaptive-onboarding.spec.ts
 * already asserts, against a server started without these variables.
 * Skipped unless MODAAFA_E2E_PROVISIONING is chat or legacy.
 */

const MODE = process.env.MODAAFA_E2E_PROVISIONING;
const ON = MODE === 'chat' || MODE === 'legacy';
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
test.skip(!ON, 'needs the fake backend, the flag and a mode: see the comment at the top');

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

test('with the manager connected, «ما عندي حساب إعلانات» offers «افتحه لي» in place of the WhatsApp tile', async ({ page, baseURL }) => {
  test.skip(MODE !== 'chat', 'the chat screen only');
  await scenario('adaptive_no_account_provisioning');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  const noAccount = page.getByRole('button', { name: 'ما عندي حساب إعلانات' }).first();
  await expect(noAccount).toBeVisible({ timeout: 20_000 });
  await noAccount.click();

  await expect(page.getByRole('button', { name: 'افتحه لي الحين، مجاناً' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('link', { name: /افتحه معي على الواتساب/ })).toHaveCount(0);
  await expect(page.getByText('qa-tester@example.com')).toBeVisible();
  await noSidewaysOverflow(page);
});

test('a press that cannot reach Google ends on a plain line and the WhatsApp way out, with nothing stored as a request', async ({ page, baseURL }) => {
  test.skip(MODE !== 'chat', 'the chat screen only');
  await scenario('adaptive_no_account_provisioning');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/onboarding');

  await page.getByRole('button', { name: 'ما عندي حساب إعلانات' }).first().click();
  const open = page.getByRole('button', { name: 'افتحه لي الحين، مجاناً' });
  await expect(open).toBeVisible({ timeout: 15_000 });

  const response = page.waitForResponse((r) => r.url().endsWith('/api/ads-account/provision') && r.request().method() === 'POST');
  await open.click();
  const result = await response;
  const text = await result.text();
  expect([500, 503], `status ${result.status()} body ${text}`).toContain(result.status());
  expect(text).not.toMatch(/customer|token|refresh|1234567890/i);

  await expect(page.locator('p[role="alert"]')).toContainText('ما قدرنا نفتحه الحين');
  await expect(page.getByRole('link', { name: /الواتساب/ }).first()).toBeVisible();
  await expect(open).toBeEnabled();
  await noSidewaysOverflow(page);
});

test('the connect page and the guide show the same tile', async ({ page, baseURL }) => {
  test.skip(MODE !== 'legacy', 'the older pages only render with the chat-first entry off');
  await scenario('adaptive_no_account_provisioning');
  await signIn(page, baseURL);
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/onboarding/connect', '/onboarding/ads-guide']) {
    await page.goto(path);
    await expect(page.getByRole('button', { name: 'افتحه لي الحين، مجاناً' })).toBeVisible({ timeout: 20_000 });
    await noSidewaysOverflow(page);
  }
});
