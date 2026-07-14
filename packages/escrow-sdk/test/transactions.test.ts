import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  SystemProgram,
  TransactionInstruction,
  type VersionedTransaction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  CLASSIC_TOKEN_PROGRAM_ID,
  deriveMarketPda,
  deriveSolVaultPda,
  deriveUsdcVaultAddress,
} from '../src/addresses.js';
import {
  applyPartialSignature,
  buildSponsoredPositionTransaction,
  buildUnsignedV0Transaction,
  messageBytesForPrivy,
  type SponsoredPositionBuildOptions,
} from '../src/transactions.js';
import {
  EscrowTransactionVerificationError,
  verifySponsoredPositionTransaction,
  type SponsoredPositionVerificationOptions,
} from '../src/verification.js';
import {
  GENESIS_HASH,
  MARKET_UUID,
  PROGRAM_ID,
  RECENT_BLOCKHASH,
  RELAYER,
  USDC_MINT,
  USER,
  key,
  sponsoredOptions,
} from './fixtures.js';

interface PlacementVector {
  readonly instruction_data_hex: string;
  readonly message_sha256: string;
  readonly accounts: readonly string[];
}

const vectors = JSON.parse(readFileSync(
  new URL('../vectors/instructions-v1.json', import.meta.url),
  'utf8',
)) as { readonly sol: PlacementVector; readonly usdc: PlacementVector };

function verification(options: SponsoredPositionBuildOptions): SponsoredPositionVerificationOptions {
  return {
    ...options,
    expectedGenesisHash: options.genesisHash,
    observedGenesisHash: options.genesisHash,
    currentBlockHeight: options.lastValidBlockHeight - 1n,
    currentUnixTimestamp: options.expiresAt - 1n,
  };
}

function signUser(transaction: VersionedTransaction): VersionedTransaction {
  transaction.sign([USER]);
  return transaction;
}

function tamperedAccountTransaction(options: SponsoredPositionBuildOptions, index: number): VersionedTransaction {
  const built = buildSponsoredPositionTransaction(options);
  const keys = built.instruction.keys.map((meta, metaIndex) => metaIndex === index
    ? { ...meta, pubkey: key(50 + index) }
    : meta);
  const instruction = new TransactionInstruction({
    programId: built.instruction.programId,
    keys,
    data: built.instruction.data,
  });
  return signUser(buildUnsignedV0Transaction({
    feePayer: options.relayerFeePayer,
    recentBlockhash: options.recentBlockhash,
    instructions: [instruction],
  }));
}

async function expectCode(promise: Promise<void>, code: string): Promise<void> {
  await expect(promise).rejects.toEqual(expect.objectContaining({
    name: 'EscrowTransactionVerificationError',
    code,
  }));
}

describe('Privy user-partial and relayer fee-payer flow', () => {
  it('matches deterministic SOL and USDC instruction/message vectors', () => {
    for (const asset of ['sol', 'usdc'] as const) {
      const built = buildSponsoredPositionTransaction(sponsoredOptions(asset));
      const vector = vectors[asset];
      expect(Buffer.from(built.instruction.data).toString('hex')).toBe(vector.instruction_data_hex);
      expect(built.instruction.keys.map((meta) => meta.pubkey.toBase58())).toEqual(vector.accounts);
      expect(createHash('sha256').update(built.transaction.message.serialize()).digest('hex'))
        .toBe(vector.message_sha256);
    }
  });

  it('assembles and verifies a SOL placement signed only by the user', async () => {
    const options = sponsoredOptions('sol');
    const built = buildSponsoredPositionTransaction(options);
    const separatelySigned = buildSponsoredPositionTransaction(options).transaction;
    separatelySigned.sign([USER]);
    const userSignature = separatelySigned.signatures[1];
    if (userSignature === undefined) throw new TypeError('user signature fixture missing');
    applyPartialSignature(built.transaction, USER.publicKey, userSignature);

    expect(messageBytesForPrivy(built.transaction)).toEqual(separatelySigned.message.serialize());
    expect(built.transaction.signatures[0]?.every((byte) => byte === 0)).toBe(true);
    const market = deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey;
    expect(built.instruction.keys[6]?.pubkey.equals(deriveSolVaultPda(PROGRAM_ID, market).publicKey)).toBe(true);
    expect(built.instruction.keys[7]?.pubkey.equals(SystemProgram.programId)).toBe(true);
    await expect(verifySponsoredPositionTransaction(built.transaction, verification(options))).resolves.toBeUndefined();
  });

  it('assembles canonical classic-token source and vault ATAs for USDC', async () => {
    const options = sponsoredOptions('usdc');
    const built = buildSponsoredPositionTransaction(options);
    signUser(built.transaction);
    const market = deriveMarketPda(PROGRAM_ID, MARKET_UUID).publicKey;
    expect(built.instruction.keys[6]?.pubkey.equals(deriveUsdcVaultAddress(market, USDC_MINT))).toBe(true);
    expect(built.instruction.keys[7]?.pubkey.equals(deriveUsdcVaultAddress(USER.publicKey, USDC_MINT))).toBe(true);
    expect(built.instruction.keys[9]?.pubkey.equals(CLASSIC_TOKEN_PROGRAM_ID)).toBe(true);
    await expect(verifySponsoredPositionTransaction(built.transaction, verification(options))).resolves.toBeUndefined();
  });

  it('accepts the relayer signature only after the user has authorized principal movement', async () => {
    const options = sponsoredOptions();
    const built = buildSponsoredPositionTransaction(options);
    built.transaction.sign([USER, RELAYER]);
    await expect(verifySponsoredPositionTransaction(built.transaction, {
      ...verification(options),
      requireRelayerSignature: true,
    })).resolves.toBeUndefined();
  });
});

