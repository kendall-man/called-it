import { describe, expect, it } from 'vitest';
import { DEVNET_ESCROW_PROGRAM_ID } from '@calledit/escrow-sdk';
import type { LogFields } from './log.js';
import {
  assertEscrowConfiguredDeploymentIdentity,
  assertEscrowWave4DeploymentConsistency,
  createTxlineWarningLogger,
  dependencyFailureReason,
} from './wiring.js';

const DEVNET_GENESIS_HASH = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const DISTINCT_MAINNET_TEST_PROGRAM_ID = 'BPFLoaderUpgradeab1e11111111111111111111111';

type ExpectedTxlineWarningReason =
  | 'feed_failure'
  | 'reconnect'
  | 'malformed'
  | 'normalization'
  | 'unknown';

const KNOWN_TXLINE_WARNINGS = [
  ['stream loop crashed', 'feed_failure'],
  ['replay loop crashed', 'feed_failure'],
  ['replay hit max virtual duration without a terminal phase', 'feed_failure'],
  ['replay could not start', 'feed_failure'],
  ['replay tick failed — continuing', 'feed_failure'],
  ['stream error — will reconnect', 'reconnect'],
  ['heartbeat timeout — reconnecting', 'reconnect'],
  ['unexpected response shape', 'malformed'],
  ['skipped malformed records', 'malformed'],
  ['stream frame is not valid JSON', 'malformed'],
  ['skipping unparseable odds record', 'malformed'],
  ['skipping unparseable scores record', 'malformed'],
  ['unknown SuperOddsType', 'normalization'],
  ['odds period rejected', 'normalization'],
  ['1X2 probabilities do not sum to ~1', 'normalization'],
  ['totals record without a parseable line', 'normalization'],
  ['unknown StatusId — keeping previous phase', 'normalization'],
  ['amend/discard without resolvable original seq', 'normalization'],
] as const satisfies readonly (readonly [string, ExpectedTxlineWarningReason])[];

type WarningEvent = {
  readonly event: string;
  readonly fields: LogFields | undefined;
};

function captureTxlineWarnings(): {
  readonly events: WarningEvent[];
  readonly warn: ReturnType<typeof createTxlineWarningLogger>;
} {
  const events: WarningEvent[] = [];
  const warn = createTxlineWarningLogger({
    warn(event, fields) {
      events.push({ event, fields });
    },
  });
  return { events, warn };
}

function wave4DeploymentIdentity() {
  const sponsorAddress = 'sponsor';
  const marketCreationAuthorityAddress = 'market-authority';
  const feedOperatorAddress = 'feed-operator';
  return {
    marketDeployment: {
      cluster: 'mainnet-beta' as const,
      genesisHash: MAINNET_GENESIS_HASH,
      programId: DISTINCT_MAINNET_TEST_PROGRAM_ID,
      canonicalUsdcMint: 'mainnet-usdc',
      marketCreationAuthority: marketCreationAuthorityAddress,
      relayerFeePayer: sponsorAddress,
      oracleSetEpoch: 7n,
      custodyVersion: 1,
    },
    placementDeployment: {
      cluster: 'mainnet-beta' as const,
      genesisHash: MAINNET_GENESIS_HASH,
      programId: DISTINCT_MAINNET_TEST_PROGRAM_ID,
      canonicalUsdcMint: 'mainnet-usdc',
      oracleSetEpoch: 7n,
      custodyVersion: 1,
      minimumSolPosition: 1n,
      maximumSolPosition: 2n,
      minimumUsdcPosition: 1n,
      maximumUsdcPosition: 2n,
      allowedGroupIds: [-100123],
    },
    recoveryDeployment: {
      cluster: 'mainnet-beta' as const,
      genesisHash: MAINNET_GENESIS_HASH,
      programId: DISTINCT_MAINNET_TEST_PROGRAM_ID,
      canonicalUsdcMint: 'mainnet-usdc',
      relayerFeePayer: sponsorAddress,
      residualRecipient: 'residual-recipient',
      custodyVersion: 1,
    },
    controlDeployment: {
      cluster: 'mainnet-beta' as const,
      genesisHash: MAINNET_GENESIS_HASH,
      programId: DISTINCT_MAINNET_TEST_PROGRAM_ID,
      custodyVersion: 1,
      feedOperatorAuthority: feedOperatorAddress,
    },
    sponsorAddress,
    marketCreationAuthorityAddress,
    feedOperatorAddress,
  };
}

