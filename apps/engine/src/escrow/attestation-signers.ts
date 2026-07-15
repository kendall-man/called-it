import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from 'node:crypto';
import {
  bytesToHex,
  encodeFeedEventAttestationV1,
  encodePositionInvalidationAttestationV1,
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
  type AttestationSignature,
  type FeedEventAttestationV1,
  type PositionInvalidationAttestationV1,
  type SettlementAttestationV1,
  type VoidAttestationV1,
} from '@calledit/escrow-sdk';
import { PublicKey, type Signer } from '@solana/web3.js';

export type EscrowAttestationSigningRequest =
  | { readonly kind: 'feed_event'; readonly attestation: FeedEventAttestationV1; readonly claimSpecificationJson: string; readonly evidenceCodecVersion: 2 }
  | { readonly kind: 'position_invalidation'; readonly attestation: PositionInvalidationAttestationV1; readonly claimSpecificationJson: string; readonly evidenceCodecVersion: 2 }
  | { readonly kind: 'settlement'; readonly attestation: SettlementAttestationV1; readonly claimSpecificationJson: string; readonly evidenceCodecVersion: 2 }
  | { readonly kind: 'void'; readonly attestation: VoidAttestationV1; readonly claimSpecificationJson: string; readonly evidenceCodecVersion: 2 };

export interface EscrowOracleAttestationProvider {
  sign(
    request: EscrowAttestationSigningRequest,
    policy?: EscrowOracleAttestationPolicy,
  ): Promise<readonly AttestationSignature[]>;
  availableSigners(): Promise<readonly string[]>;
}

export interface EscrowOracleAttestationPolicy {
  readonly oracleSetEpoch: bigint;
  readonly signers: readonly string[];
  readonly threshold: number;
}

export interface EscrowOracleSignerEndpoint {
  readonly url: string;
  readonly expectedSigner: string;
  readonly bearerToken?: string;
}

export class EscrowOracleSignerError extends Error {
  readonly name = 'EscrowOracleSignerError';

  constructor(readonly code:
    | 'configuration_invalid'
    | 'authority_reuse'
    | 'mainnet_local_signer_forbidden'
    | 'quorum_unavailable') {
    super(`escrow oracle signer rejected: ${code}`);
  }
}

interface CanonicalSigningEnvelope {
  readonly schemaVersion: 1;
  readonly kind: EscrowAttestationSigningRequest['kind'];
  readonly canonicalBytesBase64: string;
  readonly canonicalSha256Hex: string;
  readonly clusterGenesisHashHex: string;
  readonly programIdHex: string;
  readonly marketPdaHex: string;
  readonly marketDocumentHashHex: string;
  readonly oracleSetEpoch: string;
  readonly evidenceHashHex: string;
  readonly claimSpecificationJson: string;
  readonly evidenceCodecVersion: 2;
  readonly attestationJson: Readonly<Record<string, unknown>>;
}

interface SignerResponse extends CanonicalSigningEnvelope {
  readonly signerPubkey: string;
  readonly signatureBase64: string;
}

const ED25519_PKCS8_SEED_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED25519_SPKI_PUBLIC_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function canonicalBytes(request: EscrowAttestationSigningRequest): Uint8Array {
  switch (request.kind) {
    case 'feed_event': return encodeFeedEventAttestationV1(request.attestation);
    case 'position_invalidation': return encodePositionInvalidationAttestationV1(request.attestation);
    case 'settlement': return encodeSettlementAttestationV1(request.attestation);
    case 'void': return encodeVoidAttestationV1(request.attestation);
  }
}

function envelope(request: EscrowAttestationSigningRequest): CanonicalSigningEnvelope {
  const message = canonicalBytes(request);
  return {
    schemaVersion: 1,
    kind: request.kind,
    canonicalBytesBase64: Buffer.from(message).toString('base64'),
    canonicalSha256Hex: createHash('sha256').update(message).digest('hex'),
    clusterGenesisHashHex: bytesToHex(request.attestation.clusterGenesisHash),
    programIdHex: bytesToHex(request.attestation.escrowProgramId),
    marketPdaHex: bytesToHex(request.attestation.marketPda),
    marketDocumentHashHex: bytesToHex(request.attestation.marketDocumentHash),
    oracleSetEpoch: String(request.attestation.oracleSetEpoch),
    evidenceHashHex: bytesToHex(request.attestation.evidenceHash),
    claimSpecificationJson: request.claimSpecificationJson,
    evidenceCodecVersion: request.evidenceCodecVersion,
    attestationJson: JSON.parse(JSON.stringify(request.attestation, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value instanceof Uint8Array ? bytesToHex(value) : value)) as Readonly<Record<string, unknown>>,
  };
}

