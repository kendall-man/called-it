import type { ReceiptCurrency, ReceiptOutcome } from './receipts';

export type EscrowCluster = 'localnet' | 'devnet' | 'mainnet-beta';
export type EscrowPositionState = 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed';
export type EscrowClaimKind = 'payout' | 'refund';

export type PublicEscrowAggregate = {
  readonly side: 'back' | 'doubt';
  readonly state: EscrowPositionState;
  readonly lotCount: number;
  readonly amountAtomic: string;
};

export type PublicEscrowClaimTransaction = {
  readonly signature: string;
  readonly slot: string;
  readonly claimedAt: string | null;
  readonly claimKind: EscrowClaimKind;
  readonly recipientCount: number;
  readonly amountAtomic: string;
};

export type PublicEscrowReceipt = {
  readonly marketId: string;
  readonly groupSlug: string;
  readonly cluster: EscrowCluster;
  readonly asset: ReceiptCurrency;
  readonly programId: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly documentHashHex: string;
  readonly initializeSignature: string;
  readonly initializeSlot: string;
  readonly outcome: ReceiptOutcome | null;
  readonly settlementSignature: string | null;
  readonly settlementSlot: string | null;
  readonly settlementEvidenceHashHex: string | null;
  readonly settledAt: string | null;
  readonly aggregates: readonly PublicEscrowAggregate[];
  readonly claimTransactions: readonly PublicEscrowClaimTransaction[];
  readonly payoutTotalAtomic: string;
  readonly refundTotalAtomic: string;
};

type EscrowReceiptRow = Omit<
  PublicEscrowReceipt,
  'aggregates' | 'claimTransactions' | 'payoutTotalAtomic' | 'refundTotalAtomic'
>;

type AggregateRow = PublicEscrowAggregate & {
  readonly marketId: string;
  readonly cluster: EscrowCluster;
  readonly asset: ReceiptCurrency;
};

type ClaimRow = PublicEscrowClaimTransaction & {
  readonly marketId: string;
  readonly cluster: EscrowCluster;
  readonly asset: ReceiptCurrency;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const GROUP_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;

export function escrowReceiptFromRow(row: unknown): EscrowReceiptRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const groupSlug = text(row.group_slug);
  const cluster = oneOf(row.cluster, ['localnet', 'devnet', 'mainnet-beta'] as const);
  const asset = oneOf(row.asset, ['sol', 'usdc'] as const);
  const programId = text(row.program_id);
  const marketPda = text(row.market_pda);
  const vaultPda = text(row.vault_pda);
  const documentHashHex = text(row.document_hash_hex);
  const initializeSignature = text(row.initialize_signature);
  const initializeSlot = decimal(row.initialize_slot);
  const outcome = nullableOneOf(row.outcome, ['claim_won', 'claim_lost', 'void'] as const);
  const settlementSignature = nullableText(row.settlement_signature);
  const settlementSlot = nullableDecimal(row.settlement_slot);
  const settlementEvidenceHashHex = nullableText(row.evidence_hash_hex);
  const settledAt = nullableTimestamp(row.settled_at);
  if (
    marketId === null || !UUID_PATTERN.test(marketId) ||
    groupSlug === null || !GROUP_SLUG_PATTERN.test(groupSlug) ||
    cluster === null || asset === null ||
    programId === null || !PUBKEY_PATTERN.test(programId) ||
    marketPda === null || !PUBKEY_PATTERN.test(marketPda) ||
    vaultPda === null || !PUBKEY_PATTERN.test(vaultPda) ||
    documentHashHex === null || !HASH_PATTERN.test(documentHashHex) ||
    initializeSignature === null || !SIGNATURE_PATTERN.test(initializeSignature) ||
    initializeSlot === null || outcome === undefined || settlementSignature === undefined ||
    settlementSlot === undefined || settlementEvidenceHashHex === undefined || settledAt === undefined
  ) return null;
  const hasSettlement = settlementSignature !== null;
  if (
    hasSettlement !== (settlementSlot !== null) ||
    hasSettlement !== (settlementEvidenceHashHex !== null) ||
    hasSettlement !== (settledAt !== null) ||
    hasSettlement !== (outcome !== null) ||
    (settlementSignature !== null && !SIGNATURE_PATTERN.test(settlementSignature)) ||
    (settlementEvidenceHashHex !== null && !HASH_PATTERN.test(settlementEvidenceHashHex))
  ) return null;
  return {
    marketId,
    groupSlug,
    cluster,
    asset,
    programId,
    marketPda,
    vaultPda,
    documentHashHex: documentHashHex.toLowerCase(),
    initializeSignature,
    initializeSlot,
    outcome,
    settlementSignature,
    settlementSlot,
    settlementEvidenceHashHex: settlementEvidenceHashHex?.toLowerCase() ?? null,
    settledAt,
  };
}

export function escrowAggregateFromRow(row: unknown): AggregateRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const cluster = oneOf(row.cluster, ['localnet', 'devnet', 'mainnet-beta'] as const);
  const asset = oneOf(row.asset, ['sol', 'usdc'] as const);
  const side = oneOf(row.side, ['back', 'doubt'] as const);
  const state = oneOf(
    row.state,
    ['pending', 'active', 'invalidated', 'refundable', 'claimed'] as const,
  );
  const lotCount = safeCount(row.lot_count);
  const amountAtomic = decimal(row.amount_atomic);
  if (
    marketId === null || !UUID_PATTERN.test(marketId) || cluster === null || asset === null ||
    side === null || state === null || lotCount === null || amountAtomic === null
  ) return null;
  return { marketId, cluster, asset, side, state, lotCount, amountAtomic };
}

