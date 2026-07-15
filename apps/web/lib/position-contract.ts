import { z } from 'zod';

export const POSITION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const SOLANA_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_32_PATTERN = /^[0-9a-f]{64}$/;
const BASE64_TRANSACTION_PATTERN = /^[A-Za-z0-9+/]{1,4094}={0,2}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d{0,19})$/;
const POSITIVE_DECIMAL_PATTERN = /^[1-9]\d{0,19}$/;
const SOLANA_SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;

export const PositionTokenRequestSchema = z.object({
  token: z.string().regex(POSITION_TOKEN_PATTERN),
}).strict();

export const PositionIdentityRequestSchema = PositionTokenRequestSchema.extend({
  pubkey: z.string().regex(SOLANA_PUBKEY_PATTERN),
}).strict();

export const PositionSubmitRequestSchema = PositionIdentityRequestSchema.extend({
  rawTransactionBase64: z.string().max(4096).regex(BASE64_TRANSACTION_PATTERN),
}).strict();

export const PositionAuthorizationSchema = z.object({
  schemaVersion: z.literal(1),
  programId: z.string().regex(SOLANA_PUBKEY_PATTERN),
  relayerFeePayer: z.string().regex(SOLANA_PUBKEY_PATTERN),
  canonicalUsdcMint: z.string().regex(SOLANA_PUBKEY_PATTERN),
  marketUuid: z.string().regex(UUID_PATTERN),
  marketPda: z.string().regex(SOLANA_PUBKEY_PATTERN),
  marketDocumentHashHex: z.string().regex(HEX_32_PATTERN),
  side: z.enum(['back', 'doubt']),
  amount: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  asset: z.enum(['sol', 'usdc']),
  expectedRatioMilli: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  expectedEventEpoch: z.string().regex(DECIMAL_PATTERN),
  expectedLotNonce: z.string().regex(DECIMAL_PATTERN),
  expiresAt: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  genesisHash: z.string().min(1).max(128),
  recentBlockhash: z.string().min(32).max(128),
  lastValidBlockHeight: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  messageHashHex: z.string().regex(HEX_32_PATTERN),
}).strict();

export type PositionAuthorization = Readonly<z.infer<typeof PositionAuthorizationSchema>>;

export const PositionSessionSchema = z.object({
  ok: z.literal(true),
  state: z.enum(['pending', 'consumed']),
  user_id: z.union([z.number().int().positive(), z.string().regex(POSITIVE_DECIMAL_PATTERN)]),
  provider_user_id: z.string().min(1).max(255),
  provider_wallet_id: z.string().min(1).max(255),
  owner_pubkey: z.string().regex(SOLANA_PUBKEY_PATTERN),
  market_id: z.string().regex(UUID_PATTERN),
  side: z.enum(['back', 'doubt']),
  asset: z.enum(['sol', 'usdc']),
  amount_atomic: z.string().regex(POSITIVE_DECIMAL_PATTERN),
  lot_nonce: z.string().regex(DECIMAL_PATTERN),
  event_epoch: z.string().regex(DECIMAL_PATTERN),
  document_hash_hex: z.string().regex(HEX_32_PATTERN),
  transaction_message_hash_hex: z.string().regex(HEX_32_PATTERN),
  raw_transaction_base64: z.string().max(4096).regex(BASE64_TRANSACTION_PATTERN),
  authorization: PositionAuthorizationSchema,
  transaction_signature: z.string().regex(SOLANA_SIGNATURE_PATTERN).nullable(),
  expires_at: z.string().datetime({ offset: true }),
}).strict();

export type PositionSigningSession = {
  readonly state: 'pending' | 'consumed';
  readonly userId: number;
  readonly providerUserId: string;
  readonly providerWalletId: string;
  readonly ownerPubkey: string;
  readonly marketId: string;
  readonly side: 'back' | 'doubt';
  readonly asset: 'sol' | 'usdc';
  readonly amountAtomic: bigint;
  readonly lotNonce: bigint;
  readonly eventEpoch: bigint;
  readonly documentHashHex: string;
  readonly transactionMessageHashHex: string;
  readonly rawTransactionBase64: string;
  readonly authorization: PositionAuthorization;
  readonly transactionSignature: string | null;
  readonly expiresAt: string;
};

export type PositionIndexedStatus = {
  readonly stage: 'awaiting_signature' | 'confirming' | 'finalized' | 'unknown_confirmation';
  readonly signature: string | null;
  readonly positionState: 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed' | null;
  readonly commitment: 'confirmed' | 'finalized' | null;
};

export type EscrowAccountPosition = {
  readonly marketId: string;
  readonly side: 'back' | 'doubt';
  readonly asset: 'sol' | 'usdc';
  readonly depositedAtomic: string;
  readonly pendingAtomic: string;
  readonly activeAtomic: string;
  readonly refundableAtomic: string;
  readonly claimedAtomic: string;
  readonly chainState: string;
  readonly replay: boolean;
  readonly claimState: 'open' | 'pending' | 'checking' | 'ready' | 'claimed';
};

export const EngineAcceptResponseSchema = z.union([
  z.object({
    kind: z.literal('accepted'),
    duplicate: z.boolean(),
    jobCreated: z.boolean(),
    signature: z.string().regex(SOLANA_SIGNATURE_PATTERN),
  }).strict(),
  z.object({
    kind: z.literal('rejected'),
    code: z.string().min(1).max(80),
  }).strict(),
]);

export function positionAuthorizationForSdk(authorization: PositionAuthorization) {
  return {
    programId: authorization.programId,
    relayerFeePayer: authorization.relayerFeePayer,
    canonicalUsdcMint: authorization.canonicalUsdcMint,
    marketUuid: authorization.marketUuid,
    marketDocumentHash: Uint8Array.from(
      authorization.marketDocumentHashHex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [],
    ),
    side: authorization.side,
    amount: BigInt(authorization.amount),
    asset: authorization.asset,
    expectedRatioMilli: Number(authorization.expectedRatioMilli),
    expectedEventEpoch: BigInt(authorization.expectedEventEpoch),
    expectedLotNonce: BigInt(authorization.expectedLotNonce),
    expiresAt: BigInt(authorization.expiresAt),
  } as const;
}

export function parsePositionSigningSession(value: unknown): PositionSigningSession | null {
  const parsed = PositionSessionSchema.safeParse(value);
  if (!parsed.success) return null;
  const userId = Number(parsed.data.user_id);
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;
  return {
    state: parsed.data.state,
    userId,
    providerUserId: parsed.data.provider_user_id,
    providerWalletId: parsed.data.provider_wallet_id,
    ownerPubkey: parsed.data.owner_pubkey,
    marketId: parsed.data.market_id,
    side: parsed.data.side,
    asset: parsed.data.asset,
    amountAtomic: BigInt(parsed.data.amount_atomic),
    lotNonce: BigInt(parsed.data.lot_nonce),
    eventEpoch: BigInt(parsed.data.event_epoch),
    documentHashHex: parsed.data.document_hash_hex,
    transactionMessageHashHex: parsed.data.transaction_message_hash_hex,
    rawTransactionBase64: parsed.data.raw_transaction_base64,
    authorization: parsed.data.authorization,
    transactionSignature: parsed.data.transaction_signature,
    expiresAt: parsed.data.expires_at,
  };
}
