import type {
  EscrowPlacementRejectionCode,
  EscrowTelegramPort,
  EscrowWalletSessionResult,
} from '../bot/escrow-ux.js';
import type { EscrowPlacementService } from './placement-service.js';
import { EscrowPlacementError } from './placement-types.js';

export interface EscrowPrivateWalletIdentityProvider {
  resolve(telegramUserId: number): Promise<{
    readonly telegramUserId: number;
    readonly privyUserId: string;
    readonly privyWalletId: string;
    readonly ownerPubkey: string;
  } | null>;
}

export interface EscrowPrivateWalletSessionProvider {
  create(input: {
    readonly telegramUserId: number;
    readonly idempotencyKey: string;
  }): Promise<EscrowWalletSessionResult>;
}

function rejection(error: unknown): EscrowPlacementRejectionCode {
  if (!(error instanceof EscrowPlacementError)) return 'temporarily_unavailable';
  switch (error.code) {
    case 'amount_out_of_range':
    case 'group_not_allowed':
      return 'amount_out_of_range';
    case 'market_unavailable':
    case 'market_not_found':
      return 'market_closed';
    case 'invalid_session_ttl':
    case 'blockhash_invalid':
      return 'callback_expired';
    default:
      return 'temporarily_unavailable';
  }
}

export function createEscrowTelegramPort(options: {
  readonly placement: EscrowPlacementService;
  readonly identities: EscrowPrivateWalletIdentityProvider;
  readonly walletSessions: EscrowPrivateWalletSessionProvider;
  readonly network: 'devnet' | 'mainnet-beta';
  readonly sessionTtlSeconds: number;
}): EscrowTelegramPort {
  return {
    async createPlacementSession(input) {
      if (input.network !== options.network) {
        return { kind: 'rejected', code: 'temporarily_unavailable' };
      }
      let identity: Awaited<ReturnType<EscrowPrivateWalletIdentityProvider['resolve']>>;
      try {
        identity = await options.identities.resolve(input.telegramUserId);
      } catch (error) {
        return { kind: 'rejected', code: 'temporarily_unavailable' };
      }
      if (identity === null || identity.telegramUserId !== input.telegramUserId) {
        return { kind: 'rejected', code: 'wallet_required' };
      }
      try {
        const result = await options.placement.create({
          ...identity,
          groupId: input.groupId,
          marketId: input.marketId,
          expectedAsset: input.asset,
          expectedReplay: input.replay,
          side: input.side,
          amountAtomic: input.amountAtomic,
          ttlSeconds: options.sessionTtlSeconds,
        });
        if (result.kind === 'blocked') {
          return {
            kind: 'rejected',
            code: result.reasons.includes('program_paused') ? 'paused' : 'temporarily_unavailable',
          };
        }
        if (result.authorization.asset !== input.asset) {
          return { kind: 'rejected', code: 'temporarily_unavailable' };
        }
        return {
          kind: 'created',
          token: result.token,
          expiresAt: new Date(Number(result.authorization.expiresAt) * 1_000).toISOString(),
          duplicate: false,
        };
      } catch (error) {
        return { kind: 'rejected', code: rejection(error) };
      }
    },
    createWalletSession(input) {
      return options.walletSessions.create(input);
    },
  };
}
