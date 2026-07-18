import { describe, expect, it } from 'vitest';
import type { AgentModelClient } from './client.js';
import { violatesDenyList } from './denylist.js';
import { createGarnishBudget, persona } from './persona.js';
import {
  PERSONA_TEMPLATES,
  PERSONA_TEMPLATE_KEYS,
  renderTemplate,
  type PersonaVars,
} from './templates.js';
import { makeScriptedClient, makeTextClient } from './test-helpers.js';

/** Numeric-looking sample for count/amount-shaped vars, text otherwise. */
const NUMERIC_VAR_RE = /(multiplier|amount|balance|payout|pot|minute|backers|doubters)/i;

function sampleVarsFor(template: string): PersonaVars {
  const vars: PersonaVars = {};
  for (const match of template.matchAll(/\{([a-zA-Z0-9_]+)\}/g)) {
    const name = match[1];
    if (name === undefined) throw new Error('placeholder capture missing');
    vars[name] = NUMERIC_VAR_RE.test(name) ? 9 : 'the big screen';
  }
  return vars;
}

describe('template bank', () => {
  it('covers every required key with at least one variant', () => {
    for (const key of PERSONA_TEMPLATE_KEYS) {
      expect(PERSONA_TEMPLATES[key].length).toBeGreaterThanOrEqual(1);
    }
  });

  it.each(PERSONA_TEMPLATE_KEYS.map((k) => [k] as const))(
    'renders %s with all placeholders filled and deny-list clean',
    async (key) => {
      for (const variant of PERSONA_TEMPLATES[key]) {
        const vars = sampleVarsFor(variant);
        const rendered = renderTemplate(variant, vars);
        expect(rendered.length).toBeGreaterThan(0);
        // No unresolved {placeholder} left behind.
        expect(rendered).not.toMatch(/\{[a-zA-Z0-9_]+\}/);
        // The vocabulary guard: sportsbook register never ships.
        expect(violatesDenyList(rendered)).toBeNull();
      }
      // persona() without a client is fully deterministic.
      const first = PERSONA_TEMPLATES[key][0];
      const vars = sampleVarsFor(first);
      const a = await persona(key, vars);
      const b = await persona(key, vars);
      expect(a).toBe(b);
    },
  );

  it('leaves unknown placeholders visible instead of blanking them', () => {
    expect(renderTemplate('hello {who}', {})).toBe('hello {who}');
  });

  it('keeps active fallback copy direct and SOL-only', () => {
    const renderedBank = PERSONA_TEMPLATE_KEYS.flatMap((key) => PERSONA_TEMPLATES[key]).join('\n');
    const intro = PERSONA_TEMPLATES.intro_disclosure.join('\n');
    const confirmation = PERSONA_TEMPLATES.confirm_gate.join('\n');

    expect(renderedBank).not.toMatch(/\bRep\b|\breplay\b|cash\s*out|\bstack\b|real devnet SOL/i);
    expect(intro).toMatch(/mention.*\/bookit/i);
    expect(intro).toContain('Runs on Solana devnet, these are test tokens.');
    expect(intro).not.toMatch(/no monetary value/i);
    expect(confirmation).toMatch(/confirm/i);
  });
});

describe('deny-list guard', () => {
  it.each([
    // Odds NOTATION stays banned (we speak in plain percentages).
    ['11/1 shot if you ask me', 'odds_fraction'],
    ['pays 9-to-1 tonight', 'odds_spoken'],
    ['that is 9 to 1 territory', 'odds_spoken'],
    ['in at @ 2.5', 'odds_at_price'],
    // FIAT currency stays banned (amounts are devnet SOL).
    ['loser sends $20', 'currency_symbol'],
    ['a tenner says... £10 on it', 'currency_symbol'],
    ['20 dollars on france', 'currency_word'],
  ] as const)('flags %j', (text, expectedName) => {
    expect(violatesDenyList(text)?.name).toBe(expectedName);
  });

  it.each([
    // Betting language is welcome now — the product owns it.
    'back it or bet against, your call',
    'stake 0.05 SOL and you are matched',
    'the odds are great', // the WORD "odds" is fine; only odds NOTATION is banned
    'calls locked — VAR is having a look',
    '0.05 SOL on the line at ×9',
    'the call lands, receipts for everyone',
    'kickoff at 18:00, morning slate coming',
  ])('passes clean broker copy: %j', (text) => {
    expect(violatesDenyList(text)).toBeNull();
  });
});

describe('persona garnish', () => {
  const vars: PersonaVars = { user: 'Dec', amount: 50, multiplier: 9 };

  function budgeted() {
    return createGarnishBudget(5);
  }

  it('uses a clean garnish when the model behaves', async () => {
    const client = makeTextClient('Dec is IN — 50 SOL riding at ×9. Locked and loud!');
    const out = await persona('back_ack', vars, { client, budget: budgeted() });
    expect(out).toBe('Dec is IN — 50 SOL riding at ×9. Locked and loud!');
  });

  it('falls back to the template when garnish trips the deny-list', async () => {
    const client = makeTextClient('Dec wagers 50 at 9-to-1! What odds!');
    const out = await persona('back_ack', vars, { client, budget: budgeted() });
    expect(violatesDenyList(out)).toBeNull();
    expect(out).toContain('Dec');
    expect(out).toContain('50');
  });

  it('falls back when garnish drops a number from the template', async () => {
    const client = makeTextClient('Dec backs it big time. Locked!');
    const out = await persona('back_ack', vars, { client, budget: budgeted() });
    // The template carries the stake amount; a garnish that drops it falls back.
    expect(out).toContain('50');
  });

  it('falls back when the model errors', async () => {
    const client: AgentModelClient = {
      messages: {
        async create() {
          throw new Error('api down');
        },
      },
    };
    const out = await persona('back_ack', vars, { client, budget: budgeted() });
    expect(out).toContain('Dec');
    expect(violatesDenyList(out)).toBeNull();
  });

  it('falls back when the model is too slow', async () => {
    const never: AgentModelClient = {
      messages: {
        create() {
          return new Promise(() => {
            /* hangs forever */
          });
        },
      },
    };
    const out = await persona('back_ack', vars, { client: never, budget: budgeted(), timeoutMs: 10 });
    expect(out).toContain('Dec');
  });

  it('falls back when the garnish is empty', async () => {
    const client = makeTextClient('   ');
    const out = await persona('back_ack', vars, { client, budget: budgeted() });
    expect(out).toContain('Dec');
  });

  it('hard-caps garnish generations via the budget', async () => {
    const client = makeScriptedClient([
      { content: [{ type: 'text', text: 'Dec is IN — 50 SOL at ×9!' }], stop_reason: 'end_turn' },
    ]);
    const budget = createGarnishBudget(1);
    await persona('back_ack', vars, { client, budget });
    await persona('back_ack', vars, { client, budget });
    await persona('back_ack', vars, { client, budget });
    expect(client.requests).toHaveLength(1);
    expect(budget.remaining()).toBe(0);
  });

  it('never calls the model without a budget (cap by construction)', async () => {
    const client = makeTextClient('should not be used');
    const out = await persona('back_ack', vars, { client });
    expect(client.requests).toHaveLength(0);
    expect(out).toContain('Dec');
  });

  it('respects garnish: false', async () => {
    const client = makeTextClient('should not be used');
    const out = await persona('back_ack', vars, { client, budget: budgeted(), garnish: false });
    expect(client.requests).toHaveLength(0);
    expect(out).toContain('Dec');
  });
});
