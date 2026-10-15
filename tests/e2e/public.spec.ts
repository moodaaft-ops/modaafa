import { expect, test } from '@playwright/test';

const publicPages = [
  { path: '/', heading: /قوقل|مُضاعِف|مضاعف|Google/i },
  { path: '/login', heading: 'تسجيل الدخول' },
  { path: '/register', heading: 'أنشئ حسابك' },
  { path: '/privacy', heading: /الخصوصية/ },
  { path: '/terms', heading: /شروط/ },
  { path: '/refund', heading: /الاسترجاع والاسترداد/ },
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

  // The two content pages exist for search engines and AI answer engines to
  // read, so their basics are asserted on the raw HTML, not the hydrated DOM:
  // one h1 and a JSON-LD block must be in the server response itself.
  for (const contentPath of ['/about', '/google-ads-audit']) {
    test(`${contentPath} is a crawlable content page`, async ({ page, request }) => {
      const response = await page.goto(contentPath, { waitUntil: 'domcontentloaded' });

      expect(response?.status()).toBe(200);
      await expect(page.locator('h1')).toHaveCount(1);
      expect(await page.locator('script[type="application/ld+json"]').count()).toBeGreaterThan(0);

      const html = await (await request.get(contentPath)).text();
      expect(html.match(/<h1[\s>]/g) ?? []).toHaveLength(1);
      expect(html).toContain('application/ld+json');
      // Metadata is rendered in <head> for every user agent, not streamed into <body>.
      expect(html.indexOf('<title>')).toBeGreaterThan(-1);
      expect(html.indexOf('<title>')).toBeLessThan(html.indexOf('</head>'));
    });
  }

  test('landing page exposes a clear path to sign in', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/مُضاعِف|Modaafa/);
    await expect(page.getByRole('link', { name: 'تسجيل الدخول' }).first()).toHaveAttribute('href', '/login');
    await expect(page.getByRole('link', { name: /افحص حسابك مجاناً/ }).first()).toHaveAttribute('href', '/register');
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
      '/og-image-v3.png',
      '/manifest.webmanifest',
    ];

    for (const path of paths) {
      const response = await request.get(path);
      expect(response.status(), `${path} should be published`).toBe(200);
    }
  });
});

test.describe('registration inside the TikTok app browser', () => {
  test.use({
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_40.1.0 JsSdk/2.0 ByteLocale/ar Region/SA',
  });

  test('offers to reopen the page in the phone browser, form still usable', async ({ page }) => {
    await page.goto('/register?utm_source=tiktok&ttclid=E.C.P.e2e123');
    await expect(page.getByText('فاتح من داخل تيك توك؟')).toBeVisible();
    await expect(page.getByRole('button', { name: 'انسخ الرابط' })).toBeVisible();
    await expect(page.getByRole('button', { name: /أرسل لي رابط التفعيل/ })).toBeVisible();
  });
});

test('registration in a normal browser shows no in-app notice', async ({ page }) => {
  await page.goto('/register');
  await expect(page.getByRole('heading', { name: 'أنشئ حسابك' })).toBeVisible();
  await expect(page.getByText('فاتح من داخل')).toHaveCount(0);
});
