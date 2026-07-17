/**
 * Staging key bootstrap: generates the two DISTINCT devnet keypairs the
 * engine requires (env validation refuses to boot if they match), airdrops
 * devnet SOL into the wager treasury, and prints ready-to-paste .env lines.
 *
 * Run from the worktree root:   pnpm staging:keys
 *
 * Secrets are printed to YOUR terminal only — paste them into the worktree's
 * git-ignored .env and nowhere else.
 */

// Deliberately NOT importing from packages/solana's index: that pulls in
// txoracle.ts, whose @coral-xyz/anchor default-import breaks under tsx's CJS
// transform. This script only needs web3 primitives + base58.
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { base58Encode } from '../packages/solana/src/codecs.js';

const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const TREASURY_AIRDROP_SOL = 2;
const AIRDROP_CONFIRM_POLL_MS = 2_000;
const AIRDROP_CONFIRM_ATTEMPTS = 15;

async function tryAirdrop(connection: Connection, pubkey: Keypair['publicKey']): Promise<boolean> {
  try {
    const signature = await connection.requestAirdrop(
      pubkey,
      TREASURY_AIRDROP_SOL * LAMPORTS_PER_SOL,
    );
    for (let attempt = 0; attempt < AIRDROP_CONFIRM_ATTEMPTS; attempt += 1) {
      const status = await connection.getSignatureStatuses([signature]);
      const confirmation = status.value[0]?.confirmationStatus;
      if (confirmation === 'confirmed' || confirmation === 'finalized') return true;
      await new Promise((resolve) => setTimeout(resolve, AIRDROP_CONFIRM_POLL_MS));
    }
    return false;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? DEFAULT_RPC_URL;
  const connection = new Connection(rpcUrl, 'confirmed');

  const proofWallet = Keypair.generate();
  const treasury = Keypair.generate();

  console.log('\n── Staging keypairs (devnet only) ──────────────────────────');
  console.log('\n# paste into the worktree .env:');
  console.log(`SOLANA_KEYPAIR_B58=${base58Encode(proofWallet.secretKey)}`);
  console.log(`WAGER_TREASURY_KEYPAIR_B58=${base58Encode(treasury.secretKey)}`);
  console.log('\n# public keys (for explorers/faucets):');
  console.log(`# proof wallet:   ${proofWallet.publicKey.toBase58()}`);
  console.log(`# treasury:       ${treasury.publicKey.toBase58()}`);

  console.log(`\nRequesting ${TREASURY_AIRDROP_SOL} devnet SOL airdrop for the treasury…`);
  const airdropped = await tryAirdrop(connection, treasury.publicKey);
  if (airdropped) {
    const balance = await connection.getBalance(treasury.publicKey, 'confirmed');
    console.log(`✓ treasury funded: ${balance / LAMPORTS_PER_SOL} SOL`);
  } else {
    console.log(
      '✗ airdrop failed or timed out (devnet faucet is rate-limited).\n' +
        `  Fund it manually: https://faucet.solana.com → ${treasury.publicKey.toBase58()}`,
    );
  }
  console.log(
    '\nGroup members deposit by sending devnet SOL to the treasury address\n' +
      'after linking their wallet in the group — see STAGING.md.\n',
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
