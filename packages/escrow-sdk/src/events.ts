import { BorshReader } from './borsh.js';
import { bytesToHex } from './codec.js';
import type { EscrowAddress } from './accounts.js';
import type { VoidReason } from './attestations.js';
import type { EscrowAsset, PositionSide, SettlementOutcome } from './domain.js';
import { ESCROW_EVENT_DISCRIMINATORS } from './schema.js';

export type EscrowProgramEvent =
  | { readonly kind: 'ProtocolConfigInitialized'; readonly config: EscrowAddress; readonly configAuthority: EscrowAddress; readonly pauseAuthority: EscrowAddress; readonly marketCreationAuthority: EscrowAddress; readonly residualRecipient: EscrowAddress; readonly clusterGenesisHash: Uint8Array; readonly canonicalUsdcMint: EscrowAddress; readonly allowedTokenProgram: EscrowAddress }
  | { readonly kind: 'ProtocolConfigRotated'; readonly config: EscrowAddress; readonly configAuthority: EscrowAddress; readonly pauseAuthority: EscrowAddress; readonly marketCreationAuthority: EscrowAddress; readonly feedOperatorAuthority: EscrowAddress; readonly relayerFeePayer: EscrowAddress; readonly residualRecipient: EscrowAddress }
  | { readonly kind: 'OracleSetRotated'; readonly oracleSet: EscrowAddress; readonly epoch: bigint; readonly threshold: number; readonly activationSlot: bigint }
  | { readonly kind: 'ProtocolPauseChanged'; readonly paused: boolean; readonly authority: EscrowAddress }
  | { readonly kind: 'MarketInitialized'; readonly market: EscrowAddress; readonly marketUuid: string; readonly fixtureId: bigint; readonly asset: EscrowAsset; readonly ratioMilli: number; readonly marketDocumentHash: Uint8Array; readonly residualRecipient: EscrowAddress; readonly oracleSet: EscrowAddress; readonly vault: EscrowAddress; readonly inPlayStartTimestamp: bigint; readonly activationDelaySeconds: bigint; readonly positionCutoffTimestamp: bigint; readonly resolutionDeadline: bigint }
  | { readonly kind: 'MarketFrozen'; readonly market: EscrowAddress; readonly eventEpoch: bigint; readonly evidenceHash: Uint8Array }
  | { readonly kind: 'MarketUnfrozen'; readonly market: EscrowAddress; readonly eventEpoch: bigint; readonly evidenceHash: Uint8Array }
  | { readonly kind: 'PositionPlaced'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly lot: EscrowAddress; readonly owner: EscrowAddress; readonly nonce: bigint; readonly side: PositionSide; readonly amount: bigint; readonly asset: EscrowAsset; readonly pending: boolean; readonly eventEpoch: bigint; readonly activationAfter: bigint | null; readonly clientIntentHash: Uint8Array }
  | { readonly kind: 'PositionActivated'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly lot: EscrowAddress; readonly owner: EscrowAddress; readonly nonce: bigint; readonly amount: bigint; readonly eventEpoch: bigint }
  | { readonly kind: 'PositionInvalidated'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly lot: EscrowAddress; readonly owner: EscrowAddress; readonly nonce: bigint; readonly amount: bigint; readonly eventEpoch: bigint; readonly evidenceHash: Uint8Array }
  | { readonly kind: 'MarketSettlementStarted'; readonly market: EscrowAddress; readonly outcome: SettlementOutcome | null; readonly matchedBack: bigint; readonly matchedDoubt: bigint; readonly positionCount: bigint; readonly evidenceHash: Uint8Array }
  | { readonly kind: 'PositionEntitlementCalculated'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly owner: EscrowAddress; readonly baseEntitlement: bigint; readonly forfeitedAmount: bigint; readonly processedPositionCount: bigint }
  | { readonly kind: 'MarketSettled'; readonly market: EscrowAddress; readonly outcome: SettlementOutcome | null; readonly matchedBack: bigint; readonly matchedDoubt: bigint; readonly forfeitedTotal: bigint; readonly evidenceHash: Uint8Array; readonly finalPosition: EscrowAddress | null; readonly finalOwner: EscrowAddress | null; readonly finalBaseEntitlement: bigint | null; readonly finalForfeitedAmount: bigint | null }
  | { readonly kind: 'MarketVoided'; readonly market: EscrowAddress; readonly evidenceHash: Uint8Array; readonly timedOut: boolean; readonly reason: VoidReason | null; readonly decidingSequence: bigint | null }
  | { readonly kind: 'PositionClaimed'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly owner: EscrowAddress; readonly amount: bigint; readonly asset: EscrowAsset; readonly destination: EscrowAddress }
  | { readonly kind: 'PositionLotsClosed'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly owner: EscrowAddress; readonly nonces: readonly bigint[]; readonly rentRecipient: EscrowAddress }
  | { readonly kind: 'PositionClosed'; readonly market: EscrowAddress; readonly position: EscrowAddress; readonly owner: EscrowAddress; readonly rentRecipient: EscrowAddress }
  | { readonly kind: 'MarketClosed'; readonly market: EscrowAddress; readonly dustAmount: bigint; readonly asset: EscrowAsset };

