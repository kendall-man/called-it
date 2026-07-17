/**
 * Treasury deposit scanner — pure chain I/O, no DB knowledge.
 *
 * Reads finalized history for the wager treasury and extracts incoming plain
 * system transfers. The engine watcher owns cursor persistence and crediting;
 * everything here is read-only, so re-running a scan is always safe.
 *
 * Dust-spam defense: getSignaturesForAddress returns at most 1000 signatures
 * newest-first, so anyone spamming the public treasury address could push
 * real deposits past a single-page window. We page backwards with `before`
 * until the node reports it walked all the way to the cursor signature
 * (a short page) — one page is never trusted to be complete.
 */
import { PublicKey, type Connection } from '@solana/web3.js';
import { withRetry, type WithRetryOptions } from './rpc.js';

/** Deposits are credited from finalized history only — no rollback risk. */
export const DEPOSIT_COMMITMENT = 'finalized';
/** RPC maximum page size for getSignaturesForAddress. */
export const SIGNATURE_PAGE_LIMIT = 1_000;
/** Keep getParsedTransactions batches modest — heavy calls on public RPC. */
export const PARSED_TX_BATCH_SIZE = 100;
/** Hard stop for the pagination loop (100k signatures) — a treasury with a
 * deeper unscanned history than this indicates a stuck cursor, not spam. */
const MAX_SIGNATURE_PAGES = 100;
/** Legacy + v0 transactions are both scannable. */
const MAX_SUPPORTED_TX_VERSION = 0;

// ── narrow Connection facet (tests substitute fixture-backed fakes) ─────────

export interface SignatureInfoLike {
  signature: string;
  slot: number;
  err: unknown;
  memo?: string | null;
  blockTime?: number | null;
}

export interface ParsedInstructionLike {
  /** Parser-recognized program name ('system', 'spl-memo', ...); absent on
   * partially-decoded instructions. */
  program?: string;
  /** Present on every instruction shape web3.js returns. */
  programId?: unknown;
  /** Parsed payload — an object for system instructions, a bare string for
   * memos; absent on partially-decoded instructions. */
  parsed?: unknown;
}

export interface ParsedTransactionLike {
  slot: number;
  meta: { err: unknown } | null;
  transaction: {
    signatures: string[];
    message: { instructions: ParsedInstructionLike[] };
  };
}

export interface DepositScanRpc {
  getSignaturesForAddress(
    address: PublicKey,
    options?: { before?: string; until?: string; limit?: number },
    commitment?: 'finalized',
  ): Promise<SignatureInfoLike[]>;
  getParsedTransactions(
    signatures: string[],
    config?: { commitment?: 'finalized'; maxSupportedTransactionVersion?: number },
  ): Promise<(ParsedTransactionLike | null)[]>;
}

// ── public surface ───────────────────────────────────────────────────────────

export interface IncomingTransfer {
  sig: string;
  /** Index of the transfer instruction within the transaction — one tx can
   * carry several transfers to the treasury, each credited separately. */
  ixIndex: number;
  /** Sender pubkey (base58) — matched against wallet links by the engine. */
  sender: string;
  lamports: bigint;
  slot: number;
}

export interface FetchIncomingTransfersOptions {
  /** Cursor: scanning stops at this signature (exclusive). Omit on first run. */
  untilSig?: string;
  /** Drop transfers below this many lamports (default 0n: emit everything —
   * the engine stores sub-minimum deposits as uncredited rows). */
  minLamports?: bigint;
  /** Test seam; defaults to {@link SIGNATURE_PAGE_LIMIT}. */
  pageLimit?: number;
  /** Test seam; defaults to {@link PARSED_TX_BATCH_SIZE}. */
  batchSize?: number;
  /** Backoff knobs forwarded to every RPC call (test seam). */
  retry?: WithRetryOptions;
}

export type FetchIncomingTransfersResult =
  | {
      ok: true;
      /** Oldest-first — ready for in-order, per-signature cursor advance. */
      transfers: IncomingTransfer[];
      /** Newest signature scanned (even if transfer-free spam) — lets the
       * caller advance its cursor past dust once processing succeeds. */
      newestSig: string | null;
      scannedSigs: number;
    }
  | { ok: false; error: string };

/**
 * Collect every incoming system-program transfer to `treasury` newer than
 * `untilSig`, at finalized commitment. Withdrawals (treasury as source),
 * self-transfers, memos, and unparsed instructions are ignored; a signature
 * the node cannot return parsed data for fails the whole scan (never
 * silently skip a possible deposit — the cursor must not advance past it).
 */
