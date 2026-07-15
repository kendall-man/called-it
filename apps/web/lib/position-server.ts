import { createHash } from 'node:crypto';
import {
  deriveMarketPda,
  EscrowTransactionVerificationError,
  verifySponsoredPositionTransaction,
  verifySponsoredPositionTransactionBeforeUserSigning,
} from '@calledit/escrow-sdk';
import { Connection, VersionedTransaction } from '@solana/web3.js';
import { z } from 'zod';
import { loadWebEnv } from './env';
import {
  EngineAcceptResponseSchema,
  PositionIdentityRequestSchema,
  PositionSubmitRequestSchema,
  PositionTokenRequestSchema,
  positionAuthorizationForSdk,
  type PositionSigningSession,
} from './position-contract';
import {
  PrivyIdentityError,
  verifyPrivyWalletIdentity,
  type PrivyIdentityVerifier,
  type PrivyWalletIdentity,
} from './privy-server';
import {
  createPositionStore,
  hashPositionToken,
  type PositionSessionLookup,
  type PositionStore,
} from './position-store';
import { signWalletAuthJwt } from './wallet-auth-server';

export interface PositionApiResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

export type PositionServerConfig = {
  readonly appId: string;
  readonly canonicalUsdcMint: string;
  readonly custodyMode: 'legacy' | 'escrow';
  readonly engineToken: string;
  readonly engineUrl: string;
  readonly genesisHash: string;
  readonly issuer: string;
  readonly keyId: string;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly privateKeyBase64: string;
  readonly programId: string;
  readonly rpcUrl: string;
};

export interface PositionChainVerifier {
  genesisHash(): Promise<string>;
  blockHeight(): Promise<bigint>;
  blockhashValid(blockhash: string): Promise<boolean>;
}

export type PositionServerDependencies = {
  readonly chain?: PositionChainVerifier;
  readonly config?: PositionServerConfig;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly signAuthJwt?: (userId: number, expiresAt: number) => Promise<string>;
  readonly store?: PositionStore;
  readonly verifyIdentity?: PrivyIdentityVerifier;
};

const AccountRequestSchema = z.object({
  pubkey: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,64}$/),
}).strict();

const MIN_SESSION_LIFETIME_MS = 10_000;

export async function createPositionAuthSession(
  raw: unknown,
  dependencies: PositionServerDependencies = {},
): Promise<PositionApiResult> {
  const input = PositionTokenRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const config = dependencies.config ?? loadPositionServerConfig();
  if (config.custodyMode !== 'escrow') return refusal(404, 'escrow_not_enabled');
  const now = (dependencies.now ?? (() => new Date()))();
  const lookup = await (dependencies.store ?? createPositionStore()).readSession(
    hashPositionToken(input.data.token),
    now,
  );
  if (lookup.kind === 'rejected') return lookupRefusal(lookup);
  if (lookup.session.state !== 'pending') return refusal(409, 'session_consumed');
  const expiresAt = Date.parse(lookup.session.expiresAt);
  if (!Number.isFinite(expiresAt)) return refusal(410, 'session_expired');
  if (expiresAt - now.getTime() < MIN_SESSION_LIFETIME_MS) {
    return refusal(410, 'session_expired');
  }
  const sign = dependencies.signAuthJwt ?? ((userId, expiry) => signWalletAuthJwt({
    appId: config.appId,
    issuer: config.issuer,
    keyId: config.keyId,
    network: config.network,
    privateKeyBase64: config.privateKeyBase64,
  }, { userId, expiresAt: expiry }));
  const jwt = await sign(lookup.session.userId, expiresAt);
  return {
    status: 201,
    body: {
      jwt,
      expiresAt: new Date(expiresAt).toISOString(),
      network: config.network,
    },
  };
}

export async function prepareEscrowPosition(
  raw: unknown,
  accessToken: string,
  dependencies: PositionServerDependencies = {},
): Promise<PositionApiResult> {
  const input = PositionIdentityRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const context = await authenticatedContext(input.data, accessToken, dependencies);
  if ('result' in context) return context.result;
  if (context.session.state !== 'pending') return refusal(409, 'position_already_submitted');
  const bindingError = await verifyPreparedSession(context.session, context.identity, context, true);
  if (bindingError !== null) return bindingError;
  const displayTerms = await context.store.displayTerms(context.session.marketId);
  return {
    status: 200,
    body: {
      kind: 'prepared',
      rawTransactionBase64: context.session.rawTransactionBase64,
      authorization: context.session.authorization,
      terms: {
        title: displayTerms ?? 'This call',
        choice: context.session.side === 'back' ? 'It happens' : 'It does not',
        side: context.session.side,
        asset: context.session.asset,
        amountAtomic: context.session.amountAtomic.toString(),
      },
      expiresAt: context.session.expiresAt,
    },
  };
}

