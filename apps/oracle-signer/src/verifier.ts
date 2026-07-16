import { createHash } from 'node:crypto';
import {
  bytesToHex,
  canonicalJson,
  decodeMarketAccount,
  decodeOracleSetAccount,
  decodePositionLotAccount,
  decodeProtocolConfigAccount,
  deriveMarketPda,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  escrowEvidenceSequenceCommitmentV2,
  normalizedEscrowEvidenceHashV2,
  settlementEvidenceHashV2,
  type MarketAccount,
  type OracleSetAccount,
  type PositionLotAccount,
  type ProtocolConfigAccount,
} from '@calledit/escrow-sdk';
import {
  evaluateSpec,
  TERMINAL_PHASES,
  type MarketSpec,
  type MatchEvent,
  type SettlementOutcome,
} from '@calledit/market-engine';
import { base58Decode } from '@calledit/solana';
import { normalizeScores, scoresRecordSchema, type ScoresRecord } from '@calledit/txline';
import { Connection, PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import type { OracleSignerEnv } from './env.js';
import type { VerifiedAttestation } from './contracts.js';

const team = z.object({ kind: z.literal('team'), participant: z.union([z.literal(1), z.literal(2)]), name: z.string().min(1) }).strict();
const player = z.object({
  kind: z.literal('player'), normativeId: z.number().int().nonnegative(), name: z.string().min(1),
  participant: z.union([z.literal(1), z.literal(2)]).nullable(),
}).strict();
const marketSpecSchema: z.ZodType<MarketSpec> = z.object({
  claimType: z.enum(['match_winner', 'totals_ou', 'team_scores_n', 'btts', 'player_scores_n', 'comeback']),
  fixtureId: z.number().int().nonnegative(), entityRef: z.union([team, player]),
  comparator: z.enum(['gte', 'lte', 'eq']), threshold: z.number().int().nonnegative(),
  period: z.enum(['FT', 'FT_90']),
  anchor: z.object({ seq: z.number().int().nonnegative(), scoreP1: z.number().int().nonnegative(), scoreP2: z.number().int().nonnegative() }).strict().optional(),
  trustTier: z.enum(['chain_proven', 'oracle_resolved']),
}).strict();

export interface OracleChainState {
  readonly slot: bigint;
  readonly config: ProtocolConfigAccount;
  readonly oracleSet: OracleSetAccount;
  readonly market: MarketAccount;
}

export interface OracleChainReader {
  loadMarket(marketPda: string, oracleEpoch: bigint): Promise<OracleChainState>;
  loadLot(positionLotPda: string): Promise<PositionLotAccount>;
}

export interface OracleFeedReader {
  scores(fixtureId: number): Promise<readonly MatchEvent[]>;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function safeNumber(value: bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${name}`);
  return parsed;
}

async function account(connection: Connection, address: PublicKey, owner: PublicKey): Promise<Uint8Array> {
  const value = await connection.getAccountInfo(address, { commitment: 'finalized' });
  if (value === null || !value.owner.equals(owner)) throw new Error('oracle chain account mismatch');
  return Uint8Array.from(value.data);
}

export function createOracleChainReader(env: OracleSignerEnv): OracleChainReader {
  const connection = new Connection(env.SOLANA_RPC_URL, 'finalized');
  const program = new PublicKey(env.ESCROW_PROGRAM_ID);
  return {
    async loadMarket(marketPda, oracleEpoch) {
      const genesis = await connection.getGenesisHash();
      if (genesis !== env.ESCROW_GENESIS_HASH) throw new Error('oracle chain genesis mismatch');
      const [slot, configBytes, oracleBytes, marketBytes] = await Promise.all([
        connection.getSlot('finalized'),
        account(connection, deriveProtocolConfigPda(program).publicKey, program),
        account(connection, deriveOracleSetPda(program, oracleEpoch).publicKey, program),
        account(connection, new PublicKey(marketPda), program),
      ]);
      const config = decodeProtocolConfigAccount(configBytes);
      const oracleSet = decodeOracleSetAccount(oracleBytes);
      const market = decodeMarketAccount(marketBytes);
      if (
        !equal(config.clusterGenesisHash, base58Decode(env.ESCROW_GENESIS_HASH)) ||
        oracleSet.epoch !== oracleEpoch || oracleSet.activationSlot > BigInt(slot) ||
        oracleSet.signatureThreshold !== 2 || oracleSet.signers.length !== 3 ||
        new Set(oracleSet.signers).size !== 3 ||
        !oracleSet.signers.includes(env.signer.publicKey.toBase58()) ||
        market.oracleSetEpoch !== oracleEpoch ||
        deriveMarketPda(program, market.marketUuid).address !== marketPda
      ) throw new Error('oracle chain policy mismatch');
      return { slot: BigInt(slot), config, oracleSet, market };
    },
    async loadLot(positionLotPda) {
      return decodePositionLotAccount(await account(connection, new PublicKey(positionLotPda), program));
    },
  };
}

export function createOracleFeedReader(env: OracleSignerEnv, fetchImpl: typeof fetch = fetch): OracleFeedReader {
  return {
    async scores(fixtureId) {
      const url = new URL(`/api/scores/snapshot/${fixtureId}`, env.TXLINE_API_BASE);
      const response = await fetchImpl(url, {
        headers: {
          authorization: `Bearer ${env.TXLINE_GUEST_JWT}`,
          'x-api-token': env.TXLINE_API_TOKEN,
          accept: 'application/json',
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`TxLINE snapshot failed with HTTP ${response.status}`);
      const raw: unknown = await response.json();
      if (!Array.isArray(raw) || raw.length === 0) throw new Error('TxLINE snapshot is empty');
      const records: ScoresRecord[] = raw.map((value) => scoresRecordSchema.parse(value));
      const sequences = new Set<number>();
      for (const record of records) {
        if (
          record.FixtureId !== fixtureId || !Number.isSafeInteger(record.Seq) || record.Seq < 0 ||
          !Number.isSafeInteger(record.Ts) || record.Ts < 0 || sequences.has(record.Seq)
        ) throw new Error('TxLINE snapshot ordering is invalid');
        sequences.add(record.Seq);
      }
      const events = normalizeScores(records, Date.now(), { logger() {} });
      if (events.length !== records.length) throw new Error('TxLINE normalization was lossy');
      return events;
    },
  };
}

interface StandingGoal {
  readonly seq: number;
  participant: 1 | 2 | null;
  playerNormativeId: number | null;
  ownGoal: boolean;
  phase: MatchEvent['phase'];
}

function standingGoals(events: readonly MatchEvent[], throughSequence: number): StandingGoal[] {
  const goals: StandingGoal[] = [];
  for (const event of events) {
    if (event.seq > throughSequence) break;
    if (event.kind === 'goal' && event.confirmed) {
      goals.push({
        seq: event.seq, participant: event.detail?.participant ?? null,
        playerNormativeId: event.detail?.playerNormativeId ?? null,
        ownGoal: event.detail?.goalType === 'own_goal', phase: event.phase,
      });
      continue;
    }
    const reversed = event.detail?.reversesSeq;
    if (reversed === undefined) continue;
    const index = goals.findIndex((goal) => goal.seq === reversed);
    if (event.kind === 'goal_discarded' && index >= 0) {
      goals.splice(index, 1);
    } else if (event.kind === 'goal_amended' && index >= 0) {
      const goal = goals[index]!;
      if (event.detail?.participant !== undefined) goal.participant = event.detail.participant;
      if (event.detail?.playerNormativeId !== undefined) goal.playerNormativeId = event.detail.playerNormativeId;
      goal.ownGoal = event.detail?.goalType === 'own_goal';
    }
  }
  return goals;
}

function playerGoals(spec: MarketSpec, goals: readonly StandingGoal[]): number | undefined {
  if (spec.claimType !== 'player_scores_n' || spec.entityRef.kind !== 'player') return undefined;
  const playerId = spec.entityRef.normativeId;
  return goals.filter((goal) =>
    goal.playerNormativeId === playerId && !goal.ownGoal && goal.phase !== 'PE' &&
    (spec.period === 'FT' || goal.phase === 'H1' || goal.phase === 'HT' || goal.phase === 'H2')
  ).length;
}

function evidenceSequences(spec: MarketSpec, goals: readonly StandingGoal[], decidingSequence: number): number[] {
  const relevant = spec.claimType === 'team_scores_n'
    ? goals.filter((goal) => goal.participant === spec.entityRef.participant)
    : spec.claimType === 'player_scores_n' && spec.entityRef.kind === 'player'
      ? goals.filter((goal) => {
          const playerId = spec.entityRef.kind === 'player' ? spec.entityRef.normativeId : -1;
          return goal.playerNormativeId === playerId && !goal.ownGoal;
        })
      : goals;
  return [...new Set([...relevant.map((goal) => goal.seq), decidingSequence])].sort((left, right) => left - right);
}

function score(event: MatchEvent) {
  return { home: event.score.p1.goals, away: event.score.p2.goals };
}

function regulationScore(event: MatchEvent) {
  if (event.score.p1Goals90 !== null && event.score.p2Goals90 !== null) {
    return { home: event.score.p1Goals90, away: event.score.p2Goals90 };
  }
  return event.phase === 'F' ? score(event) : null;
}

function scoreEqual(left: { readonly home: number; readonly away: number } | null, right: { readonly home: number; readonly away: number } | null): boolean {
  return left === null ? right === null : right !== null && left.home === right.home && left.away === right.away;
}

function eventHash(event: MatchEvent): string {
  return bytesToHex(normalizedEscrowEvidenceHashV2(event));
}

function claimedOutcome(spec: MarketSpec, event: MatchEvent, goals: readonly StandingGoal[]): SettlementOutcome | null {
  return evaluateSpec(spec, event.score, event.phase, playerGoals(spec, goals));
}

function priceMoving(event: MatchEvent): boolean {
  return event.confirmed && (event.kind === 'goal' || (event.kind === 'card' && event.detail?.card === 'red'));
}

function freezeSignal(spec: MarketSpec, event: MatchEvent): boolean {
  return priceMoving(event) || event.kind === 'var_check' || event.kind === 'possible_event' ||
    (event.kind === 'goal' && !event.confirmed) ||
    (event.kind === 'odds_suspension' && event.confirmed) ||
    (event.minute !== null && event.minute >= 85) ||
    (spec.claimType === 'player_scores_n' && event.phase !== 'NS');
}

function unfreezeSignal(event: MatchEvent): boolean {
  return event.kind === 'var_end' || event.kind === 'goal_amended' || event.kind === 'goal_discarded' ||
    (event.kind === 'odds_suspension' && !event.confirmed) || event.confirmed;
}

function voidReason(event: MatchEvent, outcome: SettlementOutcome | null): 'cancelled' | 'abandoned' | 'coverage_loss' | 'undecidable' | null {
  if (event.phase === 'CAN') return 'cancelled';
  if (event.phase === 'ABD') return 'abandoned';
  if (event.phase === 'COV_LOST' || event.kind === 'coverage_warning') return 'coverage_loss';
  if (event.phase === 'POST') return 'undecidable';
  if (TERMINAL_PHASES.includes(event.phase) && outcome === null) return 'undecidable';
  return null;
}

export class OracleAttestationVerifier {
  constructor(readonly options: {
    readonly env: OracleSignerEnv;
    readonly chain: OracleChainReader;
    readonly feed: OracleFeedReader;
    readonly clock?: () => number;
  }) {}

  async verify(request: VerifiedAttestation, claimSpecificationJson: string): Promise<void> {
    const now = BigInt(Math.floor((this.options.clock?.() ?? Date.now()) / 1_000));
    const skew = BigInt(this.options.env.ORACLE_SIGNER_CLOCK_SKEW_SECONDS);
    const common = request.attestation;
    if (common.issuedAt > now + skew || common.expiresAt < now - skew || common.expiresAt <= common.issuedAt) {
      throw new Error('oracle attestation timestamp is invalid');
    }
    if (
      !equal(common.clusterGenesisHash, base58Decode(this.options.env.ESCROW_GENESIS_HASH)) ||
      !equal(common.escrowProgramId, new PublicKey(this.options.env.ESCROW_PROGRAM_ID).toBytes()) ||
      common.oracleSetEpoch !== this.options.env.ESCROW_ORACLE_SET_EPOCH
    ) throw new Error('oracle attestation deployment mismatch');

    const marketPda = new PublicKey(common.marketPda).toBase58();
    const state = await this.options.chain.loadMarket(marketPda, common.oracleSetEpoch);
    const market = state.market;
    if (
      market.fixtureId !== common.fixtureId ||
      !equal(market.marketDocumentHash, common.marketDocumentHash) ||
      market.state === 'closed' || market.state === 'settled' || market.state === 'voided'
    ) throw new Error('oracle market binding mismatch');

    let rawSpec: unknown;
    try { rawSpec = JSON.parse(claimSpecificationJson); } catch { throw new Error('claim specification is not JSON'); }
    if (canonicalJson(rawSpec) !== claimSpecificationJson) throw new Error('claim specification is not canonical');
    const spec = marketSpecSchema.parse(rawSpec);
    if (
      spec.fixtureId !== safeNumber(market.fixtureId, 'fixture ID') ||
      createHash('sha256').update(claimSpecificationJson).digest('hex') !== bytesToHex(market.claimSpecificationHash)
    ) throw new Error('claim specification hash mismatch');

    const events = [...await this.options.feed.scores(spec.fixtureId)].sort((left, right) => left.seq - right.seq);
    if (events.length === 0 || events.some((event, index) => index > 0 && event.seq <= events[index - 1]!.seq)) {
      throw new Error('oracle evidence ordering mismatch');
    }

    switch (request.kind) {
      case 'feed_event': return this.verifyFeed(request.attestation, spec, market, events);
      case 'position_invalidation': return this.verifyInvalidation(request.attestation, marketPda, market, events);
      case 'settlement': return this.verifySettlement(request.attestation, spec, events);
      case 'void': return this.verifyVoid(request.attestation, spec, events);
    }
  }

  private verifyFeed(
    attestation: Extract<VerifiedAttestation, { kind: 'feed_event' }>['attestation'],
    spec: MarketSpec,
    market: MarketAccount,
    events: readonly MatchEvent[],
  ): void {
    const sequence = safeNumber(attestation.decidingSequence, 'deciding sequence');
    const event = events.find((value) => value.seq === sequence);
    if (
      event === undefined || eventHash(event) !== bytesToHex(attestation.evidenceHash) ||
      attestation.observedAt !== BigInt(Math.floor(event.tsMs / 1_000)) ||
      attestation.eventEpoch !== market.eventEpoch + 1n
    ) throw new Error('feed attestation evidence mismatch');
    const valid = attestation.eventKind === 'price_moving'
      ? priceMoving(event)
      : attestation.eventKind === 'freeze'
        ? market.state === 'open' && freezeSignal(spec, event)
        : market.state === 'frozen' && unfreezeSignal(event);
    if (!valid) throw new Error('feed attestation transition mismatch');
  }

  private async verifyInvalidation(
    attestation: Extract<VerifiedAttestation, { kind: 'position_invalidation' }>['attestation'],
    marketPda: string,
    market: MarketAccount,
    events: readonly MatchEvent[],
  ): Promise<void> {
    const event = events.find((value) => value.seq === safeNumber(attestation.decidingSequence, 'deciding sequence'));
    const lotPda = new PublicKey(attestation.positionLotPda).toBase58();
    const lot = await this.options.chain.loadLot(lotPda);
    if (
      event === undefined || !priceMoving(event) || eventHash(event) !== bytesToHex(attestation.evidenceHash) ||
      lot.market !== marketPda || lot.nonce !== attestation.lotNonce ||
      lot.observedEventEpoch !== attestation.observedEventEpoch ||
      (lot.state !== 'pending' && lot.state !== 'active') || lot.activationTimestamp === null ||
      BigInt(event.tsMs) >= lot.activationTimestamp * 1_000n ||
      attestation.invalidatedEventEpoch <= attestation.observedEventEpoch ||
      (attestation.invalidatedEventEpoch !== market.eventEpoch && attestation.invalidatedEventEpoch !== market.eventEpoch + 1n)
    ) throw new Error('position invalidation evidence mismatch');
  }

  private verifySettlement(
    attestation: Extract<VerifiedAttestation, { kind: 'settlement' }>['attestation'],
    spec: MarketSpec,
    events: readonly MatchEvent[],
  ): void {
    const latest = events.at(-1)!;
    if (!TERMINAL_PHASES.includes(latest.phase)) {
      throw new Error('settlement fixture phase is not terminal');
    }
    const decidingSequence = safeNumber(attestation.decidingSequence, 'deciding sequence');
    const deciding = events.find((event) => event.seq === decidingSequence);
    if (deciding === undefined || latest.seq < deciding.seq) {
      throw new Error('settlement deciding evidence is missing');
    }
    if (eventHash(latest) !== bytesToHex(attestation.normalizedEvidenceRoot)) {
      throw new Error('settlement terminal evidence is not latest');
    }
    const decidingGoals = standingGoals(events, decidingSequence);
    const outcome = claimedOutcome(spec, deciding, decidingGoals);
    const sequences = evidenceSequences(spec, decidingGoals, decidingSequence);
    const commitment = escrowEvidenceSequenceCommitmentV2(spec.fixtureId, sequences);
    const evidenceHash = settlementEvidenceHashV2(commitment, attestation.normalizedEvidenceRoot);
    if (
      outcome !== attestation.outcome ||
      !equal(commitment, attestation.evidenceSequenceCommitment) ||
      !equal(evidenceHash, attestation.evidenceHash) ||
      attestation.terminalPhase !== latest.phase ||
      !scoreEqual(attestation.regulationScore, regulationScore(latest)) ||
      !scoreEqual(attestation.fullMatchScore, score(latest))
    ) throw new Error('settlement attestation mismatch');

    const latestOutcome = claimedOutcome(spec, latest, standingGoals(events, latest.seq));
    if (latestOutcome !== attestation.outcome) throw new Error('settlement was reversed by later evidence');
  }

  private verifyVoid(
    attestation: Extract<VerifiedAttestation, { kind: 'void' }>['attestation'],
    spec: MarketSpec,
    events: readonly MatchEvent[],
  ): void {
    const sequence = safeNumber(attestation.decidingSequence, 'deciding sequence');
    const event = events.find((value) => value.seq === sequence);
    if (event === undefined || eventHash(event) !== bytesToHex(attestation.evidenceHash)) {
      throw new Error('void evidence is missing');
    }
    const outcome = claimedOutcome(spec, event, standingGoals(events, sequence));
    if (voidReason(event, outcome) !== attestation.reason) throw new Error('void reason mismatch');

    const latest = events.at(-1)!;
    const latestOutcome = claimedOutcome(spec, latest, standingGoals(events, latest.seq));
    if (voidReason(latest, latestOutcome) !== attestation.reason) {
      throw new Error('void was reversed by later evidence');
    }
  }
}
