import {
  PublicKey,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SystemProgram,
  type AccountMeta,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  CLASSIC_TOKEN_PROGRAM_ID,
  SOL_ACCOUNT_PLACEHOLDER,
  deriveClassicAssociatedTokenAddress,
  deriveMarketPda,
  deriveOracleSetPda,
  derivePositionLotPda,
  deriveProtocolConfigPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
  deriveUserPositionPda,
} from './addresses.js';
import { publicKey, type PublicKeyInput } from './borsh.js';
import type { EscrowInstructionRequest } from './instruction-types.js';
import { ESCROW_INSTRUCTION_ACCOUNTS } from './schema.js';

type AddressMap = Readonly<Record<string, PublicKeyInput>>;
const UPGRADEABLE_LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

function metaList(kind: EscrowInstructionRequest['kind'], addresses: AddressMap, remaining: readonly PublicKeyInput[] = []): AccountMeta[] {
  const metas: AccountMeta[] = [];
  for (const schema of ESCROW_INSTRUCTION_ACCOUNTS[kind]) {
    if (schema.remaining === true) {
      metas.push(...remaining.map((value) => ({ pubkey: publicKey(value), isSigner: false, isWritable: true })));
      continue;
    }
    const address = addresses[schema.name];
    if (address === undefined) throw new Error(`missing ${kind} account: ${schema.name}`);
    metas.push({ pubkey: publicKey(address), isSigner: schema.signer, isWritable: schema.writable });
  }
  return metas;
}

function common(programId: PublicKey, marketUuid: string): { readonly config: PublicKey; readonly market: PublicKey } {
  return {
    config: deriveProtocolConfigPda(programId).publicKey,
    market: deriveMarketPda(programId, marketUuid).publicKey,
  };
}

function assetAccounts(programId: PublicKey, market: PublicKey, asset: 'sol' | 'usdc', mint: PublicKeyInput): {
  readonly vault: PublicKey;
  readonly tokenMint: PublicKey;
} {
  const tokenMint = asset === 'usdc' ? publicKey(mint) : SOL_ACCOUNT_PLACEHOLDER;
  const vault = asset === 'usdc'
    ? deriveUsdcVaultAddress(market, tokenMint)
    : deriveSolVaultPda(programId, market).publicKey;
  return { vault, tokenMint };
}

function positionAccounts(programId: PublicKey, market: PublicKey, owner: PublicKeyInput, nonce?: bigint): {
  readonly owner: PublicKey;
  readonly position: PublicKey;
  readonly lot?: PublicKey;
} {
  const ownerKey = publicKey(owner);
  const position = deriveUserPositionPda(programId, market, ownerKey).publicKey;
  return nonce === undefined
    ? { owner: ownerKey, position }
    : { owner: ownerKey, position, lot: derivePositionLotPda(programId, market, ownerKey, nonce).publicKey };
}

