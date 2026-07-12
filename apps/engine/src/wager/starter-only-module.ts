import { createWagerModuleCore } from './module-core.js';
import type {
  StarterOnlyWagerModule,
  StarterOnlyWagerModuleDeps,
} from './port.js';

export function createStarterOnlyWagerModule(
  deps: StarterOnlyWagerModuleDeps,
): StarterOnlyWagerModule {
  return {
    kind: 'starter_only',
    ...createWagerModuleCore(deps),
  };
}
