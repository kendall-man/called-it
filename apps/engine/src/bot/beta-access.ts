import type { Env } from '../env.js';

export function isBetaGroupAllowed(
  env: Pick<Env, 'DEPLOYMENT_ENV' | 'BETA_ALLOWED_GROUP_IDS'> &
    Partial<Pick<Env, 'PUBLIC_BETA_ENABLED'>>,
  groupId: number,
): boolean {
  return (env.PUBLIC_BETA_ENABLED === true && Number.isSafeInteger(groupId) && groupId < 0) ||
    env.DEPLOYMENT_ENV === 'development' ||
    env.BETA_ALLOWED_GROUP_IDS.includes(groupId);
}
