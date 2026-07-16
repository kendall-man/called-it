import type { MatchEvent } from '@calledit/market-engine';
import type { Poster } from '../bot/poster.js';
import type { Say } from '../bot/copy.js';
import type { Deps } from '../ports.js';
import type { GroupPointsService } from '../points/service.js';
import type { ProofWorker } from '../proofs/worker.js';
import { Settler } from '../settle/settler.js';
import type { EscrowEventWorkflowScheduler } from '../escrow/event-workflow-scheduler.js';

export class EscrowIntegratedSettler extends Settler {
  constructor(
    deps: Deps,
    poster: Poster,
    say: Say,
    points: GroupPointsService,
    proofWorker: ProofWorker | null,
    private readonly escrow: EscrowEventWorkflowScheduler,
  ) {
    super(deps, poster, say, points, proofWorker, null);
  }

  override async onEvent(event: MatchEvent): Promise<void> {
    await Promise.all([super.onEvent(event), this.escrow.onEvent(event)]);
  }

  override async onReplayEvent(
    groupId: number,
    event: MatchEvent,
    replayStartedAtMs: number = Number.NEGATIVE_INFINITY,
  ): Promise<void> {
    await Promise.all([
      super.onReplayEvent(groupId, event, replayStartedAtMs),
      this.escrow.onReplayEvent(groupId, event, replayStartedAtMs),
    ]);
  }

  override async tick(nowMs: number): Promise<void> {
    await Promise.all([super.tick(nowMs), this.escrow.tick(nowMs)]);
  }
}