describe('fail-closed sponsored transaction verification', () => {
  it('rejects a missing or invalid user signature', async () => {
    const options = sponsoredOptions();
    const unsigned = buildSponsoredPositionTransaction(options).transaction;
    await expectCode(verifySponsoredPositionTransaction(unsigned, verification(options)), 'missing_user_signature');
    applyPartialSignature(unsigned, USER.publicKey, new Uint8Array(64).fill(9));
    await expectCode(verifySponsoredPositionTransaction(unsigned, verification(options)), 'invalid_user_signature');
  });

  it('rejects wrong fee payer, program, and network', async () => {
    const options = sponsoredOptions();
    const wrongPayer = { ...options, relayerFeePayer: key(40) };
    const wrongPayerTx = buildSponsoredPositionTransaction(wrongPayer).transaction;
    wrongPayerTx.sign([USER]);
    await expectCode(verifySponsoredPositionTransaction(wrongPayerTx, verification(options)), 'fee_payer_mismatch');

    const wrongProgram = { ...options, programId: key(41) };
    const wrongProgramTx = buildSponsoredPositionTransaction(wrongProgram).transaction;
    wrongProgramTx.sign([USER]);
    await expectCode(verifySponsoredPositionTransaction(wrongProgramTx, verification(options)), 'program_mismatch');
    await expectCode(verifySponsoredPositionTransaction(signUser(buildSponsoredPositionTransaction(options).transaction), {
      ...verification(options), observedGenesisHash: key(42).toBase58(),
    }), 'network_mismatch');
  });

  it('rejects stale intent, stale block height, and substituted blockhash', async () => {
    const options = sponsoredOptions();
    const signed = signUser(buildSponsoredPositionTransaction(options).transaction);
    await expectCode(verifySponsoredPositionTransaction(signed, {
      ...verification(options), currentUnixTimestamp: options.expiresAt + 1n,
    }), 'stale_intent');
    await expectCode(verifySponsoredPositionTransaction(signed, {
      ...verification(options), currentBlockHeight: options.lastValidBlockHeight + 1n,
    }), 'expired_blockhash');
    const changed = { ...options, recentBlockhash: key(43).toBase58() };
    await expectCode(verifySponsoredPositionTransaction(
      signUser(buildSponsoredPositionTransaction(changed).transaction),
      verification(options),
    ), 'message_mismatch');
  });

  it('rejects amount, side, nonce, asset, and canonical mint tampering', async () => {
    const options = sponsoredOptions('usdc');
    const changes: readonly SponsoredPositionBuildOptions[] = [
      { ...options, amount: options.amount + 1n },
      { ...options, side: 'doubt' },
      { ...options, expectedLotNonce: options.expectedLotNonce + 1n },
      { ...options, asset: 'sol' },
      { ...options, canonicalUsdcMint: key(44) },
    ];
    for (const changed of changes) {
      const transaction = signUser(buildSponsoredPositionTransaction(changed).transaction);
      await expectCode(verifySponsoredPositionTransaction(transaction, verification(options)), 'message_mismatch');
    }
  });

  it('rejects alternate vault, source, mint, and token-program accounts', async () => {
    const options = sponsoredOptions('usdc');
    for (const index of [6, 7, 8, 9]) {
      await expectCode(
        verifySponsoredPositionTransaction(tamperedAccountTransaction(options, index), verification(options)),
        'message_mismatch',
      );
    }
  });

  it('rejects a placement that removes the user required-signer bit', async () => {
    const options = sponsoredOptions();
    const built = buildSponsoredPositionTransaction(options);
    const keys = built.instruction.keys.map((meta, index) => index === 3 ? { ...meta, isSigner: false } : meta);
    const instruction = new TransactionInstruction({ programId: PROGRAM_ID, keys, data: built.instruction.data });
    const transaction = buildUnsignedV0Transaction({
      feePayer: options.relayerFeePayer,
      recentBlockhash: options.recentBlockhash,
      instructions: [instruction],
    });
    await expectCode(verifySponsoredPositionTransaction(transaction, verification(options)), 'message_mismatch');
  });

  it('rejects an injected instruction', async () => {
    const options = sponsoredOptions();
    const built = buildSponsoredPositionTransaction(options);
    const transaction = buildUnsignedV0Transaction({
      feePayer: options.relayerFeePayer,
      recentBlockhash: RECENT_BLOCKHASH,
      instructions: [
        built.instruction,
        SystemProgram.transfer({ fromPubkey: USER.publicKey, toPubkey: RELAYER.publicKey, lamports: 1 }),
      ],
    });
    signUser(transaction);
    await expectCode(verifySponsoredPositionTransaction(transaction, verification(options)), 'unexpected_instruction');
  });

  it('uses a typed verification error for callers that must fail closed', () => {
    expect(new EscrowTransactionVerificationError('network_mismatch')).toBeInstanceOf(Error);
    expect(GENESIS_HASH).not.toBe('');
  });
});