function canonicalJson(value: CanonicalSigningEnvelope): string {
  return JSON.stringify(value);
}

function validSignatureBase64(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 64 && bytes.toString('base64') === value;
}

function isExactResponse(
  value: unknown,
  expected: CanonicalSigningEnvelope,
): value is SignerResponse {
  if (value === null || typeof value !== 'object') return false;
  const response = value as Partial<SignerResponse>;
  return response.schemaVersion === expected.schemaVersion &&
    response.kind === expected.kind &&
    response.canonicalBytesBase64 === expected.canonicalBytesBase64 &&
    response.canonicalSha256Hex === expected.canonicalSha256Hex &&
    response.clusterGenesisHashHex === expected.clusterGenesisHashHex &&
    response.programIdHex === expected.programIdHex &&
    response.marketPdaHex === expected.marketPdaHex &&
    response.marketDocumentHashHex === expected.marketDocumentHashHex &&
    response.oracleSetEpoch === expected.oracleSetEpoch &&
    response.evidenceHashHex === expected.evidenceHashHex &&
    response.claimSpecificationJson === expected.claimSpecificationJson &&
    response.evidenceCodecVersion === expected.evidenceCodecVersion &&
    JSON.stringify(response.attestationJson) === JSON.stringify(expected.attestationJson) &&
    typeof response.signerPubkey === 'string' &&
    validSignatureBase64(response.signatureBase64);
}

function verifyEd25519(message: Uint8Array, signer: PublicKey, signature: Uint8Array): boolean {
  const publicKey = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PUBLIC_PREFIX, signer.toBuffer()]),
    format: 'der',
    type: 'spki',
  });
  return verifyBytes(null, message, publicKey, signature);
}

function signEd25519(message: Uint8Array, signer: Signer): Uint8Array {
  if (signer.secretKey.length !== 64) throw new EscrowOracleSignerError('configuration_invalid');
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_SEED_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der',
    type: 'pkcs8',
  });
  const signature = signBytes(null, message, privateKey);
  if (!verifyEd25519(message, signer.publicKey, signature)) {
    throw new EscrowOracleSignerError('configuration_invalid');
  }
  return signature;
}

function assertV1Set(signers: readonly string[], threshold: number): void {
  if (threshold !== 2 || signers.length !== 3 || new Set(signers).size !== 3) {
    throw new EscrowOracleSignerError('configuration_invalid');
  }
  try {
    for (const signer of signers) new PublicKey(signer);
  } catch {
    throw new EscrowOracleSignerError('configuration_invalid');
  }
}

function assertNoAuthorityReuse(signers: readonly string[], forbidden: readonly string[]): void {
  const forbiddenSet = new Set(forbidden);
  if (signers.some((signer) => forbiddenSet.has(signer))) {
    throw new EscrowOracleSignerError('authority_reuse');
  }
}

function policySigners(
  request: EscrowAttestationSigningRequest,
  policy: EscrowOracleAttestationPolicy | undefined,
  defaults: readonly string[],
  threshold: number,
  forbidden: readonly string[],
): readonly string[] {
  const signers = policy?.signers ?? defaults;
  const expectedThreshold = policy?.threshold ?? threshold;
  if (
    expectedThreshold !== threshold ||
    (policy !== undefined && policy.oracleSetEpoch !== request.attestation.oracleSetEpoch)
  ) throw new EscrowOracleSignerError('configuration_invalid');
  assertV1Set(signers, expectedThreshold);
  assertNoAuthorityReuse(signers, forbidden);
  return signers;
}

