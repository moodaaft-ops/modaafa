import { expect, test, type Page } from '@playwright/test';

/**
 * The "install as an app" card inside the signed-in shell.
 *
 * Signed-in pages need the fake backend, same as mobile-layout.spec.ts:
 *   node tests/e2e/support/mock-supabase.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   MODAAFA_E2E_AUTH=1 pnpm exec playwright test install-prompt
 *
 * The browser's real beforeinstallprompt cannot be forced, and a test context
 * is an incognito profile where Chrome never raises it, so the Chromium cases
 * dispatch a stand-in event with the same shape. That the real browser raises
 * it for this site (manifest valid, worker active, no installability errors)
 * was checked separately against Chromium over the DevTools protocol.
 */

const SIGNED_IN = process.env.MODAAFA_E2E_AUTH === '1';
const CARD = { name: 'اقتراح تثبيت مُضاعِف كتطبيق' };
// The card waits a few seconds before it appears.
const APPEAR = { timeout: 15_000 };

const SESSION = JSON.stringify({
  access_token: 'a.b.c',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'qa-tester@example.com', aud: 'authenticated', role: 'authenticated' },
});

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPHONE_TIKTOK =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.1.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/ar Region/SA';
const MAC_SAFARI =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';

async function signIn(page: Page, baseURL: string) {
  await page.context().addCookies([
    { name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL },
    { name: 'modaafa_tour_seen', value: '1', url: baseURL },
  ]);
}

/** A stand-in for the event Chrome and Edge raise, fired after the page's own listener is in place. */
async function raiseInstallEvent(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __prompted?: boolean };
    window.addEventListener('load', () => {
      setTimeout(() => {
        const event = new Event('beforeinstallprompt', { cancelable: true });
        Object.assign(event, {
          prompt: async () => {
            w.__prompted = true;
          },
          userChoice: Promise.resolve({ outcome: 'accepted' }),
        });
        window.dispatchEvent(event);
      }, 300);
    });
  });
}

async function memory(page: Page) {
  return page.evaluate(() => localStorage.getItem('modaafa-install'));
}

