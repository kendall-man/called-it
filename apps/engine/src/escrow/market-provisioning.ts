import type { MarketRow } from '../ports.js';
import { canonicalJson } from '@calledit/escrow-sdk';
import type { InitializeEscrowMarketResult } from './market-initializer.js';
import type { ImmutableMarketDocumentInput } from './market-document.js';

const LIVE_POSITION_CUTOFF_SECONDS = 85n * 60n;
const REPLAY_POSITION_WINDOW_SECONDS = 10n * 60n;
const RESOLUTION_WINDOW_SECONDS = 6n * 60n * 60n;

export interface EscrowMarketProvisioningDb {
  getClaim(id: string): Promise<{ readonly quoted_text: string } | null>;
  getFixture(id: number): Promise<{ readonly kickoff_at: string | null } | null>;
}

export interface EscrowMarketProvisioner {
  ensure(market: MarketRow): Promise<boolean>;
}

export interface EscrowFinalizedMarketProjection {
  readonly marketId: string;
  readonly marketPda: string;
  readonly documentHashHex: string;
}

export class EscrowMarketProvisioningError extends Error {
  readonly name = 'EscrowMarketProvisioningError';

  constructor(readonly code: 'market_not_allowed' | 'source_unavailable' | 'invalid_timeline') {
    super(`escrow market provisioning rejected: ${code}`);
  }
}

function secondsFromMs(value: number): bigint | null {
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return BigInt(Math.floor(value / 1_000));
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

export function createEscrowMarketProvisioner(options: {
  readonly db: EscrowMarketProvisioningDb;
  readonly initialize: (input: {
    readonly document: ImmutableMarketDocumentInput;
    readonly nowIso: string;
    readonly maxAttempts: number;
  }) => Promise<InitializeEscrowMarketResult>;
  readonly allowedGroupIds: readonly number[];
  readonly oracleSetEpoch: bigint;
  readonly maximumMarketDurationSeconds: bigint;
  readonly maximumResolutionDelaySeconds: bigint;
  readonly clock: () => { readonly unix: bigint; readonly iso: string };
  /**
   * A card may only expose escrow positions after the initialized market is
   * visible through the finalized projection consumed by later workflows.
   */
  readonly finalizedProjectionReady?: (
    market: EscrowFinalizedMarketProjection,
  ) => Promise<boolean>;
}): EscrowMarketProvisioner {
  const groups = new Set(options.allowedGroupIds);
  return {
    async ensure(market) {
      if (
        market.custody_mode !== 'escrow' || !groups.has(market.group_id) ||
        (market.currency !== 'sol' && market.currency !== 'usdc')
      ) {
        throw new EscrowMarketProvisioningError('market_not_allowed');
      }
      const [claim, fixture] = await Promise.all([
        options.db.getClaim(market.claim_id),
        options.db.getFixture(market.fixture_id),
      ]);
      if (claim === null || fixture === null || market.odds_ts === null) {
        throw new EscrowMarketProvisioningError('source_unavailable');
      }
      const now = options.clock();
      const oddsTimestamp = secondsFromMs(market.odds_ts);
      const marketCreatedTimestamp = secondsFromMs(Date.parse(market.created_at));
      const fixtureKickoff = fixture.kickoff_at === null ? NaN : Date.parse(fixture.kickoff_at);
      const kickoffTimestamp = market.is_replay
        ? marketCreatedTimestamp === null ? null : marketCreatedTimestamp - 1n
        : secondsFromMs(fixtureKickoff);
      if (
        oddsTimestamp === null || marketCreatedTimestamp === null || kickoffTimestamp === null ||
        options.maximumMarketDurationSeconds <= 0n || options.maximumResolutionDelaySeconds <= 0n
      ) throw new EscrowMarketProvisioningError('invalid_timeline');

      const maximumCutoff = marketCreatedTimestamp + options.maximumMarketDurationSeconds;
      const requestedCutoff = market.is_replay
        ? marketCreatedTimestamp + REPLAY_POSITION_WINDOW_SECONDS
        : kickoffTimestamp + LIVE_POSITION_CUTOFF_SECONDS;
      const positionCutoffTimestamp = minimum(requestedCutoff, maximumCutoff);
      const resolutionDelay = minimum(
        RESOLUTION_WINDOW_SECONDS,
        options.maximumResolutionDelaySeconds,
      );
      const resolutionDeadlineTimestamp = positionCutoffTimestamp + resolutionDelay;
      if (
        oddsTimestamp >= positionCutoffTimestamp || kickoffTimestamp >= positionCutoffTimestamp ||
        resolutionDeadlineTimestamp <= positionCutoffTimestamp
      ) throw new EscrowMarketProvisioningError('invalid_timeline');

      const quoteDocument = canonicalJson({
        oddsMessageId: market.odds_message_id,
        oddsTimestampMs: market.odds_ts,
        probability: market.quote_probability,
        provenance: market.price_provenance,
      });
      const result = await options.initialize({
        document: {
          marketId: market.id,
          fixtureId: BigInt(market.fixture_id),
          claimSpecification: canonicalJson(market.spec),
          displayTerms: claim.quoted_text,
          asset: market.currency,
          probability: market.quote_probability,
          oddsMessage: new TextEncoder().encode(quoteDocument),
          oddsTimestamp,
          kickoffTimestamp,
          positionCutoffTimestamp,
          resolutionDeadlineTimestamp,
          oracleSetEpoch: options.oracleSetEpoch,
          replay: market.is_replay,
        },
        nowIso: now.iso,
        maxAttempts: 12,
      });
      if (result.kind !== 'initialized') return false;
      if (options.finalizedProjectionReady === undefined) return true;
      return options.finalizedProjectionReady({
        marketId: market.id,
        marketPda: result.marketPda,
        documentHashHex: result.documentHashHex,
      });
    },
  };
}
