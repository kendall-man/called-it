import { chmod, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { parseRecoveryCli } from './cli.js';
import { loadOwnerKeypair } from './credentials.js';
import { DEVNET_GENESIS_HASH, DEVNET_WRITE_CONSENT } from './recovery.js';

describe('recovery credential boundary', () => {
  it('loads only a matching 0600 JSON keypair file', async () => {
    const keypair = Keypair.generate();
    const path = await keypairFile(keypair, 0o600);
    const loaded = await loadOwnerKeypair(path, keypair.publicKey);
    expect(loaded.publicKey.equals(keypair.publicKey)).toBe(true);
  });

  it('rejects permissive files, symlinks, and owner mismatches without exposing secret bytes', async () => {
    const keypair = Keypair.generate();
    const permissive = await keypairFile(keypair, 0o644);
    await expect(loadOwnerKeypair(permissive, keypair.publicKey)).rejects.toMatchObject({ code: 'credential_permissions' });

    const secure = await keypairFile(keypair, 0o600);
    const link = `${secure}.link`;
    await symlink(secure, link);
    await expect(loadOwnerKeypair(link, keypair.publicKey)).rejects.toMatchObject({ code: 'credential_invalid' });

    let message = '';
    try {
      await loadOwnerKeypair(secure, Keypair.generate().publicKey);
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).not.toContain(JSON.stringify([...keypair.secretKey]));
    expect(message).not.toContain(secure);
  });

  it('defaults to dry-run and accepts no raw-secret command-line option', () => {
    const keypair = Keypair.generate();
    const base = [
      'claim', '--rpc', 'https://api.devnet.solana.com', '--genesis', DEVNET_GENESIS_HASH,
      '--program', Keypair.generate().publicKey.toBase58(), '--usdc-mint', Keypair.generate().publicKey.toBase58(),
      '--market', '4dcb8872-2f1e-4bc5-9b43-1a2b3c4d5e6f', '--owner', keypair.publicKey.toBase58(),
    ];
    expect(parseRecoveryCli(base).submit).toBe(false);
    expect(parseRecoveryCli(['--', ...base]).operation).toBe('claim');
    expect(() => parseRecoveryCli([...base, '--private-key', JSON.stringify([...keypair.secretKey])])).toThrow(/unknown or forbidden/);
    expect(() => parseRecoveryCli([...base, '--keypair', '/tmp/key.json'])).toThrow(/accepted only with --submit/);

    const submitted = parseRecoveryCli([
      ...base,
      '--submit', '--keypair', '/tmp/key.json', '--devnet-write-consent', DEVNET_WRITE_CONSENT,
    ]);
    expect(submitted.submit).toBe(true);
    expect(submitted.keypairPath).toBe('/tmp/key.json');
  });
});

async function keypairFile(keypair: Keypair, mode: number): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'calledit-recovery-'));
  const path = join(directory, 'owner.json');
  await writeFile(path, JSON.stringify([...keypair.secretKey]), { mode: 0o600 });
  await chmod(path, mode);
  return path;
}
