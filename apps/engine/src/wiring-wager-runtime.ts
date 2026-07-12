import type { Env } from './env.js';
import type { Logger } from './log.js';
import type { EngineDb } from './ports.js';
import type { WagerModule, WagerPoster } from './wager/module.js';
import type { ProductionFundedWagerOptions } from './wiring-wager-funded.js';
import type { StarterOnlyPackageDb } from './wiring-wager-starter-db.js';
import { createProductionWagerModule } from './wiring-wager.js';

type FactoryResult<Value> = Value | Promise<Value>;
type StarterOnlyDbFactory = (url: string, serviceRoleKey: string) => StarterOnlyPackageDb;
type FundedDbFactory<Connection, Treasury, PublicKey> =
  ProductionFundedWagerOptions<Connection, Treasury, PublicKey>['createDb'];
type FundedSolanaRuntime<Connection, Treasury, PublicKey> = Pick<
  ProductionFundedWagerOptions<Connection, Treasury, PublicKey>,
  'chainRuntime' | 'createConnection' | 'loadTreasury'
>;

export interface ProductionWagerRuntimeOptions {
  readonly env: Env;
  readonly log: Logger;
  readonly engineDb: EngineDb;
  readonly poster?: WagerPoster;
}

export interface ProductionWagerRuntimeFactories<Connection, Treasury, PublicKey> {
  readonly loadStarterOnlyDbFactory: () => FactoryResult<StarterOnlyDbFactory>;
  readonly loadFundedDbFactory: () => FactoryResult<
    FundedDbFactory<Connection, Treasury, PublicKey>
  >;
  readonly loadFundedSolanaRuntime: () => FactoryResult<
    FundedSolanaRuntime<Connection, Treasury, PublicKey>
  >;
}

export async function createProductionWagerRuntime<Connection, Treasury, PublicKey>(
  options: ProductionWagerRuntimeOptions,
  factories: ProductionWagerRuntimeFactories<Connection, Treasury, PublicKey>,
): Promise<WagerModule | null> {
  const { env, engineDb, log } = options;
  return createProductionWagerModule(env.WAGER_RUNTIME_MODE, {
    starterOnly: async () => {
      const [createStarterOnlyDb, starterModule, starterDb] = await Promise.all([
        factories.loadStarterOnlyDbFactory(),
        import('./wager/starter-only-module.js'),
        import('./wiring-wager-starter-db.js'),
      ]);
      return starterModule.createStarterOnlyWagerModule({
        runtimeMode: 'starter_only',
        db: starterDb.buildStarterOnlyWagerDb({
          packageDb: createStarterOnlyDb(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY),
          engineDb: {
            getUser: (userId) => engineDb.getUser(userId),
            positionsForMarket: (marketId) => engineDb.positionsForMarket(marketId),
            setPositionStates: (ids, state) => engineDb.setPositionStates(ids, state),
          },
        }),
        log,
        starterGrantsEnabled: env.STARTER_GRANTS_ENABLED,
        stakeAcceptanceEnabled: env.STAKE_ACCEPTANCE_ENABLED,
      });
    },
    funded: async () => {
      const [createDb, fundedModule, solanaRuntime] = await Promise.all([
        factories.loadFundedDbFactory(),
        import('./wiring-wager-funded.js'),
        factories.loadFundedSolanaRuntime(),
      ]);
      return fundedModule.createProductionFundedWagerModule({
        env,
        log,
        engineDb,
        poster: options.poster,
        createDb,
        ...solanaRuntime,
      });
    },
  });
}
