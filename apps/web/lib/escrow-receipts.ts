import type {
  PriceProvenance,
  PublicGroupBoardMarket,
  PublicMarketTerms,
  PublicReceipt,
  ReceiptCurrency,
  ReceiptOutcome,
} from './receipts';
import { describePeriod, describeTerms, parseMarketSpec } from './spec-terms';
import { publicSolanaNetwork, type PublicSolanaNetwork } from './solana-network';

export type EscrowCluster = 'localnet' | PublicSolanaNetwork;
export type EscrowPositionState = 'pending' | 'active' | 'invalidated' | 'refundable' | 'claimed';
export type EscrowClaimKind = 'payout' | 'refund';
export type EscrowChainState = 'open' | 'frozen' | 'settled' | 'voided' | 'closed';
export type EscrowReceiptStatus = 'open' | 'frozen' | 'settled' | 'voided';

export const ESCROW_GENESIS_BY_NETWORK = {
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
} as const satisfies Record<PublicSolanaNetwork, string>;

export type PublicEscrowIdentityConfig = {
  readonly network: PublicSolanaNetwork;
  readonly genesisHash: string;
  readonly programId: string;
  readonly canonicalUsdcMint: string | null;
};

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
  readonly cluster: PublicSolanaNetwork;
  readonly asset: ReceiptCurrency;
  readonly fixtureId: number;
  readonly terms: PublicMarketTerms;
  readonly isReplay: boolean;
  readonly kickoffAt: string | null;
  readonly createdAt: string;
  readonly priceProvenance: PriceProvenance;
  readonly quoteProbability: number;
  readonly quoteMultiplier: number;
  readonly probabilityPpm: number;
  readonly ratioMilli: string;
  readonly programId: string;
  readonly genesisHash: string;
  readonly marketPda: string;
  readonly vaultPda: string;
  readonly mintPubkey: string | null;
  readonly custodyVersion: number;
  readonly chainState: EscrowChainState;
  readonly status: EscrowReceiptStatus;
  readonly documentHashHex: string;
  readonly initializeSignature: string;
  readonly initializeInstructionIndex: number;
  readonly initializeSlot: string;
  readonly initializeBlockTime: string | null;
  readonly outcome: ReceiptOutcome | null;
  readonly settlementSignature: string | null;
  readonly settlementInstructionIndex: number | null;
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
> & {
  /** Validated snapshot inputs retained only long enough to detect conflicting duplicate rows. */
  readonly fixtureP1Name: string;
  readonly fixtureP2Name: string;
};

type AggregateRow = PublicEscrowAggregate & {
  readonly marketId: string;
  readonly cluster: PublicSolanaNetwork;
  readonly asset: ReceiptCurrency;
};

type ClaimRow = PublicEscrowClaimTransaction & {
  readonly marketId: string;
  readonly cluster: PublicSolanaNetwork;
  readonly asset: ReceiptCurrency;
};

type DisplayTotals = {
  readonly back: string;
  readonly doubt: string;
  readonly matched: string;
  readonly positionCount: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBKEY_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,64}$/;
const SIGNATURE_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{64,128}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/i;
const GROUP_SLUG_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const DECIMAL_PATTERN = /^(?:0|[1-9]\d*)$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function getPublicEscrowIdentityConfig(
  source: Readonly<Record<string, string | undefined>> = process.env,
): PublicEscrowIdentityConfig | null {
  const network = publicSolanaNetwork(source.NEXT_PUBLIC_SOLANA_NETWORK);
  const genesisHash = source.NEXT_PUBLIC_ESCROW_GENESIS_HASH;
  const programId = source.NEXT_PUBLIC_ESCROW_PROGRAM_ID;
  const canonicalUsdcMint = source.NEXT_PUBLIC_ESCROW_CANONICAL_USDC_MINT ?? null;
  if (
    genesisHash !== ESCROW_GENESIS_BY_NETWORK[network] ||
    programId === undefined ||
    !PUBKEY_PATTERN.test(programId) ||
    (canonicalUsdcMint !== null && !PUBKEY_PATTERN.test(canonicalUsdcMint))
  ) return null;
  return { network, genesisHash, programId, canonicalUsdcMint };
}

