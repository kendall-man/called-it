import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import { PublicKey, type Signer } from '@solana/web3.js';
import { z } from 'zod';

export interface EscrowMarketAuthorityDeploymentBinding {
  readonly network: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly genesisHash: string;
  readonly programId: string;
  readonly protocolConfigPda: string;
  readonly oracleSetPda: string;
  readonly oracleSetEpoch: bigint;
}

export interface EscrowMarketAuthoritySigningRequest extends EscrowMarketAuthorityDeploymentBinding {
  readonly marketId: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly documentHashHex: string;
  readonly marketCreationAuthority: string;
  readonly transactionMessageBase64: string;
  readonly transactionMessageHashHex: string;
}

export interface EscrowMarketAuthoritySignerProvider {
  readonly authorityAddress: string;
  availableSigner(signal?: AbortSignal): Promise<string | null>;
  sign(request: EscrowMarketAuthoritySigningRequest): Promise<Uint8Array>;
}

export class EscrowMarketAuthoritySignerError extends Error {
  readonly name = 'EscrowMarketAuthoritySignerError';

  constructor(readonly code:
    | 'configuration_invalid'
    | 'authority_reuse'
    | 'mainnet_local_signer_forbidden'
    | 'identity_mismatch'
    | 'signer_unavailable'
    | 'signature_invalid') {
    super(`escrow market authority signer rejected: ${code}`);
  }
}

const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const canonicalBase64Schema = z.string().min(1).refine(
  (value) => Buffer.from(value, 'base64').toString('base64') === value,
);
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  network: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  genesisHash: z.string().min(1),
  programId: z.string().min(1),
  protocolConfigPda: z.string().min(1),
  oracleSetPda: z.string().min(1),
  oracleSetEpoch: z.string().regex(/^(?:0|[1-9]\d*)$/),
  marketId: z.string().min(1),
  marketPda: z.string().min(1),
  vaultPda: z.string().min(1),
  documentHashHex: hashSchema,
  marketCreationAuthority: z.string().min(1),
  transactionMessageBase64: canonicalBase64Schema,
  transactionMessageHashHex: hashSchema,
}).strict();
const identitySchema = z.object({
  schemaVersion: z.literal(1), signerPubkey: z.string().min(1),
  network: z.enum(['localnet', 'devnet', 'mainnet-beta']),
  genesisHash: z.string().min(1), programId: z.string().min(1),
  protocolConfigPda: z.string().min(1), oracleSetPda: z.string().min(1),
  oracleSetEpoch: z.string().regex(/^(?:0|[1-9]\d*)$/),
}).strict();
const responseSchema = envelopeSchema.extend({
  signerPubkey: z.string().min(1),
  signatureBase64: z.string().refine((value) => {
    const bytes = Buffer.from(value, 'base64');
    return bytes.length === 64 && bytes.toString('base64') === value;
  }),
}).strict();

type SigningEnvelope = z.infer<typeof envelopeSchema>;
const PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function assertPublicKeys(values: readonly string[]): void {
  try {
    for (const value of values) new PublicKey(value);
  } catch (error) {
    if (error instanceof Error) throw new EscrowMarketAuthoritySignerError('configuration_invalid');
    throw error;
  }
}

function assertDistinct(expectedAuthority: string, forbidden: readonly string[]): void {
  assertPublicKeys([expectedAuthority, ...forbidden]);
  if (new Set(forbidden).has(expectedAuthority)) {
    throw new EscrowMarketAuthoritySignerError('authority_reuse');
  }
}

function sameDeployment(
  request: EscrowMarketAuthorityDeploymentBinding,
  expected: EscrowMarketAuthorityDeploymentBinding,
): boolean {
  return request.network === expected.network && request.genesisHash === expected.genesisHash &&
    request.programId === expected.programId && request.protocolConfigPda === expected.protocolConfigPda &&
    request.oracleSetPda === expected.oracleSetPda && request.oracleSetEpoch === expected.oracleSetEpoch;
}

function envelope(
  request: EscrowMarketAuthoritySigningRequest,
  deployment: EscrowMarketAuthorityDeploymentBinding,
  authority: string,
): SigningEnvelope {
  if (!sameDeployment(request, deployment) || request.marketCreationAuthority !== authority) {
    throw new EscrowMarketAuthoritySignerError('identity_mismatch');
  }
  const parsed = envelopeSchema.safeParse({
    schemaVersion: 1, network: request.network, genesisHash: request.genesisHash,
    programId: request.programId, protocolConfigPda: request.protocolConfigPda,
    oracleSetPda: request.oracleSetPda, oracleSetEpoch: String(request.oracleSetEpoch),
    marketId: request.marketId, marketPda: request.marketPda, vaultPda: request.vaultPda,
    documentHashHex: request.documentHashHex.toLowerCase(),
    marketCreationAuthority: request.marketCreationAuthority,
    transactionMessageBase64: request.transactionMessageBase64,
    transactionMessageHashHex: request.transactionMessageHashHex.toLowerCase(),
  });
  if (!parsed.success) throw new EscrowMarketAuthoritySignerError('identity_mismatch');
  const message = Buffer.from(parsed.data.transactionMessageBase64, 'base64');
  if (createHash('sha256').update(message).digest('hex') !== parsed.data.transactionMessageHashHex) {
    throw new EscrowMarketAuthoritySignerError('identity_mismatch');
  }
  assertPublicKeys([
    parsed.data.programId, parsed.data.protocolConfigPda, parsed.data.oracleSetPda,
    parsed.data.marketPda, parsed.data.vaultPda, parsed.data.marketCreationAuthority,
  ]);
  return parsed.data;
}

