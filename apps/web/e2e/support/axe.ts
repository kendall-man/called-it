import axeCore from 'axe-core';
import { expect, type Page } from '@playwright/test';

declare global {
  interface Window {
    readonly axe: typeof axeCore;
  }
}

type AxeGateViolation = {
  readonly id: string;
  readonly impact: string | null | undefined;
  readonly help: string;
  readonly targets: readonly string[];
};

export async function assertNoSeriousAxeViolations(page: Page): Promise<void> {
  await page.addScriptTag({ content: axeCore.source });
  const violations = await page.evaluate(async (): Promise<readonly AxeGateViolation[]> => {
    const results = await window.axe.run(document, { resultTypes: ['violations'] });
    return results.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        help: violation.help,
        targets: violation.nodes.map((node) => node.target.join(' ')),
      }));
  });

  expect(violations, 'axe serious or critical accessibility violations').toEqual([]);
}
