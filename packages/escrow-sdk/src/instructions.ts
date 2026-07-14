import { TransactionInstruction, type PublicKey } from '@solana/web3.js';
import { escrowInstructionAccounts } from './instruction-accounts.js';
import { assertOracleSignerSet, encodeEscrowInstructionData } from './instruction-codec.js';
import type { EscrowInstructionRequest } from './instruction-types.js';

export * from './instruction-types.js';

export function instructionRequest<const T extends EscrowInstructionRequest>(request: T): T {
  return request;
}

export interface MaterializeInstructionOptions {
  readonly programId: PublicKey;
}

export function materializeInstruction(
  request: EscrowInstructionRequest,
  options: MaterializeInstructionOptions,
): TransactionInstruction {
  if (request.kind === 'rotate_oracle_set') {
    assertOracleSignerSet(request.signers, request.signatureThreshold);
  }
  return new TransactionInstruction({
    programId: options.programId,
    keys: escrowInstructionAccounts(request, options.programId),
    data: Buffer.from(encodeEscrowInstructionData(request, options.programId)),
  });
}
