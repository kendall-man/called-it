import { createHash } from 'node:crypto';

import {
  bytesToHex,
  canonicalJson,
  decodeMarketAccount,
  encodeFeedEventAttestationV1,
} from '../../packages/escrow-sdk/src/index.js';
import { normalizeScores } from '../../packages/txline/src/normalize-scores.js';
import { scoresRecordSchema } from '../../packages/txline/src/schemas.js';
import { Connection, PublicKey } from '@solana/web3.js';

import {
  createHttpsEscrowOracleAttestationProvider,
} from '../../apps/engine/src/escrow/attestation-signers.js';
import {
  attestationPayloadHash,
  createSignedAttestationPayload,
  createUnsignedAttestationPayload,
} from '../../apps/engine/src/escrow/attestation-request-payload.js';
import { attestationRequestKey } from '../../apps/engine/src/escrow/attestation-request-service.js';
import { buildEscrowFeedEventAttestation } from '../../apps/engine/src/escrow/event-attestations.js';

const FIXTURE_ID = 18_209_181;
const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function claimSpecification(period: 'FT' | 'FT_90'): string {
  return canonicalJson({
    claimType: 'match_winner', comparator: 'gte',
    entityRef: { kind: 'team', name: 'France', participant: 1 },
    fixtureId: FIXTURE_ID, period, threshold: 1, trustTier: 'chain_proven',
  });
}

async function main(): Promise<void> {
  if (required('SOLANA_NETWORK') !== 'devnet') throw new Error('probe is devnet-only');
  const rpcUrl = required('SOLANA_RPC_URL');
  const connection = new Connection(rpcUrl, 'finalized');
  const genesisHash = await connection.getGenesisHash();
  if (genesisHash !== DEVNET_GENESIS) throw new Error('RPC is not public Solana devnet');

  const programId = required('ESCROW_PROGRAM_ID');
  const program = new PublicKey(programId);
  const accounts = await connection.getProgramAccounts(program, { commitment: 'finalized' });
  const specs = [claimSpecification('FT_90'), claimSpecification('FT')];
  const candidates = accounts.flatMap(({ pubkey, account }) => {
    try {
      const market = decodeMarketAccount(account.data);
      const spec = specs.find((value) => sha256(value) === bytesToHex(market.claimSpecificationHash));
      return market.state === 'open' && market.fixtureId === BigInt(FIXTURE_ID) && spec !== undefined
        ? [{ pubkey, market, spec }]
        : [];
    } catch {
      return [];
    }
  }).sort((left, right) => Number(right.market.resolutionDeadline - left.market.resolutionDeadline));
  const requestedMarketId = required('FREEZE_PROBE_MARKET_ID');
  const selected = candidates.find((value) => value.market.marketUuid === requestedMarketId);
  if (selected === undefined) throw new Error('no matching open public-devnet market');

  const snapshot = new URL(`/api/scores/snapshot/${FIXTURE_ID}`, required('TXLINE_API_BASE'));
  const response = await fetch(snapshot, {
    headers: {
      authorization: `Bearer ${required('TXLINE_GUEST_JWT')}`,
      'x-api-token': required('TXLINE_API_TOKEN'),
      accept: 'application/json',
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`TxLINE snapshot failed with HTTP ${response.status}`);
  const raw: unknown = await response.json();
  if (!Array.isArray(raw)) throw new Error('TxLINE snapshot is not an array');
  const records = raw.map((value) => scoresRecordSchema.parse(value));
  const events = normalizeScores(records, Date.now(), { logger() {} });
  const event = events.find((value) => value.kind === 'possible_event' && value.confirmed);
  if (event === undefined) throw new Error('fixture has no deterministic freeze signal');

  const marketPda = selected.pubkey.toBase58();
  const issuedAt = BigInt(process.env.FREEZE_PROBE_ISSUED_AT ?? Math.floor(Date.now() / 1_000));
  const attestation = buildEscrowFeedEventAttestation({
    deployment: { genesisHash, programId },
    market: {
      marketId: selected.market.marketUuid,
      marketPda,
      marketDocumentHashHex: bytesToHex(selected.market.marketDocumentHash),
      fixtureId: selected.market.fixtureId,
      oracleSetEpoch: selected.market.oracleSetEpoch,
      eventEpoch: selected.market.eventEpoch,
    },
    event,
    issuedAt,
    ttlSeconds: 300n,
    eventKind: 'freeze',
  });

  const configuredSigners = required('ESCROW_ORACLE_SIGNERS').split(',');
  const endpoints = JSON.parse(required('ESCROW_ORACLE_SIGNER_ENDPOINTS_JSON')) as Array<{
    readonly url: string;
    readonly bearerToken?: string;
  }>;
  const provider = createHttpsEscrowOracleAttestationProvider({
    endpoints: endpoints.map((endpoint, index) => ({
      ...endpoint,
      expectedSigner: configuredSigners[index]!,
    })),
    threshold: 2,
    forbiddenSignerAddresses: [required('ESCROW_CONFIG_AUTHORITY')],
  });
  const available = await provider.availableSigners();
  const signingRequest = {
    kind: 'feed_event' as const,
    attestation,
    claimSpecificationJson: selected.spec,
    evidenceCodecVersion: 2 as const,
  };
  const canonicalSha256Hex = createHash('sha256')
    .update(encodeFeedEventAttestationV1(attestation)).digest('hex');
  if (process.env.FREEZE_PROBE_DRY_RUN === 'true') {
    console.log(JSON.stringify({ issuedAt: String(issuedAt), canonicalSha256Hex }));
    return;
  }
  const signatures = await provider.sign(signingRequest, {
    oracleSetEpoch: selected.market.oracleSetEpoch,
    signers: configuredSigners,
    threshold: 2,
  });

  const unsigned = createUnsignedAttestationPayload({
    marketId: selected.market.marketUuid,
    documentHashHex: bytesToHex(selected.market.marketDocumentHash),
    claimSpecificationJson: selected.spec,
    eventEpoch: selected.market.eventEpoch,
    replay: selected.market.replay,
    oraclePolicy: {
      oracleSetEpoch: selected.market.oracleSetEpoch,
      signers: configuredSigners,
      threshold: 2,
    },
    request: {
      operation: 'freeze_market',
      marketPda,
      expectedEventEpoch: selected.market.eventEpoch,
      attestation,
    },
  });
  const unsignedPayloadHashHex = attestationPayloadHash(unsigned);
  const signed = createSignedAttestationPayload(unsignedPayloadHashHex, signatures);
  const signatureSigners = signatures.map((value) => new PublicKey(value.publicKey).toBase58());

  console.log(JSON.stringify({
    kind: 'public-devnet-freeze-quorum',
    state: 'signed',
    cluster: 'devnet',
    genesisHash,
    programId,
    marketId: selected.market.marketUuid,
    marketPda,
    marketState: selected.market.state,
    fixtureId: FIXTURE_ID,
    event: { seq: event.seq, kind: event.kind, confirmed: event.confirmed },
    canonicalSha256Hex,
    requestKey: attestationRequestKey(unsignedPayloadHashHex),
    unsignedPayloadHashHex,
    signedPayloadHashHex: attestationPayloadHash(signed),
    threshold: 2,
    availableSignerCount: available.length,
    availableSigners: available,
    signatureCount: signatures.length,
    signatureSigners,
    quorumValid: signatures.length >= 2 &&
      new Set(signatureSigners).size === signatures.length &&
      signatureSigners.every((value) => configuredSigners.includes(value)),
  }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'freeze quorum probe failed');
  process.exitCode = 1;
});
