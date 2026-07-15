export interface EscrowGroupRolloutDatabase {
  configureGroupRollout(input: {
    readonly groupId: number;
    readonly custodyMode: 'escrow';
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
    readonly enabledBy: null;
    readonly nowIso: string;
  }): Promise<{
    readonly ok: true;
    readonly created: boolean;
    readonly groupId: number;
    readonly custodyMode: 'legacy' | 'escrow';
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta' | null;
    readonly genesisHash: string | null;
    readonly programId: string | null;
    readonly custodyVersion: number | null;
  }>;
}

export function createEscrowGroupRolloutService(options: {
  readonly db: EscrowGroupRolloutDatabase;
  readonly deployment: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
  };
  readonly clock: () => string;
}) {
  return {
    async ensureEscrowGroups(groupIds: readonly number[]): Promise<void> {
      const groups = [...new Set(groupIds)];
      if (groups.some((groupId) => !Number.isSafeInteger(groupId) || groupId === 0)) {
        throw new TypeError('invalid escrow Telegram group id');
      }
      const nowIso = options.clock();
      if (!Number.isFinite(Date.parse(nowIso))) throw new TypeError('invalid escrow rollout clock');
      await Promise.all(groups.map(async (groupId) => {
        const result = await options.db.configureGroupRollout({
          groupId,
          custodyMode: 'escrow',
          ...options.deployment,
          enabledBy: null,
          nowIso,
        });
        if (
          result.groupId !== groupId || result.custodyMode !== 'escrow' ||
          result.cluster !== options.deployment.cluster ||
          result.genesisHash !== options.deployment.genesisHash ||
          result.programId !== options.deployment.programId ||
          result.custodyVersion !== options.deployment.custodyVersion
        ) throw new TypeError('escrow group rollout identity mismatch');
      }));
    },
  };
}

export type EscrowGroupRolloutService = ReturnType<typeof createEscrowGroupRolloutService>;
