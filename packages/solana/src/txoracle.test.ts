import { describe, expect, it } from 'vitest';
import { BorshInstructionCoder, BN, type Idl } from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { sha256 } from '@noble/hashes/sha2';
import { TXORACLE_IDL } from './txoracle-idl.js';
import { bytesToHex } from './codecs.js';
import {
  buildSubscribeInstruction,
  buildValidateStatInstruction,
  deriveDailyScoresRootsPda,
  derivePricingMatrixPda,
  deriveTokenTreasuryPda,
  submitValidateStat,
  type SubmitValidateStatParams,
} from './txoracle.js';

const PROGRAM_ID = new PublicKey('6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J');
const TXL_MINT = new PublicKey('4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG');
// Never dialed in these tests — instruction building is fully offline.
const OFFLINE_CONNECTION = new Connection('http://127.0.0.1:8899');
const WALLET = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, i) => i + 1));

const DISCRIMINATOR_LEN = 8;

function anchorDiscriminator(instructionName: string): Buffer {
  return Buffer.from(
    sha256(new TextEncoder().encode(`global:${instructionName}`)).subarray(0, DISCRIMINATOR_LEN),
  );
}

describe('buildSubscribeInstruction', () => {
  it('encodes discriminator + u16 serviceLevelId + u8 weeks', async () => {
    const serviceLevelId = 1;
    const weeks = 4;
    const ix = await buildSubscribeInstruction(
      OFFLINE_CONNECTION,
      WALLET,
      PROGRAM_ID,
      TXL_MINT,
      serviceLevelId,
      weeks,
    );
    const expectedArgs = Buffer.alloc(3);
    expectedArgs.writeUInt16LE(serviceLevelId, 0);
    expectedArgs.writeUInt8(weeks, 2);
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(Buffer.from(ix.data)).toEqual(
      Buffer.concat([anchorDiscriminator('subscribe'), expectedArgs]),
    );
    // Sanity: the embedded official IDL carries the same discriminator.
    const idl = TXORACLE_IDL as unknown as {
      instructions: { name: string; discriminator: number[] }[];
    };
    const fromIdl = idl.instructions.find((i) => i.name === 'subscribe')?.discriminator;
    expect(Buffer.from(fromIdl ?? [])).toEqual(anchorDiscriminator('subscribe'));
  });

  it('orders accounts per the IDL with TOKEN-2022 ATA derivations', async () => {
    const ix = await buildSubscribeInstruction(
      OFFLINE_CONNECTION,
      WALLET,
      PROGRAM_ID,
      TXL_MINT,
      1,
      4,
    );
    const treasuryPda = deriveTokenTreasuryPda(PROGRAM_ID);
    const expectedKeys = [
      { pubkey: WALLET.publicKey, isSigner: true, isWritable: true },
      { pubkey: derivePricingMatrixPda(PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: TXL_MINT, isSigner: false, isWritable: false },
      {
        pubkey: getAssociatedTokenAddressSync(
          TXL_MINT,
          WALLET.publicKey,
          false,
          TOKEN_2022_PROGRAM_ID,
        ),
        isSigner: false,
        isWritable: true,
      },
      {
        pubkey: getAssociatedTokenAddressSync(TXL_MINT, treasuryPda, true, TOKEN_2022_PROGRAM_ID),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: treasuryPda, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ];
    expect(ix.keys.length).toBe(expectedKeys.length);
    expectedKeys.forEach((expected, i) => {
      const actual = ix.keys[i]!;
      expect(actual.pubkey.toBase58()).toBe(expected.pubkey.toBase58());
      expect(actual.isSigner).toBe(expected.isSigner);
      expect(actual.isWritable).toBe(expected.isWritable);
    });
  });

  it('rejects out-of-range subscription arguments', async () => {
    await expect(
      buildSubscribeInstruction(OFFLINE_CONNECTION, WALLET, PROGRAM_ID, TXL_MINT, -1, 4),
    ).rejects.toThrow(/serviceLevelId/);
    await expect(
      buildSubscribeInstruction(OFFLINE_CONNECTION, WALLET, PROGRAM_ID, TXL_MINT, 1, 0),
    ).rejects.toThrow(/durationWeeks/);
  });
});

const STAT_KEY_GOALS = 1;
const PERIOD_FULL_TIME = 2;

function validateStatParams(
  overrides: Partial<SubmitValidateStatParams> = {},
): SubmitValidateStatParams {
  const hash = (n: number) => bytesToHex(sha256(Uint8Array.of(n)));
  return {
    connection: OFFLINE_CONNECTION,
    wallet: WALLET,
    programId: PROGRAM_ID,
    ts: 1_783_100_000_000, // unix ms on epoch day 20637
    fixtureSummary: {
      fixtureId: 987654321,
      updateStats: { updateCount: 42, minTimestamp: 1_783_000_000_000, maxTimestamp: 1_783_100_000_000 },
      eventsSubTreeRoot: hash(1),
    },
    fixtureProof: [{ hash: hash(2), isRightSibling: true }],
    mainTreeProof: [{ hash: hash(3), isRightSibling: false }],
    predicate: { threshold: 2, comparison: 'greaterThan' },
    statA: {
      statToProve: { key: STAT_KEY_GOALS, value: 3, period: PERIOD_FULL_TIME },
      eventStatRoot: hash(4),
      statProof: [{ hash: hash(5), isRightSibling: true }],
    },
    ...overrides,
  };
}

describe('buildValidateStatInstruction', () => {
  it('targets the daily_scores_roots PDA for the epoch day derived from ts', async () => {
    const ix = await buildValidateStatInstruction(validateStatParams());
    expect(ix.programId.equals(PROGRAM_ID)).toBe(true);
    expect(ix.keys.length).toBe(1);
    const expectedPda = deriveDailyScoresRootsPda(PROGRAM_ID, 20637);
    expect(ix.keys[0]!.pubkey.toBase58()).toBe(expectedPda.toBase58());
    expect(ix.keys[0]!.isWritable).toBe(false);
    expect(Buffer.from(ix.data.subarray(0, DISCRIMINATOR_LEN))).toEqual(
      anchorDiscriminator('validate_stat'),
    );
  });

  it('honors an explicit epochDay override and second-based ts', async () => {
    const fromSeconds = await buildValidateStatInstruction(
      validateStatParams({ ts: 1_783_100_000 }), // same instant, in seconds
    );
    expect(fromSeconds.keys[0]!.pubkey.toBase58()).toBe(
      deriveDailyScoresRootsPda(PROGRAM_ID, 20637).toBase58(),
    );
    const overridden = await buildValidateStatInstruction(validateStatParams({ epochDay: 20000 }));
    expect(overridden.keys[0]!.pubkey.toBase58()).toBe(
      deriveDailyScoresRootsPda(PROGRAM_ID, 20000).toBase58(),
    );
  });

  it('roundtrips through the anchor coder with all args intact', async () => {
    // Non-zero-index enum variants (LessThan=1, Subtract=1) prove the coder
    // matched our camelCase variant keys instead of falling back to variant 0.
    const params = validateStatParams({
      predicate: { threshold: 2, comparison: 'lessThan' },
      statB: {
        statToProve: { key: STAT_KEY_GOALS, value: 1, period: PERIOD_FULL_TIME },
        eventStatRoot: bytesToHex(sha256(Uint8Array.of(9))),
        statProof: [],
      },
      op: 'subtract',
    });
    const ix = await buildValidateStatInstruction(params);
    const coder = new BorshInstructionCoder(TXORACLE_IDL as unknown as Idl);
    const decoded = coder.decode(Buffer.from(ix.data));
    expect(decoded?.name).toBe('validate_stat');
    const data = decoded?.data as {
      ts: BN;
      fixture_summary: { fixture_id: BN; update_stats: { update_count: number } };
      fixture_proof: { is_right_sibling: boolean }[];
      predicate: { threshold: number; comparison: Record<string, unknown> };
      stat_a: { stat_to_prove: { key: number; value: number; period: number } };
      stat_b: { stat_to_prove: { value: number } } | null;
      op: Record<string, unknown> | null;
    };
    expect(data.ts.toString()).toBe('1783100000000');
    expect(data.fixture_summary.fixture_id.toString()).toBe('987654321');
    expect(data.fixture_summary.update_stats.update_count).toBe(42);
    expect(data.fixture_proof[0]?.is_right_sibling).toBe(true);
    expect(data.predicate.threshold).toBe(2);
    // The raw-IDL decoder reports variants in their on-chain PascalCase names.
    expect(Object.keys(data.predicate.comparison)).toEqual(['LessThan']);
    expect(data.stat_a.stat_to_prove).toEqual({
      key: STAT_KEY_GOALS,
      value: 3,
      period: PERIOD_FULL_TIME,
    });
    expect(data.stat_b?.stat_to_prove.value).toBe(1);
    expect(Object.keys(data.op ?? {})).toEqual(['Subtract']);
  });
});

describe('submitValidateStat (best-effort, never throws)', () => {
  it('returns a structured error when the RPC is unreachable', async () => {
    const deadConnection = {
      getLatestBlockhash: async () => {
        throw new Error('rpc down');
      },
    } as unknown as Connection;
    const result = await submitValidateStat(validateStatParams({ connection: deadConnection }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/validate_stat submission failed/);
  });

  it('returns a structured error on malformed proof input', async () => {
    const result = await submitValidateStat(
      validateStatParams({
        statA: {
          statToProve: { key: STAT_KEY_GOALS, value: 3, period: PERIOD_FULL_TIME },
          eventStatRoot: 'abcdef', // 3 bytes — not a 32-byte hash
          statProof: [],
        },
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/eventStatRoot/);
  });
});
