import { expect, test, type Page } from '@playwright/test';

/**
 * Mobile layout regression checks (task 03).
 *
 * The root <html> carries `overflow-x-hidden`, so `scrollWidth` can never reveal
 * sideways overflow. Every check here measures element bounds instead.
 *
 * Part 1 runs against the public pages as-is.
 * Part 2 needs signed-in pages. Start the fake backend and build the app against it:
 *   node tests/e2e/support/mock-supabase.mjs &
 *   NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321 NEXT_PUBLIC_SUPABASE_ANON_KEY=anon pnpm build
 *   MODAAFA_E2E_AUTH=1 pnpm exec playwright test mobile-layout
 * Without MODAAFA_E2E_AUTH the signed-in tests are skipped.
 */

const WIDTHS = [320, 360, 390, 430] as const;
const SIGNED_IN = process.env.MODAAFA_E2E_AUTH === '1';

const SESSION = JSON.stringify({
  access_token: 'a.b.c',
  refresh_token: 'r',
  token_type: 'bearer',
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 864000,
  user: { id: '11111111-1111-4111-8111-111111111111', email: 'qa-tester@example.com', aud: 'authenticated', role: 'authenticated' },
});

/** Elements whose box leaves the viewport sideways (ignores decorative/hidden/inner-scroller content). */
async function offscreen(page: Page) {
  return page.evaluate(() => {
    const vw = document.documentElement.clientWidth;
    const out: string[] = [];
    const drawer = document.getElementById('primary-navigation');
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (drawer?.contains(el)) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      if (el.closest('[aria-hidden="true"]') || el.closest('svg')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      let scroller = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (/(auto|scroll)/.test(pc.overflowX) && p.scrollWidth > p.clientWidth + 1) scroller = true;
      }
      if (scroller) continue;
      if (r.right > vw + 1 || r.left < -1) out.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(/\s+/)[0]} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    return out;
  });
}

test.describe('public pages never overflow sideways', () => {
  for (const width of WIDTHS) {
    for (const path of ['/', '/login', '/terms', '/privacy', '/refund', '/data-deletion']) {
      test(`${path} at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(300);
        expect(await offscreen(page)).toEqual([]);
      });
    }
  }

  test('landing footer links are comfortable touch targets', async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto('/');
    for (const name of ['الخصوصية', 'الشروط', 'الاسترداد', 'حذف البيانات', 'الدعم']) {
      const box = await page.locator('footer').getByRole('link', { name, exact: true }).boundingBox();
      expect(box, name).not.toBeNull();
      expect(box!.height, `${name} height`).toBeGreaterThanOrEqual(40);
    }
  });
});

test.describe('signed-in shell on phones', () => {
  test.skip(!SIGNED_IN, 'set MODAAFA_E2E_AUTH=1 with the fake backend running');

  test.beforeEach(async ({ context, baseURL }) => {
    await context.addCookies([{ name: 'sb-127-auth-token', value: encodeURIComponent(SESSION), url: baseURL! }]);
  });

  test('first-run tour card stays fully inside the screen', async ({ page }) => {
    for (const width of WIDTHS) {
      await page.context().clearCookies({ name: 'modaafa_tour_seen' });
      await page.setViewportSize({ width, height: 640 });
      await page.goto('/dashboard');
      const card = page.getByRole('dialog', { name: 'جولة تعريفية' }).locator('[tabindex="-1"]');
      await expect(card).toBeVisible();
      await page.waitForTimeout(400); // let the fade-in animation finish
      const box = (await card.boundingBox())!;
      expect(box.x, `left @${width}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `right @${width}`).toBeLessThanOrEqual(width);
      expect(box.y, `top @${width}`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `bottom @${width}`).toBeLessThanOrEqual(640);
    }
  });

  test.describe('after the tour is dismissed', () => {
    test.beforeEach(async ({ context, baseURL }) => {
      await context.addCookies([{ name: 'modaafa_tour_seen', value: '1', url: baseURL! }]);
    });

    test('closed drawer exposes no focusable controls', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto('/dashboard');
      const reachable = await page.evaluate(() => {
        const aside = document.getElementById('primary-navigation')!;
        return Array.from(aside.querySelectorAll<HTMLElement>('a,button,input,select,textarea')).filter(
          (e) => getComputedStyle(e).visibility !== 'hidden'
        ).length;
      });
      expect(reachable).toBe(0);

      await page.getByRole('button', { name: 'فتح القائمة' }).click();
      await expect(page.getByRole('link', { name: 'الإعدادات' })).toBeVisible();
    });

    test('campaign list shows spend and conversions without sideways scrolling', async ({ page }) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        await page.goto('/campaigns');
        const spend = page.locator('main li dt', { hasText: 'الصرف' }).first();
        await expect(spend).toBeVisible();
        const box = (await spend.boundingBox())!;
        expect(box.x + box.width, `spend label @${width}`).toBeLessThanOrEqual(width);
        expect(await offscreen(page)).toEqual([]);
      }
    });

    test('text fields are at least 16px so iOS does not zoom on focus', async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 });
      for (const path of ['/assistant', '/settings', '/autopilot']) {
        await page.goto(path);
        const small = await page.evaluate(() =>
          Array.from(document.querySelectorAll<HTMLElement>('input:not([type=hidden]):not([type=checkbox]):not([type=radio]),textarea,select'))
            .filter((e) => e.getBoundingClientRect().width > 0 && parseFloat(getComputedStyle(e).fontSize) < 16)
            .map((e) => e.tagName)
        );
        expect(small, path).toEqual([]);
      }
    });

    // The chat height is a calc() of the viewport, so short phones are where it breaks:
    // the composer must sit above the tab bar on first paint at 640 and 800 tall.
    for (const height of [640, 800]) {
      for (const width of WIDTHS) {
        test(`chat composer is visible above the tab bar without scrolling at ${width}x${height}`, async ({ page }) => {
          await page.setViewportSize({ width, height });
          await page.goto('/assistant');
          const input = page.getByLabel('رسالتك');
          await expect(input).toBeVisible();
          const tab = (await page.getByRole('navigation', { name: 'التنقل السريع' }).boundingBox())!;
          const box = (await input.boundingBox())!;
          expect(box.y + box.height).toBeLessThanOrEqual(tab.y);
        });
      }
    }

    test('signed-in pages never overflow sideways', async ({ page }) => {
      for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });
        for (const path of ['/dashboard', '/assistant', '/audit', '/optimizer', '/reports', '/campaigns', '/billing', '/settings', '/autopilot']) {
          await page.goto(path);
          await page.waitForTimeout(200);
          expect(await offscreen(page), `${path} @${width}`).toEqual([]);
        }
      }
    });
  });
});
