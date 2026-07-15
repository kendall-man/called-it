import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair, PublicKey } from '@solana/web3.js';

import type { OracleSetAccount, ProtocolConfigAccount } from './types.js';
import {
  DEVNET_CANONICAL_USDC_MINT,
  DEVNET_GENESIS_HASH,
  PINNED_ESCROW_PROGRAM_ID,
  assertExactDevnetGenesis,
  assertPinnedProgramIdentity,
  assertSanitizedArtifacts,
  createSanitizedArtifacts,
  type DevnetPublicDeployment,
  verifyDecodedProtocolState,
} from './devnet-bootstrap.js';

const key = (): string => Keypair.generate().publicKey.toBase58();

function publicDeployment(): DevnetPublicDeployment {
  return {
    network: 'devnet',
    clusterGenesisHash: DEVNET_GENESIS_HASH,
    programId: PINNED_ESCROW_PROGRAM_ID,
    programDataAddress: key(),
    programSha256: 'a'.repeat(64),
    configPda: key(),
    oracleSetPda: key(),
    oracleSetEpoch: '1',
    canonicalUsdcMint: DEVNET_CANONICAL_USDC_MINT,
    classicTokenProgramId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    limits: {
      minimumSolPosition: '1000000',
      maximumSolPosition: '50000000',
      minimumUsdcPosition: '1000000',
      maximumUsdcPosition: '25000000',
      maximumMarketDurationSeconds: '86400',
      maximumResolutionDelaySeconds: '21600',
    },
    authorities: {
      upgrade: key(),
      config: key(),
      pause: key(),
      marketCreation: key(),
      feedOperator: key(),
      relayerFeePayer: key(),
      residualRecipient: key(),
    },
    oracleSet: {
      signers: [key(), key(), key()],
      threshold: 2,
      activationSlot: '123456789',
      retirementSlot: null,
    },
    custodyModeAction: 'unchanged',
  };
}

function decodedState(deployment: DevnetPublicDeployment): {
  readonly config: ProtocolConfigAccount;
  readonly oracle: OracleSetAccount;
} {
  return {
    config: {
      version: 1,
      bump: 254,
      paused: false,
      configAuthority: deployment.authorities.config,
      pauseAuthority: deployment.authorities.pause,
      marketCreationAuthority: deployment.authorities.marketCreation,
      feedOperatorAuthority: deployment.authorities.feedOperator,
      oracleSet: deployment.oracleSetPda,
      relayerFeePayer: deployment.authorities.relayerFeePayer,
      residualRecipient: deployment.authorities.residualRecipient,
      clusterGenesisHash: deployment.clusterGenesisHash,
      canonicalUsdcMint: deployment.canonicalUsdcMint,
      allowedTokenProgram: deployment.classicTokenProgramId,
      maxSolPosition: deployment.limits.maximumSolPosition,
      maxUsdcPosition: deployment.limits.maximumUsdcPosition,
      minSolPosition: deployment.limits.minimumSolPosition,
      minUsdcPosition: deployment.limits.minimumUsdcPosition,
      maxMarketDurationSeconds: deployment.limits.maximumMarketDurationSeconds,
      maxResolutionDelaySeconds: deployment.limits.maximumResolutionDelaySeconds,
    },
    oracle: {
      version: 1,
      bump: 253,
      epoch: deployment.oracleSetEpoch,
      signers: deployment.oracleSet.signers,
      threshold: deployment.oracleSet.threshold,
      activationSlot: deployment.oracleSet.activationSlot,
      retirementSlot: deployment.oracleSet.retirementSlot,
    },
  };
}

test('refuses every cluster except the exact Solana devnet genesis hash', () => {
  assert.equal(DEVNET_GENESIS_HASH, 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
  assert.doesNotThrow(() => assertExactDevnetGenesis(DEVNET_GENESIS_HASH));
  assert.throws(
    () => assertExactDevnetGenesis('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'),
    /exact Solana devnet genesis hash/,
  );
  assert.throws(() => assertExactDevnetGenesis('devnet'), /refusing all actions/);
});

test('rejects a program keypair that does not derive the pinned program ID', () => {
  assert.doesNotThrow(() => assertPinnedProgramIdentity(new PublicKey(PINNED_ESCROW_PROGRAM_ID)));
  assert.throws(
    () => assertPinnedProgramIdentity(Keypair.generate().publicKey),
    /repository-pinned escrow program ID/,
  );
});

test('existing identical ProtocolConfig and OracleSet verification is idempotent', () => {
  const deployment = publicDeployment();
  const expected = decodedState(deployment);
  const actual = structuredClone(expected);
  assert.doesNotThrow(() => verifyDecodedProtocolState(actual.config, actual.oracle, expected.config, expected.oracle));
  assert.doesNotThrow(() => verifyDecodedProtocolState(actual.config, actual.oracle, expected.config, expected.oracle));
  assert.deepEqual(actual, expected);

  const mismatch = { ...actual.config, maxSolPosition: '50000001' };
  assert.throws(
    () => verifyDecodedProtocolState(mismatch, actual.oracle, expected.config, expected.oracle),
    /ProtocolConfig.maxSolPosition mismatch/,
  );
});

test('public manifest and env fragment redact secret inputs and never enable escrow custody', () => {
  const artifacts = createSanitizedArtifacts(publicDeployment());
  const forbidden = [
    'https://devnet.example.invalid/?api-key=private-rpc-token',
    '/private/keys/upgrade-authority.json',
    '/private/keys/oracle-1.json',
    '[1,2,3,4,5,6,7,8]',
  ];
  assert.doesNotThrow(() => assertSanitizedArtifacts(artifacts, forbidden));
  for (const value of forbidden) {
    assert.equal(artifacts.manifest.includes(value), false);
    assert.equal(artifacts.env.includes(value), false);
  }
  assert.doesNotMatch(artifacts.env, /^WAGER_CUSTODY_MODE=/m);
  assert.doesNotMatch(artifacts.env, /ESCROW_RELAYER_KEYPAIR_B58|SOLANA_RPC_URL/);
  assert.doesNotMatch(artifacts.manifest, /rpcUrl|keypairPath|secretKey/);
});