export function createHttpsEscrowOracleAttestationProvider(options: {
  readonly endpoints: readonly EscrowOracleSignerEndpoint[];
  readonly threshold: number;
  readonly forbiddenSignerAddresses: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): EscrowOracleAttestationProvider {
  const signers = options.endpoints.map((endpoint) => endpoint.expectedSigner);
  assertV1Set(signers, options.threshold);
  assertNoAuthorityReuse(signers, options.forbiddenSignerAddresses);
  const origins = new Set<string>();
  for (const endpoint of options.endpoints) {
    let url: URL;
    try {
      url = new URL(endpoint.url);
    } catch {
      throw new EscrowOracleSignerError('configuration_invalid');
    }
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || origins.has(url.origin)) {
      throw new EscrowOracleSignerError('configuration_invalid');
    }
    origins.add(url.origin);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers = (endpoint: EscrowOracleSignerEndpoint) => ({
    accept: 'application/json',
    ...(endpoint.bearerToken === undefined
      ? {}
      : { authorization: `Bearer ${endpoint.bearerToken}` }),
  });

  return {
    async availableSigners() {
      const available = await Promise.all(options.endpoints.map(async (endpoint) => {
        try {
          const response = await fetchImpl(new URL('/api/ready', endpoint.url), {
            method: 'GET',
            headers: headers(endpoint),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) return null;
          const value: unknown = await response.json();
          if (
            value === null || typeof value !== 'object' ||
            (value as { status?: unknown }).status !== 'ready' ||
            (value as { signerPubkey?: unknown }).signerPubkey !== endpoint.expectedSigner
          ) return null;
          return endpoint.expectedSigner;
        } catch {
          return null;
        }
      }));
      return available.filter((value): value is string => value !== null);
    },
    async sign(request, policy) {
      const authorizedSigners = policySigners(
        request, policy, signers, options.threshold, options.forbiddenSignerAddresses,
      );
      const expected = envelope(request);
      const message = Buffer.from(expected.canonicalBytesBase64, 'base64');
      const attempts = await Promise.all(options.endpoints.map(async (endpoint): Promise<AttestationSignature | null> => {
        try {
          const response = await fetchImpl(endpoint.url, {
            method: 'POST',
            headers: {
              ...headers(endpoint),
              'content-type': 'application/json',
            },
            body: canonicalJson(expected),
            signal: AbortSignal.timeout(timeoutMs),
          });
          if (!response.ok) return null;
          const value: unknown = await response.json();
          const endpointIndex = options.endpoints.indexOf(endpoint);
          if (!isExactResponse(value, expected) || value.signerPubkey !== authorizedSigners[endpointIndex]) return null;
          const signer = new PublicKey(value.signerPubkey);
          const signature = Buffer.from(value.signatureBase64, 'base64');
          if (!verifyEd25519(message, signer, signature)) return null;
          return { publicKey: signer.toBytes(), signature };
        } catch {
          return null;
        }
      }));
      const signatures = attempts.filter((value): value is AttestationSignature => value !== null);
      if (signatures.length < options.threshold) {
        throw new EscrowOracleSignerError('quorum_unavailable');
      }
      return signatures.slice(0, options.threshold);
    },
  };
}

export function createLocalEscrowOracleAttestationProvider(options: {
  readonly network: 'localnet' | 'devnet' | 'mainnet-beta';
  readonly authorizedSignerAddresses: readonly string[];
  readonly signers: readonly Signer[];
  readonly threshold: number;
  readonly forbiddenSignerAddresses: readonly string[];
}): EscrowOracleAttestationProvider {
  if (options.network === 'mainnet-beta') {
    throw new EscrowOracleSignerError('mainnet_local_signer_forbidden');
  }
  assertV1Set(options.authorizedSignerAddresses, options.threshold);
  const localAddresses = options.signers.map((signer) => signer.publicKey.toBase58());
  assertV1Set(localAddresses, options.threshold);
  if (
    localAddresses.some((address) => !options.authorizedSignerAddresses.includes(address)) ||
    options.authorizedSignerAddresses.some((address) => !localAddresses.includes(address))
  ) throw new EscrowOracleSignerError('configuration_invalid');
  assertNoAuthorityReuse(localAddresses, options.forbiddenSignerAddresses);

  return {
    async availableSigners() {
      return localAddresses;
    },
    async sign(request, policy) {
      const authorizedSigners = policySigners(
        request, policy, options.authorizedSignerAddresses, options.threshold,
        options.forbiddenSignerAddresses,
      );
      if (
        localAddresses.some((address) => !authorizedSigners.includes(address)) ||
        authorizedSigners.some((address) => !localAddresses.includes(address))
      ) throw new EscrowOracleSignerError('quorum_unavailable');
      const message = canonicalBytes(request);
      return options.signers.slice(0, options.threshold).map((signer) => ({
        publicKey: signer.publicKey.toBytes(),
        signature: signEd25519(message, signer),
      }));
    },
  };
}
