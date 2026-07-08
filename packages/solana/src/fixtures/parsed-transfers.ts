/**
 * Synthetic getParsedTransactions-shaped fixtures for the deposit scanner.
 * Shapes mirror what api.devnet.solana.com returns for parsed transactions
 * (system transfers, memos, partially-decoded instructions), but every
 * value — signatures, pubkeys, slots, lamports — is INVENTED via
 * ./keys.ts. Nothing here was ever fetched from a real cluster.
 */
import type {
  ParsedInstructionLike,
  ParsedTransactionLike,
  SignatureInfoLike,
} from '../deposits.js';
import { ALICE, BOB, MALLORY, TREASURY, fakeSig } from './keys.js';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const FIXTURE_BLOCK_TIME = 1_780_000_000; // invented, mid-2026

export function systemTransferIx(
  source: string,
  destination: string,
  lamports: number,
): ParsedInstructionLike {
  return {
    program: 'system',
    programId: SYSTEM_PROGRAM_ID,
    parsed: { type: 'transfer', info: { source, destination, lamports } },
  } as ParsedInstructionLike;
}

/** Parsed memo instructions carry the memo text as a bare string payload. */
export function memoIx(text: string): ParsedInstructionLike {
  return { program: 'spl-memo', programId: MEMO_PROGRAM_ID, parsed: text } as ParsedInstructionLike;
}

/** An instruction the parser could not decode (no `program`/`parsed`). */
export function partiallyDecodedIx(programId: string): ParsedInstructionLike {
  return { programId, accounts: [ALICE, TREASURY], data: '3Bxs4NN8M2Yn4TLb' } as ParsedInstructionLike;
}

export function parsedTx(
  sig: string,
  slot: number,
  instructions: ParsedInstructionLike[],
  err: unknown = null,
): ParsedTransactionLike {
  return {
    slot,
    meta: { err },
    transaction: { signatures: [sig], message: { instructions } },
  };
}

export function sigInfo(sig: string, slot: number, err: unknown = null): SignatureInfoLike {
  return { signature: sig, slot, err, memo: null, blockTime: FIXTURE_BLOCK_TIME };
}

// ── canonical deposit scenarios ──────────────────────────────────────────────

/** Plain Phantom-style send: one transfer, no memo. */
export const PLAIN_DEPOSIT_SIG = fakeSig(1);
export const PLAIN_DEPOSIT_LAMPORTS = 50_000_000;
export const PLAIN_DEPOSIT_SLOT = 1_001;
export const PLAIN_DEPOSIT_TX = parsedTx(PLAIN_DEPOSIT_SIG, PLAIN_DEPOSIT_SLOT, [
  systemTransferIx(ALICE, TREASURY, PLAIN_DEPOSIT_LAMPORTS),
]);

/** One transaction carrying TWO transfers to the treasury (CLI/dapp batch),
 * plus an unrelated transfer in between — distinct ixIndex per credit. */
export const DOUBLE_DEPOSIT_SIG = fakeSig(2);
export const DOUBLE_DEPOSIT_SLOT = 1_002;
export const DOUBLE_DEPOSIT_FIRST_LAMPORTS = 10_000_000;
export const DOUBLE_DEPOSIT_SECOND_LAMPORTS = 20_000_000;
export const DOUBLE_DEPOSIT_TX = parsedTx(DOUBLE_DEPOSIT_SIG, DOUBLE_DEPOSIT_SLOT, [
  systemTransferIx(ALICE, TREASURY, DOUBLE_DEPOSIT_FIRST_LAMPORTS),
  systemTransferIx(ALICE, BOB, 5_000_000),
  systemTransferIx(ALICE, TREASURY, DOUBLE_DEPOSIT_SECOND_LAMPORTS),
]);

/** Withdrawal: treasury is the SOURCE — must never be read as a deposit.
 * Includes a treasury→treasury self-transfer for the same reason. */
export const WITHDRAWAL_SIG = fakeSig(3);
export const WITHDRAWAL_SLOT = 1_003;
export const WITHDRAWAL_TX = parsedTx(WITHDRAWAL_SIG, WITHDRAWAL_SLOT, [
  systemTransferIx(TREASURY, BOB, 30_000_000),
  systemTransferIx(TREASURY, TREASURY, 1_000_000),
]);

/** Dust: below the engine's 0.001-SOL minimum credit threshold. */
export const DUST_SIG = fakeSig(4);
export const DUST_SLOT = 1_004;
export const DUST_LAMPORTS = 500_000;
export const DUST_TX = parsedTx(DUST_SIG, DUST_SLOT, [
  systemTransferIx(MALLORY, TREASURY, DUST_LAMPORTS),
]);

/** Memo-bearing deposit: memo tolerated and ignored, transfer extracted. */
export const MEMO_DEPOSIT_SIG = fakeSig(5);
export const MEMO_DEPOSIT_SLOT = 1_005;
export const MEMO_DEPOSIT_LAMPORTS = 25_000_000;
export const MEMO_DEPOSIT_TX = parsedTx(MEMO_DEPOSIT_SIG, MEMO_DEPOSIT_SLOT, [
  memoIx('called it — wager deposit'),
  systemTransferIx(BOB, TREASURY, MEMO_DEPOSIT_LAMPORTS),
]);

/** Unparseable program call alongside a real deposit — tolerated, ignored. */
export const OPAQUE_IX_SIG = fakeSig(6);
export const OPAQUE_IX_SLOT = 1_006;
export const OPAQUE_IX_LAMPORTS = 15_000_000;
export const OPAQUE_IX_TX = parsedTx(OPAQUE_IX_SIG, OPAQUE_IX_SLOT, [
  partiallyDecodedIx('ComputeBudget111111111111111111111111111111'),
  systemTransferIx(ALICE, TREASURY, OPAQUE_IX_LAMPORTS),
]);

/** Transaction that failed on-chain — signature listed with err set. */
export const FAILED_SIG = fakeSig(7);
export const FAILED_SLOT = 1_007;

/** Deposit whose lamports exceed Number.MAX_SAFE_INTEGER — must fail loud. */
export const UNSAFE_LAMPORTS_SIG = fakeSig(8);
export const UNSAFE_LAMPORTS_SLOT = 1_008;
export const UNSAFE_LAMPORTS_TX = parsedTx(UNSAFE_LAMPORTS_SIG, UNSAFE_LAMPORTS_SLOT, [
  systemTransferIx(ALICE, TREASURY, 2 ** 53),
]);