export function escrowReceiptFromRow(
  row: unknown,
  identity: PublicEscrowIdentityConfig,
): EscrowReceiptRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const groupSlug = text(row.group_slug);
  const cluster = oneOf(row.cluster, ['devnet', 'mainnet-beta'] as const);
  const asset = oneOf(row.asset, ['sol', 'usdc'] as const);
  const currency = oneOf(row.currency, ['sol', 'usdc'] as const);
  const fixtureId = safeCount(row.fixture_id);
  const fixtureP1Name = safeFixtureName(row.fixture_p1_name);
  const fixtureP2Name = safeFixtureName(row.fixture_p2_name);
  const spec = parseMarketSpec(row.spec);
  const kickoffAt = nullableTimestamp(row.kickoff_at);
  const createdAt = requiredTimestamp(row.created_at);
  const priceProvenance = oneOf(row.price_provenance, ['market', 'modelled'] as const);
  const quoteProbability = finiteNumber(row.quote_probability);
  const quoteMultiplier = finiteNumber(row.quote_multiplier);
  const probabilityPpm = safeCount(row.probability_ppm);
  const ratioMilli = decimal(row.ratio_milli);
  const programId = text(row.program_id);
  const genesisHash = text(row.genesis_hash);
  const marketPda = text(row.market_pda);
  const vaultPda = text(row.vault_pda);
  const mintPubkey = nullableText(row.mint_pubkey);
  const custodyVersion = safeCount(row.custody_version);
  const chainState = oneOf(row.chain_state, ['open', 'frozen', 'settled', 'voided', 'closed'] as const);
  const status = oneOf(row.status, ['open', 'frozen', 'settled', 'voided'] as const);
  const documentHashHex = text(row.document_hash_hex);
  const initializeSignature = text(row.initialize_signature);
  const initializeInstructionIndex = safeCount(row.initialize_instruction_index);
  const initializeSlot = decimal(row.initialize_slot);
  const initializeBlockTime = nullableTimestamp(row.initialize_block_time);
  const outcome = nullableOneOf(row.outcome, ['claim_won', 'claim_lost', 'void'] as const);
  const settlementSignature = nullableText(row.settlement_signature);
  const settlementInstructionIndex = nullableSafeCount(row.settlement_instruction_index);
  const settlementSlot = nullableDecimal(row.settlement_slot);
  const settlementEvidenceHashHex = nullableText(row.evidence_hash_hex);
  const settledAt = nullableTimestamp(row.settled_at);
  if (
    row.web_enabled !== true ||
    marketId === null || !UUID_PATTERN.test(marketId) ||
    groupSlug === null || !GROUP_SLUG_PATTERN.test(groupSlug) ||
    cluster === null || cluster !== identity.network ||
    asset === null || currency !== asset ||
    fixtureId === null || fixtureP1Name === null || fixtureP2Name === null || spec === null ||
    spec.fixtureId !== fixtureId || typeof row.is_replay !== 'boolean' ||
    kickoffAt === undefined || createdAt === null || priceProvenance === null ||
    quoteProbability === null || quoteProbability <= 0 || quoteProbability >= 1 ||
    quoteMultiplier === null || quoteMultiplier <= 0 ||
    probabilityPpm === null || probabilityPpm < 1 || probabilityPpm > 999_999 ||
    ratioMilli === null || BigInt(ratioMilli) < 1n ||
    programId === null || !PUBKEY_PATTERN.test(programId) || programId !== identity.programId ||
    genesisHash === null || genesisHash !== ESCROW_GENESIS_BY_NETWORK[cluster] ||
    genesisHash !== identity.genesisHash ||
    marketPda === null || !PUBKEY_PATTERN.test(marketPda) ||
    vaultPda === null || !PUBKEY_PATTERN.test(vaultPda) ||
    mintPubkey === undefined || !validAssetMint(asset, mintPubkey, identity) ||
    custodyVersion === null || custodyVersion < 1 || chainState === null || status === null ||
    documentHashHex === null || !HASH_PATTERN.test(documentHashHex) ||
    initializeSignature === null || !SIGNATURE_PATTERN.test(initializeSignature) ||
    initializeInstructionIndex === null || initializeSlot === null || initializeBlockTime === undefined ||
    outcome === undefined || settlementSignature === undefined ||
    settlementInstructionIndex === undefined || settlementSlot === undefined ||
    settlementEvidenceHashHex === undefined || settledAt === undefined
  ) return null;

  const expectedProbabilityPpm = Math.round(quoteProbability * 1_000_000);
  const ppm = BigInt(probabilityPpm);
  const expectedRatio = maximum(
    (((1_000_000n - ppm) * 1_000n) + (ppm / 2n)) / ppm,
    1n,
  );
  if (expectedProbabilityPpm !== probabilityPpm || BigInt(ratioMilli) !== expectedRatio) return null;

  const hasSettlement = settlementSignature !== null;
  if (
    hasSettlement !== (settlementInstructionIndex !== null) ||
    hasSettlement !== (settlementSlot !== null) ||
    hasSettlement !== (settlementEvidenceHashHex !== null) ||
    hasSettlement !== (outcome !== null) ||
    (settlementSignature !== null && !SIGNATURE_PATTERN.test(settlementSignature)) ||
    (settlementEvidenceHashHex !== null && !HASH_PATTERN.test(settlementEvidenceHashHex)) ||
    !validSettlementState(chainState, status, outcome, hasSettlement)
  ) return null;

  return {
    marketId,
    groupSlug,
    cluster,
    asset,
    fixtureId,
    fixtureP1Name,
    fixtureP2Name,
    terms: {
      fixtureId: spec.fixtureId,
      text: describeTerms(spec),
      period: describePeriod(spec.period),
      trustTier: spec.trustTier,
    },
    isReplay: row.is_replay,
    kickoffAt,
    createdAt,
    priceProvenance,
    quoteProbability,
    quoteMultiplier,
    probabilityPpm,
    ratioMilli,
    programId,
    genesisHash,
    marketPda,
    vaultPda,
    mintPubkey,
    custodyVersion,
    chainState,
    status,
    documentHashHex: documentHashHex.toLowerCase(),
    initializeSignature,
    initializeInstructionIndex,
    initializeSlot,
    initializeBlockTime,
    outcome,
    settlementSignature,
    settlementInstructionIndex,
    settlementSlot,
    settlementEvidenceHashHex: settlementEvidenceHashHex?.toLowerCase() ?? null,
    settledAt,
  };
}

