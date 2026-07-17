import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  CLASSIC_TOKEN_PROGRAM_ID,
  decodeOracleSetAccount,
  decodeProtocolConfigAccount,
  deriveOracleSetPda,
  deriveProtocolConfigPda,
  materializeInstruction,
} from '@calledit/escrow-sdk';
import { createMint, getMint, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { HarnessConfigurationError } from './errors.js';
import { decodeAnchorAccount } from './account-decode.js';
import { accountData, chainTimestamp, connection, deterministicKeypair, loadUpgradeAuthority, sendInstructions, waitUntil } from './runtime.js';
import type { BootstrapContext, RoleKeys } from './types.js';

const DEFAULT_RPC_URL = 'http://127.0.0.1:18999';
const PROGRAM_ID = new PublicKey('HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL');
const UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');
const PROGRAM_KEYPAIR_PATH = '/private/tmp/calledit-beta-secrets/calledit_escrow-devnet-keypair.json';
const ORACLE_EPOCH = 1n;

function roleKeys(): RoleKeys {
  return {
    configAuthority: deterministicKeypair('config-authority'),
    pauseAuthority: deterministicKeypair('pause-authority'),
    marketAuthority: deterministicKeypair('market-authority'),
    feedAuthority: deterministicKeypair('feed-authority'),
    relayer: deterministicKeypair('relayer'),
    residualRecipient: deterministicKeypair('residual-recipient'),
    mintAuthority: deterministicKeypair('mint-authority'),
    users: [
      deterministicKeypair('user-back'),
      deterministicKeypair('user-doubt'),
      deterministicKeypair('user-usdc'),
      deterministicKeypair('user-timeout'),
    ],
    oracles: [
      deterministicKeypair('oracle-one'),
      deterministicKeypair('oracle-two'),
      deterministicKeypair('oracle-three'),
    ],
  };
}

async function loadProgramIdentity(): Promise<PublicKey> {
  const path = process.env['ESCROW_PROGRAM_KEYPAIR_PATH'] ?? PROGRAM_KEYPAIR_PATH;
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!Array.isArray(parsed) || parsed.length !== 64) {
    throw new HarnessConfigurationError('escrow program keypair is not a 64-byte array');
  }
  return Keypair.fromSecretKey(Uint8Array.from(parsed)).publicKey;
}

async function assertDeploymentIdentity(context: {
  readonly connection: ReturnType<typeof connection>;
  readonly programId: PublicKey;
  readonly upgradeAuthority: Keypair;
}): Promise<void> {
  assert((await loadProgramIdentity()).equals(context.programId), 'external program identity must match the pinned ID');
  const programInfo = await context.connection.getAccountInfo(context.programId, 'finalized');
  assert(programInfo?.executable === true, 'escrow program must be executable');
  assert(programInfo.owner.equals(UPGRADEABLE_LOADER), 'escrow program must use the upgradeable loader');
  assert.equal(programInfo.data.readUInt32LE(0), 2, 'loader account must be a Program variant');
  const programDataAddress = new PublicKey(programInfo.data.subarray(4, 36));
  const expectedProgramData = PublicKey.findProgramAddressSync([context.programId.toBytes()], UPGRADEABLE_LOADER)[0];
  assert(programDataAddress.equals(expectedProgramData), 'ProgramData address must be canonical');
  const programData = await accountData(context.connection, programDataAddress, UPGRADEABLE_LOADER);
  assert.equal(Buffer.from(programData).readUInt32LE(0), 3, 'loader account must be a ProgramData variant');
  assert.equal(programData[12], 1, 'ProgramData must retain an upgrade authority');
  assert(new PublicKey(programData.slice(13, 45)).equals(context.upgradeAuthority.publicKey), 'upgrade authority mismatch');
}

async function fundRoles(context: BootstrapContext): Promise<void> {
  const recipients = [
    context.roles.configAuthority,
    context.roles.pauseAuthority,
    context.roles.marketAuthority,
    context.roles.feedAuthority,
    context.roles.relayer,
    context.roles.residualRecipient,
    context.roles.mintAuthority,
    ...context.roles.users,
  ];
  const instructions = recipients.map((recipient) => SystemProgram.transfer({
    fromPubkey: context.upgradeAuthority.publicKey,
    toPubkey: recipient.publicKey,
    lamports: recipient === context.roles.relayer ? 5_000_000_000 : 500_000_000,
  }));
  await sendInstructions({ connection: connection(context.rpcUrl), feePayer: context.upgradeAuthority, instructions });
}

