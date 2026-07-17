import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BorshWriter } from '../src/borsh.js';
import { decodeEscrowEvent } from '../src/events.js';
import {
  ESCROW_EVENT_DISCRIMINATORS,
} from '../src/schema.js';
import { hash, key } from './fixtures.js';

type Wave3EventKind =
  | 'MarketSettlementStarted'
  | 'PositionEntitlementCalculated'
  | 'MarketSettled'
  | 'MarketVoided'
  | 'PositionClaimed'
  | 'PositionLotsClosed'
  | 'PositionClosed'
  | 'MarketClosed';

interface EventIdlVector {
  readonly discriminator: readonly number[];
  readonly fields: readonly string[];
}

interface Wave3IdlVector {
  readonly events: Readonly<Record<Wave3EventKind, EventIdlVector>>;
}

const idlVector: Wave3IdlVector = JSON.parse(readFileSync(
  new URL('../vectors/wave3-idl-v1.json', import.meta.url),
  'utf8',
));
const EVENT_KINDS = [
  'MarketSettlementStarted', 'PositionEntitlementCalculated', 'MarketSettled', 'MarketVoided',
  'PositionClaimed', 'PositionLotsClosed', 'PositionClosed', 'MarketClosed',
] as const satisfies readonly Wave3EventKind[];

function eventData(kind: Wave3EventKind, body: BorshWriter): Uint8Array {
  const discriminator = Uint8Array.from(ESCROW_EVENT_DISCRIMINATORS[kind]);
  const payload = body.finish();
  const data = new Uint8Array(discriminator.length + payload.length);
  data.set(discriminator);
  data.set(payload, discriminator.length);
  return data;
}

function wave3Events(): Readonly<Record<Wave3EventKind, BorshWriter>> {
  return {
    MarketSettlementStarted: new BorshWriter()
      .publicKey(key(1)).u8(1, 'outcome').u64(20n, 'matched back').u64(21n, 'matched doubt')
      .u64(22n, 'position count').fixed(hash(23), 32, 'evidence hash'),
    PositionEntitlementCalculated: new BorshWriter()
      .publicKey(key(1)).publicKey(key(2)).publicKey(key(3))
      .u64(24n, 'base entitlement').u64(25n, 'forfeited amount').u64(26n, 'processed count'),
    MarketSettled: new BorshWriter()
      .publicKey(key(1)).u8(2, 'outcome').u64(27n, 'matched back').u64(28n, 'matched doubt')
      .u64(29n, 'forfeited total').fixed(hash(30), 32, 'evidence hash')
      .bool(true, 'final position present').publicKey(key(2))
      .bool(true, 'final owner present').publicKey(key(3))
      .optionU64(31n, 'final base entitlement').optionU64(32n, 'final forfeited amount'),
    MarketVoided: new BorshWriter()
      .publicKey(key(1)).fixed(hash(33), 32, 'evidence hash').bool(false, 'timed out')
      .bool(true, 'reason present').u8(2, 'reason').optionU64(34n, 'deciding sequence'),
    PositionClaimed: new BorshWriter()
      .publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).u64(35n, 'amount')
      .u8(1, 'asset').publicKey(key(4)),
    PositionLotsClosed: new BorshWriter()
      .publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).u64Vector([5n, 4n], 'nonces')
      .publicKey(key(6)),
    PositionClosed: new BorshWriter()
      .publicKey(key(1)).publicKey(key(2)).publicKey(key(3)).publicKey(key(6)),
    MarketClosed: new BorshWriter().publicKey(key(1)).u64(36n, 'dust amount').u8(0, 'asset'),
  };
}

describe('Wave 3 Anchor event parity', () => {
  it('matches generated-IDL discriminators and field order for every event', () => {
    const bodies = wave3Events();
    for (const kind of EVENT_KINDS) {
      const vector = idlVector.events[kind];
      expect(ESCROW_EVENT_DISCRIMINATORS[kind], kind).toEqual(vector.discriminator);
      const event = decodeEscrowEvent(eventData(kind, bodies[kind]));
      expect(Object.keys(event).filter((field) => field !== 'kind'), kind).toEqual(vector.fields);
    }
  });

  it('decodes final settlement and signed void option fields exactly', () => {
    const bodies = wave3Events();

    expect(decodeEscrowEvent(eventData('MarketSettled', bodies.MarketSettled))).toMatchObject({
      kind: 'MarketSettled',
      outcome: 'claim_lost',
      finalPosition: key(2).toBase58(),
      finalOwner: key(3).toBase58(),
      finalBaseEntitlement: 31n,
      finalForfeitedAmount: 32n,
    });
    expect(decodeEscrowEvent(eventData('MarketVoided', bodies.MarketVoided))).toMatchObject({
      kind: 'MarketVoided',
      timedOut: false,
      reason: 'coverage_loss',
      decidingSequence: 34n,
    });
  });

  it('decodes exact claim destination and close lifecycle fields', () => {
    const bodies = wave3Events();

    expect(decodeEscrowEvent(eventData('PositionClaimed', bodies.PositionClaimed))).toMatchObject({
      kind: 'PositionClaimed', asset: 'usdc', destination: key(4).toBase58(),
    });
    expect(decodeEscrowEvent(eventData('PositionLotsClosed', bodies.PositionLotsClosed))).toMatchObject({
      kind: 'PositionLotsClosed', nonces: [5n, 4n], rentRecipient: key(6).toBase58(),
    });
    expect(decodeEscrowEvent(eventData('PositionClosed', bodies.PositionClosed))).toMatchObject({
      kind: 'PositionClosed', rentRecipient: key(6).toBase58(),
    });
  });

  it('decodes timeout void options as absent and rejects substituted trailing fields', () => {
    const timeout = new BorshWriter()
      .publicKey(key(1)).fixed(hash(2), 32, 'evidence hash').bool(true, 'timed out')
      .bool(false, 'reason present').optionU64(null, 'deciding sequence');
    const data = eventData('MarketVoided', timeout);

    expect(decodeEscrowEvent(data)).toMatchObject({ timedOut: true, reason: null, decidingSequence: null });
    expect(() => decodeEscrowEvent(Uint8Array.from([...data, 1]))).toThrow(/trailing bytes/);
  });
});