export async function submitEscrowPosition(
  raw: unknown,
  accessToken: string,
  dependencies: PositionServerDependencies = {},
): Promise<PositionApiResult> {
  const input = PositionSubmitRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const context = await authenticatedContext(input.data, accessToken, dependencies);
  if ('result' in context) return context.result;
  const bindingError = await verifyPreparedSession(context.session, context.identity, context, true);
  if (bindingError !== null) return bindingError;

  const prepared = deserializeTransaction(context.session.rawTransactionBase64);
  const signed = deserializeTransaction(input.data.rawTransactionBase64);
  if (prepared === null || signed === null || !sameBytes(
    prepared.message.serialize(),
    signed.message.serialize(),
  )) {
    return refusal(400, 'transaction_changed');
  }
  if (!sameBytes(prepared.signatures[0] ?? new Uint8Array(), signed.signatures[0] ?? new Uint8Array())) {
    return refusal(400, 'sponsor_signature_changed');
  }

  const verificationError = await verifyTransaction(
    signed,
    context.session,
    context.identity.pubkey,
    context,
    false,
  );
  if (verificationError !== null) return verificationError;

  let response: Response;
  try {
    response = await (dependencies.fetchImpl ?? fetch)(
      new URL('/api/escrow/positions/accept', context.config.engineUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${context.config.engineToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          token: input.data.token,
          telegramUserId: context.session.userId,
          privyUserId: context.session.providerUserId,
          privyWalletId: context.session.providerWalletId,
          ownerPubkey: context.session.ownerPubkey,
          marketId: context.session.marketId,
          rawTransactionBase64: input.data.rawTransactionBase64,
        }),
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      },
    );
  } catch {
    return refusal(503, 'unknown_confirmation');
  }
  const body = await safeJson(response);
  const parsed = EngineAcceptResponseSchema.safeParse(body);
  if (!parsed.success) return refusal(502, 'sponsor_unavailable');
  if (parsed.data.kind === 'rejected') {
    return refusal(engineRejectionStatus(parsed.data.code), parsed.data.code);
  }
  if (!response.ok) return refusal(502, 'sponsor_unavailable');
  return {
    status: 202,
    body: parsed.data,
  };
}

export async function getEscrowPositionStatus(
  raw: unknown,
  accessToken: string,
  dependencies: PositionServerDependencies = {},
): Promise<PositionApiResult> {
  const input = PositionIdentityRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const context = await authenticatedContext(input.data, accessToken, dependencies);
  if ('result' in context) return context.result;
  const bindingError = validateSessionBindings(context.session, context.identity, context.config);
  if (bindingError !== null) return bindingError;
  const status = await context.store.indexedStatus(context.session, context.now);
  return { status: 200, body: status };
}

export async function getEscrowAccountPositions(
  raw: unknown,
  accessToken: string,
  dependencies: PositionServerDependencies = {},
): Promise<PositionApiResult> {
  const input = AccountRequestSchema.safeParse(raw);
  if (!input.success) return refusal(400, 'invalid_request');
  const config = dependencies.config ?? loadPositionServerConfig();
  if (config.custodyMode !== 'escrow') return refusal(404, 'escrow_not_enabled');
  const identityResult = await identityForRequest(
    accessToken,
    input.data.pubkey,
    dependencies.verifyIdentity ?? verifyPrivyWalletIdentity,
  );
  if ('result' in identityResult) return identityResult.result;
  const positions = await (dependencies.store ?? createPositionStore()).accountPositions(
    identityResult.identity.pubkey,
  );
  return { status: 200, body: { positions } };
}

type AuthenticatedContext = {
  readonly chain: PositionChainVerifier;
  readonly config: PositionServerConfig;
  readonly identity: PrivyWalletIdentity;
  readonly now: Date;
  readonly session: PositionSigningSession;
  readonly store: PositionStore;
};

async function authenticatedContext(
  input: { readonly token: string; readonly pubkey: string },
  accessToken: string,
  dependencies: PositionServerDependencies,
): Promise<AuthenticatedContext | { readonly result: PositionApiResult }> {
  const config = dependencies.config ?? loadPositionServerConfig();
  if (config.custodyMode !== 'escrow') return { result: refusal(404, 'escrow_not_enabled') };
  const identityResult = await identityForRequest(
    accessToken,
    input.pubkey,
    dependencies.verifyIdentity ?? verifyPrivyWalletIdentity,
  );
  if ('result' in identityResult) return identityResult;
  const now = (dependencies.now ?? (() => new Date()))();
  const store = dependencies.store ?? createPositionStore();
  const lookup = await store.readSession(hashPositionToken(input.token), now);
  if (lookup.kind === 'rejected') return { result: lookupRefusal(lookup) };
  return {
    chain: dependencies.chain ?? createPositionChainVerifier(config.rpcUrl),
    config,
    identity: identityResult.identity,
    now,
    session: lookup.session,
    store,
  };
}

