/**
 * Types for the wager façade (wager mode, devnet SOL), mirroring
 * packages/db/migrations/0002_wager.sql — and structurally matched by the
 * engine's consumer port in apps/engine/src/wager/port.ts, so the wiring
 * adapter is a pass-through.
 *
 * Same conventions as types.ts (snake_case columns, timestamptz as ISO-8601
 * strings) with one deliberate difference: lamports cross the façade as
 * BIGINT. PostgREST serializes bigint columns as JS numbers, so wager-db.ts
 * owns the number↔bigint conversion and guards every crossing with a
 * Number.isSafeInteger assert — precision loss must fail loud, never corrupt
 * a balance.
 */

import type { PositionSide } from '@calledit/market-engine';
import type { PositionState } from './types.js';

// ── Enumerations backed by CHECK constraints in migration 0002 ─────────────

export type WagerLedgerKind =
  | 'deposit'
  | 'stake'
  | 'payout'
  | 'refund'
  | 'withdrawal'
  | 'withdrawal_refund';

export type WagerWithdrawalState = 'debited' | 'submitted' | 'confirmed' | 'failed';

/** Typed rejection codes returned by the wager_stake RPC. */
export type WagerStakeErrorCode = 'insufficient' | 'wrong_side' | 'cap' | 'paused';

/** Typed rejection codes returned by the wager_request_withdrawal RPC. */
export type WagerWithdrawErrorCode = 'no_wallet' | 'insufficient';

// ── Table rows (as surfaced by the façade: lamports already bigint) ────────

export interface WagerGroupRow {
  group_id: number;
  enabled: boolean;
  /** Admin who last toggled wager mode for this group. */
  enabled_by: number;
  updated_at: string;
}

export interface WagerWalletLinkRow {
  user_id: number;
  pubkey: string;
  /** Notification routing only (deposit-credited group post) — never fund routing. */
  last_wager_group_id: number | null;
  /** Set when the first deposit from this pubkey is credited. */
  verified_at: string | null;
  created_at: string;
}

export interface WagerLedgerRow {
  id: number;
  user_id: number;
  group_id: number | null;
  market_id: string | null;
  kind: WagerLedgerKind;
  /** Signed lamports delta; balance is user-global (sum by user_id). */
  lamports: bigint;
  idempotency_key: string;
  created_at: string;
}

export interface WagerDepositRow {
  id: number;
  tx_sig: string;
  /** Instruction index — one tx can carry several transfers to the treasury. */
  ix_index: number;
  sender_pubkey: string;
  lamports: bigint;
  slot: number;
  /** null = orphan: sender pubkey was not linked when the deposit landed. */
  user_id: number | null;
  /** null = not yet posted to the ledger. */
  credited_at: string | null;
  observed_at: string;
}

export interface WagerWithdrawalRow {
  id: string;
  user_id: number;
  /** Copied from the wallet link inside the RPC — never caller-supplied. */
  dest_pubkey: string;
  lamports: bigint;
  state: WagerWithdrawalState;
  /** Deterministic signature, persisted BEFORE broadcast. */
  tx_sig: string | null;
  /** Signed transaction bytes, persisted BEFORE broadcast. */
  raw_tx_b64: string | null;
  last_valid_block_height: number | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface WagerSettlementAppliedRow {
  market_id: string;
  applied_at: string;
}

export interface WagerStatusRow {
  /** Persisted circuit breaker: blocks NEW stakes only, never payouts/withdrawals. */
  paused: boolean;
  reason: string | null;
  updated_at: string;
}

// ── Write inputs (subsets of rows the engine supplies; DB fills defaults) ──

export interface WagerLedgerEntry {
  user_id: number;
  group_id: number | null;
  market_id: string | null;
  kind: WagerLedgerKind;
  /** Signed lamports delta. */
  lamports: bigint;
  idempotency_key: string;
}

/** Deposits are always recorded as observed; attribution happens via markDepositCredited. */
export interface WagerDepositInsert {
  tx_sig: string;
  ix_index: number;
  sender_pubkey: string;
  lamports: bigint;
  slot: number;
}

export interface WagerWalletLinkInsert {
  user_id: number;
  pubkey: string;
  /** Optional so callers may set routing later via setLastWagerGroup. */
  last_wager_group_id?: number | null;
}

export type WalletLinkResult =
  /** relinked=true when the user replaced an earlier link of their own. */
  | { ok: true; relinked: boolean }
  /** First-link-wins: the pubkey is already claimed by another user. */
  | { ok: false; reason: 'pubkey_taken' };

// ── RPC inputs / results ───────────────────────────────────────────────────

export interface WagerStakeInput {
  user_id: number;
  group_id: number;
  market_id: string;
  side: PositionSide;
  lamports: bigint;
  /** Locked multiplier, stored on the position for display. */
  multiplier: number;
  state: 'pending' | 'active';
  placed_at_ms: number;
  /** Client idempotency key for at-least-once callers (concierge/API). */
  idempotency_key?: string;
}

export type WagerStakeResult =
  | { ok: true; position_id: string }
  /** A prior stake with the same client idempotency key already landed. */
  | { ok: true; duplicate: true }
  | { ok: false; code: WagerStakeErrorCode };

export type WagerWithdrawResult =
  | { ok: true; withdrawal_id: string }
  | { ok: false; code: WagerWithdrawErrorCode };

