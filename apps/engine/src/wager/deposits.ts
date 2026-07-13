/**
 * Deposit watcher: scans the treasury for incoming devnet-SOL transfers and
 * credits linked senders. Crash-safe by construction — every write is keyed:
 * wager_deposits is UNIQUE(tx_sig, ix_index), the ledger credit key is
 * 'wager:deposit:<sig>:<ix>', and the stream cursor only advances after every
 * instruction of a signature is persisted, so re-processing converges.
 *
 * Unlinked senders become orphan rows for private operations reconciliation
 * only; they are never auto-claimed by a later wallet link. Notifications are
 * group posts to last_wager_group_id — NEVER a DM (the bot cannot open one).
 */

import {
  depositCursorStream,
  WAGER_CRON_LOCKS,
  WAGER_KEYS,
  WAGER_TUNABLES,
} from './constants.js';
import { createWagerCopy } from './copy.js';
import type { WagerIncomingTransfer, WagerModuleDeps, WagerWalletLinkRow } from './port.js';

export interface OrphanDepositOpsClassification {
  orphanCount: number;
  totalLamports: bigint;
  creditableCount: number;
  dustCount: number;
  reason: 'none' | 'ops_reconciliation_required';
}

/**
 * Classify orphan deposits for manual operations review. This is intentionally
 * read-only: legacy or orphaned deposits stay in reconciliation until an ops
 * path handles them explicitly.
 */
export async function classifyOrphanDepositsForOps(
  deps: WagerModuleDeps,
  pubkey: string,
): Promise<OrphanDepositOpsClassification> {
  const orphans = await deps.db.orphanDepositsBySender(pubkey);
  let totalLamports = 0n;
  let creditableCount = 0;
  let dustCount = 0;
  for (const deposit of orphans) {
    totalLamports += deposit.lamports;
    if (deposit.lamports < WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS) dustCount += 1;
    else creditableCount += 1;
  }
  return {
    orphanCount: orphans.length,
    totalLamports,
    creditableCount,
    dustCount,
    reason: orphans.length === 0 ? 'none' : 'ops_reconciliation_required',
  };
}

async function creditTransfer(
  deps: WagerModuleDeps,
  transfer: WagerIncomingTransfer,
  link: WagerWalletLinkRow,
): Promise<void> {
  const { inserted } = await deps.db.postWagerLedger({
    user_id: link.user_id,
    group_id: null,
    market_id: null,
    kind: 'deposit',
    lamports: transfer.lamports,
    idempotency_key: WAGER_KEYS.deposit(transfer.sig, transfer.ixIndex),
  });
  await deps.db.markDepositCredited(transfer.sig, transfer.ixIndex, link.user_id);
  // inserted=false means a re-scan of an already-credited deposit — the
  // notification (and the log line) must not repeat.
  if (!inserted) return;
  deps.log.info('wager_deposit_credited', {
    txSig: transfer.sig,
    ixIndex: transfer.ixIndex,
    lamports: transfer.lamports.toString(),
  });
  if (link.last_wager_group_id === null) return;
  const name = (await deps.db.getUserName(link.user_id)) ?? 'A player';
  const balance = await deps.db.balanceLamports(link.user_id);
  deps.poster.post(
    link.last_wager_group_id,
    createWagerCopy(deps.solanaNetwork ?? 'devnet').depositCredited(name, transfer.lamports, balance),
  );
}

async function processTransfer(
  deps: WagerModuleDeps,
  transfer: WagerIncomingTransfer,
): Promise<void> {
  await deps.db.upsertDeposit({
    tx_sig: transfer.sig,
    ix_index: transfer.ixIndex,
    sender_pubkey: transfer.sender,
    lamports: transfer.lamports,
    slot: transfer.slot,
  });
  if (transfer.lamports < WAGER_TUNABLES.MIN_DEPOSIT_LAMPORTS) return; // stored, never credited
  const link = await deps.db.getWalletLinkByPubkey(transfer.sender);
  if (!link) return; // orphan — persisted for later private ops reconciliation
  await creditTransfer(deps, transfer, link);
}

export interface DepositWatcher {
  tick(): Promise<void>;
}

export function createDepositWatcher(deps: WagerModuleDeps): DepositWatcher {
  const streamName = depositCursorStream(deps.chain.treasuryPubkey());

  async function run(): Promise<void> {
    const untilSig = await deps.db.getCursor(streamName);
    const scan = await deps.chain.fetchIncomingTransfers({ untilSig });
    if (!scan.ok) {
      deps.log.warn('wager_deposit_scan_failed');
      return;
    }
    // Advance the cursor only once EVERY instruction of a signature is
    // persisted — advancing mid-signature would let a crash skip that
    // signature's remaining transfers forever (the scan is until-exclusive).
    let index = 0;
    const transfers = scan.transfers;
    while (index < transfers.length) {
      const sig = transfers[index]?.sig;
      let cursor = index;
      while (cursor < transfers.length && transfers[cursor]?.sig === sig) {
        const transfer = transfers[cursor];
        if (transfer) await processTransfer(deps, transfer);
        cursor += 1;
      }
      if (sig !== undefined) await deps.db.setCursor(streamName, sig);
      index = cursor;
    }
    // Once every transfer is persisted, jump the cursor to the newest scanned
    // signature — trailing transfer-free spam/dust must not be re-scanned
    // forever, or a dust attack could push real deposits past the pagination
    // window (the >1000-sig eviction the design defends against).
    if (scan.newestSig !== null) {
      await deps.db.setCursor(streamName, scan.newestSig);
    }
    if (scan.transfers.length > 0) {
      deps.log.info('wager_deposits_scanned', { transfers: scan.transfers.length });
    }
  }

  return {
    async tick(): Promise<void> {
      if (!(await deps.db.tryCronLock(WAGER_CRON_LOCKS.deposits))) return;
      try {
        await run();
      } catch {
        deps.log.error('wager_deposit_watcher_failed');
      } finally {
        await deps.db.releaseCronLock(WAGER_CRON_LOCKS.deposits);
      }
    },
  };
}
