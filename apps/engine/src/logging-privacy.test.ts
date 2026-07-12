import { readFileSync } from 'node:fs';
import type { RawClaimParse } from '@calledit/market-engine';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { LlmBudget } from './bot/budget.js';
import type { LogFields } from './log.js';
import { CALLER_ID, CALL_FIXTURES, GROUPS, NOW_MS } from './points/telegram-points-flow-fixtures.test-support.js';
import { createTelegramFlowRuntime, FlowLogger } from './points/telegram-points-flow-runtime.test-support.js';
import { telegramUser } from './points/telegram-points-flow-telegram.test-support.js';
import { offerClaim } from './pipeline/offer.js';
import { WAGER_TUNABLES } from './wager/constants.js';
import { makeFakeDeps } from './wager/fakes.js';
import { handleStakeTap } from './wager/stake.js';

const FIXTURE = CALL_FIXTURES[0];
const GROUP = GROUPS.find((candidate) => candidate.id === FIXTURE.groupId);
const WAGER_USER_ID = 77_001;
const WAGER_WALLET = 'PrivacyWallet1111111111111111111111111111111';
const STAKE_LAMPORTS = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0];
const MODEL_SUPPLIED_FIXTURE_ID = 918_273_645;
const CLAIMS_SOURCE = new URL('./pipeline/claims.ts', import.meta.url);

if (GROUP === undefined) throw new TypeError('Logging privacy test group is missing');

function expectEveryEventFields(log: FlowLogger, event: string, expected: LogFields | undefined): void {
  const entries = log.events.filter((candidate) => candidate.event === event);
  expect(entries, `Missing log event: ${event}`).not.toHaveLength(0);
  for (const entry of entries) expect(entry.fields).toEqual(expected);
}

function isClaimsParseLog(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const logger = node.expression.expression;
  const event = node.arguments[0];
  return node.expression.name.text === 'info' &&
    ts.isPropertyAccessExpression(logger) && logger.name.text === 'log' &&
    ts.isIdentifier(logger.expression) && logger.expression.text === 'deps' &&
    event !== undefined && ts.isStringLiteral(event) && event.text === 'parse';
}

