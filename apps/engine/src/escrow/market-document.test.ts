import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildImmutableMarketDocument,
  EscrowMarketDocumentError,
} from './market-document.js';

const INPUT = {
  marketId: '123e4567-e89b-12d3-a456-426614174000',
  fixtureId: 77n,
  claimSpecification: '{"kind":"team_score","team":"home"}',
  displayTerms: 'Home scores in regulation',
  asset: 'sol' as const,
  probability: 0.4,
  oddsMessage: new TextEncoder().encode('txline:fixture-77:sequence-18'),
  oddsTimestamp: 1_700_000_000n,
  kickoffTimestamp: 1_700_003_600n,
  positionCutoffTimestamp: 1_700_007_200n,
  resolutionDeadlineTimestamp: 1_700_010_800n,
  oracleSetEpoch: 9n,
  replay: false,
};

describe('immutable escrow market document', () => {
  it.each([
    ['pre-match', 1_700_000_000n],
    ['in-play', 1_700_004_000n],
  ] as const)('quantizes %s odds once and hashes the exact canonical terms', (_phase, oddsTimestamp) => {
    // Given a deterministic quote and its complete off-chain terms
    const input = { ...INPUT, oddsTimestamp };
    const expectedClaimHash = createHash('sha256')
      .update(INPUT.claimSpecification, 'utf8')
      .digest('hex');

    // When the immutable V1 document is built
    const result = buildImmutableMarketDocument(input);

    // Then protocol integers and hashes are frozen into one document identity
    expect(result.document.probabilityPpm).toBe(400_000);
    expect(result.document.ratioMilli).toBe(1_500);
    expect(result.document.activationDelaySeconds).toBe(150n);
    expect(result.claimSpecificationHashHex).toBe(expectedClaimHash);
    expect(result.documentHashHex).toMatch(/^[0-9a-f]{64}$/);
    expect(result.documentHashHex).toBe(
      buildImmutableMarketDocument({ ...input }).documentHashHex,
    );
  });

  it('rejects a quote at the position cutoff', () => {
    // Given an odds sample outside the immutable placement window
    const invalid = { ...INPUT, oddsTimestamp: INPUT.positionCutoffTimestamp };

    // When the document is built, then initialization fails closed
    expect(() => buildImmutableMarketDocument(invalid)).toThrow(
      EscrowMarketDocumentError,
    );
  });
});
