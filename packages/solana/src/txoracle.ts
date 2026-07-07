/**
 * Node-side client for the TxODDS txoracle Anchor program (devnet
 * 6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J). Built against the official
 * on-chain IDL embedded in ./txoracle-idl.ts.
 *
 * The TxL mint is TOKEN-2022 — all ATA derivations here use
 * TOKEN_2022_PROGRAM_ID; legacy SPL helpers would derive the wrong address.
 */
// @coral-xyz/anchor is CommonJS; under native Node ESM (the built `node
// dist/main.js` that runs in production) a named import of its runtime values
// throws "Named export 'BN' not found". Default-import the module object and
// destructure — the values live on module.exports. (tsx/vitest tolerate the
// named form, so this only bites the production build.)
import type { Idl, Program as AnchorProgram } from '@coral-xyz/anchor';
import anchorPkg from '@coral-xyz/anchor';
// The default (module.exports) carries the runtime values; cast to the module
// namespace type so they're typed without a named import that breaks at runtime.
const { AnchorProvider, BN, Program, Wallet } = anchorPkg as typeof import('@coral-xyz/anchor');
import {
  PublicKey,
  SystemProgram,
  type Connection,
  type Keypair,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { TXORACLE_IDL } from './txoracle-idl.js';
import { decodeHashInput, type HashInput } from './codecs.js';
import { deriveDailyScoresRootsAddress, epochDayFromMs, MS_PER_DAY } from './verify.js';

// PDA seeds confirmed against live devnet accounts (see package tests).
export const PRICING_MATRIX_SEED = 'pricing_matrix';
export const TOKEN_TREASURY_SEED = 'token_treasury_v2';

const MAX_U16 = 0xffff;
const MAX_U8 = 0xff;
const HASH_LEN = 32;
/** Unix timestamps above this are in milliseconds, not seconds. */
const UNIX_MS_THRESHOLD = 100_000_000_000;
const SECONDS_PER_DAY = 86_400;

export function derivePricingMatrixPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(PRICING_MATRIX_SEED)], programId)[0];
}

export function deriveTokenTreasuryPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from(TOKEN_TREASURY_SEED)], programId)[0];
}

export function deriveDailyScoresRootsPda(programId: PublicKey, epochDay: number): PublicKey {
  return new PublicKey(deriveDailyScoresRootsAddress(programId.toBase58(), epochDay));
}

function asPublicKey(value: PublicKey | string): PublicKey {
  return typeof value === 'string' ? new PublicKey(value) : value;
}

/** Loose builder shape — the untyped-IDL `program.methods` entries. */
interface MethodsBuilder {
  accountsStrict(accounts: Record<string, PublicKey>): MethodsBuilder;
  instruction(): Promise<TransactionInstruction>;
  rpc(): Promise<string>;
}

function createTxoracleProgram(
  connection: Connection,
  wallet: Keypair,
  programId: PublicKey,
): AnchorProgram {
  const provider = new AnchorProvider(connection, new Wallet(wallet), {
    commitment: 'confirmed',
  });
  // Clone the IDL so a caller-supplied programId (e.g. a future mainnet
  // deployment) overrides the embedded devnet address.
  const idl = { ...(TXORACLE_IDL as unknown as Record<string, unknown>), address: programId.toBase58() };
  return new Program(idl as Idl, provider);
}

function method(program: AnchorProgram, name: string, args: readonly unknown[]): MethodsBuilder {
  const methods = program.methods as unknown as Record<
    string,
    ((...callArgs: unknown[]) => MethodsBuilder) | undefined
  >;
  const factory = methods[name];
  if (!factory) {
    throw new Error(`txoracle IDL has no instruction "${name}"`);
  }
  return factory(...args);
}

// ── subscribe ────────────────────────────────────────────────────────────────

export interface SubscribeAccounts {
  user: PublicKey;
  pricingMatrix: PublicKey;
  tokenMint: PublicKey;
  userTokenAccount: PublicKey;
  tokenTreasuryVault: PublicKey;
  tokenTreasuryPda: PublicKey;
}

