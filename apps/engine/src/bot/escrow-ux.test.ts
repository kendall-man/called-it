import { describe, expect, it } from 'vitest';
import { dispatchCallback } from './callbacks.js';
import {
  escrowPlacementStatusText,
  type EscrowPlacementSessionInput,
  type EscrowTelegramPort,
} from './escrow-ux.js';
import {
  makeStakeContext,
  makeStakeHarness,
  fixtureAt,
  PRESET_01,
  stakeAction,
  stakeMarket,
  USER_A,
} from './callbacks.stake.test-support.js';

const TOKEN = 'a'.repeat(43);

function escrowPort(inputs: EscrowPlacementSessionInput[]): EscrowTelegramPort {
  return {
    async createPlacementSession(input) {
      inputs.push(input);
      return {
        kind: 'created',
        token: TOKEN,
        expiresAt: '2026-07-06T18:05:00.000Z',
        duplicate: inputs.length > 1,
      };
    },
    async createWalletSession() {
      return { kind: 'created', token: TOKEN, expiresAt: '2026-07-06T18:05:00.000Z' };
    },
  };
}

describe('Telegram escrow position UX', () => {
  it('creates one SOL signing link without touching the legacy ledger', async () => {
    const inputs: EscrowPlacementSessionInput[] = [];
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: escrowPort(inputs),
      balanceLamports: 50_000_000n,
      stakeAcceptanceEnabled: true,
      solanaNetwork: 'mainnet-beta',
    });
    const tap = makeStakeContext(USER_A, 'escrow-sol-tap');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      telegramUserId: USER_A,
      marketId: stakeMarket().id,
      groupId: stakeMarket().group_id,
      side: 'back',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      network: 'mainnet-beta',
      replay: false,
    });
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(0);
    expect(harness.cardEdits).toHaveLength(0);
    expect(tap.privateMessages).toHaveLength(1);
    expect(tap.privateMessages[0]?.text).toContain('Brazil to win (in 90 minutes)');
    expect(tap.privateMessages[0]?.text).toContain('On-chain escrow · MAINNET · 0.01 SOL');
    expect(tap.privateMessages[0]?.options).toEqual({
      reply_markup: {
        inline_keyboard: [[{
          text: 'Review & sign 0.01 SOL',
          web_app: { url: `https://web.test/position/${TOKEN}` },
        }]],
      },
    });
    expect(tap.privateMessages[0]?.text).not.toContain(TOKEN);
  });

  it('uses canonical USDC presets and produces the same link for a duplicate callback delivery', async () => {
    const inputs: EscrowPlacementSessionInput[] = [];
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: escrowPort(inputs),
      marketRow: stakeMarket({ currency: 'usdc' }),
      stakeAcceptanceEnabled: true,
    });
    const first = makeStakeContext(USER_A, 'same-callback');
    const duplicate = makeStakeContext(USER_A, 'same-callback');

    await dispatchCallback(harness.h, first.ctx, stakeAction('doubt', PRESET_01));
    await dispatchCallback(harness.h, duplicate.ctx, stakeAction('doubt', PRESET_01));

    expect(inputs.map(({ asset, amountAtomic }) => ({ asset, amountAtomic }))).toEqual([
      { asset: 'usdc', amountAtomic: 1_000_000n },
      { asset: 'usdc', amountAtomic: 1_000_000n },
    ]);
    expect(inputs[0]?.idempotencyKey).toBe(inputs[1]?.idempotencyKey);
    expect(JSON.stringify(first.privateMessages[0]?.options)).toBe(
      JSON.stringify(duplicate.privateMessages[0]?.options),
    );
    expect(first.privateMessages[0]?.text).toContain('1 USDC');
  });

  it('routes a mainnet completed-match replay through the same signed escrow flow', async () => {
    const inputs: EscrowPlacementSessionInput[] = [];
    const harness = makeStakeHarness({
      custodyMode: 'escrow',
      escrow: escrowPort(inputs),
      marketRow: stakeMarket({ is_replay: true }),
      replayFixture: fixtureAt('H1', 10),
      solanaNetwork: 'mainnet-beta',
    });
    const tap = makeStakeContext(USER_A, 'escrow-replay');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({ replay: true, network: 'mainnet-beta' });
    expect(tap.privateMessages).toHaveLength(1);
    expect(tap.privateMessages[0]?.text).toContain('COMPLETED-MATCH REPLAY');
    expect(tap.privateMessages[0]?.text).toContain('allowlisted, capped mainnet assets');
    expect(tap.privateMessages[0]?.text).toContain('do not change Points');
    expect(harness.wagerDb.positions).toHaveLength(0);
    expect(harness.wagerDb.ledger.filter((entry) => entry.kind === 'stake')).toHaveLength(0);
  });

  it('treats an expired signing presentation as retryable and never sends its token', async () => {
    const expiredPort: EscrowTelegramPort = {
      async createPlacementSession() {
        return {
          kind: 'created',
          token: TOKEN,
          expiresAt: '2026-07-06T17:59:59.000Z',
          duplicate: false,
        };
      },
      async createWalletSession() {
        return { kind: 'rejected', code: 'temporarily_unavailable' };
      },
    };
    const harness = makeStakeHarness({ custodyMode: 'escrow', escrow: expiredPort });
    const tap = makeStakeContext(USER_A, 'expired-callback');

    await dispatchCallback(harness.h, tap.ctx, stakeAction('back', PRESET_01));

    expect(tap.privateMessages).toHaveLength(0);
    expect(tap.toasts.at(-1)).toContain('expired');
    expect(JSON.stringify(tap.toasts)).not.toContain(TOKEN);
  });

  it('does not leak signing or provider identities in public status copy', () => {
    const signingToken = 'z'.repeat(43);
    const providerId = 'did:privy:private-provider-id';
    const text = escrowPlacementStatusText({
      participantName: 'Alice',
      network: 'devnet',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      side: 'back',
      state: { kind: 'finalized', positionState: 'active' },
    });

    expect(text).toContain('Alice');
    expect(text).toContain('Finalized on-chain');
    expect(text).not.toContain(signingToken);
    expect(text).not.toContain(providerId);
  });
});
