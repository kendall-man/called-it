import { createHash, createPrivateKey, sign as signBytes } from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import {
  createHttpsEscrowMarketAuthoritySigner,
  createLocalEscrowMarketAuthoritySigner,
  EscrowMarketAuthoritySignerError,
  type EscrowMarketAuthorityDeploymentBinding,
  type EscrowMarketAuthoritySigningRequest,
} from './market-authority-signer.js';

const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  network: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  genesisHash: z.string(),
  programId: z.string(),
  protocolConfigPda: z.string(),
  oracleSetPda: z.string(),
  oracleSetEpoch: z.string(),
  marketId: z.string(),
  marketPda: z.string(),
  vaultPda: z.string(),
  documentHashHex: z.string(),
  marketCreationAuthority: z.string(),
  transactionMessageBase64: z.string(),
  transactionMessageHashHex: z.string(),
}).strict();

function fixture() {
  const program = Keypair.generate();
  const config = Keypair.generate();
  const oracle = Keypair.generate();
  const market = Keypair.generate();
  const vault = Keypair.generate();
  const authority = Keypair.generate();
  const sponsor = Keypair.generate();
  const configAuthority = Keypair.generate();
  const oracleSigner = Keypair.generate();
  const message = Buffer.from('canonical-v0-transaction-message');
  const deployment: EscrowMarketAuthorityDeploymentBinding = {
    network: 'devnet', genesisHash: GENESIS, programId: program.publicKey.toBase58(),
    protocolConfigPda: config.publicKey.toBase58(), oracleSetPda: oracle.publicKey.toBase58(),
    oracleSetEpoch: 9n,
  };
  const request: EscrowMarketAuthoritySigningRequest = {
    ...deployment,
    marketId: '123e4567-e89b-12d3-a456-426614174000',
    marketPda: market.publicKey.toBase58(), vaultPda: vault.publicKey.toBase58(),
    documentHashHex: 'ab'.repeat(32), marketCreationAuthority: authority.publicKey.toBase58(),
    transactionMessageBase64: message.toString('base64'),
    transactionMessageHashHex: createHash('sha256').update(message).digest('hex'),
  };
  return { authority, sponsor, configAuthority, oracleSigner, deployment, request, message };
}

function signature(message: Uint8Array, signer: Keypair): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_SEED_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der', type: 'pkcs8',
  });
  return signBytes(null, message, privateKey).toString('base64');
}