/** All accounts the txoracle `subscribe` instruction needs, TOKEN-2022 ATAs included. */
export function deriveSubscribeAccounts(
  programId: PublicKey,
  txlMint: PublicKey,
  user: PublicKey,
): SubscribeAccounts {
  const tokenTreasuryPda = deriveTokenTreasuryPda(programId);
  return {
    user,
    pricingMatrix: derivePricingMatrixPda(programId),
    tokenMint: txlMint,
    userTokenAccount: getAssociatedTokenAddressSync(txlMint, user, false, TOKEN_2022_PROGRAM_ID),
    tokenTreasuryVault: getAssociatedTokenAddressSync(
      txlMint,
      tokenTreasuryPda,
      true, // treasury owner is a PDA (off-curve)
      TOKEN_2022_PROGRAM_ID,
    ),
    tokenTreasuryPda,
  };
}

function subscribeBuilder(
  program: AnchorProgram,
  wallet: Keypair,
  txlMint: PublicKey,
  serviceLevelId: number,
  durationWeeks: number,
): MethodsBuilder {
  if (!Number.isInteger(serviceLevelId) || serviceLevelId < 0 || serviceLevelId > MAX_U16) {
    throw new Error(`serviceLevelId must be a u16 (0-${MAX_U16}), got ${serviceLevelId}`);
  }
  if (!Number.isInteger(durationWeeks) || durationWeeks < 1 || durationWeeks > MAX_U8) {
    throw new Error(`durationWeeks must be a u8 >= 1, got ${durationWeeks}`);
  }
  const accounts = deriveSubscribeAccounts(program.programId, txlMint, wallet.publicKey);
  return method(program, 'subscribe', [serviceLevelId, durationWeeks]).accountsStrict({
    ...accounts,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
  });
}

/** Offline construction of the subscribe instruction (used by tests and dry runs). */
export async function buildSubscribeInstruction(
  connection: Connection,
  wallet: Keypair,
  programId: PublicKey | string,
  txlMint: PublicKey | string,
  serviceLevelId: number,
  durationWeeks: number,
): Promise<TransactionInstruction> {
  const program = createTxoracleProgram(connection, wallet, asPublicKey(programId));
  return subscribeBuilder(
    program,
    wallet,
    asPublicKey(txlMint),
    serviceLevelId,
    durationWeeks,
  ).instruction();
}

/**
 * Send the txoracle `subscribe` instruction (on-chain step of the TxLINE auth
 * chain). Resolves to the transaction signature to pass into signActivation /
 * POST /api/token/activate. Throws with a descriptive error on failure.
 */
export async function subscribeTxline(
  connection: Connection,
  wallet: Keypair,
  programId: PublicKey | string,
  txlMint: PublicKey | string,
  serviceLevelId: number,
  durationWeeks: number,
): Promise<string> {
  const program = createTxoracleProgram(connection, wallet, asPublicKey(programId));
  return subscribeBuilder(
    program,
    wallet,
    asPublicKey(txlMint),
    serviceLevelId,
    durationWeeks,
  ).rpc();
}

// ── validate_stat ────────────────────────────────────────────────────────────

/** Mirrors the on-chain ScoreStat struct (stat keys 1-8 are team-level). */
export interface ScoreStatInput {
  key: number;
  value: number;
  period: number;
}

/** One node of a Merkle path as returned by /api/scores/stat-validation. */
export interface ProofNodeInput {
  hash: HashInput;
  isRightSibling: boolean;
}

export interface StatTermInput {
  statToProve: ScoreStatInput;
  eventStatRoot: HashInput;
  statProof: readonly ProofNodeInput[];
}

export interface ScoresBatchSummaryInput {
  fixtureId: number | bigint;
  updateStats: {
    updateCount: number;
    minTimestamp: number | bigint;
    maxTimestamp: number | bigint;
  };
  eventsSubTreeRoot: HashInput;
}

export type ComparisonInput = 'greaterThan' | 'lessThan' | 'equalTo';
export type BinaryOpInput = 'add' | 'subtract';

export interface TraderPredicateInput {
  threshold: number;
  comparison: ComparisonInput;
}

