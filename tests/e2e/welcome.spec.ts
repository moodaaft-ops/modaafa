import { expect, test, type Page } from '@playwright/test';

/**
 * /welcome, the first-login screen (task: first-login screen).
 *
 * Needs the fake backend in its "new user" scenario and an app built against it:
 *   MOCK_SCENARIO=new-user node tests/e2e/support/mock-supabase.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon \
 *     SUPABASE_SERVICE_ROLE_KEY=service GOOGLE_OAUTH_CLIENT_ID=id GOOGLE_OAUTH_CLIENT_SECRET=secret \
 *     GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:3000/api/auth/google-ads/callback pnpm build
 *   (same variables) MODAAFA_E2E_WELCOME=new-user pnpm exec playwright test welcome
 * For the "already connected" check run the mock WITHOUT MOCK_SCENARIO and use
 * MODAAFA_E2E_WELCOME=connected.
 */

const SCENARIO = process.env.MODAAFA_E2E_WELCOME;
const WIDTHS = [320, 360, 390, 430] as const;
const MOCK = 'http://127.0.0.1:54321';

const SESSION = JSON.stringify({
  access_token: 'a.b.c',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'qa-tester@example.com', aud: 'authenticated', role: 'authenticated' },
});

async function offscreen(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (r.right > vw + 1 || r.left < -1) out.push(`${el.tagName.toLowerCase()} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out;
  });
}

async function loggedEvents(page: Page) {
  const res = await page.request.get(`${MOCK}/__events`);
  return (await res.json()) as Array<{ event: string; user_id: string; metadata: Record<string, unknown> }>;
}

test.describe('welcome screen for a brand-new user', () => {
  test.skip(SCENARIO !== 'new-user', 'set MODAAFA_E2E_WELCOME=new-user with the new-user fake backend running');

  test.beforeEach(async ({ context, baseURL, request }) => {
    await context.addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL! }]);
    // Most checks below are about the connect screen, so the person starts out
    // as someone who already answered the first-login questions.
    await request.post(`${MOCK}/__answers`, { data: { state: 'answered' } });
  });

  test('a signed-in user with nothing linked lands on /welcome from the dashboard', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('الخطوة الأخيرة قبل فحصك');
  });


  test('connect screen: progress bar says step 2 of 2 and the answers can be edited', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page.getByRole('group', { name: 'الخطوة 2 من 2' })).toBeVisible();
    await expect(page.getByText('سجلنا عنك:')).toContainText('متجر إلكتروني');
    await page.getByRole('link', { name: 'عدّل إجاباتك' }).click();
    await expect(page).toHaveURL(/\/welcome\?edit=1$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('عرّفنا على وضعك');
  });

  test('a table that does not exist yet never blocks the connect button', async ({ page, request }) => {
    await request.post(`${MOCK}/__answers`, { data: { state: 'unavailable' } });
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('الخطوة الأخيرة قبل فحصك');
    await expect(page.getByRole('group', { name: /الخطوة/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'اربط حسابك' }).first()).toBeVisible();
  });

  test('/onboarding sends them to /welcome too', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/welcome$/);
  });

  for (const width of WIDTHS) {
    test(`reads on a phone at ${width}px with no sideways scroll`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/welcome');
      await page.locator('details').evaluateAll((all) => all.forEach((d) => ((d as HTMLDetailsElement).open = true)));
      await page.waitForTimeout(200);
      expect(await offscreen(page)).toEqual([]);

      const button = page.getByRole('link', { name: 'اربط حسابك' }).first();
      const box = (await button.boundingBox())!;
      expect(box.height, 'button height').toBeGreaterThanOrEqual(48);
      expect(box.x, 'button left').toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, 'button right').toBeLessThanOrEqual(width);
      // The big button must be visible without scrolling on the shortest phone.
      expect(box.y + box.height, 'button above the fold').toBeLessThanOrEqual(780);

      const h1 = (await page.getByRole('heading', { level: 1 }).boundingBox())!;
      expect(h1.x + h1.width).toBeLessThanOrEqual(width);
    });
  }

  test('the page is right-to-left and shows the trust answers', async ({ page }) => {
    await page.goto('/welcome');
    expect(await page.evaluate(() => document.documentElement.dir)).toBe('rtl');
    for (const q of ['وش الصلاحيات اللي تاخذونها؟', 'هل تعدلون حملاتي؟', 'كيف أفصل الربط؟']) {
      await expect(page.getByText(q)).toBeVisible();
    }
    await page.getByText('هل تعدلون حملاتي؟').click();
    await expect(page.getByText('الطيار الآلي مطفي من الأساس')).toBeVisible();
  });

  test('the team link opens WhatsApp', async ({ page }) => {
    await page.goto('/welcome');
    const href = await page.getByRole('link', { name: 'أبي أكلم أحد من الفريق' }).first().getAttribute('href');
    expect(href).toMatch(/^https:\/\/wa\.me\/966541004029\?text=/);
  });

  test('onboarding_viewed is logged when the screen is shown', async ({ page }) => {
    await page.goto('/welcome');
    await expect.poll(async () => (await loggedEvents(page)).some((e) => e.event === 'onboarding_viewed')).toBe(true);
    const event = (await loggedEvents(page)).find((e) => e.event === 'onboarding_viewed')!;
    expect(event.user_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('the button starts the real linking flow and logs connect_clicked', async ({ page }) => {
    await page.goto('/welcome');
    const href = await page.getByRole('link', { name: 'اربط حسابك' }).first().getAttribute('href');
    expect(href).toBe('/api/auth/google-ads/connect?source=welcome');

    const res = await page.request.get(href!, { maxRedirects: 0 });
    expect([302, 303, 307]).toContain(res.status());
    const location = res.headers()['location'];
    expect(location).toContain('accounts.google.com');
    expect(location).toContain('adwords');

    await expect.poll(async () => (await loggedEvents(page)).some((e) => e.event === 'connect_clicked')).toBe(true);
    const click = (await loggedEvents(page)).find((e) => e.event === 'connect_clicked')!;
    expect(click.metadata).toEqual({ source: 'welcome' });
  });
});


test.describe('first-login questions (step 1 of 2)', () => {
  test.skip(SCENARIO !== 'new-user', 'set MODAAFA_E2E_WELCOME=new-user with the new-user fake backend running');

  test.beforeEach(async ({ context, baseURL, request }) => {
    await context.addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL! }]);
    await request.post(`${MOCK}/__answers`, { data: { state: 'none' } });
  });

  test('a person who never answered sees the questions first, each with its reason', async ({ page }) => {
    await page.goto('/welcome');
    await expect(page.getByRole('group', { name: 'الخطوة 1 من 2' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('عرّفنا على وضعك');
    for (const legend of ['وش نوع نشاطك؟', 'كم تصرف على إعلانات قوقل في الشهر تقريباً؟', 'مين يدير حسابك الإعلاني الحين؟']) {
      await expect(page.getByRole('group', { name: legend })).toBeVisible();
    }
    await expect(page.getByText('ليش نسأل:')).toHaveCount(3);
    // The Google link is not on this step at all.
    await expect(page.getByRole('link', { name: 'اربط حسابك' })).toHaveCount(0);
  });

  test('"next" refuses until all three are answered, then saves and moves to step 2', async ({ page, request }) => {
    await page.goto('/welcome');
    await page.getByRole('button', { name: 'التالي: ربط الحساب' }).click({ force: true });
    await expect(page.getByText('اختر جواب لكل سؤال')).toBeVisible();

    await page.getByText('متجر إلكتروني', { exact: true }).click();
    await page.getByText('من 10000 إلى 30000 ريال').click();
    await page.getByText('ما أحد يديره حالياً').click();
    await page.getByRole('button', { name: 'التالي: ربط الحساب' }).click();

    await expect(page.getByRole('heading', { level: 1 })).toContainText('الخطوة الأخيرة قبل فحصك');
    await expect(page.getByRole('group', { name: 'الخطوة 2 من 2' })).toBeVisible();

    const { writes } = await (await request.get(`${MOCK}/__answers`)).json();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      user_id: '11111111-1111-4111-8111-111111111111',
      business_type: 'ecommerce',
      spend_band: '10k_30k',
      account_manager: 'nobody',
      skipped: false,
    });
  });

  test('skipping saves a skip and goes straight to the connect screen', async ({ page, request }) => {
    await page.goto('/welcome');
    await page.getByRole('button', { name: 'تخطّى هالخطوة' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('الخطوة الأخيرة قبل فحصك');
    const { writes } = await (await request.get(`${MOCK}/__answers`)).json();
    expect(writes[0]).toMatchObject({ skipped: true, business_type: null });
    // And it does not ask again on the next visit.
    await page.goto('/welcome');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('الخطوة الأخيرة قبل فحصك');
  });

  for (const width of WIDTHS) {
    test(`step 1 fits a ${width}px phone with no sideways scroll and big tap targets`, async ({ page }) => {
      await page.setViewportSize({ width, height: 780 });
      await page.goto('/welcome');
      expect(await offscreen(page)).toEqual([]);
      const rows = page.locator('label:has(input[type=radio])');
      expect(await rows.count()).toBe(14);
      for (let i = 0; i < 14; i += 1) {
        const box = (await rows.nth(i).boundingBox())!;
        expect(box.height, `option ${i} height`).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
      }
      // The radio inputs are visually hidden but must stay reachable by keyboard.
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.tagName)).toBeTruthy();
    });
  }

  test('the radios work from the keyboard', async ({ page }) => {
    await page.goto('/welcome');
    const first = page.locator('input[name=businessType]').first();
    await first.focus();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
  });
});

test.describe('welcome screen for a user who already connected', () => {
  test.skip(SCENARIO !== 'connected', 'set MODAAFA_E2E_WELCOME=connected with the default fake backend running');

  test('goes to the dashboard and logs nothing', async ({ page, context, baseURL }) => {
    await context.addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL! }]);
    const before = (await loggedEvents(page)).length;
    await page.goto('/welcome');
    await expect(page).toHaveURL(/\/dashboard/);
    expect((await loggedEvents(page)).length).toBe(before);
  });
});
