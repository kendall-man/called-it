import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type {
  GetProofSubmissionResult,
  PrepareProofSubmissionInput,
  ProofSubmissionIdentity,
  ProofSubmissionMutationResult,
  ProofSubmissionOutboxDb,
  ProofSubmissionOutboxRow,
} from '@calledit/db';
import { createDurableProofWorker } from './durable-proof-worker.js';
import type {
  DurableProofSubmissionPlan,
  DurableProofSubmissionTransport,
  PreparedDurableProofSubmission,
} from './proof-submission.js';
import type { DurableQueuePolicy } from '../settle/durable.js';
import type { RecoveredSettlementFact } from '../settle/recovery-types.js';
import { MemorySettlementProofJobs } from '../settle/recovery.test-support.js';

const POLICY: DurableQueuePolicy = {
  maxAttempts: 3,
  leaseMs: 10_000,
  retryBaseMs: 1_000,
  retryMaxMs: 8_000,
  initialChainProofDelayMs: 60_000,
};
const LEAF = '11'.repeat(32);
const SIBLING = '22'.repeat(32);
const ROOT = sha256Hex(LEAF, SIBLING);
const PROOF = {
  summary: {
    updateStats: { minTimestamp: 1_752_000_000_000 },
    eventsSubTreeRoot: LEAF,
  },
  mainTreeProof: [{ hash: SIBLING, isRightSibling: true }],
};

function sha256Hex(...parts: readonly string[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part, 'hex');
  return hash.digest('hex');
}

function fact(): RecoveredSettlementFact {
  return {
    marketId: 'market-1',
    fixtureId: 99,
    outcome: 'claim_won',
    tier: 'chain_proven',
    decidingSeq: 5,
    comparator: 'gte',
    threshold: 2,
    statKey: 1,
  };
}

async function enqueueProof(jobs: MemorySettlementProofJobs, policy = POLICY): Promise<void> {
  await jobs.enqueueJob({
    marketId: 'market-1',
    jobKind: 'proof',
    dueAtIso: new Date(1_000).toISOString(),
    nowIso: new Date(1_000).toISOString(),
    maxAttempts: policy.maxAttempts,
    leaseMs: policy.leaseMs,
    retryBaseMs: policy.retryBaseMs,
    retryMaxMs: policy.retryMaxMs,
  });
}