export function escrowAggregateFromRow(row: unknown): AggregateRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const cluster = oneOf(row.cluster, ['devnet', 'mainnet-beta'] as const);
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
    side === null || state === null || lotCount === null || lotCount < 1 ||
    amountAtomic === null || BigInt(amountAtomic) < 1n
  ) return null;
  return { marketId, cluster, asset, side, state, lotCount, amountAtomic };
}

export function escrowClaimTransactionFromRow(row: unknown): ClaimRow | null {
  if (!isRecord(row)) return null;
  const marketId = text(row.market_id);
  const cluster = oneOf(row.cluster, ['devnet', 'mainnet-beta'] as const);
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
    claimKind === null || recipientCount === null || recipientCount < 1 ||
    amountAtomic === null || BigInt(amountAtomic) < 1n
  ) return null;
  return { marketId, cluster, asset, signature, slot, claimedAt, claimKind, recipientCount, amountAtomic };
}

export function assembleEscrowReceipts(
  receiptRows: unknown,
  aggregateRows: unknown,
  claimRows: unknown,
  identity: PublicEscrowIdentityConfig,
): readonly PublicEscrowReceipt[] | null {
  if (!Array.isArray(receiptRows) || !Array.isArray(aggregateRows) || !Array.isArray(claimRows)) return null;
  const receipts = mapStrict(receiptRows, (row) => escrowReceiptFromRow(row, identity));
  const aggregates = mapStrict(aggregateRows, escrowAggregateFromRow);
  const claims = mapStrict(claimRows, escrowClaimTransactionFromRow);
  if (receipts === null || aggregates === null || claims === null) return null;
  const receiptRowsUnique = dedupe(receipts, (row) => row.marketId);
  const aggregateRowsUnique = dedupe(
    aggregates,
    (row) => `${row.marketId}:${row.asset}:${row.side}:${row.state}`,
  );
  const claimRowsUnique = dedupe(
    claims,
    (row) => `${row.marketId}:${row.signature}:${row.asset}:${row.claimKind}:${row.slot}`,
  );
  if (receiptRowsUnique === null || aggregateRowsUnique === null || claimRowsUnique === null) return null;
  const markets = new Map(receiptRowsUnique.map((row) => [row.marketId, row]));
  for (const row of [...aggregateRowsUnique, ...claimRowsUnique]) {
    const receipt = markets.get(row.marketId);
    if (receipt === undefined || receipt.cluster !== row.cluster || receipt.asset !== row.asset) return null;
  }

  const assembled: PublicEscrowReceipt[] = [];
  for (const receiptRow of receiptRowsUnique) {
    const marketAggregates = aggregateRowsUnique
      .filter((row) => row.marketId === receiptRow.marketId)
      .map(({ marketId: _marketId, cluster: _cluster, asset: _asset, ...row }) => row);
    const marketClaims = claimRowsUnique
      .filter((row) => row.marketId === receiptRow.marketId)
      .map(({ marketId: _marketId, cluster: _cluster, asset: _asset, ...row }) => row);
    if (!validClaimsForReceipt(receiptRow, marketClaims) || positionCount(marketAggregates) === null) {
      return null;
    }
    const { fixtureP1Name: _fixtureP1Name, fixtureP2Name: _fixtureP2Name, ...receipt } = receiptRow;
    assembled.push({
      ...receipt,
      aggregates: marketAggregates,
      claimTransactions: marketClaims,
      payoutTotalAtomic: sumClaims(marketClaims, 'payout'),
      refundTotalAtomic: sumClaims(marketClaims, 'refund'),
    });
  }
  return assembled;
}

