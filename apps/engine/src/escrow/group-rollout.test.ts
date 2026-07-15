import { describe, expect, it } from 'vitest';
import { createEscrowGroupRolloutService, type EscrowGroupRolloutDatabase } from './group-rollout.js';

const deployment = {
  cluster: 'devnet' as const,
  genesisHash: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  programId: 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL',
  custodyVersion: 1,
};

describe('escrow group rollout service', () => {
  it('configures a negative Telegram group before market mint and deduplicates input', async () => {
    const inputs: Parameters<EscrowGroupRolloutDatabase['configureGroupRollout']>[0][] = [];
    const service = createEscrowGroupRolloutService({
      db: {
        async configureGroupRollout(input) {
          inputs.push(input);
          return { ok: true, created: true, ...input };
        },
      },
      deployment,
      clock: () => '2026-07-15T12:00:00.000Z',
    });

    await service.ensureEscrowGroups([-100123, -100123]);

    expect(inputs).toEqual([expect.objectContaining({
      groupId: -100123, custodyMode: 'escrow', enabledBy: null, ...deployment,
    })]);
  });

  it('fails closed when DB rollout truth does not echo the exact deployment', async () => {
    const service = createEscrowGroupRolloutService({
      db: {
        async configureGroupRollout(input) {
          return { ...input, ok: true, created: false, programId: 'wrong-program' };
        },
      },
      deployment,
      clock: () => '2026-07-15T12:00:00.000Z',
    });

    await expect(service.ensureEscrowGroups([-100123])).rejects.toThrow('identity mismatch');
  });
});
