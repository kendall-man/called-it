import type { WagerAsset } from '@calledit/market-engine';

/**
 * Wager-mode tunables — every money number in one place, all lamports as
 * bigint. Timing tunables that shape market mechanics (PENDING_TAP_WINDOW_MS
 * etc.) are inherited from @calledit/market-engine and NOT duplicated here.
 */

export const WAGER_TUNABLES = {
  /** Stake preset buttons: 0.01 / 0.05 / 0.1 SOL. */
  PRESET_STAKES_LAMPORTS: [10_000_000n, 50_000_000n, 100_000_000n] as const,
  PRESET_STAKES_USDC_ATOMIC: [1_000_000n, 5_000_000n, 10_000_000n] as const,
  /** Per-user, per-market total stake ceiling (matches the largest preset). */
  PER_MARKET_STAKE_CAP_LAMPORTS: 100_000_000n,
  /** Transfers below this are stored but never credited (dust defense). */
  MIN_DEPOSIT_LAMPORTS: 1_000_000n,
  MIN_DEPOSIT_USDC_ATOMIC: 100_000n,
  MIN_WITHDRAWAL_LAMPORTS: 10_000_000n,
  MIN_WITHDRAWAL_USDC_ATOMIC: 1_000_000n,
  /**
   * Fixed-point scale for the peer-matched ratio: R_milli = round((1−p)/p ×
   * MULT_SCALE), all pot math floor-divided in bigint (see wager/pot.ts).
   */
  MULT_SCALE: 1000,
  /** Treasury headroom for network fees (withdrawal fees are house-absorbed). */
  FEE_BUFFER_LAMPORTS: 50_000_000n,
  DEPOSIT_POLL_MS: 30_000,
  OUTBOX_TICK_MS: 15_000,
  SOLVENCY_POLL_MS: 5 * 60_000,
  SETTLEMENT_SWEEP_MS: 60_000,
  DEPOSIT_COMMITMENT: 'finalized',
} as const;

/**
 * Two-step stake ladder (STAKE_LADDER_ENABLED). Ascending exact amounts on a
 * 1-2-5 series, each code being that many base rungs of 0.01 of the asset:
 * SOL rungs are 0.01 / 0.02 / 0.05 / 0.1. `amountCode` is the wire form shared
 * with apps/web's `p-<hex>-<b|d>-<code>` startapp param and the engine session
 * schema; it is base units of 0.01, never a preset index. 0.01 (code 1) is the
 * anchor rung — leftmost, "base stake" in copy — but never preselected.
 */
export const STAKE_LADDER_BASE_UNITS = [1, 2, 5, 10] as const;

export type StakeLadderCode = (typeof STAKE_LADDER_BASE_UNITS)[number];

/** 0.01 of the asset, in atomic units, per ladder code. */
const STAKE_LADDER_UNIT_ATOMIC: Record<WagerAsset, bigint> = {
  sol: 10_000_000n,
  usdc: 10_000n,
};

/** On-chain escrow devnet ceiling: a single position tops out at 0.05 SOL. */
export const ESCROW_MAX_STAKE_LAMPORTS = 50_000_000n;

/** SOL lamports for a ladder code (code base units of 0.01 SOL). */
export function ladderLamports(code: number): bigint {
  return BigInt(code) * STAKE_LADDER_UNIT_ATOMIC.sol;
}

/** Atomic amount for a ladder code in the given asset. */
export function ladderAtomic(asset: WagerAsset, code: number): bigint {
  return BigInt(code) * STAKE_LADDER_UNIT_ATOMIC[asset];
}

export interface StakeLadderRung {
  readonly code: StakeLadderCode;
  readonly atomic: bigint;
}

/**
 * The highest per-position atomic amount a ladder rung may reach for a custody
 * mode: escrow enforces the on-chain devnet cap (0.05 SOL), legacy allows the
 * per-market cap (0.1 SOL). USDC mirrors the SOL rung count via its own unit.
 */
export function stakeLadderMaxAtomic(
  asset: WagerAsset,
  custody: 'legacy' | 'escrow',
): bigint {
  const unit = STAKE_LADDER_UNIT_ATOMIC[asset];
  const solCap = custody === 'escrow'
    ? ESCROW_MAX_STAKE_LAMPORTS
    : WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS;
  // Express the SOL cap as a rung count, then scale into the asset's unit so a
  // USDC ladder keeps the same 3-or-4 rung shape.
  const codeCap = solCap / STAKE_LADDER_UNIT_ATOMIC.sol;
  return codeCap * unit;
}

