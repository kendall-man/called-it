import type {
  EnqueueSettlementProofJobInput,
  JobTransitionResult,
  RecordProofStateInput,
  RecordProofStateResult,
  RecordTerminalSettlementInput,
  RecordTerminalSettlementResult,
  ReconcileTerminalJobsInput,
  ReconcileTerminalJobResult,
  SettlementProofBacklog,
  SettlementProofJobErrorCode,
  SettlementProofJobKind,
  SettlementProofJobRow,
  SettlementProofJobsDb,
  TerminalSettlementGap,
} from '@calledit/db';

type MutableJob = {
  marketId: string;
  jobKind: SettlementProofJobKind;
  status: SettlementProofJobRow['status'];
  attempts: number;
  maxAttempts: number;
  leaseMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  dueAt: string;
  leaseOwner: string | null;
  leaseToken: string | null;
  leasedAt: string | null;
  leaseExpiresAt: string | null;
  lastErrorCode: SettlementProofJobErrorCode | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deadAt: string | null;
};

type StoredProof = {
  status: 'pending' | 'verified' | 'failed' | 'unavailable';
  input: RecordProofStateInput;
};

type EnqueueResult = Awaited<ReturnType<SettlementProofJobsDb['enqueueJob']>>;

export class MemorySettlementProofJobs implements SettlementProofJobsDb {
  readonly trace: string[] = [];
  readonly jobs = new Map<string, MutableJob>();
  readonly proofs = new Map<string, StoredProof>();
  readonly settlements = new Set<string>();
  readonly posted = new Set<string>();
  readonly reconcileResults: ReconcileTerminalJobResult[] = [];
  private nextLease = 0;

  async recordTerminalSettlement(
    input: RecordTerminalSettlementInput,
  ): Promise<RecordTerminalSettlementResult> {
    this.trace.push(`terminal:${input.marketId}`);
    const duplicate = this.settlements.has(input.marketId);
    this.settlements.add(input.marketId);
    if (!this.jobs.has(jobKey(input.marketId, 'settlement'))) {
      this.jobs.set(jobKey(input.marketId, 'settlement'), createJob(input.marketId, 'settlement', input.nowIso, input));
    }
    return {
      ok: true,
      duplicate,
      marketId: input.marketId,
      jobStatus: this.job(input.marketId, 'settlement').status,
    };
  }

  async markSettlementPosted(marketId: string, _nowIso: string) {
    if (!this.settlements.has(marketId)) return { ok: false, code: 'settlement_fact_missing' } as const;
    const duplicate = this.posted.has(marketId);
    this.trace.push(`posted:${marketId}`);
    this.posted.add(marketId);
    return { ok: true, duplicate, postedAt: '1970-01-01T00:00:00.000Z' } as const;
  }

  async recordProofState(input: RecordProofStateInput): Promise<RecordProofStateResult> {
    const previous = this.proofs.get(input.marketId);
    if (previous === undefined) {
      if (input.status !== 'pending') return { ok: false, code: 'proof_fact_conflict' };
      this.proofs.set(input.marketId, { status: input.status, input });
      return proofResult(input, false);
    }
    if (previous.status !== 'pending' && previous.status !== input.status) {
      return { ok: false, code: 'proof_fact_conflict' };
    }
    if (previous.status === input.status) return proofResult(previous.input, true);
    this.proofs.set(input.marketId, { status: input.status, input });
    return proofResult(input, false);
  }

  async enqueueJob(input: EnqueueSettlementProofJobInput): Promise<EnqueueResult> {
    const key = jobKey(input.marketId, input.jobKind);
    const existing = this.jobs.get(key);
    if (existing !== undefined) {
      const result: EnqueueResult = { ok: true, created: false, job: copyJob(existing) };
      return result;
    }
    const job = createJob(input.marketId, input.jobKind, input.nowIso, input);
    job.dueAt = input.dueAtIso;
    this.jobs.set(key, job);
    this.trace.push(`enqueue:${input.jobKind}:${input.marketId}`);
    const result: EnqueueResult = { ok: true, created: true, job: copyJob(job) };
    return result;
  }

  async leaseJobs(input: {
    jobKind: SettlementProofJobKind;
    workerId: string;
    nowIso: string;
    limit: number;
  }): Promise<readonly SettlementProofJobRow[]> {
    const leased: SettlementProofJobRow[] = [];
    for (const job of this.jobs.values()) {
      if (leased.length >= input.limit || job.jobKind !== input.jobKind || job.status !== 'pending') continue;
      if (Date.parse(job.dueAt) > Date.parse(input.nowIso)) continue;
      job.status = 'leased';
      job.attempts += 1;
      job.leaseOwner = input.workerId;
      this.nextLease += 1;
      job.leaseToken = `lease-${this.nextLease}`;
      job.leasedAt = input.nowIso;
      job.leaseExpiresAt = new Date(Date.parse(input.nowIso) + job.leaseMs).toISOString();
      job.updatedAt = input.nowIso;
      this.trace.push(`lease:${job.jobKind}:${job.marketId}`);
      leased.push(copyJob(job));
    }
    return leased;
  }

