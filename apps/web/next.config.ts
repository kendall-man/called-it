import { existsSync } from 'node:fs';
import path from 'node:path';
import type { NextConfig } from 'next';
import { validateWebBuildEnv } from './lib/env';

validateWebBuildEnv();

/**
 * In-browser merkle re-verification comes from `@calledit/solana/verify`
 * (an isomorphic sibling workspace package). That package may not be built
 * yet when this app builds, so all app code imports the neutral specifier
 * `solana-verify-bridge` instead, and this config points it at:
 *   - the real compiled module when `packages/solana/dist/verify.js` exists;
 *   - a contract-typed local fallback (graceful "verification unavailable")
 *     otherwise, keeping the app buildable with the sibling unbuilt.
 * Types always come from the fallback via tsconfig `paths`, which mirrors the
 * export surface pinned in CONTRACTS.md.
 */
const VERIFY_BRIDGE_SPECIFIER = 'solana-verify-bridge';
const BUILT_VERIFY_MODULE = path.resolve(
  process.cwd(),
  '../../packages/solana/dist/verify.js',
);
const FALLBACK_VERIFY_MODULE = path.resolve(process.cwd(), 'lib/verify-fallback.ts');

const verifyModulePath = existsSync(BUILT_VERIFY_MODULE)
  ? BUILT_VERIFY_MODULE
  : FALLBACK_VERIFY_MODULE;

const nextConfig: NextConfig = {
  transpilePackages: ['@calledit/solana'],
  webpack: (config) => {
    config.resolve ??= {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      [VERIFY_BRIDGE_SPECIFIER]: verifyModulePath,
      // Privy loads these only for Farcaster and fiat-onramp surfaces we do not expose.
      '@farcaster/mini-app-solana': false,
      '@stripe/crypto': false,
    };
    return config;
  },
  // Same mapping for anyone running `next dev --turbopack`.
  turbopack: {
    resolveAlias: {
      [VERIFY_BRIDGE_SPECIFIER]: verifyModulePath,
    },
  },
};

export default nextConfig;
