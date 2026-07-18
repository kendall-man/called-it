import { expect, test } from '@playwright/test';
import { assertNoSeriousAxeViolations } from './support/axe';
import {
  assertInteractiveElementsHaveNames,
  assertKeyboardFocusWorks,
  assertNoHorizontalOverflow,
  assertNoOverlappingControls,
  assertRuntimeIsClean,
  collectRuntimeFailures,
} from './support/browser-guards';
import { mockTelegramDestination } from './support/fixture-routes';

test.describe('landing page browser gate', () => {
  test('Given the production landing page when it renders then it is accessible and visually contained', async ({ page }, testInfo) => {
    const runtimeFailures = collectRuntimeFailures(page);

    const response = await page.goto('/');
    expect(response, 'landing document response').not.toBeNull();
    expect(response?.ok(), 'landing document response is successful').toBe(true);
    await expect(page.getByRole('heading', { level: 1, name: 'Rumble' })).toBeVisible();
    await expect(page).toHaveTitle(/Rumble/);

    await assertInteractiveElementsHaveNames(page);
    await assertNoHorizontalOverflow(page);
    await assertNoOverlappingControls(page);
    await assertNoSeriousAxeViolations(page);
    await assertRuntimeIsClean(runtimeFailures);
    const screenshotPath = testInfo.outputPath('landing.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach('landing-page', {
      path: screenshotPath,
      contentType: 'image/png',
    });
  });

  test('Given the production landing page when tabbing then every interactive control receives named focus', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.ok(), 'landing document response is successful').toBe(true);
    await assertKeyboardFocusWorks(page);
    await expect(
      page.evaluate(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches),
      'reduced motion media preference',
    ).resolves.toBe(true);
  });

  test('Given the Telegram group action when activated then navigation stays inside a browser mock', async ({ page }) => {
    await mockTelegramDestination(page);
    const response = await page.goto('/');
    expect(response?.ok(), 'landing document response is successful').toBe(true);

    const telegramAction = page.getByRole('link', { name: 'Add to Telegram group' });
    await expect(telegramAction).toHaveAttribute(
      'href',
      'https://t.me/calledit_test_bot?startgroup=calledit_v1&admin=manage_chat',
    );
    await telegramAction.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Mock Telegram destination' })).toBeVisible();
  });
});
