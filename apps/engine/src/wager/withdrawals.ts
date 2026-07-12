/**
 * Withdrawal outbox executor — the only code that moves treasury SOL out.
 *
 * State machine (wager_withdrawals.state):
 *
 *   debited ──sign──▶ persist {sig, raw, lvbh} ──▶ broadcast ──▶ submitted
 *   submitted ── status confirmed/finalized ──▶ confirmed (+ chat receipt)
 *   submitted ── status found w/ on-chain err ─▶ refund credit ──▶ failed
 *   submitted ── absent & blockhash NOT expired ▶ rebroadcast IDENTICAL bytes
 *   submitted ── absent & blockhash expired ───▶ re-sign fresh (same row)
 *
 * Money-safety invariants:
 * - The signed bytes are persisted BEFORE the first broadcast, so a crash on
 *   either side of the send leaves a row whose signature we can look up.
 * - Identical bytes ⇒ identical signature, so rebroadcast is always safe.
 * - Re-signing happens ONLY when the status lookup (which the chain port must
 *   run with searchTransactionHistory:true) says the tx never landed AND its
 *   blockhash window is provably closed — the one case a fresh signature
 *   cannot double-send.
 * - The refund credit posts BEFORE the row flips to 'failed'; a crash between
 *   the two re-runs the refund idempotently (key 'wager:wrefund:<id>').
 */

import { WAGER_CRON_LOCKS, WAGER_KEYS } from './constants.js';
import { WAGER_COPY } from './copy.js';
import { explorerTxUrl } from '../engineConstants.js';
import type { WagerModuleDeps, WagerWithdrawalRow } from './port.js';

async function signPersistBroadcast(
  deps: WagerModuleDeps,
  row: WagerWithdrawalRow,
): Promise<void> {
  const built = await deps.chain.buildTransfer({ to: row.dest_pubkey, lamports: row.lamports });
  if (!built.ok) {
    if (built.permanent) {
      await refundAndFail(deps, row, `build: ${built.error}`);
      return;
    }
    deps.log.warn('wager_withdrawal_build_failed', { id: row.id });
    return; // stays in its current state — retried next tick
  }
  // Persist the signed bytes BEFORE broadcast: if we die during the send we
  // still know the exact signature to look up (and the exact bytes to resend).
  await deps.db.markWithdrawalSubmitted(row.id, {
    tx_sig: built.sig,
    raw_tx_b64: built.rawTxB64,
    last_valid_block_height: built.lastValidBlockHeight,
  });
  const sent = await deps.chain.broadcastRawTx(built.rawTxB64);
  if (!sent.ok) {
    // Row is 'submitted' with its bytes on file — the rebroadcast path owns it.
    deps.log.warn('wager_withdrawal_broadcast_failed', { id: row.id });
    return;
  }
  deps.log.info('wager_withdrawal_submitted', { id: row.id, txSig: built.sig });
}

async function refundAndFail(
  deps: WagerModuleDeps,
  row: WagerWithdrawalRow,
  error: string,
): Promise<void> {
  // Refund FIRST: if we crash after the credit but before the state flip, the
  // row stays 'submitted', re-derives the same terminal failure, and the
  // idempotency key absorbs the duplicate credit.
  await deps.db.postWagerLedger({
    user_id: row.user_id,
    group_id: null,
    market_id: null,
    kind: 'withdrawal_refund',
    lamports: row.lamports,
    idempotency_key: WAGER_KEYS.withdrawalRefund(row.id),
  });
  await deps.db.markWithdrawalFailed(row.id, error);
  deps.log.warn('wager_withdrawal_failed', { id: row.id });
  await notify(deps, row.user_id, async (name) => WAGER_COPY.withdrawFailed(name, row.lamports));
}

async function confirm(deps: WagerModuleDeps, row: WagerWithdrawalRow): Promise<void> {
  await deps.db.markWithdrawalConfirmed(row.id);
  deps.log.info('wager_withdrawal_confirmed', { id: row.id, txSig: row.tx_sig });
  await notify(deps, row.user_id, async (name) =>
    WAGER_COPY.withdrawConfirmed(name, row.lamports, explorerTxUrl(row.tx_sig ?? '')),
  );
}

/** Group post to the user's last wager group — never a DM. */
async function notify(
  deps: WagerModuleDeps,
  userId: number,
  line: (name: string) => Promise<string>,
): Promise<void> {
  const link = await deps.db.getWalletLink(userId);
  if (!link || link.last_wager_group_id === null) return;
  const name = (await deps.db.getUserName(userId)) ?? 'A player';
  deps.poster.post(link.last_wager_group_id, await line(name));
}

async function processSubmitted(deps: WagerModuleDeps, row: WagerWithdrawalRow): Promise<void> {
  if (row.tx_sig === null || row.raw_tx_b64 === null || row.last_valid_block_height === null) {
    // Structurally impossible via this executor; never guess with money.
    deps.log.error('wager_withdrawal_row_incomplete', { id: row.id });
    return;
  }
  const status = await deps.chain.getSigStatus(row.tx_sig);
  if (!status.ok) {
    deps.log.warn('wager_withdrawal_status_failed', { id: row.id });
    return; // status unknown because RPC failed — take no action at all
  }
  if (status.found) {
    if (status.err !== null) {
      await refundAndFail(deps, row, `on-chain: ${status.err}`);
      return;
    }
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      await confirm(deps, row);
      return;
    }
    return; // 'processed': it landed and is confirming — wait, touch nothing
  }
  // Never landed (full-history lookup). Only a provably-closed blockhash
  // window makes a fresh signature safe.
  const expiry = await deps.chain.isBlockheightExceeded(row.last_valid_block_height);
  if (!expiry.ok) {
    deps.log.warn('wager_withdrawal_expiry_check_failed', { id: row.id });
    return;
  }
  if (expiry.exceeded) {
    deps.log.info('wager_withdrawal_resign', { id: row.id, staleSig: row.tx_sig });
    await signPersistBroadcast(deps, row); // same row, new sig/raw/lvbh
    return;
  }
  const resent = await deps.chain.broadcastRawTx(row.raw_tx_b64); // identical bytes = same sig
  if (!resent.ok) {
    deps.log.warn('wager_withdrawal_rebroadcast_failed', { id: row.id });
  }
}

export interface WithdrawalExecutor {
  tick(): Promise<void>;
}

export function createWithdrawalExecutor(deps: WagerModuleDeps): WithdrawalExecutor {
  async function run(): Promise<void> {
    // Snapshot both lists first so a row signed THIS tick is not immediately
    // re-examined as 'submitted' (its status lookup would race the send).
    const debited = await deps.db.withdrawalsInState('debited');
    const submitted = await deps.db.withdrawalsInState('submitted');
    for (const row of debited) {
      await signPersistBroadcast(deps, row);
    }
    for (const row of submitted) {
      await processSubmitted(deps, row);
    }
  }

  return {
    async tick(): Promise<void> {
      if (!(await deps.db.tryCronLock(WAGER_CRON_LOCKS.outbox))) return;
      try {
        await run();
      } catch {
        deps.log.error('wager_withdrawal_executor_failed');
      } finally {
        await deps.db.releaseCronLock(WAGER_CRON_LOCKS.outbox);
      }
    },
  };
}
