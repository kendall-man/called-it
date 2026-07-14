import type {
  WagerCronRegistry,
  FundedWagerModule,
  WagerStakeTapArgs,
  WagerStakeTapSource,
} from '../wager/module.js';
import type { TelegramFlowDb } from './telegram-points-flow-db.test-support.js';
import type { WagerAsset } from '@calledit/market-engine';

const DEFAULT_STAKE_LAMPORTS = 10_000_000n;
const CHOICE_REPLY = 'Choice recorded with 0.01 test SOL. Test SOL has no monetary value.';

export const WALLET_ADDRESS_SENTINEL =
  '7YwA9kP3mN6rT2vX5zB8cD4fG1hJ9qR6sU3xW8yZ2aC5';

function sourceKey(source: WagerStakeTapSource): string {
  switch (source.kind) {
    case 'telegram_default_card':
    case 'telegram_card':
      return source.callbackId;
    case 'durable_source':
      return source.idempotencyKey;
    default:
      return assertNever(source);
  }
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported wager source: ${JSON.stringify(value)}`);
}

export class TelegramFlowWager implements FundedWagerModule {
  readonly kind = 'funded';
  readonly appliedSettlements: string[] = [];
  private readonly sources = new Set<string>();

  constructor(
    private readonly db: TelegramFlowDb,
    private readonly trace: string[],
  ) {}

  async currencyForMint(): Promise<'sol'> { return 'sol'; }

  async handleStakeTap(args: WagerStakeTapArgs): Promise<{ reply: string; placed: boolean }> {
    const key = sourceKey(args.source);
    if (this.sources.has(key)) return { reply: CHOICE_REPLY, placed: false };
    this.sources.add(key);
    await this.db.insertPosition({
      market_id: args.market.id,
      user_id: args.userId,
      side: args.side,
      stake: Number(args.lamports),
      locked_multiplier: 1,
      locked_odds_message_id: null,
      locked_odds_ts: null,
      state: 'active',
      placed_at_ms: args.nowMs,
    });
    this.trace.push(`wager:placed:${args.market.id}:${args.userId}:${args.side}`);
    return { reply: CHOICE_REPLY, placed: true };
  }

  async applySettlement(marketId: string): Promise<void> {
    this.appliedSettlements.push(marketId);
    this.trace.push(`wager:settled:${marketId}`);
  }

  async settlementPayoutsLine(): Promise<string> {
    return 'Test-SOL pool settled separately. Test SOL has no monetary value.';
  }

  async stakesAvailable(): Promise<boolean> { return true; }
  cardFooter(): string { return 'Test SOL has no monetary value.'; }
  presetLabels(): [string, string, string] { return ['0.01 SOL', '0.05 SOL', '0.1 SOL']; }
  presetLamports(index: number): bigint | null { return index === 0 ? DEFAULT_STAKE_LAMPORTS : null; }
  async walletSummary() {
    return {
      balances: {
        sol: { availableAtomic: 0n, lockedAtomic: 0n },
        usdc: { availableAtomic: 0n, lockedAtomic: 0n },
      },
      balanceLamports: 0n,
      lockedLamports: 0n,
      pubkey: WALLET_ADDRESS_SENTINEL,
    };
  }
  async setGroupDefaultAsset(_groupId: number, _asset: WagerAsset): Promise<void> {}
  groupAssetMessage(asset: WagerAsset): string { return `New calls use ${asset}.`; }
  async prepareStakeConfirmation(): Promise<{ ok: false; reply: string }> {
    return { ok: false, reply: 'Unavailable' };
  }
  async getStakeConfirmation(): Promise<null> { return null; }
  async confirmStakeConfirmation(): Promise<{ reply: string; placed: false }> {
    return { reply: 'Unavailable', placed: false };
  }
  async cancelStakeConfirmation(): Promise<boolean> { return false; }
  registerCommands(): void {}
  registerSettlementRecovery(_registry: WagerCronRegistry): void {}
  registerFundedWorkers(_registry: WagerCronRegistry): void {}
}
