import { expect, test } from '@playwright/test';

const publicPages = [
  { path: '/', heading: /مضاعف|إعلانات Google/i },
  { path: '/login', heading: 'تسجيل الدخول' },
  { path: '/privacy', heading: /الخصوصية/ },
  { path: '/terms', heading: /شروط/ },
  { path: '/data-deletion', heading: /حذف الحساب والبيانات/ },
];

test.describe('public launch surface', () => {
  for (const publicPage of publicPages) {
    test(`${publicPage.path} loads without browser errors`, async ({ page }) => {
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(message.text());
      });

      const response = await page.goto(publicPage.path, { waitUntil: 'domcontentloaded' });

      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { name: publicPage.heading }).first()).toBeVisible();
      // Allow deferred client work to surface runtime errors without relying
      // on networkidle, which can be held open by browser extensions or links.
      await page.waitForTimeout(250);
      expect(browserErrors).toEqual([]);
    });
  }

  test('landing page exposes a clear path to sign in', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/مُضاعِف|Modaafa/);
    await expect(page.getByRole('link', { name: 'تسجيل الدخول' }).first()).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: /ابدأ التجربة/ }).first()).toHaveAttribute('href', '/login');
  });

  test('theme choice persists after reload', async ({ page }) => {
    await page.goto('/');
    const html = page.locator('html');
    const isDark = await html.evaluate((element) => element.classList.contains('dark'));
    const targetLabel = isDark ? 'الوضع الفاتح' : 'الوضع الداكن';

    await page.getByRole('button', { name: targetLabel }).first().click();
    await expect(html).toHaveClass(isDark ? /^(?!.*\bdark\b).*$/ : /\bdark\b/);

    await page.reload();
    await expect(html).toHaveClass(isDark ? /^(?!.*\bdark\b).*$/ : /\bdark\b/);
  });

  test('viewport never overflows horizontally', async ({ page }) => {
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const dimensions = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
    }));

    expect(dimensions.documentWidth).toBeLessThanOrEqual(dimensions.viewportWidth + 1);
  });

  test('protected pages redirect anonymous visitors to login', async ({ page }) => {
    await page.goto('/dashboard');

    await expect(page).toHaveURL(/\/login\?(?:next=%2Fdashboard|error=missing_config)/);
    await expect(page.getByRole('heading', { name: 'تسجيل الدخول' })).toBeVisible();
  });

  test('document CSP uses a nonce and does not allow inline scripts', async ({ page }) => {
    const response = await page.goto('/');
    const csp = response?.headers()['content-security-policy'] ?? '';
    const scriptDirective = csp
      .split(';')
      .map((part) => part.trim())
      .find((part) => part.startsWith('script-src'));

    expect(scriptDirective).toContain("'nonce-");
    expect(scriptDirective).toContain("'strict-dynamic'");
    expect(scriptDirective).not.toContain("'unsafe-inline'");
  });

  test('launch metadata and brand assets are published', async ({ request }) => {
    const paths = [
      '/robots.txt',
      '/sitemap.xml',
      '/favicon.ico',
      '/favicon.svg',
      '/icon-192.png',
      '/icon-512.png',
      '/og-image.png',
      '/manifest.webmanifest',
    ];

    for (const path of paths) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be published`).toBe(200);
    }
  });
});
