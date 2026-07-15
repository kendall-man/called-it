import {
  createHash,
  createPrivateKey,
  sign as signBytes,
} from 'node:crypto';
import { base58Decode } from '@calledit/solana';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  createHttpsEscrowOracleAttestationProvider,
  createLocalEscrowOracleAttestationProvider,
  EscrowOracleSignerError,
  type EscrowAttestationSigningRequest,
} from './attestation-signers.js';

const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MARKET = Keypair.generate().publicKey;
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function request(): EscrowAttestationSigningRequest {
  return {
    kind: 'void',
    evidenceCodecVersion: 2,
    claimSpecificationJson: '{"claimType":"match_winner"}',
    attestation: {
      clusterGenesisHash: base58Decode(GENESIS_HASH),
      escrowProgramId: base58Decode(PROGRAM_ID),
      marketPda: MARKET.toBytes(),
      marketDocumentHash: new Uint8Array(32).fill(1),
      fixtureId: 77n,
      oracleSetEpoch: 9n,
      issuedAt: 100n,
      expiresAt: 200n,
      evidenceHash: new Uint8Array(32).fill(2),
      reason: 'cancelled',
      decidingSequence: 12n,
    },
  };
}

function detached(message: Uint8Array, signer: Keypair): string {
  const key = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  return signBytes(null, message, key).toString('base64');
}

type EndpointBehavior =
  | 'ok'
  | 'outage'
  | 'wrong_bytes'
  | 'wrong_identity'
  | 'wrong_epoch'
  | 'wrong_genesis'
  | 'wrong_program'
  | 'wrong_market'
  | 'wrong_evidence';

function endpointFetch(
  signers: readonly Keypair[],
  behavior: Readonly<Record<number, EndpointBehavior>> = {},
): typeof fetch {
  return (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const index = Number(url.hostname.slice(0, 1)) - 1;
    if (behavior[index] === 'outage') throw new Error('endpoint unavailable');
    if (init?.method === 'GET') {
      const signer = behavior[index] === 'wrong_identity' ? Keypair.generate() : signers[index];
      if (signer === undefined) throw new Error('missing test signer');
      return new Response(JSON.stringify({
        schemaVersion: 1,
        signerPubkey: signer.publicKey.toBase58(),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const signer = behavior[index] === 'wrong_identity' ? Keypair.generate() : signers[index];
    if (signer === undefined) throw new Error('missing test signer');
    const canonical = Buffer.from(String(body.canonicalBytesBase64), 'base64');
    const signed = behavior[index] === 'wrong_bytes'
      ? Buffer.from('different canonical bytes')
      : canonical;
    const responseBody: Record<string, unknown> = {
      ...body,
      signerPubkey: signer.publicKey.toBase58(),
      signatureBase64: detached(signed, signer),
      canonicalSha256Hex: behavior[index] === 'wrong_bytes'
        ? createHash('sha256').update(signed).digest('hex')
        : body.canonicalSha256Hex,
    };
    if (behavior[index] === 'wrong_epoch') responseBody.oracleSetEpoch = '10';
    if (behavior[index] === 'wrong_genesis') responseBody.clusterGenesisHashHex = '00'.repeat(32);
    if (behavior[index] === 'wrong_program') responseBody.programIdHex = '00'.repeat(32);
    if (behavior[index] === 'wrong_market') responseBody.marketPdaHex = '00'.repeat(32);
    if (behavior[index] === 'wrong_evidence') responseBody.evidenceHashHex = '00'.repeat(32);
    return new Response(JSON.stringify(responseBody), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function httpsProvider(
  signers: readonly Keypair[],
  behavior?: Readonly<Record<number, EndpointBehavior>>,
) {
  return createHttpsEscrowOracleAttestationProvider({
    endpoints: signers.map((signer, index) => ({
      url: `https://${index + 1}.oracle.example/sign`,
      expectedSigner: signer.publicKey.toBase58(),
      bearerToken: `token-${index}`,
    })),
    threshold: 2,
    forbiddenSignerAddresses: [],
    fetchImpl: endpointFetch(signers, behavior),
  });
}

describe('escrow oracle attestation providers', () => {
  it('returns an independently verified 2-of-3 HTTPS quorum over exact canonical bytes', async () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const signatures = await httpsProvider(signers).sign(request());

    expect(signatures.map((value) => Buffer.from(value.publicKey).toString('hex'))).toEqual(
      signers.slice(0, 2).map((value) => value.publicKey.toBuffer().toString('hex')),
    );
    expect(signatures.every((value) => value.signature.length === 64)).toBe(true);
  });

  it('rejects mixed canonical bytes instead of counting a disagreeing endpoint', async () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await expect(httpsProvider(signers, { 0: 'wrong_bytes', 2: 'outage' }).sign(request()))
      .rejects.toMatchObject({ code: 'quorum_unavailable' });
  });

  it('rejects a response from the wrong signer identity', async () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await expect(httpsProvider(signers, { 0: 'wrong_identity', 2: 'outage' }).sign(request()))
      .rejects.toMatchObject({ code: 'quorum_unavailable' });
  });

  it.each([
    'wrong_epoch', 'wrong_genesis', 'wrong_program', 'wrong_market', 'wrong_evidence',
  ] as const)('rejects a signer response with %s binding', async (tamper) => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    await expect(httpsProvider(signers, { 0: tamper, 2: 'outage' }).sign(request()))
      .rejects.toMatchObject({ code: 'quorum_unavailable' });
  });

  it('continues with two authorized endpoints when the third endpoint is down', async () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const provider = httpsProvider(signers, { 1: 'outage' });
    await expect(provider.sign(request())).resolves.toHaveLength(2);
    await expect(provider.availableSigners()).resolves.toEqual([
      signers[0]!.publicKey.toBase58(), signers[2]!.publicKey.toBase58(),
    ]);
  });

  it('uses a market-pinned historical oracle set after the deployment epoch rotates', async () => {
    const current = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const pinned = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const provider = createHttpsEscrowOracleAttestationProvider({
      endpoints: current.map((signer, index) => ({
        url: `https://${index + 1}.oracle.example/sign`,
        expectedSigner: signer.publicKey.toBase58(),
      })),
      threshold: 2,
      forbiddenSignerAddresses: [],
      fetchImpl: endpointFetch(pinned),
    });

    const signatures = await provider.sign(request(), {
      oracleSetEpoch: 9n,
      signers: pinned.map((value) => value.publicKey.toBase58()),
      threshold: 2,
    });

    expect(signatures.map((value) => Buffer.from(value.publicKey).toString('hex'))).toEqual(
      pinned.slice(0, 2).map((value) => value.publicKey.toBuffer().toString('hex')),
    );
  });

  it('hard-rejects local oracle key material on mainnet', () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    expect(() => createLocalEscrowOracleAttestationProvider({
      network: 'mainnet-beta',
      authorizedSignerAddresses: signers.map((value) => value.publicKey.toBase58()),
      signers,
      threshold: 2,
      forbiddenSignerAddresses: [],
    })).toThrowError(EscrowOracleSignerError);
  });

  it('rejects relayer or config authority reuse by either provider', () => {
    const signers = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    expect(() => createLocalEscrowOracleAttestationProvider({
      network: 'devnet',
      authorizedSignerAddresses: signers.map((value) => value.publicKey.toBase58()),
      signers,
      threshold: 2,
      forbiddenSignerAddresses: [signers[0]!.publicKey.toBase58()],
    })).toThrowError(/authority_reuse/);
  });
});