describe('durable proof worker', () => {
  it('writes verified only after the main-tree path matches an expected root', async () => {
    // Given a durable proof job and an already-landed durable transaction
    const jobs = new MemorySettlementProofJobs();
    const outbox = new MemoryProofSubmissionOutbox();
    const transport = new MemoryProofSubmissionTransport(['landed']);
    await enqueueProof(jobs);

    // When the proof lease runs
    await workerFor(jobs, outbox, transport).tick();

    // Then proof state follows root verification, never an opaque direct submit call
    expect(transport.built).toHaveLength(1);
    expect(jobs.proofs.get('market-1')?.status).toBe('verified');
    expect(jobs.job('market-1', 'proof').status).toBe('complete');
  });

  it('records unavailable and never builds or broadcasts when the proof misses expected roots', async () => {
    // Given a self-consistent proof whose main tree lands on no published root
    const jobs = new MemorySettlementProofJobs();
    const outbox = new MemoryProofSubmissionOutbox();
    const transport = new MemoryProofSubmissionTransport(['rebroadcast']);
    await enqueueProof(jobs);
    const worker = workerFor(jobs, outbox, transport, { roots: ['33'.repeat(32)] });

    // When the root mismatch is discovered
    await worker.tick();

    // Then the terminal fallback is honest and no fee-bearing transaction is created
    expect(transport.built).toEqual([]);
    expect(transport.rebroadcasts).toEqual([]);
    expect(jobs.proofs.get('market-1')?.status).toBe('unavailable');
    expect(jobs.job('market-1', 'proof').status).toBe('complete');
  });

  it('dead-letters only after recording failed when expected roots stay unavailable', async () => {
    // Given a one-attempt proof job and an unavailable root source
    const policy = { ...POLICY, maxAttempts: 1 };
    const jobs = new MemorySettlementProofJobs();
    await enqueueProof(jobs, policy);
    const worker = workerFor(
      jobs,
      new MemoryProofSubmissionOutbox(),
      new MemoryProofSubmissionTransport(['rebroadcast']),
      { policy, roots: null },
    );

    // When the sole attempt cannot verify a real root
    await worker.tick();

    // Then failed proof state is durable before the job reaches the dead letter
    expect(jobs.proofs.get('market-1')?.status).toBe('failed');
    expect(jobs.job('market-1', 'proof').status).toBe('dead');
    expect(jobs.trace.indexOf('dead:proof:market-1')).toBeGreaterThan(
      jobs.trace.indexOf('lease:proof:market-1'),
    );
  });

  it('recovers a SIGKILL after durable persistence by rebroadcasting exactly the persisted bytes', async () => {
    const jobs = new MemorySettlementProofJobs();
    const outbox = new MemoryProofSubmissionOutbox();
    const transport = new MemoryProofSubmissionTransport(['rebroadcast']);
    let now = 1_000;
    await enqueueProof(jobs);
    outbox.afterPrepare = () => {
      throw new Error('simulated SIGKILL after persistence');
    };

    // The first process dies after the transaction bytes are committed, before send.
    await workerFor(jobs, outbox, transport, { now: () => now }).tick();
    const persisted = outbox.latest('market-1');
    expect(persisted?.state).toBe('prepared');
    expect(transport.rebroadcasts).toEqual([]);
    expect(jobs.job('market-1', 'proof').status).toBe('pending');

    // A restarted worker discovers the durable identity and sends no rebuilt transaction.
    outbox.afterPrepare = null;
    now = 2_000;
    await workerFor(jobs, outbox, transport, { now: () => now }).tick();

    expect(transport.built).toHaveLength(1);
    expect(transport.rebroadcasts).toEqual([persisted?.rawTxB64]);
    expect(outbox.latest('market-1')?.state).toBe('broadcast');
  });

  it('recovers a SIGKILL after send without charging a second transaction', async () => {
    const jobs = new MemorySettlementProofJobs();
    const outbox = new MemoryProofSubmissionOutbox();
    const transport = new MemoryProofSubmissionTransport(['rebroadcast', 'landed']);
    let now = 1_000;
    await enqueueProof(jobs);
    transport.failAfterFirstSend = true;

    // The raw transaction reaches the network, then the process disappears before markBroadcast.
    await workerFor(jobs, outbox, transport, { now: () => now }).tick();
    expect(outbox.latest('market-1')?.state).toBe('prepared');
    expect(transport.rebroadcasts).toHaveLength(1);

    // Full-history status observes the landed signature and completes without rebroadcast.
    now = 2_000;
    await workerFor(jobs, outbox, transport, { now: () => now }).tick();

    expect(transport.built).toHaveLength(1);
    expect(transport.rebroadcasts).toHaveLength(1);
    expect(outbox.latest('market-1')?.state).toBe('landed');
    expect(jobs.proofs.get('market-1')?.status).toBe('verified');
    expect(jobs.job('market-1', 'proof').status).toBe('complete');
  });

  it('expires an absent transaction before constructing and sending a replacement', async () => {
    const jobs = new MemorySettlementProofJobs();
    const outbox = new MemoryProofSubmissionOutbox();
    const transport = new MemoryProofSubmissionTransport(['rebuild', 'rebroadcast']);
    await enqueueProof(jobs);

    await workerFor(jobs, outbox, transport).tick();

    const attempts = outbox.entriesFor('market-1');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.state).toBe('expired');
    expect(attempts[1]?.state).toBe('broadcast');
    expect(transport.built).toHaveLength(2);
    expect(transport.rebroadcasts).toEqual([attempts[1]?.rawTxB64]);
  });
});

function workerFor(
  jobs: MemorySettlementProofJobs,
  outbox: MemoryProofSubmissionOutbox,
  submission: MemoryProofSubmissionTransport | null,
  overrides: {
    readonly now?: () => number;
    readonly policy?: DurableQueuePolicy;
    readonly roots?: readonly string[] | null;
  } = {},
) {
  return createDurableProofWorker({
    jobs,
    outbox,
    facts: { find: async () => fact() },
    tx: { fetchStatProof: async () => PROOF },
    submission,
    roots: { rootsFor: async () => overrides.roots ?? [ROOT] },
    clock: { now: overrides.now ?? (() => 1_000) },
    policy: overrides.policy ?? POLICY,
    workerId: 'proof-a',
    leaseLimit: 4,
    log: silentLog,
  });
}

class MemoryProofSubmissionOutbox implements ProofSubmissionOutboxDb {
  readonly entries = new Map<string, ProofSubmissionOutboxRow[]>();
  afterPrepare: (() => void) | null = null;

  async get(marketId: string): Promise<GetProofSubmissionResult> {
    return { ok: true, outbox: this.latest(marketId) };
  }

