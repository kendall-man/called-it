import type {
  Comparator,
  CompileContext,
  CompileResult,
  MarketSpec,
  MarketState,
  MatchEvent,
  OddsInputs,
  PriceQuote,
  RawClaimParse,
  ReduceResult,
} from '@calledit/market-engine';
import type { FixtureUpsert } from './rows.js';

export interface EntityHints {
  teamNames: string[];
  playerNames: string[];
}

export interface ClassifyResult {
  isClaim: boolean;
  confidence: number;
  claimTypeGuess: string | null;
}

export interface AgentPort {
  prefilter(text: string, entities: EntityHints): boolean;
  classify(text: string, entities: EntityHints): Promise<ClassifyResult>;
  parse(text: string, ctx: CompileContext): Promise<RawClaimParse>;
  persona(templateKey: string, vars: Record<string, string | number>): Promise<string>;
}

export interface EnginePort {
  compileClaim(parse: RawClaimParse, ctx: CompileContext): CompileResult;
  priceSpec(spec: MarketSpec, odds: OddsInputs, ctx: CompileContext): PriceQuote;
  reduceMarket(state: MarketState, event: MatchEvent): ReduceResult;
  checkDebounce(state: MarketState, nowMs: number): ReduceResult;
}

export interface EventSourceLike {
  start(onEvent: (event: MatchEvent) => Promise<void>): void;
  stop(): void;
  currentAsOfMs?(): number | null;
}

export type OddsFetchResult =
  | { kind: 'ok'; odds: OddsInputs }
  | { kind: 'no_odds' }
  | { kind: 'transient' };

export interface TxPort {
  fetchOdds(fixtureId: number, asOfMs?: number): Promise<OddsFetchResult>;
  fetchFixtures(): Promise<FixtureUpsert[]>;
  fetchScoreEvents(fixtureId: number): Promise<readonly MatchEvent[]>;
  fetchStatProof(fixtureId: number, seq: number, statKey: number): Promise<unknown>;
  createLiveSource(fixtureId: number): EventSourceLike;
  createReplaySource(fixtureId: number, speed: number): EventSourceLike;
}

export interface ProofSubmission {
  fixtureId: number;
  seq: number;
  statKey: number;
  comparator: Comparator;
  threshold: number;
  proof: unknown;
}

export interface ProofSubmitResult {
  ok: boolean;
  txSig?: string;
  error?: string;
  permanent?: boolean;
}

export interface ProofSubmitter {
  submit(args: ProofSubmission): Promise<ProofSubmitResult>;
}
