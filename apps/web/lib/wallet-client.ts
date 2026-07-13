import { z } from 'zod';

const ChallengeSchema = z.object({
  challengeId: z.string().uuid(),
  message: z.string().min(1),
}).strict();

const VerificationSchema = z.object({
  wallet: z.object({
    status: z.literal('verified'),
    pubkey: z.string().min(32),
  }).strict(),
}).strict();

const ErrorSchema = z.object({ error: z.string() }).passthrough();

export class WalletClientError extends Error {
  readonly name = 'WalletClientError';

  constructor(readonly code: string) {
    super(code);
  }
}

export async function linkPrivyWallet(input: {
  readonly sessionToken: string;
  readonly accessToken: string;
  readonly pubkey: string;
  readonly signMessage: (message: Uint8Array) => Promise<Uint8Array>;
}): Promise<void> {
  const challengeResponse = await fetch('/api/wallet/challenge', {
    method: 'POST',
    headers: authorizationHeaders(input.accessToken),
    cache: 'no-store',
    body: JSON.stringify({ token: input.sessionToken, pubkey: input.pubkey }),
  });
  const challengeBody = await responseJson(challengeResponse);
  const challenge = ChallengeSchema.safeParse(challengeBody);
  if (!challengeResponse.ok || !challenge.success) {
    throw new WalletClientError(responseError(challengeBody));
  }

  const signature = await input.signMessage(new TextEncoder().encode(challenge.data.message));
  const verifyResponse = await fetch('/api/wallet/verify', {
    method: 'POST',
    headers: authorizationHeaders(input.accessToken),
    cache: 'no-store',
    body: JSON.stringify({
      token: input.sessionToken,
      pubkey: input.pubkey,
      challengeId: challenge.data.challengeId,
      signatureHex: bytesToHex(signature),
    }),
  });
  const verifyBody = await responseJson(verifyResponse);
  if (!verifyResponse.ok || !VerificationSchema.safeParse(verifyBody).success) {
    throw new WalletClientError(responseError(verifyBody));
  }
}

export function walletClientErrorMessage(cause: unknown): string {
  const code = cause instanceof WalletClientError ? cause.code : '';
  switch (code) {
    case 'wallet_link_expired':
    case 'challenge_expired':
    case 'session_invalid':
      return 'This private link expired. Return to Telegram and open /wallet again.';
    case 'privy_auth_required':
      return 'Your secure wallet session expired. Sign in with Telegram again.';
    case 'privy_identity_invalid':
    case 'privy_identity_reserved':
    case 'privy_wallet_reserved':
      return 'This wallet does not match the Telegram account that opened it.';
    case 'balance_nonzero':
      return 'Move or withdraw your Called It balance before changing wallets.';
    case 'positions_open':
      return 'Wait for your open positions to settle before changing wallets.';
    case 'withdrawal_pending':
      return 'Wait for the current withdrawal before changing wallets.';
    case 'pubkey_reserved':
      return 'This wallet is already linked to another Telegram account.';
    default:
      return 'Wallet verification failed. Return to Telegram and try /wallet again.';
  }
}

function authorizationHeaders(accessToken: string): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
  };
}

async function responseJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function responseError(value: unknown): string {
  const parsed = ErrorSchema.safeParse(value);
  return parsed.success ? parsed.data.error : 'wallet_service_unavailable';
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
