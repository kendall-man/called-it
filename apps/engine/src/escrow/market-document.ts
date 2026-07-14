import { createHash } from 'node:crypto';
import {
  POSITION_ACTIVATION_DELAY_SECONDS_V1,
  bytesToHex,
  hashMarketDocumentV1,
  quantizeProbabilityPpm,
  ratioMilliFromProbabilityPpm,
  type EscrowAsset,
  type MarketDocumentV1,
} from '@calledit/escrow-sdk';

export interface ImmutableMarketDocumentInput {
  readonly marketId: string;
  readonly fixtureId: bigint;
  readonly claimSpecification: string;
  readonly displayTerms: string;
  readonly asset: EscrowAsset;
  readonly probability: number;
  readonly oddsMessage: Uint8Array;
  readonly oddsTimestamp: bigint;
  readonly kickoffTimestamp: bigint;
  readonly positionCutoffTimestamp: bigint;
  readonly resolutionDeadlineTimestamp: bigint;
  readonly oracleSetEpoch: bigint;
  readonly replay: boolean;
}

export interface ImmutableMarketDocument {
  readonly document: MarketDocumentV1;
  readonly documentHashHex: string;
  readonly claimSpecificationHashHex: string;
  readonly displayTermsHashHex: string;
  readonly oddsMessageHashHex: string;
}

export class EscrowMarketDocumentError extends Error {
  readonly name = 'EscrowMarketDocumentError';

  constructor(readonly code: 'invalid_terms' | 'invalid_quote' | 'invalid_timeline') {
    super(`escrow market document rejected: ${code}`);
  }
}

function hash(value: string | Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(value).digest());
}

function assertInput(input: ImmutableMarketDocumentInput): void {
  if (input.claimSpecification.length === 0 || input.displayTerms.length === 0) {
    throw new EscrowMarketDocumentError('invalid_terms');
  }
  if (input.oddsMessage.length === 0 || input.fixtureId < 0n || input.oracleSetEpoch < 0n) {
    throw new EscrowMarketDocumentError('invalid_quote');
  }
  if (
    input.oddsTimestamp >= input.positionCutoffTimestamp ||
    input.kickoffTimestamp >= input.positionCutoffTimestamp ||
    input.positionCutoffTimestamp >= input.resolutionDeadlineTimestamp
  ) {
    throw new EscrowMarketDocumentError('invalid_timeline');
  }
}

export function buildImmutableMarketDocument(
  input: ImmutableMarketDocumentInput,
): ImmutableMarketDocument {
  assertInput(input);
  try {
    const probabilityPpm = quantizeProbabilityPpm(input.probability);
    const claimSpecificationHash = hash(input.claimSpecification);
    const displayTermsHash = hash(input.displayTerms);
    const oddsMessageHash = hash(input.oddsMessage);
    const document: MarketDocumentV1 = {
      marketUuid: input.marketId,
      fixtureId: input.fixtureId,
      claimSpecificationHash,
      displayTermsHash,
      asset: input.asset,
      probabilityPpm,
      ratioMilli: ratioMilliFromProbabilityPpm(probabilityPpm),
      oddsMessageHash,
      oddsTimestamp: input.oddsTimestamp,
      inPlayStartTimestamp: input.kickoffTimestamp,
      activationDelaySeconds: POSITION_ACTIVATION_DELAY_SECONDS_V1,
      positionCutoff: input.positionCutoffTimestamp,
      resolutionDeadline: input.resolutionDeadlineTimestamp,
      feeBps: 0,
      oracleSetEpoch: input.oracleSetEpoch,
      replayFlag: input.replay,
    };
    return {
      document,
      documentHashHex: bytesToHex(hashMarketDocumentV1(document)),
      claimSpecificationHashHex: bytesToHex(claimSpecificationHash),
      displayTermsHashHex: bytesToHex(displayTermsHash),
      oddsMessageHashHex: bytesToHex(oddsMessageHash),
    };
  } catch (error) {
    if (error instanceof EscrowMarketDocumentError) throw error;
    if (error instanceof Error) {
      throw new EscrowMarketDocumentError('invalid_quote');
    }
    throw error;
  }
}
