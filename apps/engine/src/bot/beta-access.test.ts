import { describe, expect, it } from 'vitest';
import { isBetaGroupAllowed } from './beta-access.js';

describe('beta group access', () => {
  it('allows every local development group but only explicitly listed deployed groups', () => {
    expect(
      isBetaGroupAllowed(
        { DEPLOYMENT_ENV: 'development', BETA_ALLOWED_GROUP_IDS: [] },
        -100123,
      ),
    ).toBe(true);
    expect(
      isBetaGroupAllowed(
        { DEPLOYMENT_ENV: 'production', BETA_ALLOWED_GROUP_IDS: [-100123] },
        -100123,
      ),
    ).toBe(true);
    expect(
      isBetaGroupAllowed(
        { DEPLOYMENT_ENV: 'production', BETA_ALLOWED_GROUP_IDS: [-100123] },
        -100999,
      ),
    ).toBe(false);
  });
});