describe('escrow deployment wiring', () => {
  it('accepts the pinned devnet identity and a distinct mainnet identity', () => {
    expect(() => assertEscrowConfiguredDeploymentIdentity({
      network: 'devnet',
      programId: DEVNET_ESCROW_PROGRAM_ID,
      genesisHash: DEVNET_GENESIS_HASH,
    })).not.toThrow();
    expect(() => assertEscrowConfiguredDeploymentIdentity({
      network: 'mainnet-beta',
      programId: DISTINCT_MAINNET_TEST_PROGRAM_ID,
      genesisHash: MAINNET_GENESIS_HASH,
    })).not.toThrow();
    expect(() => assertEscrowWave4DeploymentConsistency(wave4DeploymentIdentity())).not.toThrow();
  });

  it.each([
    ['devnet with the mainnet program', 'devnet', DISTINCT_MAINNET_TEST_PROGRAM_ID, DEVNET_GENESIS_HASH],
    ['mainnet with the devnet program', 'mainnet-beta', DEVNET_ESCROW_PROGRAM_ID, MAINNET_GENESIS_HASH],
    ['devnet with mainnet genesis', 'devnet', DEVNET_ESCROW_PROGRAM_ID, MAINNET_GENESIS_HASH],
    ['mainnet with devnet genesis', 'mainnet-beta', DISTINCT_MAINNET_TEST_PROGRAM_ID, DEVNET_GENESIS_HASH],
  ] as const)('rejects crossed deployment identity: %s', (_name, network, programId, genesisHash) => {
    expect(() => assertEscrowConfiguredDeploymentIdentity({ network, programId, genesisHash }))
      .toThrowError('escrow production runtime unavailable: deployment_identity_mismatch');
  });

  it.each(['programId', 'genesisHash', 'canonicalUsdcMint'] as const)(
    'rejects a crossed Wave 4 placement %s',
    (field) => {
      const identity = wave4DeploymentIdentity();
      identity.placementDeployment[field] = `crossed-${field}`;
      expect(() => assertEscrowWave4DeploymentConsistency(identity))
        .toThrowError('escrow Wave 4 deployment identity mismatch');
    },
  );
});

describe('wiring dependency error narrowing', () => {
  it('returns a bounded reason without exposing Error text', () => {
    // Given a dependency throws a normal Error
    const error = new Error('upstream unavailable');

    // When wiring prepares stable metadata
    const reason = dependencyFailureReason(error);

    // Then callers get a categorical reason only
    expect(reason).toBe('dependency_exception');
    expect(reason).not.toContain(error.message);
  });

  it('rethrows unknown thrown values instead of stringifying them', () => {
    // Given a dependency throws a non-Error sentinel
    const thrown = Object.freeze({ secret: 'do-not-stringify' });

    // When wiring prepares stable metadata
    const invoke = () => dependencyFailureReason(thrown);

    // Then the original value propagates untouched
    try {
      invoke();
    } catch (error) {
      expect(error).toBe(thrown);
      return;
    }
    throw new Error('expected non-Error dependency throw to propagate');
  });
});

describe('TxLINE warning redaction', () => {
  it('maps every supported warning variant to its operational reason', () => {
    // Given every warning message currently emitted by TxLINE call sites
    const { events, warn } = captureTxlineWarnings();

    // When the production adapter receives each warning with freeform context
    for (const [message] of KNOWN_TXLINE_WARNINGS) {
      warn(message, { error: 'TXLINE_CONTEXT_SENTINEL_PRIVATE' });
    }

    // Then all events preserve only the expected bounded operational distinction
    expect(events).toEqual(KNOWN_TXLINE_WARNINGS.map(([, reason]) => ({
      event: 'txline_warning',
      fields: { reason },
    })));
    expect(JSON.stringify(events)).not.toContain('TXLINE_CONTEXT_SENTINEL_PRIVATE');
  });

  it('maps an arbitrary warning and context to unknown without retaining either', () => {
    // Given provider-controlled warning text and nested context
    const { events, warn } = captureTxlineWarnings();
    const rawMessage = 'TXLINE_MESSAGE_SENTINEL_PRIVATE';
    const rawContext = 'TXLINE_CONTEXT_SENTINEL_PRIVATE';

    // When the production adapter receives the unknown warning
    warn(rawMessage, { error: rawContext, nested: { excerpt: rawContext } });

    // Then the emitted event is closed and contains no freeform input
    expect(events).toEqual([{
      event: 'txline_warning',
      fields: { reason: 'unknown' },
    }]);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(rawMessage);
    expect(serialized).not.toContain(rawContext);
  });
});
