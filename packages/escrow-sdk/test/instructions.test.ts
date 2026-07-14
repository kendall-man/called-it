import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  EscrowIdlUnavailableError,
  instructionRequest,
  materializeInstruction,
} from '../src/instructions.js';
import { bytesToHex } from '../src/codec.js';
import { encodePositionIntentV1, hashPositionIntentV1 } from '../src/transactions.js';

describe('IDL-independent instruction requests', () => {
  it('retains typed place-position inputs without manufacturing program bytes', () => {
    const request = instructionRequest({
      kind: 'place_position',
      marketUuid: '00112233-4455-6677-8899-aabbccddeeff',
      side: 'back',
      amount: 10_000n,
      expectedAsset: 'sol',
      expectedRatioMilli: 613,
      expectedEventEpoch: 0n,
      expectedLotNonce: 0n,
      clientIntentHash: new Uint8Array(32),
      clientExpiryTimestamp: 1_730_000_300n,
    });
    expect(request.kind).toBe('place_position');
  });

  it('fails closed until the generated IDL adapter is supplied', () => {
    expect(() => materializeInstruction(
      instructionRequest({ kind: 'claim_position' }),
      { programId: PublicKey.default },
    )).toThrow(EscrowIdlUnavailableError);
  });

  it('does not allow a close caller to choose the residual destination', () => {
    const close = instructionRequest({ kind: 'close_market' });
    expect(Object.keys(close)).toEqual(['kind']);
  });

  it('binds the user intent to program, market, wallet, terms, nonce, and expiry', () => {
    const intent = {
      escrowProgramId: new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111'),
      marketPda: new PublicKey('Vote111111111111111111111111111111111111111'),
      marketDocumentHash: new Uint8Array(32).fill(7),
      userWallet: new PublicKey('So11111111111111111111111111111111111111112'),
      side: 'back' as const,
      amount: 10_000n,
      asset: 'sol' as const,
      expectedRatioMilli: 613,
      expectedEventEpoch: 2n,
      expectedLotNonce: 4n,
      expiresAt: 1_730_000_300n,
    };
    expect(encodePositionIntentV1(intent)).toEqual(encodePositionIntentV1(intent));
    expect(bytesToHex(hashPositionIntentV1({ ...intent, expectedLotNonce: 5n })))
      .not.toBe(bytesToHex(hashPositionIntentV1(intent)));
  });
});
