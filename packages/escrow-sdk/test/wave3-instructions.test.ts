import { readFileSync } from 'node:fs';
import type { TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_TOKEN_PROGRAM_ID,
  SOL_ACCOUNT_PLACEHOLDER,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  derivePositionLotPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  deriveUserPositionPda,
} from '../src/addresses.js';
import {
  encodeSettlementAttestationV1,
  encodeVoidAttestationV1,
} from '../src/attestations.js';
import { bytesToHex } from '../src/codec.js';
import {
  materializeInstruction,
  type EscrowInstructionRequest,
} from '../src/instructions.js';
import {
  ESCROW_INSTRUCTION_ACCOUNTS,
  ESCROW_INSTRUCTION_DISCRIMINATORS,
  type EscrowInstructionKind,
} from '../src/schema.js';
import {
  buildAttestationVerificationInstructions,
  buildSettlementAttestationVerificationInstructions,
  buildVoidAttestationVerificationInstructions,
} from '../src/transactions.js';
import {
  MARKET_UUID,
  PROGRAM_ID,
  RELAYER,
  USER,
  USDC_MINT,
  hash,
  instructionRequests,
  key,
  settlementAttestation,
  voidAttestation,
} from './fixtures.js';

type Wave3InstructionKind = Extract<EscrowInstructionKind,
  | 'settle_market' | 'calculate_position_entitlement' | 'void_market' | 'timeout_void'
  | 'claim_position' | 'claim_position_for' | 'close_position_lots'
  | 'close_position' | 'close_market'>;

interface IdlInstructionVector {
  readonly discriminator: readonly number[];
  readonly accounts: readonly (readonly [string, boolean, boolean])[];
  readonly data_hex?: string;
}

interface Wave3IdlVector {
  readonly source_commit: string;
  readonly program_id_commit: string;
  readonly program_id: string;
  readonly anchor_version: string;
  readonly instructions: Readonly<Record<Wave3InstructionKind, IdlInstructionVector>>;
}

const idlVector: Wave3IdlVector = JSON.parse(readFileSync(
  new URL('../vectors/wave3-idl-v1.json', import.meta.url),
  'utf8',
));
const WAVE3_KINDS = [
  'settle_market', 'calculate_position_entitlement', 'void_market', 'timeout_void',
  'claim_position', 'claim_position_for', 'close_position_lots', 'close_position', 'close_market',
] as const satisfies readonly Wave3InstructionKind[];

function request(kind: EscrowInstructionKind): EscrowInstructionRequest {
  const value = instructionRequests().find((item) => item.kind === kind);
  if (value === undefined) throw new TypeError(`${kind} fixture missing`);
  return value;
}

function ed25519Message(instruction: TransactionInstruction): Uint8Array {
  const data = instruction.data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const offset = view.getUint16(10, true);
  const length = view.getUint16(12, true);
  return Uint8Array.from(data.subarray(offset, offset + length));
}

describe('Wave 3 generated IDL parity', () => {
  it('matches frozen discriminators and ordered fixed account metadata', () => {
    expect(idlVector.source_commit).toBe('81aedda');
    expect(idlVector.program_id_commit).toBe('666efac');
    expect(idlVector.program_id).toBe(PROGRAM_ID.toBase58());
    expect(idlVector.anchor_version).toBe('0.31.1');
    for (const kind of WAVE3_KINDS) {
      const expected = idlVector.instructions[kind];
      expect(ESCROW_INSTRUCTION_DISCRIMINATORS[kind], kind).toEqual(expected.discriminator);
      expect(ESCROW_INSTRUCTION_ACCOUNTS[kind]
        .filter((account) => account.remaining !== true)
        .map((account) => [account.name, account.signer, account.writable]), kind)
        .toEqual(expected.accounts);
    }
  });

  it('matches Rust Borsh bytes for settlement and signed void arguments', () => {
    for (const kind of ['settle_market', 'void_market'] as const) {
      const expected = idlVector.instructions[kind].data_hex;
      expect(expected).toBeDefined();
      expect(bytesToHex(materializeInstruction(request(kind), { programId: PROGRAM_ID }).data))
        .toBe(expected);
    }
  });
});

