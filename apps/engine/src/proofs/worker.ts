/**
 * Async chain-proof upgrade (PRD: settle in seconds from the feed, then
 * fetch the TxLINE stat-validation Merkle proof, submit validate_stat from
 * the server keypair, and flip the receipt badge via the proofs row).
 * Proof failure NEVER blocks or reverses a settlement — it downgrades the
 * badge honestly.
 */

import type { Deps } from '../ports.js';
import { ENGINE, explorerTxUrl } from '../engineConstants.js';

import type { Comparator } from '@calledit/market-engine';

export interface ProofJob {
  marketId: string;
  fixtureId: number;
  seq: number;
  statKey: number;
  comparator: Comparator;
  threshold: number;
}

export class ProofWorker {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private stopped = false;

  constructor(private readonly deps: Deps) {}

  /** Schedule the first attempt after the publication batch has time to close. */
  enqueue(job: ProofJob): void {
    this.deps.log.info('proof_enqueued', { ...job });
    this.schedule(job, 1, ENGINE.PROOF_FIRST_ATTEMPT_DELAY_MS);
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }

  private schedule(job: ProofJob, attempt: number, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.attempt(job, attempt);
    }, delayMs);
    this.timers.add(timer);
  }

  private async attempt(job: ProofJob, attempt: number): Promise<void> {
    if (this.stopped) return;
    try {
      const proof = await this.deps.tx.fetchStatProof(job.fixtureId, job.seq, job.statKey);
      await this.deps.db.upsertProof({
        market_id: job.marketId,
        kind: 'stat',
        stat_key: job.statKey,
        seq: job.seq,
        merkle_proof: proof,
        validate_stat_tx: null,
        explorer_url: null,
        status: 'pending',
      });

      if (!this.deps.proofSubmitter) {
        // No hot wallet configured — record the proof, badge stays honest.
        await this.deps.db.upsertProof({
          market_id: job.marketId,
          kind: 'stat',
          stat_key: job.statKey,
          seq: job.seq,
          merkle_proof: proof,
          validate_stat_tx: null,
          explorer_url: null,
          status: 'unavailable',
        });
        this.deps.log.warn('proof_submit_unavailable', { marketId: job.marketId });
        return;
      }

      const result = await this.deps.proofSubmitter.submit({
        fixtureId: job.fixtureId,
        seq: job.seq,
        statKey: job.statKey,
        comparator: job.comparator,
        threshold: job.threshold,
        proof,
      });
      if (result.permanent) {
        await this.deps.db.upsertProof({
          market_id: job.marketId,
          kind: 'stat',
          stat_key: job.statKey,
          seq: job.seq,
          merkle_proof: proof,
          validate_stat_tx: null,
          explorer_url: null,
          status: 'unavailable',
        });
        this.deps.log.warn('proof_submit_permanent_failure', {
          marketId: job.marketId,
          error: result.error,
        });
        return;
      }
      if (result.ok && result.txSig) {
        await this.deps.db.upsertProof({
          market_id: job.marketId,
          kind: 'stat',
          stat_key: job.statKey,
          seq: job.seq,
          merkle_proof: proof,
          validate_stat_tx: result.txSig,
          explorer_url: explorerTxUrl(result.txSig),
          status: 'verified',
        });
        this.deps.log.info('proof_verified', { marketId: job.marketId, txSig: result.txSig });
        return;
      }
      throw new Error(result.error ?? 'validate_stat submission failed');
    } catch (err) {
      this.deps.log.warn('proof_attempt_failed', {
        marketId: job.marketId,
        attempt,
        error: String(err),
      });
      if (attempt < ENGINE.PROOF_MAX_ATTEMPTS) {
        this.schedule(job, attempt + 1, ENGINE.PROOF_RETRY_DELAY_MS);
        return;
      }
      await this.deps.db
        .upsertProof({
          market_id: job.marketId,
          kind: 'stat',
          stat_key: job.statKey,
          seq: job.seq,
          merkle_proof: null,
          validate_stat_tx: null,
          explorer_url: null,
          status: 'failed',
        })
        .catch(() => undefined);
    }
  }
}
