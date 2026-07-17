import {
  CanonicalWriter,
  assertInteger,
  hashCanonicalBytes,
  uuidToBytes,
  writeDomain,
} from './codec.js';
import { ratioMilliFromProbabilityPpm } from './math-reference.js';

export const MARKET_DOCUMENT_DOMAIN_V1 = 'calledit.escrow.market.v1';
export const ESCROW_SCHEMA_VERSION = 1 as const;
export const POSITION_ACTIVATION_DELAY_SECONDS_V1 = 150n;
export type EscrowAsset = 'sol' | 'usdc';
export type PositionSide = 'back' | 'doubt';
export type SettlementOutcome = 'claim_won' | 'claim_lost' | 'void';

export interface MarketDocumentV1 {
  readonly marketUuid: string;
  readonly fixtureId: bigint;
  readonly claimSpecificationHash: Uint8Array;
  readonly displayTermsHash: Uint8Array;
  readonly asset: EscrowAsset;
  readonly probabilityPpm: number;
  readonly ratioMilli: number;
  readonly oddsMessageHash: Uint8Array;
  readonly oddsTimestamp: bigint;
  readonly inPlayStartTimestamp: bigint;
  readonly activationDelaySeconds: bigint;
  readonly positionCutoff: bigint;
  readonly resolutionDeadline: bigint;
  readonly feeBps: number;
  readonly oracleSetEpoch: bigint;
  readonly replayFlag: boolean;
}

const ASSET_TAG: Readonly<Record<EscrowAsset, number>> = { sol: 0, usdc: 1 };

export function encodeMarketDocumentV1(document: MarketDocumentV1): Uint8Array {
  const expectedRatio = ratioMilliFromProbabilityPpm(document.probabilityPpm);
  if (document.ratioMilli !== expectedRatio) {
    throw new Error(`market ratio ${document.ratioMilli} does not match probability PPM ${document.probabilityPpm} (${expectedRatio})`);
  }
  if (document.feeBps !== 0) throw new Error('V1 market fee must be zero basis points');
  if (document.activationDelaySeconds !== POSITION_ACTIVATION_DELAY_SECONDS_V1) {
    throw new Error(`V1 activation delay must be ${POSITION_ACTIVATION_DELAY_SECONDS_V1} seconds`);
  }
  if (document.oddsTimestamp >= document.positionCutoff) {
    throw new Error('odds timestamp must be earlier than the position cutoff');
  }
  if (document.inPlayStartTimestamp >= document.positionCutoff) {
    throw new Error('position cutoff must be later than the in-play start');
  }
  if (document.resolutionDeadline <= document.positionCutoff) {
    throw new Error('resolution deadline must be later than the position cutoff');
  }

  const writer = new CanonicalWriter();
  writeDomain(writer, MARKET_DOCUMENT_DOMAIN_V1);
  writer
    .fixed(uuidToBytes(document.marketUuid), 16, 'market UUID')
    .u64(document.fixtureId, 'fixture ID')
    .fixed(document.claimSpecificationHash, 32, 'claim specification hash')
    .fixed(document.displayTermsHash, 32, 'display terms hash')
    .u8(ASSET_TAG[document.asset], 'asset')
    .u32(assertInteger(document.probabilityPpm, 'probability PPM', 1, 999_999), 'probability PPM')
    .u32(document.ratioMilli, 'ratio milli')
    .fixed(document.oddsMessageHash, 32, 'odds message hash')
    .i64(document.oddsTimestamp, 'odds timestamp')
    .i64(document.inPlayStartTimestamp, 'in-play start timestamp')
    .u64(document.activationDelaySeconds, 'activation delay seconds')
    .i64(document.positionCutoff, 'position cutoff')
    .i64(document.resolutionDeadline, 'resolution deadline')
    .u16(document.feeBps, 'fee basis points')
    .u64(document.oracleSetEpoch, 'oracle-set epoch')
    .bool(document.replayFlag, 'replay flag');
  return writer.finish();
}

export function hashMarketDocumentV1(document: MarketDocumentV1): Uint8Array {
  return hashCanonicalBytes(encodeMarketDocumentV1(document));
}