export function escrowClaimTransactionFromRow(row: unknown): ClaimRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const cluster = oneOf(row.cluster, ['localnet', 'devnet', 'mainnet-beta'] as const);
  const asset = oneOf(row.asset, ['sol', 'usdc'] as const);
  const signature = text(row.claim_signature);
  const slot = decimal(row.claim_slot);
  const claimedAt = nullableTimestamp(row.claimed_at);
  const claimKind = oneOf(row.claim_kind, ['payout', 'refund'] as const);
  const recipientCount = safeCount(row.recipient_count);
  const amountAtomic = decimal(row.amount_atomic);
  if (
    marketId === null || !UUID_PATTERN.test(marketId) || cluster === null || asset === null ||
    signature === null || !SIGNATURE_PATTERN.test(signature) || slot === null || claimedAt === undefined ||
    claimKind === null || recipientCount === null || amountAtomic === null
  ) return null;
  return { marketId, cluster, asset, signature, slot, claimedAt, claimKind, recipientCount, amountAtomic };
}

export function assembleEscrowReceipts(
  receiptRows: unknown,
  aggregateRows: unknown,
  claimRows: unknown,
): readonly PublicEscrowReceipt[] | null {
  if (!Array.isArray(receiptRows) || !Array.isArray(aggregateRows) || !Array.isArray(claimRows)) return null;
  const receipts = mapStrict(receiptRows, escrowReceiptFromRow);
  const aggregates = mapStrict(aggregateRows, escrowAggregateFromRow);
  const claims = mapStrict(claimRows, escrowClaimTransactionFromRow);
  if (receipts === null || aggregates === null || claims === null) return null;
  const receiptByMarket = dedupe(receipts, (row) => row.marketId);
  const aggregateRowsUnique = dedupe(
    aggregates,
    (row) => `${row.marketId}:${row.asset}:${row.side}:${row.state}`,
  );
  const claimRowsUnique = dedupe(
    claims,
    (row) => `${row.marketId}:${row.signature}:${row.asset}:${row.claimKind}:${row.slot}`,
  );
  if (receiptByMarket === null || aggregateRowsUnique === null || claimRowsUnique === null) return null;
  const markets = new Map(receiptByMarket.map((row) => [row.marketId, row]));
  for (const row of [...aggregateRowsUnique, ...claimRowsUnique]) {
    const receipt = markets.get(row.marketId);
    if (receipt === undefined || receipt.cluster !== row.cluster || receipt.asset !== row.asset) return null;
  }
  return receiptByMarket.map((receipt) => {
    const marketAggregates = aggregateRowsUnique
      .filter((row) => row.marketId === receipt.marketId)
      .map(({ marketId: _marketId, cluster: _cluster, asset: _asset, ...row }) => row);
    const marketClaims = claimRowsUnique
      .filter((row) => row.marketId === receipt.marketId)
      .map(({ marketId: _marketId, cluster: _cluster, asset: _asset, ...row }) => row);
    return {
      ...receipt,
      aggregates: marketAggregates,
      claimTransactions: marketClaims,
      payoutTotalAtomic: sumClaims(marketClaims, 'payout'),
      refundTotalAtomic: sumClaims(marketClaims, 'refund'),
    };
  });
}

export function explorerTransactionUrlForCluster(
  signature: string,
  cluster: EscrowCluster,
): string | null {
  if (!SIGNATURE_PATTERN.test(signature) || cluster === 'localnet') return null;
  const url = new URL(`/tx/${signature}`, 'https://explorer.solana.com');
  if (cluster === 'devnet') url.searchParams.set('cluster', 'devnet');
  return url.toString();
}

export function escrowNetworkLabel(cluster: EscrowCluster): string {
  if (cluster === 'mainnet-beta') return 'Solana mainnet';
  if (cluster === 'devnet') return 'Solana devnet';
  return 'Local validator';
}

function sumClaims(rows: readonly PublicEscrowClaimTransaction[], kind: EscrowClaimKind): string {
  return rows
    .filter((row) => row.claimKind === kind)
    .reduce((total, row) => total + BigInt(row.amountAtomic), 0n)
    .toString();
}

function mapStrict<T>(rows: readonly unknown[], mapper: (row: unknown) => T | null): T[] | null {
  const result: T[] = [];
  for (const row of rows) {
    const mapped = mapper(row);
    if (mapped === null) return null;
    result.push(mapped);
  }
  return result;
}

function dedupe<T>(rows: readonly T[], key: (row: T) => string): T[] | null {
  const values = new Map<string, T>();
  for (const row of rows) {
    const identity = key(row);
    const current = values.get(identity);
    if (current !== undefined && JSON.stringify(current) !== JSON.stringify(row)) return null;
    values.set(identity, row);
  }
  return [...values.values()];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function nullableText(value: unknown): string | null | undefined {
  return value === null ? null : text(value) ?? undefined;
}

function decimal(value: unknown): string | null {
  const normalized = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof normalized === 'string' && DECIMAL_PATTERN.test(normalized) ? normalized : null;
}

function nullableDecimal(value: unknown): string | null | undefined {
  return value === null ? null : decimal(value) ?? undefined;
}

function safeCount(value: unknown): number | null {
  const parsed = decimal(value);
  if (parsed === null) return null;
  const count = Number(parsed);
  return Number.isSafeInteger(count) ? count : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  const parsed = text(value);
  return parsed !== null && !Number.isNaN(Date.parse(parsed)) ? parsed : undefined;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : null;
}

function nullableOneOf<T extends string>(value: unknown, choices: readonly T[]): T | null | undefined {
  return value === null ? null : oneOf(value, choices) ?? undefined;
}
