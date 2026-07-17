import {
  derivePositionLotPda,
  deriveUserPositionPda,
  type MarketAccount,
  type UserPositionAccount,
} from '@calledit/escrow-sdk';
import type { DecodedEscrowAccount } from './solana-accounts.js';
import type { EscrowRecoveryChain } from './recovery-relayer.js';
import {
  MAX_CLOSE_POSITION_LOTS_PER_TRANSACTION,
  type EscrowRecoveryRequest,
  type createEscrowRecoveryService,
} from './recovery-workflows.js';

export interface EscrowTerminalPositionIdentity {
  readonly ownerPubkey: string;
  readonly positionPda: string;
}

export interface EscrowTerminalPositionSource {
  positions(input: {
    readonly marketId: string;
    readonly marketPda: string;
  }): Promise<readonly EscrowTerminalPositionIdentity[]>;
}

export type EscrowTerminalWorkflowOperation = EscrowRecoveryRequest['operation'];

export interface EscrowTerminalWorkflowReport {
  readonly state: 'waiting' | 'scheduled' | 'blocked' | 'closed';
  readonly chainState: MarketAccount['state'] | null;
  readonly scheduled: readonly {
    readonly operation: EscrowTerminalWorkflowOperation;
    readonly owner: string | null;
  }[];
  readonly reasons: readonly string[];
}

type Recovery = Pick<ReturnType<typeof createEscrowRecoveryService>, 'enqueue'>;
type Chain = Pick<EscrowRecoveryChain, 'market' | 'position' | 'accountExists'>;

interface LoadedPosition {
  readonly identity: EscrowTerminalPositionIdentity;
  readonly account: DecodedEscrowAccount<UserPositionAccount> | null;
}

function compareIdentity(
  left: EscrowTerminalPositionIdentity,
  right: EscrowTerminalPositionIdentity,
): number {
  return left.ownerPubkey < right.ownerPubkey ? -1 : left.ownerPubkey > right.ownerPubkey ? 1 : 0;
}

function owner(request: EscrowRecoveryRequest): string | null {
  return 'owner' in request ? request.owner : null;
}

function waiting(
  chainState: MarketAccount['state'],
  ...reasons: readonly string[]
): EscrowTerminalWorkflowReport {
  return { state: 'waiting', chainState, scheduled: [], reasons };
}

function validateMarket(
  account: DecodedEscrowAccount<MarketAccount>,
  input: { readonly marketId: string; readonly marketPda: string },
  programId: string,
): boolean {
  return account.address === input.marketPda &&
    account.ownerProgramId === programId &&
    account.value.marketUuid === input.marketId;
}

async function loadPositions(options: {
  readonly source: EscrowTerminalPositionSource;
  readonly chain: Chain;
  readonly programId: string;
  readonly marketId: string;
  readonly marketPda: string;
  readonly positionCount: bigint;
}): Promise<readonly LoadedPosition[] | null> {
  const identities = [...await options.source.positions({
    marketId: options.marketId,
    marketPda: options.marketPda,
  })].sort(compareIdentity);
  if (BigInt(identities.length) !== options.positionCount) return null;
  if (new Set(identities.map((value) => value.ownerPubkey)).size !== identities.length) return null;

  for (const identity of identities) {
    if (
      deriveUserPositionPda(options.programId, options.marketPda, identity.ownerPubkey).address !==
      identity.positionPda
    ) return null;
  }

  return Promise.all(identities.map(async (identity): Promise<LoadedPosition> => {
    const account = await options.chain.position(identity.positionPda);
    if (
      account !== null &&
      (
        account.address !== identity.positionPda ||
        account.ownerProgramId !== options.programId ||
        account.value.market !== options.marketPda ||
        account.value.owner !== identity.ownerPubkey
      )
    ) throw new TypeError('escrow terminal position identity mismatch');
    return { identity, account };
  }));
}

function outstandingLotNonces(nextLotNonce: bigint): readonly bigint[] {
  const result: bigint[] = [];
  for (
    let nonce = nextLotNonce;
    nonce > 0n && result.length < MAX_CLOSE_POSITION_LOTS_PER_TRANSACTION;
  ) {
    nonce -= 1n;
    result.push(nonce);
  }
  return result;
}

