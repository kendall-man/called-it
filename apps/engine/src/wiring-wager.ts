import type { WagerRuntimeMode } from './env.js';
import type {
  FundedWagerModule,
  StarterOnlyWagerModule,
  WagerModule,
} from './wager/module.js';

type FactoryResult<Value> = Value | Promise<Value>;

export interface ProductionWagerFactories {
  readonly starterOnly: () => FactoryResult<StarterOnlyWagerModule>;
  readonly funded: () => FactoryResult<FundedWagerModule | null>;
}

function assertNeverRuntimeMode(mode: never): never {
  throw new TypeError(`unsupported wager runtime mode: ${String(mode)}`);
}

export async function createProductionWagerModule(
  mode: WagerRuntimeMode,
  factories: ProductionWagerFactories,
): Promise<WagerModule | null> {
  switch (mode) {
    case 'disabled':
      return null;
    case 'starter_only':
      return factories.starterOnly();
    case 'funded':
      return factories.funded();
    default:
      return assertNeverRuntimeMode(mode);
  }
}
