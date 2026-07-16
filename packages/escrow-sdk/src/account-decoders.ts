import type { PublicKeyInput } from './borsh.js';
import { BorshReader, publicKey } from './borsh.js';
import { bytesToHex } from './codec.js';
import type {
  MarketAccount,
  MarketState,
  OracleSetAccount,
  PositionLotAccount,
  PositionLotState,
  ProtocolConfigAccount,
  UserPositionAccount,
} from './accounts.js';
import type { EscrowAsset, PositionSide, SettlementOutcome } from './domain.js';
import { ESCROW_ACCOUNT_DISCRIMINATORS } from './schema.js';

const discriminatorHex = (name: keyof typeof ESCROW_ACCOUNT_DISCRIMINATORS): string =>
  bytesToHex(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS[name]));

function accountReader(data: Uint8Array, name: keyof typeof ESCROW_ACCOUNT_DISCRIMINATORS): BorshReader {
  const reader = new BorshReader(data);
  const actual = bytesToHex(reader.fixed(8, `${name} discriminator`));
  if (actual !== discriminatorHex(name)) throw new TypeError(`invalid ${name} account discriminator`);
  return reader;
}

function asset(reader: BorshReader): EscrowAsset {
  const tag = reader.u8('asset');
  if (tag === 0) return 'sol';
  if (tag === 1) return 'usdc';
  throw new RangeError(`invalid asset tag ${tag}`);
}

function side(reader: BorshReader): PositionSide {
  const tag = reader.u8('position side');
  if (tag === 0) return 'back';
  if (tag === 1) return 'doubt';
  throw new RangeError(`invalid position side tag ${tag}`);
}

function marketState(reader: BorshReader): MarketState {
  const states = ['opening', 'open', 'frozen', 'settling', 'settled', 'voided', 'closed'] as const;
  const tag = reader.u8('market state');
  const state = states[tag];
  if (state === undefined) throw new RangeError(`invalid market state tag ${tag}`);
  return state;
}

function lotState(reader: BorshReader): PositionLotState {
  const states = ['pending', 'active', 'voided'] as const;
  const tag = reader.u8('lot state');
  const state = states[tag];
  if (state === undefined) throw new RangeError(`invalid lot state tag ${tag}`);
  return state;
}

function settlementOutcome(reader: BorshReader): SettlementOutcome | null {
  const outcomes = [null, 'claim_won', 'claim_lost', 'void'] as const;
  const tag = reader.u8('settlement outcome');
  const outcome = outcomes[tag];
  if (outcome === undefined) throw new RangeError(`invalid settlement outcome tag ${tag}`);
  return outcome;
}

function optionalI64(reader: BorshReader, name: string): bigint | null {
  const tag = reader.u8(`${name} option`);
  if (tag > 1) throw new RangeError(`${name} has an invalid Borsh option tag`);
  return tag === 0 ? null : reader.i64(name);
}

function optionalHash(reader: BorshReader, name: string): Uint8Array | null {
  const tag = reader.u8(`${name} option`);
  if (tag > 1) throw new RangeError(`${name} has an invalid Borsh option tag`);
  return tag === 0 ? null : reader.fixed(32, name);
}

function tokenMint(reader: BorshReader): string | null {
  const value = reader.publicKey('token mint');
  return value === '11111111111111111111111111111111' ? null : value;
}

function nullableHash(reader: BorshReader, name: string): Uint8Array | null {
  const value = reader.fixed(32, name);
  return value.every((byte) => byte === 0) ? null : value;
}