export async function fetchIncomingTransfers(
  rpc: DepositScanRpc,
  treasury: PublicKey | string,
  options: FetchIncomingTransfersOptions = {},
): Promise<FetchIncomingTransfersResult> {
  const pageLimit = options.pageLimit ?? SIGNATURE_PAGE_LIMIT;
  const batchSize = options.batchSize ?? PARSED_TX_BATCH_SIZE;
  const minLamports = options.minLamports ?? 0n;

  let treasuryPk: PublicKey;
  try {
    treasuryPk = typeof treasury === 'string' ? new PublicKey(treasury) : treasury;
  } catch (cause) {
    return { ok: false, error: `fetchIncomingTransfers: invalid treasury pubkey: ${errorMessage(cause)}` };
  }
  const treasuryB58 = treasuryPk.toBase58();

  try {
    const infos = await collectSignatureInfos(rpc, treasuryPk, options.untilSig, pageLimit, options.retry);
    // Failed transactions moved no lamports; the cursor itself is already credited.
    const candidates = infos.filter(
      (info) => info.err == null && info.signature !== options.untilSig,
    );

    // Aligned with `candidates` (newest-first); flattened oldest-first below.
    const transfersPerTx: IncomingTransfer[][] = [];
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const sigs = batch.map((info) => info.signature);
      const parsedBatch = await withRetry(
        () =>
          rpc.getParsedTransactions(sigs, {
            commitment: DEPOSIT_COMMITMENT,
            maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
          }),
        options.retry,
      );
      for (let i = 0; i < sigs.length; i++) {
        const sig = sigs[i]!;
        const tx = parsedBatch[i] ?? null;
        if (tx === null) {
          return {
            ok: false,
            error: `fetchIncomingTransfers: getParsedTransactions returned null for finalized signature ${sig}`,
          };
        }
        const extracted = extractTreasuryTransfers(sig, tx, treasuryB58, minLamports);
        if (!extracted.ok) return { ok: false, error: `fetchIncomingTransfers: ${extracted.error}` };
        transfersPerTx.push(extracted.transfers);
      }
    }

    return {
      ok: true,
      transfers: transfersPerTx.reverse().flat(),
      newestSig: infos[0]?.signature ?? null,
      scannedSigs: infos.length,
    };
  } catch (cause) {
    return { ok: false, error: `fetchIncomingTransfers: ${errorMessage(cause)}` };
  }
}

/**
 * Scan finalized SPL-token transfers into a known treasury token account.
 * The destination account fixes the mint; transferChecked instructions are
 * additionally required to report that same mint. The signer authority is
 * used as the linked wallet identity.
 */
export async function fetchIncomingTokenTransfers(
  rpc: DepositScanRpc,
  treasuryTokenAccount: PublicKey | string,
  expectedMint: PublicKey | string,
  options: FetchIncomingTransfersOptions = {},
): Promise<FetchIncomingTransfersResult> {
  const pageLimit = options.pageLimit ?? SIGNATURE_PAGE_LIMIT;
  const batchSize = options.batchSize ?? PARSED_TX_BATCH_SIZE;
  const minimum = options.minLamports ?? 0n;
  try {
    const destinationPk = typeof treasuryTokenAccount === 'string'
      ? new PublicKey(treasuryTokenAccount)
      : treasuryTokenAccount;
    const mintPk = typeof expectedMint === 'string' ? new PublicKey(expectedMint) : expectedMint;
    const destination = destinationPk.toBase58();
    const mint = mintPk.toBase58();
    const infos = await collectSignatureInfos(
      rpc,
      destinationPk,
      options.untilSig,
      pageLimit,
      options.retry,
    );
    const candidates = infos.filter(
      (info) => info.err == null && info.signature !== options.untilSig,
    );
    const transfersPerTx: IncomingTransfer[][] = [];
    for (let offset = 0; offset < candidates.length; offset += batchSize) {
      const batch = candidates.slice(offset, offset + batchSize);
      const sigs = batch.map((info) => info.signature);
      const parsedBatch = await withRetry(
        () => rpc.getParsedTransactions(sigs, {
          commitment: DEPOSIT_COMMITMENT,
          maxSupportedTransactionVersion: MAX_SUPPORTED_TX_VERSION,
        }),
        options.retry,
      );
      for (let index = 0; index < sigs.length; index++) {
        const sig = sigs[index]!;
        const tx = parsedBatch[index] ?? null;
        if (tx === null) {
          return {
            ok: false,
            error: `fetchIncomingTokenTransfers: getParsedTransactions returned null for finalized signature ${sig}`,
          };
        }
        const extracted = extractTokenTransfers(sig, tx, destination, mint, minimum);
        if (!extracted.ok) return extracted;
        transfersPerTx.push(extracted.transfers);
      }
    }
    return {
      ok: true,
      transfers: transfersPerTx.reverse().flat(),
      newestSig: infos[0]?.signature ?? null,
      scannedSigs: infos.length,
    };
  } catch (cause) {
    return { ok: false, error: `fetchIncomingTokenTransfers: ${errorMessage(cause)}` };
  }
}

// ── internals ────────────────────────────────────────────────────────────────

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Newest-first signature walk. The node stops a page early when it reaches
 * `until` (or the start of history), so a full page always means "there may
 * be more" — keep paging with `before` until a short page proves coverage.
 */
