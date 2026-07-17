import type { Env } from '../env.js';

export function isBetaGroupAllowed(
  env: Pick<Env, 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'>,
  groupId: number,
): boolean {
  return env.DEPLOYMENT_ENV === 'development' || env.BETA_ALLOWED_GROUP_IDS.includes(groupId);
}
