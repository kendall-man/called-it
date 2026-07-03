/**
 * TxLINE devnet bootstrap — automates the full auth chain (PRD story 48):
 *
 *   1. POST guest auth            → TXLINE_GUEST_JWT
 *   2. devnet SOL balance check   → airdrop if low
 *   3. on-chain txoracle subscribe (TOKEN-2022 TxL mint)
 *   4. wallet-sign the activation message + POST /api/token/activate
 *   5. print TXLINE_GUEST_JWT / TXLINE_API_TOKEN lines ready for .env
 *
 * Run from the repo root:   pnpm bootstrap:txline
 * Config check only:        pnpm bootstrap:txline --check
 *
 * Reads .env at the repo root (SOLANA_KEYPAIR_B58, TXLINE_API_BASE,
 * SOLANA_RPC_URL, TXORACLE_PROGRAM_ID, TXL_MINT); every value has a devnet
 * default. Fails loud with a hint at the exact step that broke.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { resolve } from 'node:path';
import {
  base58Encode,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  loadWallet,
  signActivation,
  subscribeTxline,
} from '../packages/solana/src/index.js';

const DEFAULT_API_BASE = 'https://txline-dev.txodds.com';
const DEFAULT_RPC_URL = 'https://api.devnet.solana.com';
const DEFAULT_PROGRAM_ID = '6pW64gN1s2uqjHkn1unFeEjAwJkPGHoppGvS715wyP2J';
const DEFAULT_TXL_MINT = '4Zao8ocPhmMgq7PdsYWyxvqySMGx7xb9cMftPMkEokRG';

/** Free tier per the TxLINE quickstart; renewable 4-week (28-day) periods. */
const DEFAULT_SERVICE_LEVEL_ID = 1;
const DEFAULT_DURATION_WEEKS = 4;

const MIN_BALANCE_SOL = 0.05;
const AIRDROP_SOL = 1;
const HTTP_TIMEOUT_MS = 20_000;
const ERROR_BODY_PREVIEW_CHARS = 300;

interface BootstrapConfig {
  apiBase: string;
  rpcUrl: string;
  programId: string;
  txlMint: string;
}

// ── console helpers ──────────────────────────────────────────────────────────

const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;

function say(message: string): void {
  console.log(message);
}

async function ask(rl: Interface, question: string, fallback: string): Promise<string> {
  if (!interactive) return fallback;
  const answer = (await rl.question(question)).trim();
  return answer.length > 0 ? answer : fallback;
}

async function runStep<T>(
  label: string,
  hints: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  say(`\n── ${label} ──`);
  try {
    return await work();
  } catch (cause) {
    console.error(`\n✗ ${label} FAILED`);
    console.error(`  ${cause instanceof Error ? cause.message : String(cause)}`);
    for (const hint of hints) console.error(`  hint: ${hint}`);
    process.exit(1);
  }
}

// ── config ───────────────────────────────────────────────────────────────────

function loadRepoDotEnv(): void {
  // pnpm always runs package scripts with cwd = repo root.
  const envPath = resolve(process.cwd(), '.env');
  try {
    process.loadEnvFile(envPath);
    say(`Loaded env from ${envPath}`);
  } catch {
    say(`No .env at ${envPath} — using defaults + existing environment.`);
  }
}

function envOrDefault(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : fallback;
}

function resolveConfig(): BootstrapConfig {
  const config: BootstrapConfig = {
    apiBase: envOrDefault('TXLINE_API_BASE', DEFAULT_API_BASE).replace(/\/+$/, ''),
    rpcUrl: envOrDefault('SOLANA_RPC_URL', DEFAULT_RPC_URL),
    programId: envOrDefault('TXORACLE_PROGRAM_ID', DEFAULT_PROGRAM_ID),
    txlMint: envOrDefault('TXL_MINT', DEFAULT_TXL_MINT),
  };
  say(`TxLINE API base : ${config.apiBase}`);
  say(`Solana RPC      : ${config.rpcUrl}`);
  say(`txoracle program: ${config.programId}`);
  say(`TxL mint (T22)  : ${config.txlMint}`);
  return config;
}