function uuid(bytes: Uint8Array): string {
  const hex = bytesToHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function decodeProtocolConfigAccount(data: Uint8Array): ProtocolConfigAccount {
  const reader = accountReader(data, 'ProtocolConfig');
  const result: ProtocolConfigAccount = {
    version: reader.u8('version'), bump: reader.u8('bump'), paused: reader.bool('paused'),
    configAuthority: reader.publicKey('config authority'), pauseAuthority: reader.publicKey('pause authority'),
    marketCreationAuthority: reader.publicKey('market creation authority'),
    feedOperatorAuthority: reader.publicKey('feed operator authority'), oracleSet: reader.publicKey('oracle set'),
    relayerFeePayer: reader.publicKey('relayer fee payer'), residualRecipient: reader.publicKey('residual recipient'),
    clusterGenesisHash: reader.fixed(32, 'cluster genesis hash'), canonicalUsdcMint: reader.publicKey('canonical USDC mint'),
    allowedTokenProgram: reader.publicKey('allowed token program'), maximumSolPosition: reader.u64('maximum SOL position'),
    maximumUsdcPosition: reader.u64('maximum USDC position'), minimumSolPosition: reader.u64('minimum SOL position'),
    minimumUsdcPosition: reader.u64('minimum USDC position'),
    maximumMarketDurationSeconds: reader.u64('maximum market duration'),
    maximumResolutionDelaySeconds: reader.u64('maximum resolution delay'),
  };
  reader.finishZeroPadded('ProtocolConfig');
  return result;
}

export function decodeOracleSetAccount(data: Uint8Array): OracleSetAccount {
  const reader = accountReader(data, 'OracleSet');
  const result: OracleSetAccount = {
    version: reader.u8('version'), bump: reader.u8('bump'), epoch: reader.u64('epoch'),
    signers: reader.publicKeyVector('signers', 3), signatureThreshold: reader.u8('signature threshold'),
    activationSlot: reader.u64('activation slot'), retirementSlot: reader.optionU64('retirement slot'),
  };
  reader.finishZeroPadded('OracleSet');
  return result;
}

export function decodeMarketAccount(data: Uint8Array): MarketAccount {
  const reader = accountReader(data, 'Market');
  const result: MarketAccount = {
    version: reader.u8('version'), bump: reader.u8('bump'), marketUuid: uuid(reader.fixed(16, 'market UUID')),
    fixtureId: reader.u64('fixture ID'), claimSpecificationHash: reader.fixed(32, 'claim specification hash'),
    displayTermsHash: reader.fixed(32, 'display terms hash'), oddsMessageHash: reader.fixed(32, 'odds source message hash'),
    marketDocumentHash: reader.fixed(32, 'market document hash'), quoteTimestamp: reader.i64('quote timestamp'),
    probabilityPpm: reader.u32('probability PPM'), ratioMilli: reader.u32('ratio milli'), asset: asset(reader),
    tokenMint: tokenMint(reader), feeBps: reader.u16('fee basis points'), state: marketState(reader),
    replay: reader.bool('replay'), residualRecipient: reader.publicKey('residual recipient'),
    createdTimestamp: reader.i64('created timestamp'), inPlayStartTimestamp: reader.i64('in-play start timestamp'),
    activationDelaySeconds: reader.u64('activation delay seconds'), positionCutoffTimestamp: reader.i64('position cutoff'),
    resolutionDeadline: reader.i64('resolution deadline'), oracleSetEpoch: reader.u64('oracle-set epoch'),
    eventEpoch: reader.u64('event epoch'), activeBackTotal: reader.u64('active back total'),
    activeDoubtTotal: reader.u64('active doubt total'), pendingBackTotal: reader.u64('pending back total'),
    pendingDoubtTotal: reader.u64('pending doubt total'), finalMatchedBackTotal: reader.u64('final matched back total'),
    finalMatchedDoubtTotal: reader.u64('final matched doubt total'), finalForfeitedTotal: reader.u64('final forfeited total'),
    settlementProcessedPositionCount: reader.u64('settlement processed position count'),
    settlementOutcome: settlementOutcome(reader), settlementEvidenceHash: nullableHash(reader, 'settlement evidence hash'),
    positionCount: reader.u64('position count'), claimedPositionCount: reader.u64('claimed position count'),
    vault: reader.publicKey('vault'), vaultBump: reader.u8('vault bump'),
  };
  reader.finishZeroPadded('Market');
  return result;
}

export function decodeUserPositionAccount(data: Uint8Array): UserPositionAccount {
  const reader = accountReader(data, 'UserPosition');
  const result: UserPositionAccount = {
    version: reader.u8('version'), bump: reader.u8('bump'), market: reader.publicKey('market'),
    owner: reader.publicKey('owner'), side: side(reader), activeAmount: reader.u64('active amount'),
    pendingAmount: reader.u64('pending amount'), refundableAmount: reader.u64('refundable amount'),
    settlementBaseEntitlement: reader.u64('settlement base entitlement'),
    settlementProcessed: reader.bool('settlement processed'), nextLotNonce: reader.u64('next lot nonce'),
    claimed: reader.bool('claimed'), totalPaidAmount: reader.u64('total paid amount'),
    createdSlot: reader.u64('created slot'), updatedSlot: reader.u64('updated slot'),
  };
  reader.finishZeroPadded('UserPosition');
  return result;
}

export function decodePositionLotAccount(data: Uint8Array): PositionLotAccount {
  const reader = accountReader(data, 'PositionLot');
  const result: PositionLotAccount = {
    version: reader.u8('version'), bump: reader.u8('bump'), market: reader.publicKey('market'),
    owner: reader.publicKey('owner'), nonce: reader.u64('nonce'), side: side(reader), amount: reader.u64('amount'),
    placedTimestamp: reader.i64('placed timestamp'), placedSlot: reader.u64('placed slot'),
    observedEventEpoch: reader.u64('observed event epoch'), state: lotState(reader),
    activationTimestamp: optionalI64(reader, 'activation timestamp'),
    invalidationEvidenceHash: optionalHash(reader, 'invalidation evidence hash'),
  };
  reader.finishZeroPadded('PositionLot');
  return result;
}

export function assertEscrowAccountOwner(owner: PublicKeyInput, expectedProgramId: PublicKeyInput): void {
  if (!publicKey(owner).equals(publicKey(expectedProgramId))) throw new TypeError('escrow account has an unexpected owner program');
}
