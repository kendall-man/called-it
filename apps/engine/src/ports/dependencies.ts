import type { EngineReadinessPorts } from '../api/readiness-checks.js';
import type { ShutdownDrainPort } from '../api/shutdown.js';
import type { Env } from '../env.js';
import type { Logger } from '../log.js';
import type { WagerModule } from '../wager/module.js';
import type { EngineDb } from './database.js';
import type { AgentPort, EnginePort, ProofSubmitter, TxPort } from './services.js';

export interface Deps {
  db: EngineDb;
  agent: AgentPort;
  engine: EnginePort;
  tx: TxPort;
  proofSubmitter: ProofSubmitter | null;
  wager: WagerModule | null;
  readiness: Omit<EngineReadinessPorts, 'telegram'>;
  drains: readonly ShutdownDrainPort[];
  env: Env;
  log: Logger;
  now(): number;
}