describe('Wave 3 canonical account derivation', () => {
  it('uses exact SOL aliases for placement, direct claim, and market close', () => {
    const placement = materializeInstruction(request('place_position'), { programId: PROGRAM_ID });
    const claim = materializeInstruction(request('claim_position'), { programId: PROGRAM_ID });
    const close = materializeInstruction(request('close_market'), { programId: PROGRAM_ID });
    const market = deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey;

    expect(placement.keys[6]?.pubkey).toEqual(deriveSolVaultPda(PROGRAM_ID, market).publicKey);
    expect(placement.keys[7]?.pubkey).toEqual(USER.publicKey);
    expect(placement.keys[8]?.pubkey).toEqual(SOL_ACCOUNT_PLACEHOLDER);
    expect(claim.keys[2]).toMatchObject({ pubkey: USER.publicKey, isSigner: true, isWritable: true });
    expect(claim.keys[4]?.pubkey).toEqual(SOL_ACCOUNT_PLACEHOLDER);
    expect(claim.keys[5]?.pubkey).toEqual(USER.publicKey);
    expect(close.keys[3]?.pubkey).toEqual(SOL_ACCOUNT_PLACEHOLDER);
    expect(close.keys[4]?.pubkey).toEqual(key(7));
  });

  it('derives classic SPL vault and destination ATAs for USDC', () => {
    const direct = request('claim_position');
    const sponsored = request('claim_position_for');
    const close = request('close_market');
    if (direct.kind !== 'claim_position' || sponsored.kind !== 'claim_position_for' || close.kind !== 'close_market') {
      throw new TypeError('claim fixtures missing');
    }
    const directIx = materializeInstruction({ ...direct, asset: 'usdc' }, { programId: PROGRAM_ID });
    const sponsoredIx = materializeInstruction({ ...sponsored, asset: 'usdc' }, { programId: PROGRAM_ID });
    const closeIx = materializeInstruction({ ...close, asset: 'usdc' }, { programId: PROGRAM_ID });
    const market = deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey;
    const ownerAta = deriveClassicAssociatedTokenAddress(USER.publicKey, USDC_MINT);

    expect(directIx.keys[3]?.pubkey).toEqual(deriveUsdcVaultAddress(market, USDC_MINT));
    expect(directIx.keys[5]?.pubkey).toEqual(ownerAta);
    expect(directIx.keys[6]?.pubkey).toEqual(CLASSIC_TOKEN_PROGRAM_ID);
    expect(sponsoredIx.keys[0]?.pubkey).toEqual(RELAYER.publicKey);
    expect(sponsoredIx.keys[6]?.pubkey).toEqual(ownerAta);
    expect(closeIx.keys[4]?.pubkey).toEqual(deriveClassicAssociatedTokenAddress(key(7), USDC_MINT));
  });

  it('derives config, position, and descending lot accounts for recovery closes', () => {
    const lots = materializeInstruction(request('close_position_lots'), { programId: PROGRAM_ID });
    const positionClose = materializeInstruction(request('close_position'), { programId: PROGRAM_ID });
    const market = deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey;
    const position = deriveUserPositionPda(PROGRAM_ID, market, USER.publicKey).publicKey;

    expect(lots.keys.slice(0, 5).map((meta) => meta.pubkey)).toEqual([
      deriveProtocolConfigPda(PROGRAM_ID).publicKey, market, position, key(7), SOL_ACCOUNT_PLACEHOLDER,
    ]);
    expect(lots.keys.slice(5).map((meta) => meta.pubkey)).toEqual([
      derivePositionLotPda(PROGRAM_ID, market, USER.publicKey, 5n).publicKey,
      derivePositionLotPda(PROGRAM_ID, market, USER.publicKey, 4n).publicKey,
    ]);
    expect(positionClose.keys.map((meta) => meta.pubkey)).toEqual([
      deriveProtocolConfigPda(PROGRAM_ID).publicKey, market, position, key(7),
    ]);
  });
});