async function identityForRequest(
  accessToken: string,
  pubkey: string,
  verifier: PrivyIdentityVerifier,
): Promise<{ readonly identity: PrivyWalletIdentity } | { readonly result: PositionApiResult }> {
  try {
    return { identity: await verifier(accessToken, pubkey) };
  } catch (cause) {
    if (!(cause instanceof PrivyIdentityError)) throw cause;
    if (cause.code === 'unauthenticated') return { result: refusal(401, 'privy_auth_required') };
    if (cause.code === 'provider_unavailable') {
      return { result: refusal(503, 'sponsor_unavailable') };
    }
    return { result: refusal(403, 'identity_mismatch') };
  }
}

async function verifyPreparedSession(
  session: PositionSigningSession,
  identity: PrivyWalletIdentity,
  context: AuthenticatedContext,
  beforeSigning: boolean,
): Promise<PositionApiResult | null> {
  const bindingError = validateSessionBindings(session, identity, context.config);
  if (bindingError !== null) return bindingError;
  const expiresAt = Date.parse(session.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= context.now.getTime()) {
    return refusal(410, 'session_expired');
  }
  const transaction = deserializeTransaction(session.rawTransactionBase64);
  if (transaction === null) return refusal(503, 'sponsor_unavailable');
  if (transactionMessageHashHex(transaction) !== session.transactionMessageHashHex) {
    return refusal(409, 'binding_mismatch');
  }
  return verifyTransaction(transaction, session, identity.pubkey, context, beforeSigning);
}

function validateSessionBindings(
  session: PositionSigningSession,
  identity: PrivyWalletIdentity,
  config: PositionServerConfig,
): PositionApiResult | null {
  const authorization = session.authorization;
  const expiresAtUnix = BigInt(Math.floor(Date.parse(session.expiresAt) / 1_000));
  const expectedMarketPda = deriveMarketPda(config.programId, session.marketId).address;
  const ratio = BigInt(authorization.expectedRatioMilli);
  if (
    identity.telegramUserId !== String(session.userId) ||
    identity.privyUserId !== session.providerUserId ||
    identity.walletId !== session.providerWalletId ||
    identity.pubkey !== session.ownerPubkey
  ) {
    return refusal(403, 'identity_mismatch');
  }
  if (
    authorization.programId !== config.programId ||
    authorization.canonicalUsdcMint !== config.canonicalUsdcMint ||
    authorization.genesisHash !== config.genesisHash ||
    authorization.marketUuid !== session.marketId ||
    authorization.marketPda !== expectedMarketPda ||
    authorization.side !== session.side ||
    authorization.asset !== session.asset ||
    authorization.amount !== session.amountAtomic.toString() ||
    authorization.expectedEventEpoch !== session.eventEpoch.toString() ||
    authorization.expectedLotNonce !== session.lotNonce.toString() ||
    authorization.marketDocumentHashHex !== session.documentHashHex ||
    authorization.messageHashHex !== session.transactionMessageHashHex ||
    authorization.expiresAt !== expiresAtUnix.toString() ||
    ratio < 1n || ratio > 4_294_967_295n
  ) {
    return refusal(409, 'binding_mismatch');
  }
  return null;
}

