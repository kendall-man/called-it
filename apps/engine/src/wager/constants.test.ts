import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { depositCursorStream, WAGER_KEYS, WAGER_TUNABLES } from './constants.js';
import { WAGER_COPY } from './copy.js';

// apps/engine/src/wager → repo root → packages/db/migrations
const MIGRATION_0002_PATH = fileURLToPath(
  new URL('../../../../packages/db/migrations/0002_wager.sql', import.meta.url),
);

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

  it('every cap fits comfortably inside Number.MAX_SAFE_INTEGER', () => {
    // PostgREST returns bigint columns as JS numbers; the design holds only
    // under 2^53 — a future cap bump past that must fail THIS test first.
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    expect(WAGER_TUNABLES.MAX_MARKET_LIABILITY_LAMPORTS < safe).toBe(true);
    expect(WAGER_TUNABLES.FLOAT_TARGET_LAMPORTS < safe).toBe(true);
  });

  it('cursor stream names are treasury-scoped', () => {
    expect(depositCursorStream('Abc')).toBe('wager:deposits:Abc');
    expect(depositCursorStream('Abc')).not.toBe(depositCursorStream('Xyz'));
  });

  it('idempotency keys are namespaced and mutually distinct', () => {
    const keys = [
      WAGER_KEYS.stake('x'),
      WAGER_KEYS.deposit('x', 0),
      WAGER_KEYS.refund('x'),
      WAGER_KEYS.payout('x', 1),
      WAGER_KEYS.withdrawal('x'),
      WAGER_KEYS.withdrawalRefund('x'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key.startsWith('wager:')).toBe(true);
  });
});

describe('MULT_SCALE parity with migration 0002', () => {
  // The db slice lands 0002_wager.sql in parallel; until it exists there is
  // nothing to compare against. Once present this test pins JS and SQL to the
  // same fixed-point scale forever.
  it.skipIf(!existsSync(MIGRATION_0002_PATH))(
    'the wager_stake SQL uses the same milli scale as settlement.ts',
    () => {
      const sql = readFileSync(MIGRATION_0002_PATH, 'utf8');
      expect(sql).toContain('wager_stake');
      expect(sql).toMatch(/mult_milli/);
      const scale = String(WAGER_TUNABLES.MULT_SCALE);
      // round(multiplier * 1000) and floor(stake * mult_milli / 1000)
      expect(sql).toMatch(new RegExp(`\\*\\s*${scale}(?![0-9])`));
      expect(sql).toMatch(new RegExp(`/\\s*${scale}(?![0-9])`));
    },
  );
});

describe('copy bank hygiene', () => {
  it('every line renders non-empty with no leftover placeholders', () => {
    const samples: string[] = [
      WAGER_COPY.unlinkedOnboarding(),
      WAGER_COPY.paused(),
      WAGER_COPY.insufficient(1n),
      WAGER_COPY.pickALane(),
      WAGER_COPY.capReached(1n),
      WAGER_COPY.fullyLoaded(),
      WAGER_COPY.stakePlaced('A', 'Backing', 1n, '2'),
      WAGER_COPY.staleTap(),
      WAGER_COPY.walletUsage(),
      WAGER_COPY.walletInvalid(),
      WAGER_COPY.walletPubkeyTaken(),
      WAGER_COPY.walletLinked('Pub', { creditedCount: 1, creditedLamports: 1n }, true),
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
      WAGER_COPY.wagerModeEnabled(),
      WAGER_COPY.wagerModeDisabled(),
      WAGER_COPY.cardFooter(),
      WAGER_COPY.payoutsLineVoid(),
      WAGER_COPY.payoutsLineNone(),
      WAGER_COPY.payoutsLine([WAGER_COPY.payoutPart('A', 1n)]),
      WAGER_COPY.opsSolvencyAlert(1n, 2n, 'note'),
      WAGER_COPY.opsAirdropRequested(1n),
      WAGER_COPY.opsAirdropFailed('err'),
      WAGER_COPY.opsSolvencyRecovered(),
    ];
    for (const line of samples) {
      expect(line.trim().length).toBeGreaterThan(0);
      expect(line).not.toMatch(/\$\{|\{\w+\}/); // no unrendered templates
    }
  });

  it('the deposit explainer carries the devnet-only warning and the treasury address', () => {
    const line = WAGER_COPY.depositInstructions('TreasuryAddr', true);
    expect(line).toContain('TreasuryAddr');
    expect(line).toContain('DEVNET ONLY');
    expect(line).toContain('mainnet');
  });

  it('value-moving lines are stamped (devnet)', () => {
    expect(WAGER_COPY.depositCredited('A', 1n, 2n)).toContain('(devnet)');
    expect(WAGER_COPY.withdrawConfirmed('A', 1n, 'u')).toContain('(devnet)');
    expect(WAGER_COPY.payoutsLineVoid()).toContain('(devnet)');
    expect(WAGER_COPY.payoutsLineNone()).toContain('(devnet)');
    expect(WAGER_COPY.payoutsLine(['x'])).toContain('(devnet)');
  });
});