  async completeJob(input: {
    marketId: string;
    jobKind: SettlementProofJobKind;
    workerId: string;
    leaseToken: string;
    nowIso: string;
  }): Promise<JobTransitionResult> {
    const job = this.jobs.get(jobKey(input.marketId, input.jobKind));
    if (!ownsLease(job, input)) return { ok: false, code: 'lease_lost' };
    job.status = 'complete';
    job.completedAt = input.nowIso;
    job.updatedAt = input.nowIso;
    job.lastErrorCode = null;
    this.trace.push(`complete:${input.jobKind}:${input.marketId}`);
    return { ok: true, status: 'complete', duplicate: false };
  }

  async retryJob(input: {
    marketId: string;
    jobKind: SettlementProofJobKind;
    workerId: string;
    leaseToken: string;
    errorCode: SettlementProofJobErrorCode;
    delayMs: number;
    nowIso: string;
  }): Promise<JobTransitionResult> {
    const job = this.jobs.get(jobKey(input.marketId, input.jobKind));
    if (!ownsLease(job, input)) return { ok: false, code: 'lease_lost' };
    job.lastErrorCode = input.errorCode;
    job.updatedAt = input.nowIso;
    if (job.attempts >= job.maxAttempts) {
      job.status = 'dead';
      job.deadAt = input.nowIso;
      this.trace.push(`dead:${input.jobKind}:${input.marketId}`);
      return { ok: true, status: 'dead', duplicate: false };
    }
    job.status = 'pending';
    job.dueAt = new Date(Date.parse(input.nowIso) + input.delayMs).toISOString();
    this.trace.push(`retry:${input.jobKind}:${input.marketId}`);
    return { ok: true, status: 'retry_wait', duplicate: false };
  }

  async deadLetterJob(input: {
    marketId: string;
    jobKind: SettlementProofJobKind;
    workerId: string;
    leaseToken: string;
    errorCode: SettlementProofJobErrorCode;
    nowIso: string;
  }): Promise<JobTransitionResult> {
    const job = this.jobs.get(jobKey(input.marketId, input.jobKind));
    if (!ownsLease(job, input)) return { ok: false, code: 'lease_lost' };
    job.status = 'dead';
    job.deadAt = input.nowIso;
    job.lastErrorCode = input.errorCode;
    this.trace.push(`dead:${input.jobKind}:${input.marketId}`);
    return { ok: true, status: 'dead', duplicate: false };
  }

  async terminalGaps(_limit: number): Promise<readonly TerminalSettlementGap[]> {
    return [];
  }

  async reconcileTerminalJobs(_input: ReconcileTerminalJobsInput): Promise<readonly ReconcileTerminalJobResult[]> {
    return this.reconcileResults;
  }

  async backlog(kind: SettlementProofJobKind, nowIso: string): Promise<SettlementProofBacklog> {
    const relevant = [...this.jobs.values()].filter((job) => job.jobKind === kind);
    const ready = relevant.filter((job) => job.status === 'pending' && Date.parse(job.dueAt) <= Date.parse(nowIso));
    const oldest = ready.reduce<number | null>((age, job) => {
      const next = Math.max(0, Date.parse(nowIso) - Date.parse(job.createdAt));
      return age === null ? next : Math.max(age, next);
    }, null);
    return {
      readyCount: ready.length,
      oldestReadyAgeMs: oldest,
      activeLeaseCount: relevant.filter((job) => job.status === 'leased').length,
      retryWaitCount: relevant.filter((job) => job.status === 'retry_wait').length,
      expiredLeaseCount: 0,
      deadCount: relevant.filter((job) => job.status === 'dead').length,
    };
  }

  job(marketId: string, kind: SettlementProofJobKind): SettlementProofJobRow {
    return copyJob(this.jobs.get(jobKey(marketId, kind)) ?? missingJob(marketId, kind));
  }
}

function createJob(
  marketId: string,
  jobKind: SettlementProofJobKind,
  nowIso: string,
  policy: { readonly maxAttempts: number; readonly leaseMs: number; readonly retryBaseMs: number; readonly retryMaxMs: number },
): MutableJob {
  return {
    marketId,
    jobKind,
    status: 'pending',
    attempts: 0,
    maxAttempts: policy.maxAttempts,
    leaseMs: policy.leaseMs,
    retryBaseMs: policy.retryBaseMs,
    retryMaxMs: policy.retryMaxMs,
    dueAt: nowIso,
    leaseOwner: null,
    leaseToken: null,
    leasedAt: null,
    leaseExpiresAt: null,
    lastErrorCode: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    completedAt: null,
    deadAt: null,
  };
}

function missingJob(marketId: string, jobKind: SettlementProofJobKind): MutableJob {
  return createJob(marketId, jobKind, '1970-01-01T00:00:00.000Z', {
    maxAttempts: 1,
    leaseMs: 1_000,
    retryBaseMs: 1,
    retryMaxMs: 1,
  });
}

function proofResult(input: RecordProofStateInput, duplicate: boolean): RecordProofStateResult {
  return {
    ok: true,
    duplicate,
    marketId: input.marketId,
    kind: input.kind,
    status: input.status,
    verifiedAt: input.status === 'verified' ? input.nowIso : null,
  };
}

function ownsLease(
  job: MutableJob | undefined,
  input: { readonly workerId: string; readonly leaseToken: string },
): job is MutableJob {
  return job !== undefined && job.status === 'leased' && job.leaseOwner === input.workerId && job.leaseToken === input.leaseToken;
}

function copyJob(job: MutableJob): SettlementProofJobRow {
  return { ...job };
}

function jobKey(marketId: string, kind: SettlementProofJobKind): string {
  return `${kind}:${marketId}`;
}