function remoteFetch(input: {
  readonly fixture: ReturnType<typeof fixture>;
  readonly responseSigner?: Keypair;
  readonly mutate?: (value: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>;
  readonly unavailable?: boolean;
}): typeof fetch {
  return async (_url, init) => {
    if (input.unavailable) return new Response(null, { status: 503 });
    const signer = input.responseSigner ?? input.fixture.authority;
    if (init?.method === 'GET') {
      return Response.json({
        schemaVersion: 1, signerPubkey: signer.publicKey.toBase58(),
        network: input.fixture.deployment.network,
        genesisHash: input.fixture.deployment.genesisHash,
        programId: input.fixture.deployment.programId,
        protocolConfigPda: input.fixture.deployment.protocolConfigPda,
        oracleSetPda: input.fixture.deployment.oracleSetPda,
        oracleSetEpoch: String(input.fixture.deployment.oracleSetEpoch),
      });
    }
    const parsed: unknown = JSON.parse(String(init?.body));
    const envelope = envelopeSchema.parse(parsed);
    const response = {
      ...envelope,
      signerPubkey: signer.publicKey.toBase58(),
      signatureBase64: signature(Buffer.from(envelope.transactionMessageBase64, 'base64'), signer),
    };
    return Response.json(input.mutate?.(response) ?? response);
  };
}

function httpsProvider(
  value: ReturnType<typeof fixture>,
  fetchImpl: typeof fetch,
) {
  return createHttpsEscrowMarketAuthoritySigner({
    deployment: value.deployment,
    expectedAuthority: value.authority.publicKey.toBase58(),
    endpoint: { url: 'https://market-authority.example.test/sign', bearerToken: 'authority-token' },
    forbiddenSignerAddresses: [
      value.sponsor.publicKey.toBase58(), value.configAuthority.publicKey.toBase58(),
      value.oracleSigner.publicKey.toBase58(),
    ],
    forbiddenEndpointOrigins: ['https://oracle-1.example.test'],
    fetchImpl,
  });
}

describe('market creation authority signer', () => {
  it('signs a fully bound devnet message with a distinct local authority', async () => {
    const value = fixture();
    const provider = createLocalEscrowMarketAuthoritySigner({
      deployment: value.deployment, expectedAuthority: value.authority.publicKey.toBase58(),
      signer: value.authority, forbiddenSignerAddresses: [value.sponsor.publicKey.toBase58()],
    });

    await expect(provider.availableSigner()).resolves.toBe(value.authority.publicKey.toBase58());
    await expect(provider.sign(value.request)).resolves.toHaveLength(64);
  });

  it('rejects local key injection on mainnet and all authority reuse', () => {
    const value = fixture();
    expect(() => createLocalEscrowMarketAuthoritySigner({
      deployment: { ...value.deployment, network: 'mainnet-beta' },
      expectedAuthority: value.authority.publicKey.toBase58(), signer: value.authority,
      forbiddenSignerAddresses: [],
    })).toThrowError(new EscrowMarketAuthoritySignerError('mainnet_local_signer_forbidden'));
    expect(() => createLocalEscrowMarketAuthoritySigner({
      deployment: value.deployment, expectedAuthority: value.authority.publicKey.toBase58(),
      signer: value.authority, forbiddenSignerAddresses: [value.authority.publicKey.toBase58()],
    })).toThrowError(new EscrowMarketAuthoritySignerError('authority_reuse'));
    expect(() => createHttpsEscrowMarketAuthoritySigner({
      deployment: { ...value.deployment, network: 'mainnet-beta' },
      expectedAuthority: value.authority.publicKey.toBase58(),
      endpoint: { url: 'https://market-authority.example.test/sign' },
      forbiddenSignerAddresses: [],
    })).toThrowError(new EscrowMarketAuthoritySignerError('configuration_invalid'));
  });

  it('accepts one exact remote authority signature and reports readiness', async () => {
    const value = fixture();
    const provider = httpsProvider(value, remoteFetch({ fixture: value }));

    await expect(provider.availableSigner()).resolves.toBe(value.authority.publicKey.toBase58());
    await expect(provider.sign(value.request)).resolves.toHaveLength(64);
  });

  it('fails closed on endpoint outage or signer substitution', async () => {
    const value = fixture();
    const replacement = Keypair.generate();
    await expect(httpsProvider(value, remoteFetch({ fixture: value, unavailable: true })).sign(value.request))
      .rejects.toMatchObject({ code: 'signer_unavailable' });
    await expect(httpsProvider(value, remoteFetch({ fixture: value, responseSigner: replacement })).sign(value.request))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it.each([
    ['message', { transactionMessageHashHex: '00'.repeat(32) }],
    ['network', { network: 'mainnet-beta' }],
    ['program', { programId: Keypair.generate().publicKey.toBase58() }],
    ['market', { marketPda: Keypair.generate().publicKey.toBase58() }],
  ])('rejects a remote %s echo substitution', async (_label, replacement) => {
    const value = fixture();
    const provider = httpsProvider(value, remoteFetch({
      fixture: value,
      mutate: (response) => ({ ...response, ...replacement }),
    }));

    await expect(provider.sign(value.request)).rejects.toMatchObject({ code: 'identity_mismatch' });
  });

  it('rejects a request bound to the wrong deployment before calling the endpoint', async () => {
    const value = fixture();
    let calls = 0;
    const provider = httpsProvider(value, async () => {
      calls += 1;
      return new Response(null, { status: 500 });
    });

    await expect(provider.sign({ ...value.request, genesisHash: 'wrong-network' }))
      .rejects.toMatchObject({ code: 'identity_mismatch' });
    expect(calls).toBe(0);
  });

  it('rejects endpoint credential reuse by origin', () => {
    const value = fixture();
    expect(() => createHttpsEscrowMarketAuthoritySigner({
      deployment: value.deployment, expectedAuthority: value.authority.publicKey.toBase58(),
      endpoint: { url: 'https://oracle-1.example.test/market-sign' },
      forbiddenSignerAddresses: [], forbiddenEndpointOrigins: ['https://oracle-1.example.test'],
    })).toThrowError(new EscrowMarketAuthoritySignerError('authority_reuse'));
  });
});