async function verifyTransaction(
  transaction: VersionedTransaction,
  session: PositionSigningSession,
  ownerPubkey: string,
  context: Pick<AuthenticatedContext, 'chain' | 'config' | 'now'>,
  beforeSigning: boolean,
): Promise<PositionApiResult | null> {
  let observedGenesisHash: string;
  let currentBlockHeight: bigint;
  let blockhashValid: boolean;
  try {
    [observedGenesisHash, currentBlockHeight, blockhashValid] = await Promise.all([
      context.chain.genesisHash(),
      context.chain.blockHeight(),
      context.chain.blockhashValid(session.authorization.recentBlockhash),
    ]);
  } catch {
    return refusal(503, 'rpc_unavailable');
  }
  if (!blockhashValid) return refusal(410, 'expired_blockhash');
  const options = {
    ...positionAuthorizationForSdk(session.authorization),
    userWallet: ownerPubkey,
    expectedGenesisHash: context.config.genesisHash,
    observedGenesisHash,
    recentBlockhash: session.authorization.recentBlockhash,
    lastValidBlockHeight: BigInt(session.authorization.lastValidBlockHeight),
    currentBlockHeight,
    currentUnixTimestamp: BigInt(Math.floor(context.now.getTime() / 1_000)),
  };
  try {
    if (beforeSigning) {
      await verifySponsoredPositionTransactionBeforeUserSigning(transaction, options);
    } else {
      await verifySponsoredPositionTransaction(transaction, {
        ...options,
        requireRelayerSignature: true,
      });
    }
  } catch (cause) {
    if (cause instanceof EscrowTransactionVerificationError) {
      return refusal(
        cause.code === 'expired_blockhash' || cause.code === 'stale_intent' ? 410 : 409,
        verificationCode(cause.code),
      );
    }
    throw cause;
  }
  return null;
}

function loadPositionServerConfig(): PositionServerConfig {
  const env = loadWebEnv();
  if (
    env.NEXT_PUBLIC_ESCROW_PROGRAM_ID === undefined ||
    env.NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT === undefined ||
    env.ESCROW_GENESIS_HASH === undefined ||
    env.CONCIERGE_WALLET_API_URL === undefined ||
    env.WEB_CONCIERGE_TOKEN === undefined ||
    env.SOLANA_RPC_URL === undefined ||
    env.PRIVY_APP_ID === undefined ||
    env.WEB_BASE_URL === undefined ||
    env.WALLET_AUTH_PRIVATE_KEY === undefined ||
    env.WALLET_AUTH_KEY_ID === undefined
  ) {
    throw new Error('escrow position configuration unavailable');
  }
  return {
    appId: env.PRIVY_APP_ID,
    canonicalUsdcMint: env.NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT,
    custodyMode: env.NEXT_PUBLIC_WAGER_CUSTODY_MODE,
    engineToken: env.WEB_CONCIERGE_TOKEN,
    engineUrl: env.CONCIERGE_WALLET_API_URL,
    genesisHash: env.ESCROW_GENESIS_HASH,
    issuer: new URL(env.WEB_BASE_URL).origin,
    keyId: env.WALLET_AUTH_KEY_ID,
    network: env.NEXT_PUBLIC_SOLANA_NETWORK,
    privateKeyBase64: env.WALLET_AUTH_PRIVATE_KEY,
    programId: env.NEXT_PUBLIC_ESCROW_PROGRAM_ID,
    rpcUrl: env.SOLANA_RPC_URL,
  };
}

function createPositionChainVerifier(rpcUrl: string): PositionChainVerifier {
  const connection = new Connection(rpcUrl, 'confirmed');
  return {
    async genesisHash() {
      return connection.getGenesisHash();
    },
    async blockHeight() {
      return BigInt(await connection.getBlockHeight('confirmed'));
    },
    async blockhashValid(blockhash) {
      return (await connection.isBlockhashValid(blockhash, { commitment: 'confirmed' })).value;
    },
  };
}

function deserializeTransaction(value: string): VersionedTransaction | null {
  try {
    return VersionedTransaction.deserialize(Buffer.from(value, 'base64'));
  } catch {
    return null;
  }
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function verificationCode(code: string): string {
  switch (code) {
    case 'network_mismatch': return 'network_mismatch';
    case 'expired_blockhash':
    case 'stale_intent': return 'expired_blockhash';
    case 'unexpected_user_signature': return 'transaction_already_signed';
    case 'missing_user_signature': return 'wallet_did_not_sign';
    case 'invalid_user_signature': return 'wallet_signature_invalid';
    case 'missing_relayer_signature':
    case 'invalid_relayer_signature': return 'sponsor_signature_invalid';
    default: return 'binding_mismatch';
  }
}

function engineRejectionStatus(code: string): number {
  if (code === 'session_expired') return 410;
  if (code === 'session_not_found') return 404;
  return 409;
}

function lookupRefusal(lookup: Extract<PositionSessionLookup, { readonly kind: 'rejected' }>): PositionApiResult {
  if (lookup.code === 'session_expired') return refusal(410, lookup.code);
  if (lookup.code === 'session_not_found') return refusal(404, lookup.code);
  if (lookup.code === 'invalid_input') return refusal(400, lookup.code);
  return refusal(409, lookup.code);
}

function refusal(status: number, error: string): PositionApiResult {
  return { status, body: { error } };
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function transactionMessageHashHex(transaction: VersionedTransaction): string {
  return createHash('sha256').update(transaction.message.serialize()).digest('hex');
}
