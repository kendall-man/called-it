import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { after, test } from 'node:test';
import {
  bytesToHex,
  canonicalJson,
  escrowEvidenceSequenceCommitmentV2,
  normalizedEscrowEvidenceHashV2,
  settlementEvidenceHashV2,
} from '../../packages/escrow-sdk/dist/index.js';
import { base58Decode } from '../../packages/solana/dist/codecs.js';
import { createHttpsEscrowOracleAttestationProvider } from '../../apps/engine/dist/escrow/attestation-signers.js';
import { createOracleSignerServer } from '../../apps/oracle-signer/dist/server.js';

const require = createRequire(new URL('../../apps/engine/package.json', import.meta.url));
const { Keypair } = require('@solana/web3.js');
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const PROGRAM = Keypair.generate().publicKey;
const MARKET = Keypair.generate().publicKey;
const NOW_MS = 1_800_000_000_000;
const CLAIM = {
  claimType: 'match_winner', fixtureId: 77,
  entityRef: { kind: 'team', participant: 1, name: 'Home' },
  comparator: 'gte', threshold: 1, period: 'FT_90', trustTier: 'oracle_resolved',
};
const CLAIM_JSON = canonicalJson(CLAIM);
const EVENT = {
  kind: 'phase_change', fixtureId: 77, seq: 20,
  tsMs: NOW_MS - 20_000, receivedAtMs: NOW_MS - 19_000,
  confirmed: true, phase: 'F', minute: 90,
  score: {
    p1: { goals: 2, yellowCards: 0, redCards: 0, corners: 3 },
    p2: { goals: 1, yellowCards: 1, redCards: 0, corners: 2 },
    p1Goals90: 2, p2Goals90: 1,
  },
};

function request(outcome = 'claim_won') {
  const commitment = escrowEvidenceSequenceCommitmentV2(77, [20]);
  const root = normalizedEscrowEvidenceHashV2(EVENT);
  return {
    kind: 'settlement',
    claimSpecificationJson: CLAIM_JSON,
    evidenceCodecVersion: 2,
    attestation: {
      clusterGenesisHash: base58Decode(GENESIS), escrowProgramId: PROGRAM.toBytes(),
      marketPda: MARKET.toBytes(),
      marketDocumentHash: Uint8Array.from(createHash('sha256').update('market').digest()),
      fixtureId: 77n, oracleSetEpoch: 9n,
      issuedAt: BigInt(Math.floor(NOW_MS / 1_000) - 30),
      expiresAt: BigInt(Math.floor(NOW_MS / 1_000) + 300),
      evidenceHash: settlementEvidenceHashV2(commitment, root), outcome,
      decidingSequence: 20n, terminalPhase: 'F',
      regulationScore: { home: 2, away: 1 }, fullMatchScore: { home: 2, away: 1 },
      evidenceSequenceCommitment: commitment, normalizedEvidenceRoot: root,
    },
  };
}

const servers = [];
after(async () => {
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
});

test('built engine and three built signer servers share one exact envelope contract', async () => {
  const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const tokens = signers.map((_, index) => `signer-${index}-${'t'.repeat(32)}`);
  const localOrigins = new Map();
  for (const [index, signer] of signers.entries()) {
    const server = createOracleSignerServer({
      bearerToken: tokens[index], signer,
      verifier: {
        async verify(value, claimSpecificationJson) {
          assert.equal(claimSpecificationJson, CLAIM_JSON);
          assert.equal(value.kind, 'settlement');
          assert.equal(value.attestation.outcome, 'claim_won');
        },
      },
      journal: { async record() {} },
    });
    servers.push(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('signer server did not bind');
    localOrigins.set(`signer-${index}.calledit.test`, `http://127.0.0.1:${address.port}`);
  }

  const fetchImpl = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const origin = localOrigins.get(url.hostname);
    if (origin === undefined) throw new Error('unexpected signer host');
    return fetch(new URL(url.pathname, origin), init);
  };
  const provider = createHttpsEscrowOracleAttestationProvider({
    endpoints: signers.map((signer, index) => ({
      url: `https://signer-${index}.calledit.test/sign`,
      expectedSigner: signer.publicKey.toBase58(),
      bearerToken: tokens[index],
    })),
    threshold: 2, forbiddenSignerAddresses: [], fetchImpl,
  });
  const policy = {
    oracleSetEpoch: 9n,
    signers: signers.map((signer) => signer.publicKey.toBase58()),
    threshold: 2,
  };

  assert.deepEqual(await provider.availableSigners(), policy.signers);
  const signatures = await provider.sign(request(), policy);
  assert.equal(signatures.length, 2);
  assert.deepEqual(signatures.map((value) => bytesToHex(value.publicKey)),
    signers.slice(0, 2).map((signer) => bytesToHex(signer.publicKey.toBytes())));
  await assert.rejects(provider.sign(request('claim_lost'), policy), /quorum_unavailable/);
});
