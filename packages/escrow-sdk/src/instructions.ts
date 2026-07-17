import { TransactionInstruction, type PublicKey } from '@solana/web3.js';
import { deriveMarketPda } from './addresses.js';
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

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function assertAttestationBinding(request: EscrowInstructionRequest, programId: PublicKey): void {
  if (request.kind !== 'settle_market' && request.kind !== 'void_market') return;
  if (!equalBytes(request.attestation.escrowProgramId, programId.toBytes())) {
    throw new TypeError(`${request.kind} attestation program ID does not match the instruction program`);
  }
  const market = deriveMarketPda(programId, request.marketUuid).publicKey.toBytes();
  if (!equalBytes(request.attestation.marketPda, market)) {
    throw new TypeError(`${request.kind} attestation market PDA does not match the instruction market`);
  }
}

export function materializeInstruction(
  request: EscrowInstructionRequest,
  options: MaterializeInstructionOptions,
): TransactionInstruction {
  assertAttestationBinding(request, options.programId);
  if (request.kind === 'rotate_oracle_set') {
    assertOracleSignerSet(request.signers, request.signatureThreshold);
  }
  return new TransactionInstruction({
    programId: options.programId,
    keys: escrowInstructionAccounts(request, options.programId),
    data: Buffer.from(encodeEscrowInstructionData(request, options.programId)),
  });
}
