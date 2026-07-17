import type { ServerResponse } from 'node:http';
import type { Deps } from '../ports.js';
import type { Env } from '../env.js';
import { createAccountRateLimiter, type AccountRateLimiter } from './account-rate-limit.js';
import { handleCreateChallenge, handleVerifyChallenge } from './account-challenges.js';
import {
  handleCancelIntent,
  handleConfirmIntent,
  handleCreateIntent,
  handleFundingObserved,
  handleReadActiveIntent,
} from './account-intents.js';
import { handleAccountState } from './account-state.js';
import { sendJson } from './server-http.js';

export type WalletLinkChallenge = {
  readonly webBaseUrl: string;
  readonly telegramUserId: number;
  readonly pubkey: string;
  readonly cluster: string;
  readonly nonce: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly challengeId: string;
};

export type WalletLinkVerifier = {
  readonly build: (challenge: WalletLinkChallenge) =>
    | { readonly ok: true; readonly message: string; readonly bytes: Uint8Array }
    | { readonly ok: false; readonly code: string };
  readonly verify: (
    payload: unknown,
    challenge: WalletLinkChallenge,
    clock: { readonly now: () => Date },
  ) => { readonly ok: true } | { readonly ok: false; readonly code: string };
};

export type StoredWalletChallenge = {
  readonly challenge: WalletLinkChallenge;
  readonly challengeHashHex: string;
};

export type AccountApiContext = {
  readonly deps: Deps;
  readonly env: Env;
  readonly walletLinkVerifier: WalletLinkVerifier;
  readonly rateLimiter: AccountRateLimiter;
  readonly challenges: Map<string, StoredWalletChallenge>;
};

export interface AccountApi {
  handle(input: {
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
    readonly res: ServerResponse;
  }): Promise<boolean>;
}

export function createAccountApi(
  deps: Deps,
  env: Env,
  walletLinkVerifier: WalletLinkVerifier,
): AccountApi {
  const context: AccountApiContext = {
    deps,
    env,
    walletLinkVerifier,
    rateLimiter: createAccountRateLimiter(deps.now),
    challenges: new Map(),
  };
  return {
    async handle({ method, path, body, res }) {
      if (method !== 'POST') return false;
      if (path === '/api/account/challenges') return handleCreateChallenge(context, body, res);
      if (path === '/api/account/challenges/verify') return handleVerifyChallenge(context, body, res);
      if (path === '/api/account/state') return handleAccountState(context, body, res);
      if (path === '/api/account/stake-intents') return handleCreateIntent(context, body, res);
      if (path === '/api/account/stake-intents/active') return handleReadActiveIntent(context, body, res);
      const match = path.match(/^\/api\/account\/stake-intents\/([0-9a-f-]{36})\/(cancel|funding-observed|confirm)$/i);
      if (match === null) return false;
      const intentId = match[1];
      const action = match[2];
      if (intentId === undefined || action === undefined) {
        sendJson(res, 404, { error: 'not_found' });
        return true;
      }
      const intentOperation = { context, intentId, rawBody: body, res };
      if (action === 'cancel') return handleCancelIntent(intentOperation);
      if (action === 'funding-observed') return handleFundingObserved(intentOperation);
      return handleConfirmIntent(intentOperation);
    },
  };
}