// ── step 1: guest JWT ────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
}

async function startGuestSession(apiBase: string): Promise<string> {
  const url = `${apiBase}/auth/guest/start`;
  const response = await fetchWithTimeout(url, { method: 'POST' });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST ${url} → HTTP ${response.status}: ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  let token: unknown;
  try {
    token = (JSON.parse(body) as { token?: unknown }).token;
  } catch {
    throw new Error(`guest auth returned non-JSON body: ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`);
  }
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `guest auth response is missing "token": ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  say(`Guest JWT issued (${token.length} chars, expires in ~30 days).`);
  return token;
}

// ── step 2: wallet + SOL balance ─────────────────────────────────────────────

async function resolveWallet(rl: Interface): Promise<Keypair> {
  const fromEnv = process.env.SOLANA_KEYPAIR_B58?.trim();
  if (fromEnv) {
    const wallet = loadWallet(fromEnv);
    say(`Using wallet from SOLANA_KEYPAIR_B58: ${wallet.publicKey.toBase58()}`);
    return wallet;
  }
  say('SOLANA_KEYPAIR_B58 is not set.');
  const answer = await ask(rl, 'Generate a fresh devnet hot wallet now? [Y/n] ', 'y');
  if (!/^y/i.test(answer)) {
    throw new Error('aborted — set SOLANA_KEYPAIR_B58 in .env and re-run');
  }
  const wallet = Keypair.generate();
  say(`Generated wallet ${wallet.publicKey.toBase58()}`);
  say('Save this secret in .env NOW (devnet only, never reuse on mainnet):');
  say(`\n  SOLANA_KEYPAIR_B58=${base58Encode(wallet.secretKey)}\n`);
  return wallet;
}

async function ensureSolBalance(connection: Connection, wallet: Keypair): Promise<void> {
  const balance = await connection.getBalance(wallet.publicKey);
  say(`Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  if (balance >= MIN_BALANCE_SOL * LAMPORTS_PER_SOL) return;
  say(`Below ${MIN_BALANCE_SOL} SOL — requesting a ${AIRDROP_SOL} SOL devnet airdrop…`);
  const signature = await connection.requestAirdrop(
    wallet.publicKey,
    AIRDROP_SOL * LAMPORTS_PER_SOL,
  );
  const latest = await connection.getLatestBlockhash('confirmed');
  await connection.confirmTransaction({ signature, ...latest }, 'confirmed');
  const after = await connection.getBalance(wallet.publicKey);
  say(`Airdrop confirmed. New balance: ${(after / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
}

// ── step 3: on-chain subscribe ───────────────────────────────────────────────

async function promptSubscription(
  rl: Interface,
): Promise<{ serviceLevelId: number; weeks: number; leagues: number[] }> {
  const levelAnswer = await ask(
    rl,
    `Service level id [${DEFAULT_SERVICE_LEVEL_ID} = free tier]: `,
    String(DEFAULT_SERVICE_LEVEL_ID),
  );
  const weeksAnswer = await ask(
    rl,
    `Duration in weeks (4-week multiples) [${DEFAULT_DURATION_WEEKS}]: `,
    String(DEFAULT_DURATION_WEEKS),
  );
  const leaguesAnswer = await ask(
    rl,
    'League ids, comma-separated (blank = standard/free tier, no custom leagues): ',
    '',
  );
  const serviceLevelId = Number.parseInt(levelAnswer, 10);
  const weeks = Number.parseInt(weeksAnswer, 10);
  if (Number.isNaN(serviceLevelId) || Number.isNaN(weeks)) {
    throw new Error(`service level and weeks must be integers (got "${levelAnswer}", "${weeksAnswer}")`);
  }
  const leagues = leaguesAnswer
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const league = Number.parseInt(part, 10);
      if (Number.isNaN(league)) throw new Error(`league id "${part}" is not an integer`);
      return league;
    });
  return { serviceLevelId, weeks, leagues };
}

// ── step 4: token activation ─────────────────────────────────────────────────

async function activateApiToken(
  apiBase: string,
  jwt: string,
  txSig: string,
  walletSignature: string,
  leagues: readonly number[],
): Promise<string> {
  const url = `${apiBase}/api/token/activate`;
  const response = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ txSig, walletSignature, leagues }),
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `POST ${url} → HTTP ${response.status}: ${body.slice(0, ERROR_BODY_PREVIEW_CHARS)}`,
    );
  }
  // The spec returns the token as text/plain; tolerate a JSON-quoted string.
  let token = body.trim();
  if (token.startsWith('"')) {
    try {
      token = String(JSON.parse(token));
    } catch {
      // keep the raw trimmed body
    }
  }
  if (token.length === 0) throw new Error('activation returned an empty token body');
  return token;
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  say('TxLINE devnet bootstrap — guest JWT → SOL top-up → subscribe → activate');
  if (!interactive) say('(no TTY detected — running non-interactively with defaults)');

  loadRepoDotEnv();
  const config = resolveConfig();
  if (process.argv.includes('--check')) {
    say('\n--check passed: config resolves. No network calls made.');
    return;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const jwt = await runStep(
      'Step 1/4 — TxLINE guest session',
      [
        `is ${config.apiBase} reachable from this machine?`,
        'TXLINE_API_BASE must point at the DEVNET host (txline-dev), not production',
      ],
      () => startGuestSession(config.apiBase),
    );

    const connection = new Connection(config.rpcUrl, 'confirmed');
    const wallet = await runStep(
      'Step 2/4 — devnet wallet + SOL',
      [
        'check SOLANA_KEYPAIR_B58 in .env (base58 secret key, devnet only)',
        'devnet airdrops rate-limit aggressively — grab SOL at https://faucet.solana.com and re-run',
      ],
      async () => {
        const resolved = await resolveWallet(rl);
        await ensureSolBalance(connection, resolved);
        return resolved;
      },
    );

    const { txSig, leagues } = await runStep(
      'Step 3/4 — on-chain txoracle subscribe',
      [
        'if the wallet has 0 SOL the transaction cannot pay fees (re-run step 2 hints)',
        'if the error mentions a missing/invalid service level, the tier may not exist on devnet — read the pricing_matrix or ask in t.me/TxLINEChat',
        'paid tiers also need TxL (TOKEN-2022) in the wallet ATA; the free tier does not',
      ],
      async () => {
        const choice = await promptSubscription(rl);
        say(
          `Subscribing: serviceLevelId=${choice.serviceLevelId}, weeks=${choice.weeks}, leagues=[${choice.leagues.join(',')}]`,
        );
        const signature = await subscribeTxline(
          connection,
          wallet,
          config.programId,
          config.txlMint,
          choice.serviceLevelId,
          choice.weeks,
        );
        say(`Subscribe tx: ${signature}`);
        say(`Explorer: https://explorer.solana.com/tx/${signature}?cluster=devnet`);
        return { txSig: signature, leagues: choice.leagues };
      },
    );

    const apiToken = await runStep(
      'Step 4/4 — wallet-signed token activation',
      [
        'HTTP 401 → the guest JWT expired or the wrong JWT was used; re-run to mint a fresh one',
        'HTTP 403 → signature/leagues mismatch: leagues must exactly match the subscription tier',
        'the subscribe tx may need a few seconds to finalize — wait and re-run (the tx is not lost)',
      ],
      async () => {
        const walletSignature = signActivation(wallet, txSig, leagues, jwt);
        return activateApiToken(config.apiBase, jwt, txSig, walletSignature, leagues);
      },
    );

    say('\n✓ Bootstrap complete. Paste these into .env:');
    say('');
    say(`TXLINE_GUEST_JWT=${jwt}`);
    say(`TXLINE_API_TOKEN=${apiToken}`);
    say('');
    say('Both headers are required on data calls: Authorization: Bearer <jwt> AND X-Api-Token.');
    say('The guest JWT expires in ~30 days; the subscription renews in 4-week periods.');
  } finally {
    rl.close();
  }
}

// No top-level await: the repo root is CJS-scoped (no "type": "module").
main().catch((cause: unknown) => {
  console.error('\n✗ bootstrap failed unexpectedly:');
  console.error(cause);
  process.exit(1);
});
