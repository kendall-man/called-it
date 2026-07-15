import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Connection, PublicKey } from '@solana/web3.js';
import { ScenarioTimeoutError } from './errors.js';

const RPC_PORT = 18_999;
const FAUCET_PORT = 19_900;
const PROGRAM_ID = 'HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL';
const AUTHORITY = '9c4TwBc9Gx55VNiu1XPQXey5Y2t58LgJ9fU5vagCPzJV';
const PROGRAM_KEYPAIR = '/private/tmp/calledit-beta-secrets/calledit_escrow-devnet-keypair.json';
const PROGRAM_ARTIFACT = '/private/tmp/calledit-beta-artifacts/calledit_escrow.so';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

async function existingPath(path: string): Promise<string | undefined> {
  try {
    await access(path);
    return path;
  } catch {
    return undefined;
  }
}

async function resolveSbfArtifact(input: {
  readonly environmentName: string;
  readonly fileName: string;
}): Promise<string> {
  const override = process.env[input.environmentName];
  if (override !== undefined) {
    const path = await existingPath(resolve(override));
    if (path !== undefined) return path;
    throw new ScenarioTimeoutError(`${input.environmentName} does not reference a readable file`);
  }
  const registryRoot = join(homedir(), '.cargo', 'registry', 'src');
  const registries = await readdir(registryRoot, { withFileTypes: true });
  for (const registry of registries.filter((entry) => entry.isDirectory())) {
    const registryPath = join(registryRoot, registry.name);
    const packages = await readdir(registryPath, { withFileTypes: true });
    for (const packageEntry of packages
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('litesvm-'))
      .sort((left, right) => right.name.localeCompare(left.name))) {
      const path = await existingPath(join(registryPath, packageEntry.name, 'src', 'programs', 'elf', input.fileName));
      if (path !== undefined) return path;
    }
  }
  throw new ScenarioTimeoutError(`offline SBF artifact ${input.fileName} is unavailable`);
}

async function assertPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close((error) => error === undefined ? resolvePromise() : reject(error)));
  });
}

async function waitForValidator(rpcUrl: string, child: ChildProcess): Promise<void> {
  const rpc = new Connection(rpcUrl, 'finalized');
  const deadline = Date.now() + 30_000;
  const requiredPrograms = [PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID].map(
    (address) => new PublicKey(address),
  );
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new ScenarioTimeoutError('validator process exited during startup');
    try {
      await rpc.getVersion();
      const [slot, ...programs] = await Promise.all([
        rpc.getSlot('finalized'),
        ...requiredPrograms.map((address) => rpc.getAccountInfo(address, 'finalized')),
      ]);
      if (slot >= 2 && programs.every((program) => program?.executable === true)) return;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 200));
    }
  }
  throw new ScenarioTimeoutError('isolated validator startup');
}

async function stopProcessGroup(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return;
    throw error;
  }
  const closed = await Promise.race([
    new Promise<boolean>((resolvePromise) => child.once('close', () => resolvePromise(true))),
    new Promise<boolean>((resolvePromise) => setTimeout(() => resolvePromise(false), 5_000)),
  ]);
  if (!closed) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  }
}

async function runScenario(rpcUrl: string): Promise<number> {
  const vitest = resolve(process.cwd(), 'node_modules/.bin/vitest');
  const child = spawn(vitest, [
    'run', '--testTimeout=300000', 'test/local-validator.integration.test.ts',
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ESCROW_LOCAL_RPC_URL: rpcUrl, ESCROW_PROGRAM_ID: PROGRAM_ID },
    stdio: 'inherit',
  });
  return new Promise<number>((resolvePromise, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolvePromise(code ?? 1));
  });
}

async function main(): Promise<void> {
  await Promise.all([assertPortAvailable(RPC_PORT), assertPortAvailable(FAUCET_PORT)]);
  const [tokenProgram, associatedTokenProgram] = await Promise.all([
    resolveSbfArtifact({ environmentName: 'SPL_TOKEN_PROGRAM_ARTIFACT', fileName: 'spl_token-3.5.0.so' }),
    resolveSbfArtifact({
      environmentName: 'SPL_ASSOCIATED_TOKEN_PROGRAM_ARTIFACT',
      fileName: 'spl_associated_token_account-1.1.1.so',
    }),
  ]);
  const ledger = await mkdtemp(`${tmpdir()}/calledit-escrow-integration-`);
  const rpcUrl = `http://127.0.0.1:${RPC_PORT}`;
  const validator = spawn('solana-test-validator', [
    '--reset', '--ledger', ledger,
    '--rpc-port', String(RPC_PORT), '--faucet-port', String(FAUCET_PORT),
    '--limit-ledger-size', '1000',
    '--ticks-per-slot', '8',
    '--bpf-program', TOKEN_PROGRAM_ID, tokenProgram,
    '--bpf-program', ASSOCIATED_TOKEN_PROGRAM_ID, associatedTokenProgram,
    '--upgradeable-program', PROGRAM_KEYPAIR, PROGRAM_ARTIFACT, AUTHORITY,
    '--quiet',
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const logs: string[] = [];
  const retain = (chunk: Buffer): void => {
    logs.push(chunk.toString('utf8'));
    if (logs.length > 80) logs.shift();
  };
  validator.stdout?.on('data', retain);
  validator.stderr?.on('data', retain);
  try {
    await waitForValidator(rpcUrl, validator);
    const exitCode = await runScenario(rpcUrl);
    if (exitCode !== 0) process.exitCode = exitCode;
  } catch (error) {
    if (error instanceof Error) {
      process.stderr.write(`${error.message}\n${logs.join('')}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  } finally {
    try {
      await stopProcessGroup(validator);
    } finally {
      await rm(ledger, { recursive: true, force: true });
    }
  }
}

await main();
