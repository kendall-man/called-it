import { describe, expect, it } from 'vitest';
import type { MarketRow } from '../ports.js';
import { createEscrowMarketProvisioner, EscrowMarketProvisioningError } from './market-provisioning.js';
import type { ImmutableMarketDocumentInput } from './market-document.js';

const NOW = 1_700_000_000n;
const MARKET = {
  id: '123e4567-e89b-12d3-a456-426614174000', claim_id: 'claim', group_id: -100,
  fixture_id: 7, currency: 'sol', is_replay: false, odds_ts: Number((NOW - 30n) * 1_000n),
  odds_message_id: 'odds', quote_probability: 0.4, quote_multiplier: 2.5,
  price_provenance: 'market', spec: { z: 2, a: 1 },
} as unknown as MarketRow;

function fixture(market: MarketRow = MARKET, initialized = false) {
  const documents: ImmutableMarketDocumentInput[] = [];
  const service = createEscrowMarketProvisioner({
    db: {
      async getClaim() { return { quoted_text: 'Team A wins' }; },
      async getFixture() { return { kickoff_at: new Date(Number((NOW + 3_600n) * 1_000n)).toISOString() }; },
    },
    async initialize(input) {
      documents.push(input.document);
      return initialized
        ? { kind: 'initialized', marketPda: 'market', vaultPda: 'vault', documentHashHex: 'ab', state: 'open' }
        : { kind: 'queued', created: true, marketPda: 'market', vaultPda: 'vault', documentHashHex: 'ab' };
    },
    allowedGroupIds: [-100], oracleSetEpoch: 9n,
    maximumMarketDurationSeconds: 8n * 60n * 60n,
    maximumResolutionDelaySeconds: 12n * 60n * 60n,
    clock: () => ({ unix: NOW, iso: '2023-11-14T22:13:20.000Z' }),
  });
  return { service, documents, market };
}

describe('escrow market provisioner', () => {
  it('queues deterministic pre-match terms and reports readiness only after chain initialization', async () => {
    const queued = fixture();
    await expect(queued.service.ensure(queued.market)).resolves.toBe(false);
    expect(queued.documents[0]).toMatchObject({
      marketId: MARKET.id, kickoffTimestamp: NOW + 3_600n,
      positionCutoffTimestamp: NOW + 3_600n + 85n * 60n,
      resolutionDeadlineTimestamp: NOW + 3_600n + 85n * 60n + 6n * 60n * 60n,
      replay: false,
    });
    expect(queued.documents[0]?.claimSpecification).toBe('{"a":1,"z":2}');

    await expect(fixture(MARKET, true).service.ensure(MARKET)).resolves.toBe(true);
  });

  it('uses a current isolated timeline for completed-match replay accounts', async () => {
    const replay = fixture({ ...MARKET, is_replay: true });
    await replay.service.ensure(replay.market);
    expect(replay.documents[0]).toMatchObject({
      kickoffTimestamp: NOW - 1n,
      positionCutoffTimestamp: NOW + 10n * 60n,
      replay: true,
    });
  });

  it('fails closed outside the rollout or after the live cutoff', async () => {
    await expect(fixture({ ...MARKET, group_id: -200 }).service.ensure({ ...MARKET, group_id: -200 }))
      .rejects.toBeInstanceOf(EscrowMarketProvisioningError);
    const late = fixture({ ...MARKET, odds_ts: Number((NOW + 20_000n) * 1_000n) });
    await expect(late.service.ensure(late.market)).rejects.toMatchObject({ code: 'invalid_timeline' });
  });
});