export interface SubmitValidateStatParams {
  connection: Connection;
  wallet: Keypair;
  programId: PublicKey | string;
  /** `ts` from the stat-validation response (unix ms or seconds — auto-detected for the PDA). */
  ts: number | bigint;
  fixtureSummary: ScoresBatchSummaryInput;
  fixtureProof: readonly ProofNodeInput[];
  mainTreeProof: readonly ProofNodeInput[];
  predicate: TraderPredicateInput;
  statA: StatTermInput;
  statB?: StatTermInput;
  op?: BinaryOpInput;
  /** Overrides the epoch day derived from `ts` when selecting the roots PDA. */
  epochDay?: number;
}

export type ValidateStatResult =
  | { ok: true; txSig: string }
  | { ok: false; error: string };

function toHash32(input: HashInput, label: string): number[] {
  const bytes = decodeHashInput(input);
  if (bytes.length !== HASH_LEN) {
    throw new Error(`${label} must be ${HASH_LEN} bytes, got ${bytes.length}`);
  }
  return Array.from(bytes);
}

function toProofNodeArg(node: ProofNodeInput, label: string) {
  return {
    hash: toHash32(node.hash, `${label}.hash`),
    isRightSibling: node.isRightSibling,
  };
}

function toStatTermArg(term: StatTermInput, label: string) {
  return {
    statToProve: { ...term.statToProve },
    eventStatRoot: toHash32(term.eventStatRoot, `${label}.eventStatRoot`),
    statProof: term.statProof.map((node, i) => toProofNodeArg(node, `${label}.statProof[${i}]`)),
  };
}

function epochDayFromTs(ts: number | bigint): number {
  const numeric = Number(ts);
  return numeric > UNIX_MS_THRESHOLD
    ? epochDayFromMs(numeric)
    : Math.floor(numeric / SECONDS_PER_DAY);
}

function validateStatBuilder(params: SubmitValidateStatParams): MethodsBuilder {
  const programId = asPublicKey(params.programId);
  const program = createTxoracleProgram(params.connection, params.wallet, programId);
  const epochDay = params.epochDay ?? epochDayFromTs(params.ts);
  const args = [
    new BN(params.ts.toString()),
    {
      fixtureId: new BN(params.fixtureSummary.fixtureId.toString()),
      updateStats: {
        updateCount: params.fixtureSummary.updateStats.updateCount,
        minTimestamp: new BN(params.fixtureSummary.updateStats.minTimestamp.toString()),
        maxTimestamp: new BN(params.fixtureSummary.updateStats.maxTimestamp.toString()),
      },
      eventsSubTreeRoot: toHash32(
        params.fixtureSummary.eventsSubTreeRoot,
        'fixtureSummary.eventsSubTreeRoot',
      ),
    },
    params.fixtureProof.map((node, i) => toProofNodeArg(node, `fixtureProof[${i}]`)),
    params.mainTreeProof.map((node, i) => toProofNodeArg(node, `mainTreeProof[${i}]`)),
    { threshold: params.predicate.threshold, comparison: { [params.predicate.comparison]: {} } },
    toStatTermArg(params.statA, 'statA'),
    params.statB ? toStatTermArg(params.statB, 'statB') : null,
    params.op ? { [params.op]: {} } : null,
  ];
  return method(program, 'validateStat', args).accountsStrict({
    dailyScoresMerkleRoots: deriveDailyScoresRootsPda(programId, epochDay),
  });
}

/** Offline construction of the validate_stat instruction (used by tests). */
export async function buildValidateStatInstruction(
  params: SubmitValidateStatParams,
): Promise<TransactionInstruction> {
  return validateStatBuilder(params).instruction();
}

/**
 * Submit the on-chain `validate_stat` proof check. Best-effort by contract:
 * proof failure must never block or reverse a settlement, so this NEVER
 * throws — every failure comes back as `{ ok: false, error }`.
 */
export async function submitValidateStat(
  params: SubmitValidateStatParams,
): Promise<ValidateStatResult> {
  try {
    const txSig = await validateStatBuilder(params).rpc();
    return { ok: true, txSig };
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause);
    return { ok: false, error: `validate_stat submission failed: ${error}` };
  }
}
