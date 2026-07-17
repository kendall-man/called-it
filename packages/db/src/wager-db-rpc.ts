import { DbError, unwrapRows } from './errors.js';
import {
  isNonEmptyString,
  isWithdrawErrorCode,
  lamportsToDb,
  parseRpcOutcome,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { stakeDbMethod } from './wager-db-stake.js';
import type { WagerWithdrawErrorCode } from './wager-types.js';

type RpcDb = Pick<WagerDb, 'wagerStake' | 'requestWithdrawal'>;

export function rpcDbMethods(client: WagerDbClient): RpcDb {
  return {
    ...stakeDbMethod(client),

    async requestWithdrawal(args) {
      const result = await client.rpc('wager_request_withdrawal', {
        p_user_id: args.user_id,
        p_asset: args.asset ?? 'sol',
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
