import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { thresholdInstructionsForSigners } from '../src/attestation-fixtures.js';

describe('compact threshold Ed25519 instruction', () => {
  it('stores two signatures over one shared self-contained message', () => {
    const message = Buffer.from('calledit-threshold-fixture');
    const instructions = thresholdInstructionsForSigners([
      Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 1)),
      Keypair.fromSeed(Uint8Array.from({ length: 32 }, () => 2)),
    ], message);
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    if (instruction === undefined) throw new TypeError('threshold instruction missing');
    const data = Buffer.from(instruction.data);

    expect(data[0]).toBe(2);
    expect(data[1]).toBe(0);
    expect(data.length).toBe(222 + message.length);
    for (const index of [0, 1]) {
      const descriptor = 2 + index * 14;
      expect(data.readUInt16LE(descriptor + 2)).toBe(0xffff);
      expect(data.readUInt16LE(descriptor + 6)).toBe(0xffff);
      expect(data.readUInt16LE(descriptor + 8)).toBe(222);
      expect(data.readUInt16LE(descriptor + 10)).toBe(message.length);
      expect(data.readUInt16LE(descriptor + 12)).toBe(0xffff);
    }
    expect(data.subarray(222)).toEqual(message);
  });
});
