import { describe, expect, it } from 'vitest';
import {
  assertEscrowAccountOwner,
  decodeMarketAccount,
  decodeOracleSetAccount,
  decodePositionLotAccount,
  decodeProtocolConfigAccount,
  decodeUserPositionAccount,
} from '../src/account-decoders.js';
import { BorshWriter } from '../src/borsh.js';
import { decodeEscrowEvent, decodeEscrowEventLog } from '../src/events.js';
import { ESCROW_ACCOUNT_DISCRIMINATORS, ESCROW_EVENT_DISCRIMINATORS } from '../src/schema.js';
import { MARKET_UUID, PROGRAM_ID, hash, key } from './fixtures.js';

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function accountData(
  name: keyof typeof ESCROW_ACCOUNT_DISCRIMINATORS,
  body: BorshWriter,
): Uint8Array {
  return concat(Uint8Array.from(ESCROW_ACCOUNT_DISCRIMINATORS[name]), body.finish());
}

function eventData(
  name: keyof typeof ESCROW_EVENT_DISCRIMINATORS,
  body: BorshWriter,
): Uint8Array {
  return concat(Uint8Array.from(ESCROW_EVENT_DISCRIMINATORS[name]), body.finish());
}

describe('typed Anchor account decoders', () => {
  it('decodes ProtocolConfig and OracleSet in exact Rust field order', () => {
    const config = decodeProtocolConfigAccount(accountData('ProtocolConfig', new BorshWriter()
      .u8(1, 'version').u8(255, 'bump').bool(false, 'paused')
      .publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4))
      .publicKey(key(5)).publicKey(key(6)).publicKey(key(7)).fixed(hash(8), 32, 'genesis')
      .publicKey(key(9)).publicKey(key(10)).u64(11n, 'max sol').u64(12n, 'max usdc')
      .u64(13n, 'min sol').u64(14n, 'min usdc').u64(15n, 'duration').u64(16n, 'delay')));
    expect(config).toMatchObject({
      version: 1, bump: 255, configAuthority: key(1).toBase58(),
      feedOperatorAuthority: key(4).toBase58(), maximumSolPosition: 11n,
      minimumUsdcPosition: 14n, maximumResolutionDelaySeconds: 16n,
    });

    const oracle = decodeOracleSetAccount(accountData('OracleSet', new BorshWriter()
      .u8(1, 'version').u8(9, 'bump').u64(7n, 'epoch')
      .publicKeyVector([key(1), key(2), key(3)], 'signers').u8(2, 'threshold')
      .u64(100n, 'activation').optionU64(200n, 'retirement')));
    expect(oracle).toEqual({
      version: 1, bump: 9, epoch: 7n,
      signers: [key(1).toBase58(), key(2).toBase58(), key(3).toBase58()],
      signatureThreshold: 2, activationSlot: 100n, retirementSlot: 200n,
    });
  });

  it('decodes Market, UserPosition, and PositionLot status fields', () => {
    const market = decodeMarketAccount(accountData('Market', new BorshWriter()
      .u8(1, 'version').u8(2, 'bump').fixed(Uint8Array.from(Buffer.from(MARKET_UUID.replaceAll('-', ''), 'hex')), 16, 'uuid')
      .u64(91_001n, 'fixture').fixed(hash(1), 32, 'claim').fixed(hash(2), 32, 'display')
      .fixed(hash(3), 32, 'odds').fixed(hash(4), 32, 'document').i64(10n, 'quote')
      .u32(620_000, 'ppm').u32(613, 'ratio').u8(1, 'asset').publicKey(key(9)).u16(0, 'fee')
      .u8(3, 'state').bool(true, 'replay').publicKey(key(10)).i64(11n, 'created').i64(12n, 'kickoff')
      .u64(150n, 'delay').i64(13n, 'cutoff').i64(14n, 'resolution').u64(7n, 'oracle')
      .u64(2n, 'event').u64(3n, 'active back').u64(4n, 'active doubt').u64(5n, 'pending back')
      .u64(6n, 'pending doubt').u64(7n, 'matched back').u64(8n, 'matched doubt')
      .u64(9n, 'forfeited').u64(10n, 'processed').u8(1, 'outcome').fixed(hash(11), 32, 'evidence')
      .u64(12n, 'positions').u64(13n, 'claimed').publicKey(key(12)).u8(4, 'vault bump')));
    expect(market).toMatchObject({ asset: 'usdc', state: 'settling', replay: true, settlementOutcome: 'claim_won' });

    const position = decodeUserPositionAccount(accountData('UserPosition', new BorshWriter()
      .u8(1, 'version').u8(2, 'bump').publicKey(key(1)).publicKey(key(2)).u8(1, 'side')
      .u64(3n, 'active').u64(4n, 'pending').u64(5n, 'refund').u64(6n, 'base')
      .bool(true, 'processed').u64(7n, 'nonce').bool(false, 'claimed').u64(8n, 'paid')
      .u64(9n, 'created').u64(10n, 'updated')));
    expect(position).toMatchObject({ side: 'doubt', settlementProcessed: true, nextLotNonce: 7n });

    const lot = decodePositionLotAccount(accountData('PositionLot', new BorshWriter()
      .u8(1, 'version').u8(2, 'bump').publicKey(key(1)).publicKey(key(2)).u64(3n, 'nonce')
      .u8(0, 'side').u64(4n, 'amount').i64(5n, 'placed').u64(6n, 'slot').u64(7n, 'epoch')
      .u8(0, 'state').u8(1, 'activation option').i64(8n, 'activation')
      .u8(1, 'hash option').fixed(hash(9), 32, 'hash')));
    expect(lot).toMatchObject({ side: 'back', state: 'pending', activationTimestamp: 8n });
  });

  it('rejects wrong owner, discriminator, enum, and trailing bytes', () => {
    expect(() => assertEscrowAccountOwner(key(1), PROGRAM_ID)).toThrow(/owner/);
    expect(() => decodeProtocolConfigAccount(new Uint8Array(379))).toThrow(/discriminator/);
    const badOracle = accountData('OracleSet', new BorshWriter()
      .u8(1, 'version').u8(1, 'bump').u64(1n, 'epoch').u32(4, 'length'));
    expect(() => decodeOracleSetAccount(badOracle)).toThrow(/maximum length/);
  });
});

