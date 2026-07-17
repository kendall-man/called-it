import { DbError, unwrapRows } from './errors.js';
import { isNonEmptyString, lamportsFromDb } from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import type {
  WagerDepositCreditResult,
  WagerLegacyReconciliationReason,
  WagerLegacyReconciliationSummary,
  WagerSolvencySnapshot,
} from './wager-types.js';

type HardeningDb = Pick<
  WagerDb,
  | 'creditDepositToCurrentVerifiedWallet'
  | 'classifyLegacyWalletReconciliation'
  | 'getSolvencySnapshot'
  | 'setSolvencyStatus'
>;

export function hardeningDbMethods(client: WagerDbClient): HardeningDb {
  return {
    async creditDepositToCurrentVerifiedWallet(args) {
      const payload = unwrapRows<unknown>(
        'wager_credit_deposit',
        await client.rpc('wager_credit_deposit', {
          p_tx_sig: args.tx_sig,
          p_ix_index: args.ix_index,
          p_min_lamports: numberForRpc('creditDeposit.min_lamports', args.min_lamports),
        }),
      );
      return parseDepositCreditResult(payload);
    },

    async classifyLegacyWalletReconciliation() {
      const payload = unwrapRows<unknown>(
        'wager_classify_legacy_reconciliation',
        await client.rpc('wager_classify_legacy_reconciliation', {}),
      );
      return parseLegacyReconciliationSummary(payload);
    },

    async getSolvencySnapshot() {
      const payload = unwrapRows<unknown>(
        'wager_solvency_snapshot',
        await client.rpc('wager_solvency_snapshot', {}),
      );
      return parseSolvencySnapshot(payload);
    },

    async setSolvencyStatus(paused, reason) {
      const payload = unwrapRows<unknown>(
        'wager_set_solvency_status',
        await client.rpc('wager_set_solvency_status', { p_paused: paused, p_reason: reason }),
      );
      const row = record('wager_set_solvency_status', payload);
      if (row.ok !== true) {
        throw new DbError('wager_set_solvency_status', {
          message: `malformed RPC payload: ${JSON.stringify(payload)}`,
        });
      }
    },
  };
}

function parseDepositCreditResult(payload: unknown): WagerDepositCreditResult {
  const row = record('wager_credit_deposit', payload);
  if (row.ok === true && isDepositCreditOutcome(row.outcome) && isSafeInteger(row.user_id)) {
    return { ok: true, outcome: row.outcome, user_id: row.user_id };
  }
  if (row.ok === false && isDepositCreditCode(row.code)) {
    return { ok: false, code: row.code };
  }
  throw new DbError('wager_credit_deposit', {
    message: `malformed RPC payload: ${JSON.stringify(payload)}`,
  });
}

function parseSolvencySnapshot(payload: unknown): WagerSolvencySnapshot {
  const row = record('wager_solvency_snapshot', payload);
  return {
    positive_ledger_lamports: nonNegativeLamports('positive_ledger_lamports', row.positive_ledger_lamports),
    open_escrow_lamports: nonNegativeLamports('open_escrow_lamports', row.open_escrow_lamports),
    pending_withdrawal_lamports: nonNegativeLamports(
      'pending_withdrawal_lamports',
      row.pending_withdrawal_lamports,
    ),
    remaining_starter_cap_lamports: nonNegativeLamports(
      'remaining_starter_cap_lamports',
      row.remaining_starter_cap_lamports,
    ),
  };
}

function parseLegacyReconciliationSummary(payload: unknown): WagerLegacyReconciliationSummary {
  const row = record('wager_classify_legacy_reconciliation', payload);
  if (!Array.isArray(row.reasons)) {
    throw malformed('wager_classify_legacy_reconciliation', payload);
  }
  return {
    unresolved_count: nonNegativeInteger('unresolved_count', row.unresolved_count),
    unverified_link_count: nonNegativeInteger('unverified_link_count', row.unverified_link_count),
    orphan_deposit_count: nonNegativeInteger('orphan_deposit_count', row.orphan_deposit_count),
    reasons: row.reasons.map((value) => parseLegacyReason(value)),
  };
}

function parseLegacyReason(value: unknown): WagerLegacyReconciliationReason {
  const row = record('wager_classify_legacy_reconciliation.reasons', value);
  if (!isReconciliationKind(row.kind) || !isNonEmptyString(row.reason)) {
    throw malformed('wager_classify_legacy_reconciliation.reasons', value);
  }
  return {
    kind: row.kind,
    reason: row.reason,
    count: nonNegativeInteger('reasons.count', row.count),
  };
}

function record(op: string, value: unknown): Readonly<Record<string, unknown>> {
  if (isRecord(value)) {
    return value;
  }
  throw malformed(op, value);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDepositCreditOutcome(value: unknown): value is 'credited' | 'already_credited' {
  return value === 'credited' || value === 'already_credited';
}

function isDepositCreditCode(
  value: unknown,
): value is 'not_found' | 'below_minimum' | 'legacy_orphan' | 'unlinked_sender' | 'unverified_wallet' | 'stale_wallet' {
  return (
    value === 'not_found' ||
    value === 'below_minimum' ||
    value === 'legacy_orphan' ||
    value === 'unlinked_sender' ||
    value === 'unverified_wallet' ||
    value === 'stale_wallet'
  );
}

function isReconciliationKind(value: unknown): value is 'unverified_link' | 'orphan_deposit' {
  return value === 'unverified_link' || value === 'orphan_deposit';
}

function nonNegativeLamports(field: string, value: unknown): bigint {
  if (!isSafeInteger(value) || value < 0) {
    throw malformed(`wager_solvency_snapshot.${field}`, value);
  }
  return lamportsFromDb(`wager_solvency_snapshot.${field}`, value);
}

function numberForRpc(op: string, value: bigint): number {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  if (value < 0n || value > maximum) {
    throw new DbError(op, { message: `lamports ${value} exceed the Number-safe range` });
  }
  return Number(value);
}

function nonNegativeInteger(field: string, value: unknown): number {
  if (!isSafeInteger(value) || value < 0) {
    throw malformed(`wager_classify_legacy_reconciliation.${field}`, value);
  }
  return value;
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function malformed(op: string, value: unknown): DbError {
  return new DbError(op, { message: `malformed RPC payload: ${JSON.stringify(value)}` });
}
