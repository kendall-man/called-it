import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { depositCursorStream, WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { createWagerCopy, WAGER_COPY } from './copy.js';

describe('WAGER_TUNABLES internal consistency', () => {
  it('presets are three ascending lamport amounts', () => {
    const presets = WAGER_TUNABLES.PRESET_STAKES_LAMPORTS;
    expect(presets).toHaveLength(3);
    expect(presets[0] < presets[1] && presets[1] < presets[2]).toBe(true);
  });

  it('the per-market cap admits the largest preset', () => {
    expect(WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS >= WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[2]).toBe(true);
  });

  it('deposit minimum sits below the smallest preset (a min deposit can play)', () => {
    expect(WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS <= WAGER_TUNABLES.PRESET_STAKES_LAMPORTS[0]).toBe(true);
  });

  it('every lamport tunable fits comfortably inside Number.MAX_SAFE_INTEGER', () => {
    // PostgREST returns bigint columns as JS numbers; the design holds only
    // under 2^53 — a future bump past that must fail THIS test first.
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    expect(WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS < safe).toBe(true);
    expect(WAGER_TUNABLES.FEE_BUFFER_LAMPORTS < safe).toBe(true);
    expect(WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS < safe).toBe(true);
  });

  it('cursor stream names are treasury-scoped', () => {
    expect(depositCursorStream('Abc')).toBe('wager:deposits:sol:Abc');
    expect(depositCursorStream('Abc', 'usdc')).toBe('wager:deposits:usdc:Abc');
    expect(depositCursorStream('Abc')).not.toBe(depositCursorStream('Xyz'));
    expect(depositCursorStream('Abc')).not.toBe(depositCursorStream('Abc', 'usdc'));
  });

  it('idempotency keys are namespaced and mutually distinct', () => {
    const keys = [
      WAGER_KEYS.stake('x'),
      WAGER_KEYS.starterGrant(1),
      WAGER_KEYS.apiStake('x'),
      WAGER_KEYS.deposit('x', 0),
      WAGER_KEYS.refund('x'),
      WAGER_KEYS.payout('x', 1),
      WAGER_KEYS.withdrawal('x'),
      WAGER_KEYS.withdrawalRefund('x'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key.startsWith('wager:')).toBe(true);
  });

  it('the api-stake key matches the SQL ledger key namespace in migration 0003', () => {
    // wager_stake v2 writes 'wager:stake:api:' || p_idempotency_key.
    expect(WAGER_KEYS.apiStake('abc')).toBe('wager:stake:api:abc');
  });

  it('the starter-grant key matches the SQL ledger key namespace in migration 0004', async () => {
    const sql = await readFile('../../packages/db/migrations/0004_starter_grant.sql', 'utf8');
    expect(sql).toContain("'wager:starter:' || p_user_id::text");
    expect(WAGER_KEYS.starterGrant(123)).toBe('wager:starter:123');
  });
});

describe('copy bank hygiene', () => {
  it('every line renders non-empty and follows the direct SOL vocabulary', () => {
    const samples: string[] = [
      WAGER_COPY.unlinkedOnboarding(),
      WAGER_COPY.paused(),
      WAGER_COPY.marketClosed(),
      WAGER_COPY.starterUnavailable(),
      WAGER_COPY.budgetExhausted(),
      WAGER_COPY.walletRequired(),
      WAGER_COPY.insufficient(1n),
      WAGER_COPY.pickALane(),
      WAGER_COPY.capReached(1n),
      WAGER_COPY.stakePlaced('A', 'Backing', 1n, '2'),
      WAGER_COPY.stakeReplayed(),
      WAGER_COPY.staleTap(),
      WAGER_COPY.walletSetupUnavailable(),
      WAGER_COPY.walletStatus('Pub', 1n),
      WAGER_COPY.depositInstructions('Treasury', false),
      WAGER_COPY.depositCredited('A', 1n, 2n),
      WAGER_COPY.withdrawUsage(),
      WAGER_COPY.withdrawNoWallet(),
      WAGER_COPY.withdrawBelowMin(),
      WAGER_COPY.withdrawInsufficient(1n),
      WAGER_COPY.withdrawQueued(1n),
      WAGER_COPY.withdrawConfirmed('A', 1n, 'https://example.com'),
      WAGER_COPY.withdrawFailed('A', 1n),
      WAGER_COPY.payoutsLineVoid(),
      WAGER_COPY.payoutsLineNone(),
      WAGER_COPY.payoutsLine([WAGER_COPY.payoutPart('A', 1n)]),
      WAGER_COPY.opsSolvencyAlert(1n, 2n),
      WAGER_COPY.opsSolvencyRecovered(),
    ];
    const banned = [
      /\bRep\b/i,
      /\breplay\b/i,
      /\bcash\s*out\b/i,
      /\bstack\b/i,
      /\breal\s+(?:devnet\s+)?SOL\b/i,
    ];
    for (const line of samples) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).not.toMatch(/\$\{|\{\w+\}/); // no unrendered templates
      for (const pattern of banned) expect(line).not.toMatch(pattern);
    }
  });

  it('keeps the single devnet disclosure at wallet setup and off routine copy', () => {
    const onboarding = WAGER_COPY.unlinkedOnboarding();
    expect(onboarding).toMatch(/No SOL moved/i);
    expect(onboarding).not.toMatch(/\b(?:awarded|credited|funded|placed|recorded|success(?:ful)?)\b/i);
    // The one devnet disclosure lives at wallet setup; routine copy never
    // repeats value disclaimers (voice rule: honesty is not a nag).
    expect(WAGER_COPY.walletSetupReady()).toContain('Runs on Solana devnet — these are test tokens.');
    expect(WAGER_COPY.cardFooter()).toBe('');
    expect(WAGER_COPY.stakePlaced('A', 'Backing', 1n, '2')).not.toMatch(/monetary value|devnet/i);
    expect(onboarding).not.toMatch(/monetary value/i);
  });

  it('the deposit explainer carries the devnet-only warning and the treasury address', () => {
    const line = WAGER_COPY.depositInstructions('TreasuryAddr', true);
    expect(line).toContain('TreasuryAddr');
    expect(line).toContain('DEVNET ONLY');
    expect(line).toContain('mainnet');
  });

  it('devnet money lines carry no network stamp or repeated disclaimer', () => {
    const lines = [
      WAGER_COPY.depositCredited('A', 1n, 2n),
      WAGER_COPY.withdrawConfirmed('A', 1n, 'u'),
      WAGER_COPY.payoutsLineVoid(),
      WAGER_COPY.payoutsLineNone(),
      WAGER_COPY.payoutsLine(['x']),
    ];
    expect(lines.join('\n')).not.toMatch(/\(devnet\)|monetary value/i);
  });

  it('mainnet copy removes test-token language and stamps value movement', () => {
    const copy = createWagerCopy('mainnet-beta');
    const samples = [
      copy.unlinkedOnboarding(),
      copy.insufficient(1n),
      copy.stakePlaced('A', 'Backing', 1n, '2'),
      copy.walletStatus('Pub', 1n),
      copy.depositInstructions('TreasuryAddr', true),
      copy.depositCredited('A', 1n, 2n),
      copy.withdrawUsage(),
      copy.withdrawQueued(1n),
      copy.withdrawConfirmed('A', 1n, 'u'),
      copy.cardFooter(),
      copy.payoutsLineVoid(),
      copy.payoutsLineNone(),
      copy.payoutsLine(['x']),
      copy.opsSolvencyAlert(1n, 2n),
    ];
    expect(samples.join('\n')).not.toMatch(/devnet|test SOL|faucet/i);
    expect(copy.depositInstructions('TreasuryAddr', true)).toContain('MAINNET ONLY');
    expect(copy.withdrawConfirmed('A', 1n, 'u')).toContain('(mainnet)');
  });
});
