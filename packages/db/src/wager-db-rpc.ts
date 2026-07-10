import { DbError, unwrapRows } from './errors.js';
import {
  assertSafeInteger,
  isNonEmptyString,
  isStakeErrorCode,
  isUuid,
  isWithdrawErrorCode,
  lamportsToDb,
  parseRpcOutcome,
  type WagerDb,
  type WagerDbClient,
} from './wager-db-core.js';
import type { WagerStakeErrorCode, WagerWithdrawErrorCode } from './wager-types.js';

type RpcDb = Pick<WagerDb, 'wagerStake' | 'requestWithdrawal'>;

export function rpcDbMethods(client: WagerDbClient): RpcDb {
  return {
    async wagerStake(args) {
      assertSafeInteger('wagerStake.placed_at_ms', args.placed_at_ms);
      const result = await client.rpc('wager_stake', {
        p_user_id: args.user_id,
        p_group_id: args.group_id,
        p_market_id: args.market_id,
        p_side: args.side,
        p_lamports: lamportsToDb('wagerStake.lamports', args.lamports),
        p_multiplier: args.multiplier,
        p_state: args.state,
        p_placed_at_ms: args.placed_at_ms,
        p_idempotency_key: args.idempotency_key ?? null,
        p_allow_starter: args.allow_starter,
      });
      const payload = unwrapRows<unknown>('wager_stake', result);
      const outcome = parseRpcOutcome<WagerStakeErrorCode>(
        'wager_stake',
        payload,
        'position_id',
        isStakeErrorCode,
        isUuid,
      );
      if (!outcome.ok) return outcome;
      return 'duplicate' in outcome
        ? { ok: true, duplicate: true }
        : { ok: true, position_id: outcome.id };
    },

    async requestWithdrawal(args) {
      const result = await client.rpc('wager_request_withdrawal', {
        p_user_id: args.user_id,
        p_lamports: lamportsToDb('requestWithdrawal.lamports', args.lamports),
      });
      const payload = unwrapRows<unknown>('wager_request_withdrawal', result);
      const outcome = parseRpcOutcome<WagerWithdrawErrorCode>(
        'wager_request_withdrawal',
        payload,
        'withdrawal_id',
        isWithdrawErrorCode,
        isNonEmptyString,
      );
      if (!outcome.ok) return outcome;
      if ('duplicate' in outcome) {
        // The withdrawal RPC has no idempotent-replay path; a duplicate here is drift.
        throw new DbError('wager_request_withdrawal', { message: 'unexpected duplicate outcome' });
      }
      return { ok: true, withdrawal_id: outcome.id };
    },

  };
}
