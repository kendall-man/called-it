import { expect, test } from '@playwright/test';
import {
  assertInteractiveElementsHaveNames,
  assertNoConsoleOrPageErrors,
  assertNoHorizontalOverflow,
  assertNoNonSuccessResponses,
  assertNoOverlappingControls,
  collectRuntimeFailures,
} from './support/browser-guards';
import { openGuardFixture } from './support/fixture-routes';

test.describe('browser guard fixtures', () => {
  test('Given a nameless control fixture when the name guard runs then it fails', async ({ page }) => {
    await openGuardFixture(page, 'missing-accessible-name');
    await expect(assertInteractiveElementsHaveNames(page)).rejects.toThrow(/accessible name/i);
  });

  test('Given an overflowing fixture when the overflow guard runs then it fails', async ({ page }) => {
    await openGuardFixture(page, 'overflow');
    await expect(assertNoHorizontalOverflow(page)).rejects.toThrow(/horizontal overflow/i);
  });

  test('Given overlapping controls when the overlap guard runs then it fails', async ({ page }) => {
    await openGuardFixture(page, 'overlap');
    await expect(assertNoOverlappingControls(page)).rejects.toThrow(/overlapping interactive controls/i);
  });

  test('Given a console error fixture when runtime guards run then they fail', async ({ page }) => {
    const runtimeFailures = collectRuntimeFailures(page);
    await openGuardFixture(page, 'console-error');
    await expect(assertNoConsoleOrPageErrors(runtimeFailures)).rejects.toThrow(/browser console errors/i);
  });

  test('Given an unavailable fixture when runtime guards run then they fail', async ({ page }) => {
    const runtimeFailures = collectRuntimeFailures(page);
    await openGuardFixture(page, 'unavailable');
    await expect(assertNoNonSuccessResponses(runtimeFailures)).rejects.toThrow(/non-2xx application resources/i);
  });
});