type EventKind = EscrowProgramEvent['kind'];

const EVENT_KINDS = [
  'ProtocolConfigInitialized', 'ProtocolConfigRotated', 'OracleSetRotated', 'ProtocolPauseChanged',
  'MarketInitialized', 'MarketFrozen', 'MarketUnfrozen', 'PositionPlaced',
  'PositionActivated', 'PositionInvalidated', 'MarketSettlementStarted',
  'PositionEntitlementCalculated', 'MarketSettled', 'MarketVoided',
  'PositionClaimed', 'PositionLotsClosed', 'PositionClosed', 'MarketClosed',
] as const;

function eventKind(discriminator: Uint8Array): EventKind {
  const actual = bytesToHex(discriminator);
  for (const kind of EVENT_KINDS) {
    const expected = ESCROW_EVENT_DISCRIMINATORS[kind];
    if (actual === bytesToHex(Uint8Array.from(expected))) return kind;
  }
  throw new TypeError('unknown escrow event discriminator');
}

function asset(reader: BorshReader): EscrowAsset {
  const tag = reader.u8('asset');
  if (tag === 0) return 'sol';
  if (tag === 1) return 'usdc';
  throw new RangeError(`invalid event asset tag ${tag}`);
}

function side(reader: BorshReader): PositionSide {
  const tag = reader.u8('position side');
  if (tag === 0) return 'back';
  if (tag === 1) return 'doubt';
  throw new RangeError(`invalid event position side tag ${tag}`);
}

function outcome(reader: BorshReader): SettlementOutcome | null {
  const outcomes = [null, 'claim_won', 'claim_lost', 'void'] as const;
  const tag = reader.u8('settlement outcome');
  const value = outcomes[tag];
  if (value === undefined) throw new RangeError(`invalid event settlement outcome tag ${tag}`);
  return value;
}