export function publicReceiptFromEscrow(escrow: PublicEscrowReceipt): PublicReceipt | null {
  const totals = displayTotals(escrow);
  if (totals === null) return null;
  return {
    marketId: escrow.marketId,
    groupSlug: escrow.groupSlug,
    terms: escrow.terms,
    status: escrow.status,
    currency: escrow.asset,
    priceProvenance: escrow.priceProvenance,
    quoteProbability: escrow.quoteProbability,
    quoteMultiplier: escrow.quoteMultiplier,
    backPotLamports: totals.back,
    doubtPotLamports: totals.doubt,
    matchedAmountLamports: totals.matched,
    refundedAmountLamports: escrow.refundTotalAtomic,
    paidAmountLamports: escrow.payoutTotalAtomic,
    positionCount: totals.positionCount,
    createdAt: escrow.createdAt,
    outcome: escrow.outcome,
    decidingSeq: null,
    evidenceSeqs: [],
    tier: escrow.terms.trustTier,
    settledAt: escrow.settledAt,
    proofStatus: null,
    explorerUrl: null,
    browserProof: null,
    ...(escrow.isReplay ? { isReplay: true as const } : {}),
    escrow,
  };
}

export function publicGroupBoardMarketFromEscrow(
  escrow: PublicEscrowReceipt,
): PublicGroupBoardMarket | null {
  const receipt = publicReceiptFromEscrow(escrow);
  if (receipt === null) return null;
  const {
    decidingSeq: _decidingSeq,
    evidenceSeqs: _evidenceSeqs,
    tier: _tier,
    proofStatus: _proofStatus,
    explorerUrl: _explorerUrl,
    browserProof: _browserProof,
    ...market
  } = receipt;
  return market;
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

function displayTotals(escrow: PublicEscrowReceipt): DisplayTotals | null {
  const back = sumAggregates(escrow.aggregates, 'back');
  const doubt = sumAggregates(escrow.aggregates, 'doubt');
  const activeBack = sumAggregates(escrow.aggregates, 'back', 'active');
  const activeDoubt = sumAggregates(escrow.aggregates, 'doubt', 'active');
  const ratio = BigInt(escrow.ratioMilli);
  const matchedBack = minimum(activeBack, (activeDoubt * 1_000n) / ratio);
  const matchedDoubt = minimum(activeDoubt, (matchedBack * ratio) / 1_000n);
  const count = positionCount(escrow.aggregates);
  if (count === null) return null;
  return {
    back: back.toString(),
    doubt: doubt.toString(),
    matched: (matchedBack + matchedDoubt).toString(),
    positionCount: count,
  };
}

function sumAggregates(
  rows: readonly PublicEscrowAggregate[],
  side: PublicEscrowAggregate['side'],
  state?: PublicEscrowAggregate['state'],
): bigint {
  return rows
    .filter((row) => row.side === side && (state === undefined || row.state === state))
    .reduce((total, row) => total + BigInt(row.amountAtomic), 0n);
}

function positionCount(rows: readonly PublicEscrowAggregate[]): number | null {
  let total = 0;
  for (const row of rows) {
    total += row.lotCount;
    if (!Number.isSafeInteger(total)) return null;
  }
  return total;
}

function validAssetMint(
  asset: ReceiptCurrency,
  mintPubkey: string | null,
  identity: PublicEscrowIdentityConfig,
): boolean {
  if (asset === 'sol') return mintPubkey === null;
  return (
    mintPubkey !== null &&
    PUBKEY_PATTERN.test(mintPubkey) &&
    identity.canonicalUsdcMint !== null &&
    mintPubkey === identity.canonicalUsdcMint
  );
}

function validSettlementState(
  chainState: EscrowChainState,
  status: EscrowReceiptStatus,
  outcome: ReceiptOutcome | null,
  hasSettlement: boolean,
): boolean {
  if (status === 'open' || status === 'frozen') {
    return chainState === status && outcome === null && !hasSettlement;
  }
  if (status === 'voided') {
    return (chainState === 'voided' || chainState === 'closed') && outcome === 'void' && hasSettlement;
  }
  return (
    (chainState === 'settled' || chainState === 'closed') &&
    (outcome === 'claim_won' || outcome === 'claim_lost') &&
    hasSettlement
  );
}

function validClaimsForReceipt(
  receipt: EscrowReceiptRow,
  claims: readonly PublicEscrowClaimTransaction[],
): boolean {
  if (receipt.status === 'open' || receipt.status === 'frozen') return claims.length === 0;
  const expectedKind: EscrowClaimKind = receipt.status === 'voided' ? 'refund' : 'payout';
  return claims.every((claim) => claim.claimKind === expectedKind);
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

function safeFixtureName(value: unknown): string | null {
  const parsed = text(value);
  return parsed !== null && parsed.length <= 160 && !CONTROL_CHARACTER_PATTERN.test(parsed)
    ? parsed
    : null;
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

function nullableSafeCount(value: unknown): number | null | undefined {
  return value === null ? null : safeCount(value) ?? undefined;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function requiredTimestamp(value: unknown): string | null {
  const parsed = text(value);
  return parsed !== null && !Number.isNaN(Date.parse(parsed)) ? parsed : null;
}

function nullableTimestamp(value: unknown): string | null | undefined {
  if (value === null) return null;
  return requiredTimestamp(value) ?? undefined;
}

function oneOf<T extends string>(value: unknown, choices: readonly T[]): T | null {
  return typeof value === 'string' && choices.includes(value as T) ? value as T : null;
}

function nullableOneOf<T extends string>(value: unknown, choices: readonly T[]): T | null | undefined {
  return value === null ? null : oneOf(value, choices) ?? undefined;
}

function minimum(left: bigint, right: bigint): bigint {
  return left < right ? left : right;
}

function maximum(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}