async function collectSignatureInfos(
  rpc: DepositScanRpc,
  treasuryPk: PublicKey,
  untilSig: string | undefined,
  pageLimit: number,
  retry: WithRetryOptions | undefined,
): Promise<SignatureInfoLike[]> {
  const collected: SignatureInfoLike[] = [];
  let before: string | undefined;
  for (let page = 0; page < MAX_SIGNATURE_PAGES; page++) {
    const infos = await withRetry(
      () =>
        rpc.getSignaturesForAddress(
          treasuryPk,
          { before, until: untilSig, limit: pageLimit },
          DEPOSIT_COMMITMENT,
        ),
      retry,
    );
    collected.push(...infos);
    if (infos.length < pageLimit) return collected;
    const oldest = infos[infos.length - 1];
    if (!oldest) return collected;
    before = oldest.signature;
  }
  throw new Error(
    `aborted after ${MAX_SIGNATURE_PAGES} signature pages without reaching the cursor — stuck cursor or spam flood`,
  );
}

interface SystemTransferInfo {
  source: string;
  destination: string;
  lamports: number;
}

/** Recognize a parsed system-program transfer; memos, other programs, and
 * partially-decoded instructions return null (tolerated, ignored). */
function asSystemTransfer(ix: ParsedInstructionLike): SystemTransferInfo | null {
  if (ix.program !== 'system' || typeof ix.parsed !== 'object' || ix.parsed === null) return null;
  const parsed = ix.parsed as { type?: unknown; info?: unknown };
  if (parsed.type !== 'transfer') return null;
  const info = parsed.info as
    | { source?: unknown; destination?: unknown; lamports?: unknown }
    | null
    | undefined;
  if (
    !info ||
    typeof info.source !== 'string' ||
    typeof info.destination !== 'string' ||
    typeof info.lamports !== 'number'
  ) {
    return null;
  }
  return { source: info.source, destination: info.destination, lamports: info.lamports };
}

function extractTreasuryTransfers(
  sig: string,
  tx: ParsedTransactionLike,
  treasuryB58: string,
  minLamports: bigint,
): { ok: true; transfers: IncomingTransfer[] } | { ok: false; error: string } {
  // Failed on-chain: fee burned, no lamports moved.
  if (tx.meta?.err != null) return { ok: true, transfers: [] };
  const transfers: IncomingTransfer[] = [];
  const instructions = tx.transaction.message.instructions;
  for (let ixIndex = 0; ixIndex < instructions.length; ixIndex++) {
    const ix = instructions[ixIndex];
    if (!ix) continue;
    const transfer = asSystemTransfer(ix);
    if (!transfer) continue;
    // Withdrawals and self-transfers have the treasury as source — never deposits.
    if (transfer.destination !== treasuryB58) continue;
    if (transfer.source === treasuryB58) continue;
    if (!Number.isSafeInteger(transfer.lamports) || transfer.lamports < 0) {
      return {
        ok: false,
        error: `unsafe lamports value ${String(transfer.lamports)} in ${sig}[${ixIndex}]`,
      };
    }
    const lamports = BigInt(transfer.lamports);
    if (lamports < minLamports) continue;
    transfers.push({ sig, ixIndex, sender: transfer.source, lamports, slot: tx.slot });
  }
  return { ok: true, transfers };
}

function extractTokenTransfers(
  sig: string,
  tx: ParsedTransactionLike,
  treasuryTokenAccount: string,
  expectedMint: string,
  minimum: bigint,
): { ok: true; transfers: IncomingTransfer[] } | { ok: false; error: string } {
  if (tx.meta?.err != null) return { ok: true, transfers: [] };
  const transfers: IncomingTransfer[] = [];
  const instructions = tx.transaction.message.instructions;
  for (let ixIndex = 0; ixIndex < instructions.length; ixIndex++) {
    const ix = instructions[ixIndex];
    if (ix?.program !== 'spl-token' || typeof ix.parsed !== 'object' || ix.parsed === null) continue;
    const parsed = ix.parsed as { type?: unknown; info?: unknown };
    if (parsed.type !== 'transfer' && parsed.type !== 'transferChecked') continue;
    const info = parsed.info as {
      source?: unknown;
      destination?: unknown;
      authority?: unknown;
      mint?: unknown;
      amount?: unknown;
      tokenAmount?: { amount?: unknown };
    } | null;
    if (
      info === null
      || typeof info.destination !== 'string'
      || typeof info.source !== 'string'
      || typeof info.authority !== 'string'
      || info.destination !== treasuryTokenAccount
      || info.source === treasuryTokenAccount
    ) continue;
    if (parsed.type === 'transferChecked' && info.mint !== expectedMint) continue;
    const amount = parsed.type === 'transferChecked' ? info.tokenAmount?.amount : info.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) {
      return { ok: false, error: `unsafe token amount in ${sig}[${ixIndex}]` };
    }
    const atomic = BigInt(amount);
    if (atomic < minimum) continue;
    transfers.push({
      sig,
      ixIndex,
      sender: info.authority,
      lamports: atomic,
      slot: tx.slot,
    });
  }
  return { ok: true, transfers };
}

// ── compile-time proof that a live Connection satisfies the facet ───────────

type Satisfies<T extends U, U> = T;
type _DepositScanRpcCheck = Satisfies<Connection, DepositScanRpc>;