function verifySignature(message: Uint8Array, authority: string, signature: Uint8Array): boolean {
  const publicKey = createPublicKey({
    key: Buffer.concat([SPKI_PUBLIC_PREFIX, new PublicKey(authority).toBuffer()]),
    format: 'der', type: 'spki',
  });
  return verifyBytes(null, message, publicKey, signature);
}

function localSignature(message: Uint8Array, signer: Signer): Uint8Array {
  if (signer.secretKey.length !== 64) throw new EscrowMarketAuthoritySignerError('configuration_invalid');
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_SEED_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der', type: 'pkcs8',
  });
  return signBytes(null, message, privateKey);
}

export function createLocalEscrowMarketAuthoritySigner(options: {
  readonly deployment: EscrowMarketAuthorityDeploymentBinding;
  readonly expectedAuthority: string;
  readonly signer: Signer;
  readonly forbiddenSignerAddresses: readonly string[];
}): EscrowMarketAuthoritySignerProvider {
  if (options.deployment.network === 'mainnet-beta') {
    throw new EscrowMarketAuthoritySignerError('mainnet_local_signer_forbidden');
  }
  assertDistinct(options.expectedAuthority, options.forbiddenSignerAddresses);
  if (options.signer.publicKey.toBase58() !== options.expectedAuthority) {
    throw new EscrowMarketAuthoritySignerError('configuration_invalid');
  }
  return {
    authorityAddress: options.expectedAuthority,
    async availableSigner() { return options.expectedAuthority; },
    async sign(request) {
      const value = envelope(request, options.deployment, options.expectedAuthority);
      const message = Buffer.from(value.transactionMessageBase64, 'base64');
      const signature = localSignature(message, options.signer);
      if (!verifySignature(message, options.expectedAuthority, signature)) {
        throw new EscrowMarketAuthoritySignerError('signature_invalid');
      }
      return signature;
    },
  };
}

export function createHttpsEscrowMarketAuthoritySigner(options: {
  readonly deployment: EscrowMarketAuthorityDeploymentBinding;
  readonly expectedAuthority: string;
  readonly endpoint: { readonly url: string; readonly bearerToken?: string };
  readonly forbiddenSignerAddresses: readonly string[];
  readonly forbiddenEndpointOrigins?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): EscrowMarketAuthoritySignerProvider {
  assertDistinct(options.expectedAuthority, options.forbiddenSignerAddresses);
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpoint.url);
  } catch (error) {
    if (error instanceof Error) throw new EscrowMarketAuthoritySignerError('configuration_invalid');
    throw error;
  }
  if (endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '') {
    throw new EscrowMarketAuthoritySignerError('configuration_invalid');
  }
  if (options.deployment.network === 'mainnet-beta' && options.endpoint.bearerToken === undefined) {
    throw new EscrowMarketAuthoritySignerError('configuration_invalid');
  }
  if (new Set(options.forbiddenEndpointOrigins ?? []).has(endpoint.origin)) {
    throw new EscrowMarketAuthoritySignerError('authority_reuse');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers = {
    accept: 'application/json',
    ...(options.endpoint.bearerToken === undefined ? {} : { authorization: `Bearer ${options.endpoint.bearerToken}` }),
  };
  const signal = (external?: AbortSignal) => external === undefined
    ? AbortSignal.timeout(timeoutMs)
    : AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
  return {
    authorityAddress: options.expectedAuthority,
    async availableSigner(externalSignal) {
      try {
        const response = await fetchImpl(endpoint, { method: 'GET', headers, signal: signal(externalSignal) });
        if (!response.ok) return null;
        const parsed = identitySchema.safeParse(await response.json());
        if (!parsed.success) return null;
        const value = parsed.data;
        return value.signerPubkey === options.expectedAuthority && value.network === options.deployment.network &&
          value.genesisHash === options.deployment.genesisHash && value.programId === options.deployment.programId &&
          value.protocolConfigPda === options.deployment.protocolConfigPda &&
          value.oracleSetPda === options.deployment.oracleSetPda &&
          BigInt(value.oracleSetEpoch) === options.deployment.oracleSetEpoch
          ? options.expectedAuthority : null;
      } catch (error) {
        if (error instanceof Error) return null;
        throw error;
      }
    },
    async sign(request) {
      const expected = envelope(request, options.deployment, options.expectedAuthority);
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify(expected), signal: signal(),
        });
        if (!response.ok) throw new EscrowMarketAuthoritySignerError('signer_unavailable');
        const parsed = responseSchema.safeParse(await response.json());
        if (!parsed.success) throw new EscrowMarketAuthoritySignerError('identity_mismatch');
        const { signerPubkey, signatureBase64, ...echoed } = parsed.data;
        if (signerPubkey !== options.expectedAuthority || JSON.stringify(echoed) !== JSON.stringify(expected)) {
          throw new EscrowMarketAuthoritySignerError('identity_mismatch');
        }
        const message = Buffer.from(expected.transactionMessageBase64, 'base64');
        const signature = Buffer.from(signatureBase64, 'base64');
        if (!verifySignature(message, options.expectedAuthority, signature)) {
          throw new EscrowMarketAuthoritySignerError('signature_invalid');
        }
        return signature;
      } catch (error) {
        if (error instanceof EscrowMarketAuthoritySignerError) throw error;
        if (error instanceof Error) throw new EscrowMarketAuthoritySignerError('signer_unavailable');
        throw error;
      }
    },
  };
}