function claimsParseLogFieldSets(): readonly (readonly string[])[] {
  const sourceFile = ts.createSourceFile(
    CLAIMS_SOURCE.pathname,
    readFileSync(CLAIMS_SOURCE, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const fieldSets: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (isClaimsParseLog(node)) {
      const fields = node.arguments[1];
      fieldSets.push(fields !== undefined && ts.isObjectLiteralExpression(fields)
        ? fields.properties.map((property) =>
          'name' in property && property.name !== undefined
            ? property.name.getText(sourceFile)
            : '<computed-field>').sort()
        : ['<non-literal-fields>']);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return fieldSets;
}

describe('informational logging privacy', () => {
  it('offer_claim retains claim diagnostics without Telegram identity', async () => {
    // Given a Telegram claim carrying raw chat, user, name, and username identity
    const runtime = createTelegramFlowRuntime();

    // When the offer is recorded
    await offerClaim(runtime.h, {
      chatId: GROUP.id,
      group: GROUP,
      text: FIXTURE.text,
      claimer: telegramUser(CALLER_ID, 'Private Caller', 'private_calls'),
      sourceMessageId: 701,
      confidence: 0.87,
      announce: false,
      consent: 'awaiting_confirm',
    });
    await runtime.queue.idle();

    // Then only stable, non-identity diagnostics are logged
    expectEveryEventFields(runtime.log, 'offer_claim', {
      claimId: expect.any(String),
      confidence: 0.87,
      consent: 'awaiting_confirm',
    });
  });

  it('market_minted retains market diagnostics without Telegram identity', async () => {
    // Given an explicit Telegram claim carrying raw chat, user, name, and username identity
    const runtime = createTelegramFlowRuntime();

    // When the claim is priced and minted
    await offerClaim(runtime.h, {
      chatId: GROUP.id,
      group: GROUP,
      text: FIXTURE.text,
      claimer: telegramUser(CALLER_ID, 'Private Caller', 'private_calls'),
      sourceMessageId: 702,
      confidence: 1,
      announce: true,
      consent: 'explicit',
    });
    await runtime.queue.idle();

    // Then only stable, non-identity diagnostics are logged
    expectEveryEventFields(runtime.log, 'market_minted', {
      marketId: expect.any(String),
      claimId: expect.any(String),
      fixtureId: FIXTURE.fixtureId,
      claimType: 'match_winner',
      status: 'open',
      isReplay: false,
    });
  });

  it('parse retains bounded provenance without a model-supplied fixture id or text', async () => {
    // Given a model parse containing an arbitrary numeric fixture reference and sensitive text
    const runtime = createTelegramFlowRuntime();
    const raw: RawClaimParse = {
      claimType: 'match_winner',
      fixtureId: MODEL_SUPPLIED_FIXTURE_ID,
      entityName: 'ENTITY_TEXT_SENTINEL_PRIVATE_NAME',
      entityKind: 'team',
      comparator: 'gte',
      threshold: 1,
      period: 'FT_90',
      unresolved: 'UNRESOLVED_TEXT_SENTINEL_PRIVATE_SECRET',
    };
    const h = {
      ...runtime.h,
      deps: {
        ...runtime.deps,
        agent: { ...runtime.deps.agent, parse: async () => raw },
      },
    };

    // When the claim is parsed
    await offerClaim(h, {
      chatId: GROUP.id,
      group: GROUP,
      text: FIXTURE.text,
      claimer: telegramUser(CALLER_ID, 'Private Caller', 'private_calls'),
      sourceMessageId: 704,
      confidence: 1,
      announce: false,
      consent: 'explicit',
    });

    // Then every parse event records only bounded categories and presence flags
    expectEveryEventFields(runtime.log, 'parse', {
      claimId: expect.any(String),
      hasFixtureId: true,
      claimType: 'match_winner',
      entityKind: 'team',
      comparator: 'gte',
      period: 'FT_90',
      hasEntityName: true,
      hasUnresolved: true,
    });
    expect(JSON.stringify(runtime.log.events.filter((entry) => entry.event === 'parse')))
      .not.toContain(String(MODEL_SUPPLIED_FIXTURE_ID));
  });

  it('claims parse source limits pre-grounding log fields to bounded metadata', () => {
    // Given the production claims source
    // When its parse-event metadata is inspected through the TypeScript AST
    const fieldSets = claimsParseLogFieldSets();

    // Then the event has one literal field set with no numeric fixture value slot
    expect(fieldSets).toEqual([[
      'claimId', 'claimType', 'comparator', 'entityKind', 'hasEntityName', 'hasFixtureId', 'hasUnresolved', 'period',
    ].sort()]);
  });

  it('wager_position_placed retains position diagnostics without Telegram identity', async () => {
    // Given a funded Telegram user carrying raw group, user, and name identity
    const log = new FlowLogger();
    const { deps, db } = makeFakeDeps({ log });
    db.seedLink(WAGER_USER_ID, WAGER_WALLET);
    db.seedBalance(WAGER_USER_ID, 1_000_000_000n);

    // When the position is placed
    await handleStakeTap(deps, {
      market: {
        id: 'market-privacy',
        group_id: GROUP.id,
        status: 'open',
        quote_probability: 0.4,
        quote_multiplier: 2.2,
      },
      userId: WAGER_USER_ID,
      userName: 'Private Wagerer',
      side: 'back',
      lamports: STAKE_LAMPORTS,
      inPlay: false,
      nowMs: NOW_MS,
      source: { kind: 'durable_source', idempotencyKey: 'privacy-position' },
    });

    // Then only stable, non-identity diagnostics are logged
    expectEveryEventFields(log, 'wager_position_placed', {
      marketId: 'market-privacy',
      positionId: expect.any(String),
      side: 'back',
      lamports: STAKE_LAMPORTS.toString(),
      state: 'active',
    });
  });

  it('nearby budget exhaustion logging omits the Telegram group identity', async () => {
    // Given an explicit claim after its group budget is exhausted
    const runtime = createTelegramFlowRuntime();
    const h = { ...runtime.h, budget: new LlmBudget(0, () => NOW_MS) };

    // When the claim is rejected before parsing
    await offerClaim(h, {
      chatId: GROUP.id,
      group: GROUP,
      text: FIXTURE.text,
      claimer: telegramUser(CALLER_ID, 'Private Caller', 'private_calls'),
      sourceMessageId: 703,
      confidence: 1,
      announce: false,
      consent: 'explicit',
    });

    // Then the event itself is sufficient and no identity fields are attached
    expectEveryEventFields(runtime.log, 'llm_budget_exhausted', undefined);
  });

  it('nearby wager refusal logging omits the Telegram user identity', async () => {
    // Given a linked Telegram user whose stake is refused
    const log = new FlowLogger();
    const { deps, db } = makeFakeDeps({ log });
    db.seedLink(WAGER_USER_ID, WAGER_WALLET);
    db.stakeResult = { ok: false, code: 'closed' };

    // When the stake is attempted
    await handleStakeTap(deps, {
      market: {
        id: 'market-refused',
        group_id: GROUP.id,
        status: 'open',
        quote_probability: 0.4,
        quote_multiplier: 2.2,
      },
      userId: WAGER_USER_ID,
      userName: 'Private Wagerer',
      side: 'doubt',
      lamports: STAKE_LAMPORTS,
      inPlay: false,
      nowMs: NOW_MS,
      source: { kind: 'durable_source', idempotencyKey: 'privacy-refusal' },
    });

    // Then only stable, non-identity diagnostics are logged
    expectEveryEventFields(log, 'wager_stake_refused', {
      marketId: 'market-refused',
      side: 'doubt',
      lamports: STAKE_LAMPORTS.toString(),
      code: 'closed',
    });
  });

  it('nearby duplicate logging omits the Telegram user identity', async () => {
    // Given a funded Telegram user whose durable stake already landed
    const log = new FlowLogger();
    const { deps, db } = makeFakeDeps({ log });
    db.seedLink(WAGER_USER_ID, WAGER_WALLET);
    db.seedBalance(WAGER_USER_ID, 1_000_000_000n);
    const args = {
      market: {
        id: 'market-duplicate',
        group_id: GROUP.id,
        status: 'open' as const,
        quote_probability: 0.4,
        quote_multiplier: 2.2,
      },
      userId: WAGER_USER_ID,
      userName: 'Private Wagerer',
      side: 'back' as const,
      lamports: STAKE_LAMPORTS,
      inPlay: false,
      nowMs: NOW_MS,
      source: { kind: 'durable_source' as const, idempotencyKey: 'privacy-duplicate' },
    };
    await handleStakeTap(deps, args);

    // When the durable stake is replayed
    await handleStakeTap(deps, args);

    // Then only stable, non-identity diagnostics are logged
    expectEveryEventFields(log, 'wager_stake_duplicate', {
      marketId: 'market-duplicate',
      side: 'back',
    });
  });
});