  async prepare(input: PrepareProofSubmissionInput): Promise<ProofSubmissionMutationResult> {
    const existing = this.latest(input.marketId);
    if (existing !== null && existing.state !== 'expired') {
      if (
        existing.signature === input.signature &&
        existing.rawTxB64 === input.rawTxB64 &&
        existing.lastValidBlockHeight === input.lastValidBlockHeight
      ) {
        return { ok: true, duplicate: true, outbox: existing };
      }
      return { ok: false, code: 'submission_identity_conflict' };
    }
    const row: ProofSubmissionOutboxRow = {
      marketId: input.marketId,
      attempt: (existing?.attempt ?? 0) + 1,
      state: 'prepared',
      signature: input.signature,
      rawTxB64: input.rawTxB64,
      lastValidBlockHeight: input.lastValidBlockHeight,
      proofPayload: input.proofPayload,
      broadcastCount: 0,
      preparedAt: input.nowIso,
      lastBroadcastAt: null,
      landedAt: null,
      expiredAt: null,
      updatedAt: input.nowIso,
    };
    this.entriesFor(input.marketId).push(row);
    this.afterPrepare?.();
    return { ok: true, duplicate: false, outbox: row };
  }

  async markBroadcast(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult> {
    const row = this.find(input);
    if (row === null) return { ok: false, code: 'submission_not_found' };
    if (row.state === 'expired') return { ok: false, code: 'submission_not_active' };
    const updated = { ...row, state: 'broadcast' as const, broadcastCount: row.broadcastCount + 1, lastBroadcastAt: input.nowIso, updatedAt: input.nowIso };
    this.replace(updated);
    return { ok: true, duplicate: false, outbox: updated };
  }

  async markLanded(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult> {
    const row = this.find(input);
    if (row === null) return { ok: false, code: 'submission_not_found' };
    if (row.state === 'expired') return { ok: false, code: 'submission_not_active' };
    const updated = { ...row, state: 'landed' as const, landedAt: input.nowIso, updatedAt: input.nowIso };
    this.replace(updated);
    return { ok: true, duplicate: false, outbox: updated };
  }

  async markExpired(input: ProofSubmissionIdentity): Promise<ProofSubmissionMutationResult> {
    const row = this.find(input);
    if (row === null) return { ok: false, code: 'submission_not_found' };
    if (row.state === 'landed') return { ok: false, code: 'submission_not_active' };
    const updated = { ...row, state: 'expired' as const, expiredAt: input.nowIso, updatedAt: input.nowIso };
    this.replace(updated);
    return { ok: true, duplicate: false, outbox: updated };
  }

  latest(marketId: string): ProofSubmissionOutboxRow | null {
    const rows = this.entries.get(marketId);
    return rows?.at(-1) ?? null;
  }

  entriesFor(marketId: string): ProofSubmissionOutboxRow[] {
    const existing = this.entries.get(marketId);
    if (existing !== undefined) return existing;
    const created: ProofSubmissionOutboxRow[] = [];
    this.entries.set(marketId, created);
    return created;
  }

  private find(input: ProofSubmissionIdentity): ProofSubmissionOutboxRow | null {
    const row = this.entriesFor(input.marketId).find((candidate) => candidate.attempt === input.attempt);
    if (row === undefined || row.signature !== input.signature) return null;
    return row;
  }

  private replace(row: ProofSubmissionOutboxRow): void {
    const rows = this.entriesFor(row.marketId);
    const index = rows.findIndex((candidate) => candidate.attempt === row.attempt);
    if (index < 0) throw new Error('outbox row disappeared');
    rows[index] = row;
  }
}

class MemoryProofSubmissionTransport implements DurableProofSubmissionTransport {
  readonly built: PreparedDurableProofSubmission[] = [];
  readonly rebroadcasts: string[] = [];
  failAfterFirstSend = false;
  private nextPlan = 0;

  constructor(private readonly plans: readonly DurableProofSubmissionPlan['kind'][]) {}

  async build(): Promise<{ readonly ok: true; readonly submission: PreparedDurableProofSubmission }> {
    const sequence = this.built.length + 1;
    const submission = {
      signature: `proof-signature-${sequence}`,
      rawTxB64: `proof-raw-${sequence}`,
      lastValidBlockHeight: 100 + sequence,
    };
    this.built.push(submission);
    return { ok: true, submission };
  }

  async inspect(): Promise<{ readonly ok: true; readonly plan: DurableProofSubmissionPlan }> {
    const kind = this.plans[this.nextPlan] ?? 'wait';
    this.nextPlan += 1;
    return kind === 'onchain_failed'
      ? { ok: true, plan: { kind } }
      : { ok: true, plan: { kind } };
  }

  async rebroadcast(submission: PreparedDurableProofSubmission): Promise<{ readonly ok: true }> {
    this.rebroadcasts.push(submission.rawTxB64);
    if (this.failAfterFirstSend && this.rebroadcasts.length === 1) {
      throw new Error('simulated SIGKILL after send');
    }
    return { ok: true };
  }
}

const silentLog = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