export async function bootstrapEscrow(): Promise<BootstrapContext> {
  const rpcUrl = process.env['ESCROW_LOCAL_RPC_URL'] ?? DEFAULT_RPC_URL;
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== 'http:' || parsedRpc.hostname !== '127.0.0.1') {
    throw new HarnessConfigurationError('escrow integration RPC must be an HTTP loopback URL');
  }
  const programId = new PublicKey(process.env['ESCROW_PROGRAM_ID'] ?? PROGRAM_ID);
  if (!programId.equals(PROGRAM_ID)) throw new HarnessConfigurationError('escrow program ID differs from the pinned local deployment');
  const rpc = connection(rpcUrl);
  const upgradeAuthority = await loadUpgradeAuthority();
  await assertDeploymentIdentity({ connection: rpc, programId, upgradeAuthority });
  const genesisHash = await rpc.getGenesisHash();
  const genesisBytes = new PublicKey(genesisHash).toBytes();
  const roles = roleKeys();
  const mintKeypair = deterministicKeypair('canonical-usdc-mint');
  const contextBase = {
    rpcUrl, programId, upgradeAuthority, roles, canonicalUsdcMint: mintKeypair.publicKey,
    genesisHash, genesisBytes, oracleEpoch: ORACLE_EPOCH,
    oracleSet: deriveOracleSetPda(programId, ORACLE_EPOCH).publicKey,
  } satisfies BootstrapContext;
  await fundRoles(contextBase);
  const canonicalUsdcMint = await createMint(rpc, upgradeAuthority, roles.mintAuthority.publicKey, null, 6, mintKeypair, undefined, TOKEN_PROGRAM_ID);
  assert(canonicalUsdcMint.equals(contextBase.canonicalUsdcMint), 'canonical USDC mint identity changed');
  const mint = await getMint(rpc, canonicalUsdcMint, 'finalized', TOKEN_PROGRAM_ID);
  assert.equal(mint.decimals, 6, 'local USDC must use six decimals');

  const initialize = materializeInstruction({
    kind: 'initialize_config', initializer: upgradeAuthority.publicKey,
    configAuthority: roles.configAuthority.publicKey, pauseAuthority: roles.pauseAuthority.publicKey,
    marketCreationAuthority: roles.marketAuthority.publicKey, feedOperatorAuthority: roles.feedAuthority.publicKey,
    relayerFeePayer: roles.relayer.publicKey, residualRecipient: roles.residualRecipient.publicKey,
    clusterGenesisHash: genesisBytes, canonicalUsdcMint, allowedTokenProgram: CLASSIC_TOKEN_PROGRAM_ID,
    minimumSolPosition: 1_000_000n, maximumSolPosition: 100_000_000n,
    minimumUsdcPosition: 1_000n, maximumUsdcPosition: 100_000_000n,
    maximumMarketDurationSeconds: 3_600n, maximumResolutionDelaySeconds: 3_600n,
  }, { programId });
  await sendInstructions({ connection: rpc, feePayer: upgradeAuthority, instructions: [initialize] });

  const activationSlot = BigInt(await rpc.getSlot('processed')) + 10n;
  const rotate = materializeInstruction({
    kind: 'rotate_oracle_set', payer: roles.relayer.publicKey,
    configAuthority: roles.configAuthority.publicKey, currentOracleSet: SystemProgram.programId,
    epoch: ORACLE_EPOCH, signers: roles.oracles.map((oracle) => oracle.publicKey),
    signatureThreshold: 2, activationSlot, retirementSlot: null,
  }, { programId });
  await sendInstructions({ connection: rpc, feePayer: roles.relayer, instructions: [rotate], signers: [roles.configAuthority] });
  await waitUntil({ operation: 'oracle-set activation', timeoutMs: 10_000, predicate: async () => BigInt(await rpc.getSlot('finalized')) >= activationSlot });

  const config = decodeProtocolConfigAccount(await accountData(rpc, deriveProtocolConfigPda(programId).publicKey, programId));
  assert.equal(
    Buffer.from(config.clusterGenesisHash).equals(Buffer.from(genesisBytes)),
    true,
    'config genesis hash must match the validator',
  );
  assert.equal(config.canonicalUsdcMint, canonicalUsdcMint.toBase58());
  assert.equal(config.allowedTokenProgram, TOKEN_PROGRAM_ID.toBase58());
  assert.equal(config.oracleSet, contextBase.oracleSet.toBase58());
  const oracleSet = decodeAnchorAccount(
    await accountData(rpc, contextBase.oracleSet, programId),
    decodeOracleSetAccount,
  );
  assert.equal(oracleSet.signatureThreshold, 2);
  assert.equal(oracleSet.signers.length, 3);
  assert.equal(await chainTimestamp(rpc) > 0n, true);
  return contextBase;
}
