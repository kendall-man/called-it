import { expect, type Page } from '@playwright/test';

const INTERACTIVE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([type="hidden"]):not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[role="button"]:not([aria-disabled="true"])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

type RuntimeFailures = {
  readonly consoleErrors: readonly string[];
  readonly pageErrors: readonly string[];
  readonly nonSuccessResponses: readonly string[];
};

type ControlBox = {
  readonly description: string;
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
};

function describeBox(box: ControlBox): string {
  return `${box.description} (${box.left},${box.top})-${box.right},${box.bottom}`;
}

function boxesOverlap(left: ControlBox, right: ControlBox): boolean {
  return (
    left.left < right.right &&
    left.right > right.left &&
    left.top < right.bottom &&
    left.bottom > right.top
  );
}

export function collectRuntimeFailures(page: Page): RuntimeFailures {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const nonSuccessResponses: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('response', (response) => {
    const request = response.request();
    if (response.status() >= 400 && request.resourceType() !== 'other') {
      nonSuccessResponses.push(`${response.status()} ${request.method()} ${response.url()}`);
    }
  });

  return { consoleErrors, pageErrors, nonSuccessResponses };
}

export async function assertRuntimeIsClean(failures: RuntimeFailures): Promise<void> {
  await assertNoConsoleOrPageErrors(failures);
  await assertNoNonSuccessResponses(failures);
}

export async function assertNoConsoleOrPageErrors(failures: RuntimeFailures): Promise<void> {
  expect(failures.consoleErrors, 'browser console errors').toEqual([]);
  expect(failures.pageErrors, 'uncaught page errors').toEqual([]);
}

export async function assertNoNonSuccessResponses(failures: RuntimeFailures): Promise<void> {
  expect(failures.nonSuccessResponses, 'non-2xx application resources').toEqual([]);
}

export async function assertInteractiveElementsHaveNames(page: Page): Promise<void> {
  const controls = page.locator(INTERACTIVE_SELECTOR);
  const count = await controls.count();
  expect(count, 'interactive controls').toBeGreaterThan(0);

  for (let index = 0; index < count; index += 1) {
    await expect(controls.nth(index), `interactive control ${index + 1} accessible name`).toHaveAccessibleName(
      /\S/,
    );
  }
}

export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    documentWidth: document.documentElement.scrollWidth,
    bodyWidth: document.body.scrollWidth,
  }));
  expect(
    Math.max(dimensions.documentWidth, dimensions.bodyWidth),
    `horizontal overflow at ${dimensions.viewport}px viewport`,
  ).toBeLessThanOrEqual(dimensions.viewport);
}

export async function assertNoOverlappingControls(page: Page): Promise<void> {
  const boxes = await page.locator(INTERACTIVE_SELECTOR).evaluateAll((controls) =>
    controls.flatMap((control) => {
      const style = window.getComputedStyle(control);
      const bounds = control.getBoundingClientRect();
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        Number.parseFloat(style.opacity) === 0 ||
        bounds.width === 0 ||
        bounds.height === 0
      ) {
        return [];
      }

      const label = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
      return [{
        description: `${control.tagName.toLowerCase()}[${label || 'unnamed'}]`,
        left: bounds.left,
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
      }];
    }),
  );

  const overlaps: string[] = [];
  for (let leftIndex = 0; leftIndex < boxes.length; leftIndex += 1) {
    const left = boxes[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < boxes.length; rightIndex += 1) {
      const right = boxes[rightIndex];
      if (right !== undefined && boxesOverlap(left, right)) {
        overlaps.push(`${describeBox(left)} overlaps ${describeBox(right)}`);
      }
    }
  }
  expect(overlaps, 'overlapping interactive controls').toEqual([]);
}

export async function assertKeyboardFocusWorks(page: Page): Promise<void> {
  const controls = page.locator(INTERACTIVE_SELECTOR);
  const count = await controls.count();
  expect(count, 'keyboard focusable controls').toBeGreaterThan(0);

  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  for (let index = 0; index < count; index += 1) {
    await page.keyboard.press('Tab');
    const focused = page.locator(':focus');
    await expect(focused, `tab stop ${index + 1}`).toBeVisible();
    await expect(focused, `tab stop ${index + 1} accessible name`).toHaveAccessibleName(/\S/);
  }
}
