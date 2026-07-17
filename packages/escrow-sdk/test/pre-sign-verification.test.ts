import {
  AddressLookupTableAccount,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction as SolanaInstruction,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import {
  applyPartialSignature,
  buildSponsoredPositionTransaction,
  buildUnsignedV0Transaction,
  type SponsoredPositionBuildOptions,
} from '../src/transactions.js';
import {
  verifySponsoredPositionTransactionBeforeUserSigning,
  type SponsoredPositionPreSignVerificationOptions,
} from '../src/verification.js';
import {
  PROGRAM_ID,
  RELAYER,
  USER,
  hash,
  key,
  keypair,
  sponsoredOptions,
} from './fixtures.js';

function verification(options: SponsoredPositionBuildOptions): SponsoredPositionPreSignVerificationOptions {
  return {
    ...options,
    expectedGenesisHash: options.genesisHash,
    observedGenesisHash: options.genesisHash,
    currentBlockHeight: options.lastValidBlockHeight - 1n,
    currentUnixTimestamp: options.expiresAt - 1n,
  };
}

function sponsor(transaction: VersionedTransaction): VersionedTransaction {
  transaction.sign([RELAYER]);
  return transaction;
}

function sponsoredInstructionTransaction(
  options: SponsoredPositionBuildOptions,
  instruction: SolanaInstruction,
): VersionedTransaction {
  return sponsor(buildUnsignedV0Transaction({
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

describe('browser pre-sign sponsored position verification', () => {
  it('accepts an exact sponsor-signed message with an empty user signature slot', async () => {
    const options = sponsoredOptions('usdc');
    const built = buildSponsoredPositionTransaction(options);
    built.transaction.sign([RELAYER]);
    await expect(verifySponsoredPositionTransactionBeforeUserSigning(
      built.transaction,
      verification(options),
    )).resolves.toBeUndefined();
    expect(built.transaction.signatures[1]?.every((byte) => byte === 0)).toBe(true);
  });

  it('rejects an injected transaction instruction', async () => {
    const options = sponsoredOptions();
    const built = buildSponsoredPositionTransaction(options);
    const transaction = sponsor(buildUnsignedV0Transaction({
      feePayer: options.relayerFeePayer,
      recentBlockhash: options.recentBlockhash,
      instructions: [
        built.instruction,
        SystemProgram.transfer({ fromPubkey: USER.publicKey, toPubkey: RELAYER.publicKey, lamports: 1 }),
      ],
    }));
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(transaction, verification(options)),
      'unexpected_instruction',
    );
  });

  it('rejects account and instruction-data tampering', async () => {
    const options = sponsoredOptions('usdc');
    const built = buildSponsoredPositionTransaction(options);
    const keys = built.instruction.keys.map((meta, index) => index === 6
      ? { ...meta, pubkey: key(50) }
      : meta);
    const accountInstruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data: built.instruction.data,
    });
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(
      sponsoredInstructionTransaction(options, accountInstruction),
      verification(options),
    ), 'message_mismatch');

    const data = Buffer.from(built.instruction.data);
    data[data.length - 1] = (data[data.length - 1] ?? 0) ^ 1;
    const dataInstruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys: built.instruction.keys,
      data,
    });
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(
      sponsoredInstructionTransaction(options, dataInstruction),
      verification(options),
    ), 'message_mismatch');
  });

  it('rejects asset, amount, epoch, and market-document hash tampering', async () => {
    const options = sponsoredOptions('usdc');
    const changes: readonly SponsoredPositionBuildOptions[] = [
      { ...options, asset: 'sol' },
      { ...options, amount: options.amount + 1n },
      { ...options, expectedEventEpoch: options.expectedEventEpoch + 1n },
      { ...options, marketDocumentHash: hash(61) },
    ];
    for (const changed of changes) {
      const transaction = buildSponsoredPositionTransaction(changed).transaction;
      sponsor(transaction);
      await expectCode(
        verifySponsoredPositionTransactionBeforeUserSigning(transaction, verification(options)),
        'message_mismatch',
      );
    }
  });

  it('rejects fee-payer and recent-blockhash tampering', async () => {
    const options = sponsoredOptions();
    const alternateRelayer = keypair(62);
    const changedPayer = { ...options, relayerFeePayer: alternateRelayer.publicKey };
    const payerTransaction = buildSponsoredPositionTransaction(changedPayer).transaction;
    payerTransaction.sign([alternateRelayer]);
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(payerTransaction, verification(options)),
      'fee_payer_mismatch',
    );

    const changedBlockhash = { ...options, recentBlockhash: key(63).toBase58() };
    const blockhashTransaction = buildSponsoredPositionTransaction(changedBlockhash).transaction;
    sponsor(blockhashTransaction);
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(blockhashTransaction, verification(options)),
      'message_mismatch',
    );
  });

  it('rejects program-ID and required-user-signer tampering', async () => {
    const options = sponsoredOptions();
    const wrongProgram = { ...options, programId: key(67) };
    const programTransaction = buildSponsoredPositionTransaction(wrongProgram).transaction;
    sponsor(programTransaction);
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(programTransaction, verification(options)),
      'program_mismatch',
    );

    const built = buildSponsoredPositionTransaction(options);
    const keys = built.instruction.keys.map((meta, index) => index === 3
      ? { ...meta, isSigner: false }
      : meta);
    const instruction = new TransactionInstruction({
      programId: PROGRAM_ID,
      keys,
      data: built.instruction.data,
    });
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(
      sponsoredInstructionTransaction(options, instruction),
      verification(options),
    ), 'message_mismatch');
  });

  it('rejects a missing or invalid sponsor signature', async () => {
    const options = sponsoredOptions();
    const missing = buildSponsoredPositionTransaction(options).transaction;
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(missing, verification(options)),
      'missing_relayer_signature',
    );
    applyPartialSignature(missing, RELAYER.publicKey, new Uint8Array(64).fill(7));
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(missing, verification(options)),
      'invalid_relayer_signature',
    );
  });

  it('rejects a prefilled user signature slot', async () => {
    const options = sponsoredOptions();
    const transaction = buildSponsoredPositionTransaction(options).transaction;
    transaction.sign([RELAYER, USER]);
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(transaction, verification(options)),
      'unexpected_user_signature',
    );
  });

  it('rejects wrong genesis, expired block height, and stale intent expiry', async () => {
    const options = sponsoredOptions();
    const transaction = sponsor(buildSponsoredPositionTransaction(options).transaction);
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
      ...verification(options),
      observedGenesisHash: key(64).toBase58(),
    }), 'network_mismatch');
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
      ...verification(options),
      currentBlockHeight: options.lastValidBlockHeight + 1n,
    }), 'expired_blockhash');
    await expectCode(verifySponsoredPositionTransactionBeforeUserSigning(transaction, {
      ...verification(options),
      currentUnixTimestamp: options.expiresAt + 1n,
    }), 'stale_intent');
  });

  it('rejects address lookup tables before inspecting signatures', async () => {
    const options = sponsoredOptions();
    const built = buildSponsoredPositionTransaction(options);
    const lookup = new AddressLookupTableAccount({
      key: key(65),
      state: {
        deactivationSlot: (1n << 64n) - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        authority: undefined,
        addresses: [built.instruction.keys[0]?.pubkey ?? key(66)],
      },
    });
    const message = new TransactionMessage({
      payerKey: RELAYER.publicKey,
      recentBlockhash: options.recentBlockhash,
      instructions: [built.instruction],
    }).compileToV0Message([lookup]);
    const transaction = sponsor(new VersionedTransaction(message));
    await expectCode(
      verifySponsoredPositionTransactionBeforeUserSigning(transaction, verification(options)),
      'lookup_table_forbidden',
    );
  });
});
