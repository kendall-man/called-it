import type { Page } from '@playwright/test';

const GUARD_FIXTURES = {
  'missing-accessible-name': '<button type="button"></button>',
  overflow: '<div style="width: calc(100vw + 1px); height: 1px">overflow</div>',
  overlap: [
    '<button type="button" style="position:fixed;left:0;top:0">First</button>',
    '<button type="button" style="position:fixed;left:0;top:0">Second</button>',
  ].join(''),
  'console-error': '<script>console.error("browser guard fixture failure")</script>',
  unavailable: '<main><h1>Unavailable</h1></main>',
} as const;

export type GuardFixtureName = keyof typeof GUARD_FIXTURES;

export async function openGuardFixture(page: Page, name: GuardFixtureName): Promise<void> {
  const path = `/__e2e__/guards/${name}`;
  await page.route(`**${path}`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      status: name === 'unavailable' ? 503 : 200,
      body: `<!doctype html><html lang="en"><body>${GUARD_FIXTURES[name]}</body></html>`,
    }),
  );
  await page.goto(path);
}

export async function mockTelegramDestination(page: Page): Promise<void> {
  await page.route('https://t.me/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      status: 200,
      body: '<!doctype html><html lang="en"><body><main><h1>Mock Telegram destination</h1></main></body></html>',
    }),
  );
}
