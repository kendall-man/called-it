export const BOT_ONBOARDING_VERSIONS = ['calledit_v1'] as const;

export type BotOnboardingVersion = (typeof BOT_ONBOARDING_VERSIONS)[number];

export type BotGroupReadyResult =
  | {
      readonly ok: true;
      readonly created: boolean;
      readonly groupId: number;
      readonly onboardingVersion: BotOnboardingVersion;
    }
  | {
      readonly ok: false;
      readonly code: 'invalid_input' | 'group_not_found';
    };

export interface BotOnboardingDb {
  markGroupReady(input: {
    readonly groupId: number;
    readonly onboardingVersion: BotOnboardingVersion;
  }): Promise<BotGroupReadyResult>;
}