test.describe('install card', () => {
  test.skip(!SIGNED_IN, 'set MODAAFA_E2E_AUTH=1 with the fake backend running');
  test.setTimeout(45_000);

  test.beforeEach(async ({ baseURL }, info) => {
    info.annotations.push({ type: 'base', description: baseURL ?? '' });
  });

  test.describe('iPhone Safari', () => {
    test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, hasTouch: true });

    test('shows the share-sheet steps, stays on screen, and keeps quiet for a month after "not now"', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.goto('/dashboard');
      const card = page.getByRole('complementary', CARD);
      await expect(card).toBeVisible(APPEAR);

      await card.getByRole('button', { name: 'وريني كيف' }).click();
      await expect(card.getByText('Add to Home Screen')).toBeVisible();

      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(390);
      expect(box.y + box.height).toBeLessThanOrEqual(844);

      await card.getByRole('button', { name: 'مو الحين' }).click();
      await expect(card).toBeHidden();
      expect(JSON.parse((await memory(page))!)).toMatchObject({ dismissedAt: expect.any(Number) });

      await page.reload();
      await page.waitForTimeout(8_000);
      await expect(page.getByRole('complementary', CARD)).toHaveCount(0);
    });

    test('"تم التثبيت" is remembered as installed', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.goto('/dashboard');
      const card = page.getByRole('complementary', CARD);
      await expect(card).toBeVisible(APPEAR);
      await card.getByRole('button', { name: 'وريني كيف' }).click();
      await card.getByRole('button', { name: 'تم التثبيت' }).click();
      await expect(card).toBeHidden();
      expect(JSON.parse((await memory(page))!)).toMatchObject({ installed: true });
    });

    test('an app already running from the Home Screen is not asked again', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'standalone', { value: true });
      });
      await page.goto('/dashboard');
      await page.waitForTimeout(8_000);
      await expect(page.getByRole('complementary', CARD)).toHaveCount(0);
    });
  });

  // The simple shell keeps its menu drawer in the page, marked aria-modal but
  // hidden. The card once waited on that drawer and never showed up there.
  //   CHAT_FIRST_ENTRY=true SUPABASE_SERVICE_ROLE_KEY=service pnpm start ... then MODAAFA_E2E_SIMPLE=1
  test.describe('simple shell', () => {
    test.skip(process.env.MODAAFA_E2E_SIMPLE !== '1', 'set MODAAFA_E2E_SIMPLE=1 with CHAT_FIRST_ENTRY=true');
    test.use({ userAgent: IPHONE_SAFARI, viewport: { width: 390, height: 844 }, hasTouch: true });

    test('the card appears on /home even though a closed drawer is marked as a dialog', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.goto('/home');
      await expect(page.getByRole('complementary', CARD)).toBeVisible(APPEAR);
    });

    test.describe('laptop widths', () => {
      test.use({ userAgent: undefined, viewport: { width: 1366, height: 768 }, hasTouch: false });

      test('the card never sits on the message box, where the send button is', async ({ page, baseURL }) => {
        await signIn(page, baseURL!);
        await raiseInstallEvent(page);
        await page.goto('/home');
        const card = page.getByRole('complementary', CARD);
        await expect(card).toBeVisible(APPEAR);
        const cardBox = (await card.boundingBox())!;
        // The message box: the nearest wide ancestor of the input.
        const composer = await page.locator('textarea, input[type="text"]').first().evaluate((el) => {
          let node: HTMLElement = el as HTMLElement;
          for (let i = 0; i < 4 && node.parentElement; i += 1) {
            if (node.getBoundingClientRect().width > 300) break;
            node = node.parentElement;
          }
          const r = node.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        });
        const overlapX = Math.min(cardBox.x + cardBox.width, composer.x + composer.w) - Math.max(cardBox.x, composer.x);
        const overlapY = Math.min(cardBox.y + cardBox.height, composer.y + composer.h) - Math.max(cardBox.y, composer.y);
        expect(overlapX > 0 && overlapY > 0, `card ${JSON.stringify(cardBox)} vs composer ${JSON.stringify(composer)}`).toBe(false);
      });
    });
  });

  test.describe('inside TikTok', () => {
    test.use({ userAgent: IPHONE_TIKTOK, viewport: { width: 390, height: 844 }, hasTouch: true });

    test('no card: an in-app browser cannot install anything', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.goto('/dashboard');
      await page.waitForTimeout(8_000);
      await expect(page.getByRole('complementary', CARD)).toHaveCount(0);
    });
  });

  test.describe('Safari on a Mac', () => {
    test.use({ userAgent: MAC_SAFARI, viewport: { width: 1440, height: 900 } });

    test('points to Add to Dock', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await page.goto('/dashboard');
      const card = page.getByRole('complementary', CARD);
      await expect(card).toBeVisible(APPEAR);
      await card.getByRole('button', { name: 'وريني كيف' }).click();
      await expect(card.getByText('Add to Dock')).toBeVisible();
    });
  });

  test.describe('Chrome and Edge', () => {
    test.use({ viewport: { width: 1440, height: 900 } });

    test('the install button calls the browser prompt and the card goes away', async ({ page, baseURL }) => {
      await signIn(page, baseURL!);
      await raiseInstallEvent(page);
      await page.goto('/dashboard');
      const card = page.getByRole('complementary', CARD);
      await expect(card).toBeVisible(APPEAR);

      // Desktop: lower corner on the side away from the sidebar (left in RTL),
      // lifted clear of the chat composer's row.
      const box = (await card.boundingBox())!;
      expect(box.x).toBeLessThan(100);
      expect(box.y + box.height).toBeGreaterThan(900 - 160);
      expect(box.y + box.height).toBeLessThanOrEqual(900 - 110);

      await card.getByRole('button', { name: 'ثبّته' }).click();
      await expect(card).toBeHidden();
      expect(await page.evaluate(() => (window as unknown as { __prompted?: boolean }).__prompted)).toBe(true);
      expect(JSON.parse((await memory(page))!)).toMatchObject({ installed: true });
    });

    test('on a phone-sized window the card sits under the top bar and inside the screen', async ({ page, baseURL }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await signIn(page, baseURL!);
      await raiseInstallEvent(page);
      await page.goto('/dashboard');
      const card = page.getByRole('complementary', CARD);
      await expect(card).toBeVisible(APPEAR);
      const box = (await card.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(360);
      expect(box.y).toBeGreaterThanOrEqual(56);
    });
  });
});
