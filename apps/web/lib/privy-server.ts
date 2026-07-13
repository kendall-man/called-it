import { PrivyClient, verifyAccessToken } from '@privy-io/node';
import { z } from 'zod';
import { loadWebEnv } from './env';
import { parseWalletAuthSubject } from './wallet-auth-subject';

const SOLANA_PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const MAX_ACCESS_TOKEN_LENGTH = 8_192;

const PrivyUserSchema = z.object({
  id: z.string().min(1).max(255),
  linked_accounts: z.array(z.unknown()),
}).passthrough();

const CustomAuthAccountSchema = z.object({
  type: z.literal('custom_auth'),
  custom_user_id: z.string().min(1).max(255),
}).passthrough();

const EmbeddedSolanaWalletSchema = z.object({
  type: z.literal('wallet'),
  id: z.string().min(1).max(255).nullable(),
  address: z.string().regex(SOLANA_PUBKEY_PATTERN),
  public_key: z.string().regex(SOLANA_PUBKEY_PATTERN),
  chain_type: z.literal('solana'),
  connector_type: z.literal('embedded'),
  wallet_client_type: z.literal('privy'),
}).passthrough();

export type PrivyIdentityErrorCode =
  | 'unauthenticated'
  | 'identity_mismatch'
  | 'wallet_not_owned'
  | 'provider_unavailable';

export type PrivyWalletIdentity = {
  readonly privyUserId: string;
  readonly telegramUserId: string;
  readonly walletId: string;
  readonly pubkey: string;
};

export type PrivyIdentityVerifier = (
  accessToken: string,
  expectedWalletAddress: string,
) => Promise<PrivyWalletIdentity>;

export class PrivyIdentityError extends Error {
  readonly name = 'PrivyIdentityError';

  constructor(
    readonly code: PrivyIdentityErrorCode,
    options?: ErrorOptions,
  ) {
    super(code, options);
  }
}

export function readPrivyBearerToken(header: string | null): string | null {
  if (header === null) return null;
  const match = /^Bearer ([^\s]+)$/.exec(header);
  const token = match?.[1];
  if (token === undefined || token.length < 16 || token.length > MAX_ACCESS_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

export function resolvePrivyWalletIdentity(
  rawUser: unknown,
  tokenUserId: string,
  expectedWalletAddress: string,
  expectedNetwork: 'devnet' | 'mainnet-beta',
): PrivyWalletIdentity {
  const user = PrivyUserSchema.safeParse(rawUser);
  if (!user.success || user.data.id !== tokenUserId) {
    throw new PrivyIdentityError('identity_mismatch');
  }
  const customAuth = user.data.linked_accounts
    .map((account) => CustomAuthAccountSchema.safeParse(account))
    .find((account) => account.success);
  if (customAuth === undefined || !customAuth.success) {
    throw new PrivyIdentityError('identity_mismatch');
  }
  const authSubject = parseWalletAuthSubject(customAuth.data.custom_user_id);
  if (authSubject === null || authSubject.network !== expectedNetwork) {
    throw new PrivyIdentityError('identity_mismatch');
  }
  const wallet = user.data.linked_accounts
    .map((account) => EmbeddedSolanaWalletSchema.safeParse(account))
    .find((account) => (
      account.success &&
      account.data.address === expectedWalletAddress &&
      account.data.public_key === expectedWalletAddress
    ));
  if (wallet === undefined || !wallet.success) {
    throw new PrivyIdentityError('wallet_not_owned');
  }
  return {
    privyUserId: user.data.id,
    telegramUserId: authSubject.telegramUserId,
    walletId: wallet.data.id ?? `solana:${wallet.data.address}`,
    pubkey: wallet.data.address,
  };
}

export function isPrivySessionOwner(
  identity: PrivyWalletIdentity,
  telegramUserId: number,
): boolean {
  return Number.isSafeInteger(telegramUserId) && telegramUserId > 0 &&
    identity.telegramUserId === String(telegramUserId);
}

export const verifyPrivyWalletIdentity: PrivyIdentityVerifier = async (
  accessToken,
  expectedWalletAddress,
) => {
  const env = loadWebEnv();
  if (
    !env.WALLET_MINIAPP_ENABLED || env.WALLET_PROVIDER !== 'privy' ||
    env.PRIVY_APP_ID === undefined || env.PRIVY_APP_SECRET === undefined ||
    env.PRIVY_JWT_VERIFICATION_KEY === undefined
  ) {
    throw new PrivyIdentityError('provider_unavailable');
  }

  let token: Awaited<ReturnType<typeof verifyAccessToken>>;
  try {
    token = await verifyAccessToken({
      access_token: accessToken,
      app_id: env.PRIVY_APP_ID,
      verification_key: env.PRIVY_JWT_VERIFICATION_KEY,
    });
  } catch (cause) {
    throw new PrivyIdentityError('unauthenticated', { cause });
  }

  const client = new PrivyClient({
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    jwtVerificationKey: env.PRIVY_JWT_VERIFICATION_KEY,
  });
  let user: unknown;
  try {
    user = await client.users()._get(token.user_id);
  } catch (cause) {
    throw new PrivyIdentityError('provider_unavailable', { cause });
  }
  return resolvePrivyWalletIdentity(
    user,
    token.user_id,
    expectedWalletAddress,
    env.NEXT_PUBLIC_SOLANA_NETWORK,
  );
};