function tokenPrograms(): AddressMap {
  return {
    tokenProgram: CLASSIC_TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

export function escrowInstructionAccounts(request: EscrowInstructionRequest, programId: PublicKey): AccountMeta[] {
  switch (request.kind) {
    case 'initialize_config': return metaList(request.kind, {
      initializer: request.initializer,
      config: deriveProtocolConfigPda(programId).publicKey,
      escrowProgram: programId,
      programData: PublicKey.findProgramAddressSync([programId.toBytes()], UPGRADEABLE_LOADER_ID)[0],
      systemProgram: SystemProgram.programId,
    });
    case 'rotate_config': return metaList(request.kind, {
      config: deriveProtocolConfigPda(programId).publicKey,
      configAuthority: request.currentConfigAuthority,
    });
    case 'rotate_oracle_set': return metaList(request.kind, {
      config: deriveProtocolConfigPda(programId).publicKey,
      configAuthority: request.configAuthority,
      currentOracleSet: request.currentOracleSet,
      newOracleSet: deriveOracleSetPda(programId, request.epoch).publicKey,
      payer: request.payer,
      systemProgram: SystemProgram.programId,
    });
    case 'set_pause': return metaList(request.kind, {
      authority: request.authority,
      config: deriveProtocolConfigPda(programId).publicKey,
    });
    case 'initialize_market': {
      const base = common(programId, request.document.marketUuid);
      const asset = assetAccounts(programId, base.market, request.document.asset, request.canonicalUsdcMint);
      return metaList(request.kind, {
        payer: request.payer,
        marketCreationAuthority: request.marketCreationAuthority,
        ...base,
        oracleSet: deriveOracleSetPda(programId, request.document.oracleSetEpoch).publicKey,
        ...asset,
        ...tokenPrograms(),
      });
    }
    case 'freeze_market': return metaList(request.kind, {
      feedOperatorAuthority: request.feedOperatorAuthority,
      ...common(programId, request.marketUuid),
    });
    case 'unfreeze_market': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, {
        ...base,
        oracleSet: deriveOracleSetPda(programId, request.attestation.oracleSetEpoch).publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      });
    }
    case 'place_position': {
      const base = common(programId, request.marketUuid);
      const position = positionAccounts(programId, base.market, request.owner, request.expectedLotNonce);
      const asset = assetAccounts(programId, base.market, request.expectedAsset, request.canonicalUsdcMint);
      const assetSource = request.expectedAsset === 'usdc'
        ? deriveClassicAssociatedTokenAddress(position.owner, asset.tokenMint)
        : position.owner;
      return metaList(request.kind, { payer: request.payer, ...base, ...position, ...asset, assetSource, ...tokenPrograms() });
    }
    case 'activate_position_lot': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, { ...base, ...positionAccounts(programId, base.market, request.owner, request.lotNonce) });
    }
    case 'invalidate_position_lot': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, {
        ...base,
        ...positionAccounts(programId, base.market, request.owner, request.lotNonce),
        oracleSet: deriveOracleSetPda(programId, request.attestation.oracleSetEpoch).publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      });
    }
    case 'settle_market':
    case 'void_market': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, {
        ...base,
        oracleSet: deriveOracleSetPda(programId, request.attestation.oracleSetEpoch).publicKey,
        instructionsSysvar: SYSVAR_INSTRUCTIONS_PUBKEY,
      });
    }
    case 'calculate_position_entitlement': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, { ...base, ...positionAccounts(programId, base.market, request.owner) });
    }
    case 'timeout_void': return metaList(request.kind, common(programId, request.marketUuid));
    case 'claim_position':
    case 'claim_position_for': {
      const base = common(programId, request.marketUuid);
      const position = positionAccounts(programId, base.market, request.owner);
      const asset = assetAccounts(programId, base.market, request.asset, request.canonicalUsdcMint);
      const ownerTokenAccount = request.asset === 'usdc'
        ? deriveClassicAssociatedTokenAddress(position.owner, asset.tokenMint)
        : position.owner;
      const payer = request.kind === 'claim_position_for' ? request.payer : position.owner;
      return metaList(request.kind, { payer, ...base, ...position, ...asset, ownerTokenAccount, ...tokenPrograms() });
    }
    case 'close_position_lots': {
      const base = common(programId, request.marketUuid);
      const position = positionAccounts(programId, base.market, request.owner);
      const lots = request.lotNonces.map((nonce) => derivePositionLotPda(programId, base.market, position.owner, nonce).publicKey);
      return metaList(request.kind, {
        ...base,
        ...position,
        rentRecipient: request.rentRecipient,
        systemProgram: SystemProgram.programId,
      }, lots);
    }
    case 'close_position': {
      const base = common(programId, request.marketUuid);
      return metaList(request.kind, {
        ...base,
        ...positionAccounts(programId, base.market, request.owner),
        rentRecipient: request.rentRecipient,
      });
    }
    case 'close_market': {
      const base = common(programId, request.marketUuid);
      const asset = assetAccounts(programId, base.market, request.asset, request.canonicalUsdcMint);
      const residualTokenAccount = request.asset === 'usdc'
        ? deriveClassicAssociatedTokenAddress(request.residualRecipient, asset.tokenMint)
        : publicKey(request.residualRecipient);
      return metaList(request.kind, {
        ...base,
        ...asset,
        residualRecipient: request.residualRecipient,
        residualTokenAccount,
        ...tokenPrograms(),
      });
    }
  }
}
