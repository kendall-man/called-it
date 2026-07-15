import { afterEach, describe, expect, it } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { createOracleSignerServer } from './server.js';

const servers: Array<ReturnType<typeof createOracleSignerServer>> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
  })));
});

describe('oracle signer readiness', () => {
  it('reports process readiness without exposing credentials', async () => {
    const signer = Keypair.generate();
    const server = createOracleSignerServer({
      bearerToken: 'not-returned',
      signer,
      verifier: { verify: async () => undefined },
      journal: { record: async () => undefined },
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('test server did not bind');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ready',
      signerPubkey: signer.publicKey.toBase58(),
    });
  });
});
