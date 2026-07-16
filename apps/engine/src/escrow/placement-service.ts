import { createPlacementCallbackAcceptor } from './placement-callback.js';
import { createPlacementSessionCreator } from './placement-session.js';
import { createPlacementPresenter } from './placement-presentation.js';
import type {
  AcceptEscrowPlacementInput,
  AcceptEscrowPlacementResult,
  CreateEscrowPlacementInput,
  CreateEscrowPlacementResult,
  EscrowPlacementServiceDependencies,
  EscrowPlacementDatabase,
  EscrowPlacementPresentationResult,
} from './placement-types.js';

export * from './placement-types.js';

export interface EscrowPlacementService {
  create(input: CreateEscrowPlacementInput): Promise<CreateEscrowPlacementResult>;
  present(token: string): Promise<EscrowPlacementPresentationResult>;
  accept(input: AcceptEscrowPlacementInput): Promise<AcceptEscrowPlacementResult>;
}

export function createEscrowPlacementService(options: EscrowPlacementServiceDependencies & {
  readonly db: EscrowPlacementDatabase;
}): EscrowPlacementService {
  return {
    create: createPlacementSessionCreator(options.db, options),
    present: createPlacementPresenter({ ...options, db: options.db }),
    accept: createPlacementCallbackAcceptor(options.db, options),
  };
}