describe('typed Anchor event decoders', () => {
  it('decodes every indexer event and consumes the full payload', () => {
    const events: readonly [keyof typeof ESCROW_EVENT_DISCRIMINATORS, BorshWriter][] = [
      ['ProtocolConfigInitialized', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4)).publicKey(key(5)).fixed(hash(6), 32, 'genesis').publicKey(key(7)).publicKey(key(8))],
      ['ProtocolConfigRotated', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4)).publicKey(key(5)).publicKey(key(6)).publicKey(key(7))],
      ['OracleSetRotated', new BorshWriter().publicKey(key(1)).u64(2n, 'epoch').u8(2, 'threshold').u64(3n, 'slot')],
      ['ProtocolPauseChanged', new BorshWriter().bool(true, 'paused').publicKey(key(1))],
      ['MarketInitialized', new BorshWriter().publicKey(key(1)).fixed(new Uint8Array(16), 16, 'uuid').u64(2n, 'fixture').u8(0, 'asset').u32(3, 'ratio').fixed(hash(4), 32, 'document').publicKey(key(5)).publicKey(key(6)).publicKey(key(7)).i64(8n, 'kickoff').u64(150n, 'delay').i64(9n, 'cutoff').i64(10n, 'resolution')],
      ['MarketFrozen', new BorshWriter().publicKey(key(1)).u64(2n, 'epoch').fixed(hash(3), 32, 'evidence')],
      ['MarketUnfrozen', new BorshWriter().publicKey(key(1)).u64(2n, 'epoch').fixed(hash(3), 32, 'evidence')],
      ['PositionPlaced', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4)).u64(5n, 'nonce').u8(0, 'side').u64(6n, 'amount').u8(1, 'asset').bool(true, 'pending').u64(7n, 'epoch').u8(1, 'activation option').i64(8n, 'activation').fixed(hash(9), 32, 'intent')],
      ['PositionActivated', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4)).u64(5n, 'nonce').u64(6n, 'amount').u64(7n, 'epoch')],
      ['PositionInvalidated', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(4)).u64(5n, 'nonce').u64(6n, 'amount').u64(7n, 'epoch').fixed(hash(8), 32, 'evidence')],
      ['MarketSettled', new BorshWriter().publicKey(key(1)).u8(1, 'outcome').u64(2n, 'back').u64(3n, 'doubt').u64(4n, 'forfeited').fixed(hash(5), 32, 'evidence')],
      ['MarketVoided', new BorshWriter().publicKey(key(1)).fixed(hash(2), 32, 'evidence').bool(true, 'timed out')],
      ['PositionClaimed', new BorshWriter().publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).u64(4n, 'amount').u8(0, 'asset')],
      ['MarketClosed', new BorshWriter().publicKey(key(1)).u64(2n, 'dust').u8(1, 'asset')],
    ];
    for (const [kind, body] of events) expect(decodeEscrowEvent(eventData(kind, body)).kind).toBe(kind);
  });

  it('decodes Anchor Program data logs and rejects unknown discriminators', () => {
    const data = eventData('MarketFrozen', new BorshWriter()
      .publicKey(key(1)).u64(2n, 'epoch').fixed(hash(3), 32, 'evidence'));
    expect(decodeEscrowEventLog(`Program data: ${Buffer.from(data).toString('base64')}`))
      .toMatchObject({ kind: 'MarketFrozen', eventEpoch: 2n });
    expect(decodeEscrowEventLog('Program log: unrelated')).toBeNull();
    expect(() => decodeEscrowEvent(new Uint8Array(8))).toThrow(/unknown/);
  });
});