/**
 * The value ladder for a market: ascending rungs filtered to the effective per
 * position cap. Escrow devnet keeps three rungs (0.01 / 0.02 / 0.05); legacy
 * keeps four (adds 0.1). The `_network` argument reserves room for a
 * network-specific cap without changing call sites.
 */
export function stakeLadder(
  asset: WagerAsset,
  custody: 'legacy' | 'escrow',
  _network: 'devnet' | 'mainnet-beta',
): readonly StakeLadderRung[] {
  const max = stakeLadderMaxAtomic(asset, custody);
  const rungs: StakeLadderRung[] = [];
  for (const code of STAKE_LADDER_BASE_UNITS) {
    const atomic = ladderAtomic(asset, code);
    if (atomic <= max) rungs.push({ code, atomic });
  }
  return rungs;
}

/** True when `code` is a rung offered for this market (guards forged taps). */
export function isLadderCodeAllowed(
  code: number,
  asset: WagerAsset,
  custody: 'legacy' | 'escrow',
  network: 'devnet' | 'mainnet-beta',
): boolean {
  return stakeLadder(asset, custody, network).some((rung) => rung.code === code);
}

export function presetStakes(asset: WagerAsset): readonly [bigint, bigint, bigint] {
  return asset === 'sol'
    ? WAGER_TUNABLES.PRESET_STAKES_LAMPORTS
    : WAGER_TUNABLES.PRESET_STAKES_USDC_ATOMIC;
}

export function perMarketStakeCap(asset: WagerAsset): bigint {
  return asset === 'sol'
    ? WAGER_TUNABLES.PER_MARKET_STAKE_CAP_LAMPORTS
    : WAGER_TUNABLES.PRESET_STAKES_USDC_ATOMIC[2];
}

export function minimumDeposit(asset: WagerAsset): bigint {
  return asset === 'sol'
    ? WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS
    : WAGER_TUNABLES.MIN_DEPOSIT_USDC_ATOMIC;
}

export function minimumWithdrawal(asset: WagerAsset): bigint {
  return asset === 'sol'
    ? WAGER_TUNABLES.MIN_WITHDRAWAL_LAMPORTS
    : WAGER_TUNABLES.MIN_WITHDRAWAL_USDC_ATOMIC;
}

/**
 * Ledger idempotency keys — single source so a key never drifts between the
 * writer and the crash-recovery sweeper that re-derives it. The stake key is
 * minted server-side by the wager_stake RPC; it is mirrored here so tests can
 * assert parity with migration 0002.
 */
export const WAGER_KEYS = {
  stake: (positionId: string) => `wager:stake:${positionId}`,
  starterGrant: (userId: number) => `wager:starter:${userId}`,
  /** Client-supplied idempotency key for API/concierge stakes (at-least-once). */
  apiStake: (key: string) => `wager:stake:api:${key}`,
  deposit: (txSig: string, ixIndex: number) => `wager:deposit:${txSig}:${ixIndex}`,
  refund: (positionId: string) => `wager:refund:${positionId}`,
  payout: (marketId: string, userId: number) => `wager:payout:${marketId}:${userId}`,
  withdrawal: (withdrawalId: string) => `wager:withdrawal:${withdrawalId}`,
  withdrawalRefund: (withdrawalId: string) => `wager:wrefund:${withdrawalId}`,
} as const;

/**
 * Deposit-watcher cursor stream name, scoped by treasury pubkey so rotating
 * the treasury restarts scanning from genesis instead of resuming a cursor
 * that belongs to the old address.
 */
export function depositCursorStream(treasuryPubkey: string, asset: WagerAsset = 'sol'): string {
  return `wager:deposits:${asset}:${treasuryPubkey}`;
}

/** Advisory-lock names for the singleton crons (rolling-deploy overlap guard). */
export const WAGER_CRON_LOCKS = {
  deposits: (asset: WagerAsset) => `wager:cron:deposits:${asset}`,
  outbox: 'wager:cron:outbox',
} as const;

/** Solvency-breaker reasons are prefixed so auto-recovery never clears a manual pause. */
export const SOLVENCY_PAUSE_REASON_PREFIX = 'solvency:';