export function createEscrowTerminalWorkflowOrchestrator(options: {
  readonly programId: string;
  readonly chain: Chain;
  readonly positions: EscrowTerminalPositionSource;
  readonly recovery: Recovery;
  readonly nowEpochSeconds: () => bigint;
}) {
  async function enqueueAll(
    chainState: MarketAccount['state'],
    actions: readonly EscrowRecoveryRequest[],
  ): Promise<EscrowTerminalWorkflowReport> {
    const scheduled: { operation: EscrowTerminalWorkflowOperation; owner: string | null }[] = [];
    for (const action of actions) {
      const result = await options.recovery.enqueue(action);
      if (result.kind === 'blocked') {
        return { state: 'blocked', chainState, scheduled, reasons: result.reasons };
      }
      scheduled.push({ operation: action.operation, owner: owner(action) });
    }
    return {
      state: actions.length === 0 ? 'waiting' : 'scheduled',
      chainState,
      scheduled,
      reasons: actions.length === 0 ? ['awaiting_finalized_chain_progress'] : [],
    };
  }

  return {
    async progress(input: {
      readonly marketId: string;
      readonly marketPda: string;
    }): Promise<EscrowTerminalWorkflowReport> {
      const marketAccount = await options.chain.market(input.marketPda);
      if (marketAccount === null) {
        return { state: 'closed', chainState: null, scheduled: [], reasons: [] };
      }
      if (!validateMarket(marketAccount, input, options.programId)) {
        throw new TypeError('escrow terminal market identity mismatch');
      }
      const market = marketAccount.value;
      if (market.state === 'closed') {
        return { state: 'closed', chainState: market.state, scheduled: [], reasons: [] };
      }
      if (market.state === 'opening') return waiting(market.state, 'market_not_open');
      if (market.state === 'open' || market.state === 'frozen') {
        if (options.nowEpochSeconds() < market.resolutionDeadline) {
          return waiting(market.state, 'resolution_deadline_not_reached');
        }
        return enqueueAll(market.state, [{ operation: 'timeout_void', marketPda: input.marketPda }]);
      }

      const positions = await loadPositions({
        source: options.positions,
        chain: options.chain,
        programId: options.programId,
        marketId: input.marketId,
        marketPda: input.marketPda,
        positionCount: market.positionCount,
      });
      if (positions === null) return waiting(market.state, 'position_projection_incomplete');

      const existing = positions.filter((value) => value.account !== null);
      const claimedExisting = existing.filter((value) => value.account?.value.claimed === true).length;
      const closedCount = positions.length - existing.length;

      if (market.state === 'settling') {
        if (closedCount !== 0) return waiting(market.state, 'position_missing_during_settlement');
        const processed = existing.filter((value) => value.account?.value.settlementProcessed === true).length;
        if (BigInt(processed) !== market.settlementProcessedPositionCount) {
          return waiting(market.state, 'settlement_counter_mismatch');
        }
        return enqueueAll(market.state, existing.flatMap((value): readonly EscrowRecoveryRequest[] => {
          if (value.account?.value.settlementProcessed === true) return [];
          return [{
            operation: 'calculate_position_entitlement',
            marketPda: input.marketPda,
            owner: value.identity.ownerPubkey,
          }];
        }));
      }

      if (market.state !== 'settled' && market.state !== 'voided') {
        return waiting(market.state, 'market_not_terminal');
      }
      if (
        BigInt(existing.length) !== market.settlementProcessedPositionCount ||
        BigInt(claimedExisting + closedCount) !== market.claimedPositionCount
      ) return waiting(market.state, 'terminal_counter_mismatch');
      if (
        market.state === 'settled' &&
        existing.some((value) => value.account?.value.settlementProcessed !== true)
      ) return waiting(market.state, 'settled_entitlement_missing');

      if (existing.length === 0) {
        if (
          market.claimedPositionCount !== market.positionCount ||
          market.settlementProcessedPositionCount !== 0n
        ) return waiting(market.state, 'market_close_counters_incomplete');
        return enqueueAll(market.state, [{ operation: 'close_market', marketPda: input.marketPda }]);
      }

      const actions: EscrowRecoveryRequest[] = [];
      for (const item of existing) {
        const position = item.account?.value;
        if (position === undefined) continue;
        if (!position.claimed) {
          actions.push({
            operation: 'claim_position_for',
            marketPda: input.marketPda,
            owner: item.identity.ownerPubkey,
          });
          continue;
        }
        if (position.nextLotNonce > 0n) {
          const lotNonces = outstandingLotNonces(position.nextLotNonce);
          const present = await Promise.all(lotNonces.map((nonce) => options.chain.accountExists(
            derivePositionLotPda(
              options.programId,
              input.marketPda,
              item.identity.ownerPubkey,
              nonce,
            ).address,
          )));
          if (present.some((value) => !value)) {
            return waiting(market.state, 'position_lot_account_missing');
          }
          actions.push({
            operation: 'close_position_lots',
            marketPda: input.marketPda,
            owner: item.identity.ownerPubkey,
            lotNonces,
          });
          continue;
        }
        if (market.settlementProcessedPositionCount === 0n) {
          return waiting(market.state, 'position_close_counter_exhausted');
        }
        actions.push({
          operation: 'close_position',
          marketPda: input.marketPda,
          owner: item.identity.ownerPubkey,
        });
      }
      return enqueueAll(market.state, actions);
    },
  };
}