describe('Wave 3 attestation signature inputs', () => {
  const signatures = [{ publicKey: key(40).toBytes(), signature: new Uint8Array(64).fill(41) }] as const;

  it('embeds exact canonical settlement and void bytes in Ed25519 instructions', () => {
    const settlement = buildSettlementAttestationVerificationInstructions(settlementAttestation, signatures);
    const voided = buildVoidAttestationVerificationInstructions(voidAttestation, signatures);
    const settlementInstruction = settlement[0];
    const voidInstruction = voided[0];
    if (settlementInstruction === undefined || voidInstruction === undefined) {
      throw new TypeError('signature verification instruction missing');
    }

    expect(ed25519Message(settlementInstruction))
      .toEqual(encodeSettlementAttestationV1(settlementAttestation));
    expect(ed25519Message(voidInstruction))
      .toEqual(encodeVoidAttestationV1(voidAttestation));
  });

  it('shares canonical bytes across multiple signatures in one Ed25519 instruction', () => {
    const signatures = [
      { publicKey: key(40).toBytes(), signature: new Uint8Array(64).fill(41) },
      { publicKey: key(42).toBytes(), signature: new Uint8Array(64).fill(43) },
    ] as const;
    const instructions = buildSettlementAttestationVerificationInstructions(
      settlementAttestation,
      signatures,
    );
    expect(instructions).toHaveLength(1);
    const instruction = instructions[0];
    if (instruction === undefined) throw new TypeError('signature verification instruction missing');
    expect(instruction.data[0]).toBe(2);
    expect(ed25519Message(instruction)).toEqual(encodeSettlementAttestationV1(settlementAttestation));

    const view = new DataView(
      instruction.data.buffer,
      instruction.data.byteOffset,
      instruction.data.byteLength,
    );
    expect(view.getUint16(24, true)).toBe(view.getUint16(10, true));
    expect(view.getUint16(26, true)).toBe(view.getUint16(12, true));
    expect(view.getUint16(28, true)).toBe(0xffff);
  });

  it('rejects empty, duplicate, or oversized signature sets', () => {
    const message = encodeSettlementAttestationV1(settlementAttestation);
    expect(() => buildSettlementAttestationVerificationInstructions(settlementAttestation, []))
      .toThrow(/between one and three/);
    expect(() => buildSettlementAttestationVerificationInstructions(
      settlementAttestation,
      Array.from({ length: 4 }, (_, index) => ({
        publicKey: key(50 + index).toBytes(),
        signature: new Uint8Array(64).fill(60 + index),
      })),
    )).toThrow(/between one and three/);
    expect(() => buildAttestationVerificationInstructions(message, [signatures[0], signatures[0]]))
      .toThrow(/distinct/);
  });

  it('rejects substituted program and market bindings and changes signed field bytes', () => {
    const settle = request('settle_market');
    const voided = request('void_market');
    if (settle.kind !== 'settle_market' || voided.kind !== 'void_market') {
      throw new TypeError('attested fixtures missing');
    }

    expect(() => materializeInstruction({
      ...settle,
      attestation: { ...settle.attestation, escrowProgramId: hash(90) },
    }, { programId: PROGRAM_ID })).toThrow(/program ID/);
    expect(() => materializeInstruction({
      ...voided,
      attestation: { ...voided.attestation, marketPda: hash(91) },
    }, { programId: PROGRAM_ID })).toThrow(/market PDA/);
    expect(encodeSettlementAttestationV1({ ...settlementAttestation, evidenceHash: hash(92) }))
      .not.toEqual(encodeSettlementAttestationV1(settlementAttestation));
    expect(encodeVoidAttestationV1({ ...voidAttestation, reason: 'undecidable' }))
      .not.toEqual(encodeVoidAttestationV1(voidAttestation));
  });
});
