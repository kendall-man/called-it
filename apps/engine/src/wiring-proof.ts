import type { Env } from './env.js';
import type { Logger } from './log.js';
import type { ProofSubmitter } from './ports.js';
import {
  mapStatValidationToParams,
  type MappedValidateStatParams,
} from './proofs/mapping.js';

interface ProofRuntime<Connection, Wallet> {
  createConnection(rpcUrl: string): Connection;
  loadWallet(secret: string): Wallet;
  submit(
    input: MappedValidateStatParams & {
      connection: Connection;
      wallet: Wallet;
      programId: string;
    },
  ): Promise<{ ok: true; txSig: string } | { ok: false; error: string }>;
}

export function createProductionProofSubmitter<Connection, Wallet>(
  env: Env,
  log: Logger,
  runtime: ProofRuntime<Connection, Wallet>,
): ProofSubmitter | null {
  const secret = env.SOLANA_KEYPAIR_B58;
  if (secret === undefined) {
    log.warn('proof_submitter_disabled', { reason: 'SOLANA_KEYPAIR_B58 not set' });
    return null;
  }
  return {
    async submit(args) {
      try {
        const mapped = mapStatValidationToParams(args.proof, args.comparator, args.threshold);
        if (mapped === null) {
          return {
            ok: false,
            permanent: true,
            error: 'stat-validation payload missing required proof fields',
          };
        }
        const result = await runtime.submit({
          connection: runtime.createConnection(env.SOLANA_RPC_URL),
          wallet: runtime.loadWallet(secret),
          programId: env.TXORACLE_PROGRAM_ID,
          ...mapped,
        });
        return result.ok ? { ok: true, txSig: result.txSig } : result;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        const message = error.toString();
        return { ok: false, error: message };
      }
    },
  };
}
