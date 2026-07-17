import { unwrapRows } from './errors.js';
import type { StarterOnlyWagerDb, WagerDb, WagerDbClient } from './wager-db-contract.js';
import {
  assertSafeInteger,
  isStakeErrorCode,
  isUuid,
  lamportsToDb,
  parseRpcOutcome,
} from './wager-db-core.js';
import type {
  WagerStakeErrorCode,
  WagerStakeInput,
  WagerStakeResult,
} from './wager-types.js';

type StakeDb = Pick<WagerDb, 'wagerStake'>;
type StarterStakeDb = Pick<StarterOnlyWagerDb, 'wagerStarterStake'>;
type WagerStakeRpcInput = Omit<WagerStakeInput, 'starterOnly'>;

async function executeWagerStake(
  client: WagerDbClient,
  args: WagerStakeRpcInput,
  starterOnly: boolean,
): Promise<WagerStakeResult> {
  assertSafeInteger('wagerStake.placed_at_ms', args.placed_at_ms);
  const payload = unwrapRows<unknown>('wager_stake', await client.rpc('wager_stake', {
    p_user_id: args.user_id,
    p_group_id: args.group_id,
    p_market_id: args.market_id,
    p_side: args.side,
    p_lamports: lamportsToDb('wagerStake.lamports', args.lamports),
    p_multiplier: args.multiplier,
    p_state: args.state,
    p_placed_at_ms: args.placed_at_ms,
    p_idempotency_key: args.idempotency_key ?? null,
    p_starter_only: starterOnly,
  }));
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
}

export function stakeDbMethod(client: WagerDbClient): StakeDb {
  return {
    wagerStake: (args) => executeWagerStake(client, args, args.starterOnly),
  };
}

export function starterStakeDbMethod(client: WagerDbClient): StarterStakeDb {
  return {
    wagerStarterStake: (args) => executeWagerStake(client, args, true),
  };
}
