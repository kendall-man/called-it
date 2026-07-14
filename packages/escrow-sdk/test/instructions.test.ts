import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { bytesToHex } from '../src/codec.js';
import { materializeInstruction } from '../src/instructions.js';
import { ESCROW_INSTRUCTION_ACCOUNTS, ESCROW_INSTRUCTION_DISCRIMINATORS } from '../src/schema.js';
import { PROGRAM_ID, instructionRequests } from './fixtures.js';

describe('concrete Anchor instruction adapter', () => {
  it('materializes every frozen instruction with the exact Anchor discriminator', () => {
    for (const request of instructionRequests()) {
      const instruction = materializeInstruction(request, { programId: PROGRAM_ID });
      const expected = createHash('sha256').update(`global:${request.kind}`).digest('hex').slice(0, 16);
      expect(bytesToHex(instruction.data.subarray(0, 8)), request.kind).toBe(expected);
      expect(bytesToHex(Uint8Array.from(ESCROW_INSTRUCTION_DISCRIMINATORS[request.kind]))).toBe(expected);
    }
  });

  it('uses the centralized ordered signer and writable account schema', () => {
    for (const request of instructionRequests()) {
      const instruction = materializeInstruction(request, { programId: PROGRAM_ID });
      const schema = ESCROW_INSTRUCTION_ACCOUNTS[request.kind];
      const fixed = schema.filter((account) => account.remaining !== true);
      expect(instruction.keys.length).toBeGreaterThanOrEqual(fixed.length);
      for (const [index, account] of fixed.entries()) {
        expect(instruction.keys[index]?.isSigner, `${request.kind}.${account.name}.signer`).toBe(account.signer);
        expect(instruction.keys[index]?.isWritable, `${request.kind}.${account.name}.writable`).toBe(account.writable);
      }
    }
  });

  it('uses the frozen Borsh width for every argument struct', () => {
    const lengths = {
      initialize_config: 344, rotate_config: 248, rotate_oracle_set: 134, set_pause: 9,
      initialize_market: 380, freeze_market: 48, unfreeze_market: 80, place_position: 126,
      activate_position_lot: 24, invalidate_position_lot: 80, settle_market: 89,
      calculate_position_entitlement: 8, void_market: 48, timeout_void: 8,
      claim_position: 8, close_position_lots: 28, close_market: 8,
    } as const;
    for (const request of instructionRequests()) {
      expect(materializeInstruction(request, { programId: PROGRAM_ID }).data.length, request.kind)
        .toBe(lengths[request.kind]);
    }
  });

  it('matches the fixed place-position Borsh vector', () => {
    const request = instructionRequests().find((item) => item.kind === 'place_position');
    expect(request?.kind).toBe('place_position');
    if (request?.kind !== 'place_position') throw new TypeError('place-position fixture missing');
    const instruction = materializeInstruction(request, { programId: PROGRAM_ID });
    expect(bytesToHex(instruction.data)).toBe(
      'da1f5a4b65d105fd00112233445566778899aabbccddeeff0080f0fa02000000000065020000746bfdef6cf562aee152f894d0ad378e68c9c0bcb8ad8aed201b141d486cd340010000000000000004000000000000001e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e7cbd1d6700000000',
    );
  });

  it('rejects an oracle set outside the frozen three-key two-signature policy', () => {
    const request = instructionRequests().find((item) => item.kind === 'rotate_oracle_set');
    if (request?.kind !== 'rotate_oracle_set') throw new TypeError('oracle fixture missing');
    expect(() => materializeInstruction({ ...request, signatureThreshold: 1 }, { programId: PROGRAM_ID }))
      .toThrow(/threshold/);
    expect(() => materializeInstruction({ ...request, signers: request.signers.slice(0, 2) }, { programId: PROGRAM_ID }))
      .toThrow(/exactly 3/);
  });
});