function uuid(reader: BorshReader): string {
  const hex = bytesToHex(reader.fixed(16, 'market UUID'));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function optionalI64(reader: BorshReader, name: string): bigint | null {
  const tag = reader.u8(`${name} option`);
  if (tag > 1) throw new RangeError(`${name} has an invalid Borsh option tag`);
  return tag === 0 ? null : reader.i64(name);
}

function optionalPublicKey(reader: BorshReader, name: string): EscrowAddress | null {
  const tag = reader.u8(`${name} option`);
  if (tag > 1) throw new RangeError(`${name} has an invalid Borsh option tag`);
  return tag === 0 ? null : reader.publicKey(name);
}

function voidReason(reader: BorshReader): VoidReason {
  const reasons = ['cancelled', 'abandoned', 'coverage_loss', 'undecidable'] as const;
  const tag = reader.u8('void reason');
  const value = reasons[tag];
  if (value === undefined) throw new RangeError(`invalid void reason tag ${tag}`);
  return value;
}

function optionalVoidReason(reader: BorshReader): VoidReason | null {
  const tag = reader.u8('void reason option');
  if (tag > 1) throw new RangeError('void reason has an invalid Borsh option tag');
  return tag === 0 ? null : voidReason(reader);
}

function decode(kind: EventKind, reader: BorshReader): EscrowProgramEvent {
  switch (kind) {
    case 'ProtocolConfigInitialized': return { kind, config: reader.publicKey('config'), configAuthority: reader.publicKey('config authority'), pauseAuthority: reader.publicKey('pause authority'), marketCreationAuthority: reader.publicKey('market creation authority'), residualRecipient: reader.publicKey('residual recipient'), clusterGenesisHash: reader.fixed(32, 'cluster genesis hash'), canonicalUsdcMint: reader.publicKey('canonical USDC mint'), allowedTokenProgram: reader.publicKey('allowed token program') };
    case 'ProtocolConfigRotated': return { kind, config: reader.publicKey('config'), configAuthority: reader.publicKey('config authority'), pauseAuthority: reader.publicKey('pause authority'), marketCreationAuthority: reader.publicKey('market creation authority'), feedOperatorAuthority: reader.publicKey('feed operator authority'), relayerFeePayer: reader.publicKey('relayer fee payer'), residualRecipient: reader.publicKey('residual recipient') };
    case 'OracleSetRotated': return { kind, oracleSet: reader.publicKey('oracle set'), epoch: reader.u64('epoch'), threshold: reader.u8('threshold'), activationSlot: reader.u64('activation slot') };
    case 'ProtocolPauseChanged': return { kind, paused: reader.bool('paused'), authority: reader.publicKey('authority') };
    case 'MarketInitialized': return { kind, market: reader.publicKey('market'), marketUuid: uuid(reader), fixtureId: reader.u64('fixture ID'), asset: asset(reader), ratioMilli: reader.u32('ratio milli'), marketDocumentHash: reader.fixed(32, 'market document hash'), residualRecipient: reader.publicKey('residual recipient'), oracleSet: reader.publicKey('oracle set'), vault: reader.publicKey('vault'), inPlayStartTimestamp: reader.i64('in-play start timestamp'), activationDelaySeconds: reader.u64('activation delay seconds'), positionCutoffTimestamp: reader.i64('position cutoff timestamp'), resolutionDeadline: reader.i64('resolution deadline') };
    case 'MarketFrozen': return { kind, market: reader.publicKey('market'), eventEpoch: reader.u64('event epoch'), evidenceHash: reader.fixed(32, 'evidence hash') };
    case 'MarketUnfrozen': return { kind, market: reader.publicKey('market'), eventEpoch: reader.u64('event epoch'), evidenceHash: reader.fixed(32, 'evidence hash') };
    case 'PositionPlaced': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), lot: reader.publicKey('lot'), owner: reader.publicKey('owner'), nonce: reader.u64('nonce'), side: side(reader), amount: reader.u64('amount'), asset: asset(reader), pending: reader.bool('pending'), eventEpoch: reader.u64('event epoch'), activationAfter: optionalI64(reader, 'activation after'), clientIntentHash: reader.fixed(32, 'client intent hash') };
    case 'PositionActivated': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), lot: reader.publicKey('lot'), owner: reader.publicKey('owner'), nonce: reader.u64('nonce'), amount: reader.u64('amount'), eventEpoch: reader.u64('event epoch') };
    case 'PositionInvalidated': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), lot: reader.publicKey('lot'), owner: reader.publicKey('owner'), nonce: reader.u64('nonce'), amount: reader.u64('amount'), eventEpoch: reader.u64('event epoch'), evidenceHash: reader.fixed(32, 'evidence hash') };
    case 'MarketSettlementStarted': return { kind, market: reader.publicKey('market'), outcome: outcome(reader), matchedBack: reader.u64('matched back'), matchedDoubt: reader.u64('matched doubt'), positionCount: reader.u64('position count'), evidenceHash: reader.fixed(32, 'evidence hash') };
    case 'PositionEntitlementCalculated': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), owner: reader.publicKey('owner'), baseEntitlement: reader.u64('base entitlement'), forfeitedAmount: reader.u64('forfeited amount'), processedPositionCount: reader.u64('processed position count') };
    case 'MarketSettled': return { kind, market: reader.publicKey('market'), outcome: outcome(reader), matchedBack: reader.u64('matched back'), matchedDoubt: reader.u64('matched doubt'), forfeitedTotal: reader.u64('forfeited total'), evidenceHash: reader.fixed(32, 'evidence hash'), finalPosition: optionalPublicKey(reader, 'final position'), finalOwner: optionalPublicKey(reader, 'final owner'), finalBaseEntitlement: reader.optionU64('final base entitlement'), finalForfeitedAmount: reader.optionU64('final forfeited amount') };
    case 'MarketVoided': return { kind, market: reader.publicKey('market'), evidenceHash: reader.fixed(32, 'evidence hash'), timedOut: reader.bool('timed out'), reason: optionalVoidReason(reader), decidingSequence: reader.optionU64('deciding sequence') };
    case 'PositionClaimed': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), owner: reader.publicKey('owner'), amount: reader.u64('amount'), asset: asset(reader), destination: reader.publicKey('destination') };
    case 'PositionLotsClosed': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), owner: reader.publicKey('owner'), nonces: reader.u64Vector('nonces', 256), rentRecipient: reader.publicKey('rent recipient') };
    case 'PositionClosed': return { kind, market: reader.publicKey('market'), position: reader.publicKey('position'), owner: reader.publicKey('owner'), rentRecipient: reader.publicKey('rent recipient') };
    case 'MarketClosed': return { kind, market: reader.publicKey('market'), dustAmount: reader.u64('dust amount'), asset: asset(reader) };
  }
}

export function decodeEscrowEvent(data: Uint8Array): EscrowProgramEvent {
  const reader = new BorshReader(data);
  const kind = eventKind(reader.fixed(8, 'event discriminator'));
  const event = decode(kind, reader);
  reader.finish(kind);
  return event;
}

export function decodeEscrowEventLog(log: string): EscrowProgramEvent | null {
  const prefix = 'Program data: ';
  if (!log.startsWith(prefix)) return null;
  return decodeEscrowEvent(Buffer.from(log.slice(prefix.length), 'base64'));
}
