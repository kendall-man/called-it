import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { JsonRpcReader } from './release.js';
import { EscrowControlError, EXIT } from './types.js';
import { encodeBase58 } from './util.js';

function key(byte: number): string {
  return encodeBase58(Buffer.alloc(32, byte));
}

function transactionResult(): Record<string, unknown> {
  return {
    slot: 42,
    blockTime: 1_786_000_000,
    meta: {
      err: null,
      loadedAddresses: {
        writable: [key(4)],
        readonly: [key(5)],
      },
      preBalances: [100, 200, 300, 400, 500],
      postBalances: [90, 200, 300, 410, 500],
      preTokenBalances: [{
        accountIndex: 3,
        mint: key(6),
        uiTokenAmount: { amount: '7', decimals: 6, uiAmount: 0.000007, uiAmountString: '0.000007' },
      }],
      postTokenBalances: [{
        accountIndex: 3,
        mint: key(6),
        uiTokenAmount: { amount: '17', decimals: 6, uiAmount: 0.000017, uiAmountString: '0.000017' },
      }],
    },
    transaction: {
      message: {
        accountKeys: [key(1), key(2), key(3)],
        instructions: [{
          programIdIndex: 2,
          accounts: [0, 3, 4],
          data: encodeBase58(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
        }],
      },
    },
  };
}

async function readResult(result: unknown): Promise<Awaited<ReturnType<JsonRpcReader['finalizedTransaction']>>> {
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as { method?: unknown; params?: unknown };
      assert.equal(payload.method, 'getTransaction');
      assert.deepEqual(payload.params, [
        'test-signature',
        { commitment: 'finalized', encoding: 'json', maxSupportedTransactionVersion: 0 },
      ]);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('test RPC did not bind a TCP port');
  try {
    return await new JsonRpcReader(`http://127.0.0.1:${address.port}`).finalizedTransaction('test-signature');
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
  }
}

test('JsonRpcReader resolves v0 transaction accounts and effects', async () => {
  // Given a finalized v0 transaction with writable and readonly lookup-table accounts.
  const result = transactionResult();

  // When the RPC producer normalizes the transaction.
  const transaction = await readResult(result);

  // Then every index-based field is resolved against the canonical account order.
  assert.deepEqual(transaction, {
    slot: 42,
    blockTime: 1_786_000_000,
    accountKeys: [key(1), key(2), key(3), key(4), key(5)],
    instructions: [{
      programId: key(3),
      accounts: [key(1), key(4), key(5)],
      data: encodeBase58(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])),
    }],
    preBalances: [100, 200, 300, 400, 500],
    postBalances: [90, 200, 300, 410, 500],
    preTokenBalances: [{ account: key(4), mint: key(6), amount: '7' }],
    postTokenBalances: [{ account: key(4), mint: key(6), amount: '17' }],
  });
});

test('JsonRpcReader rejects malformed or index-mismatched transaction responses', async (context) => {
  const cases: ReadonlyArray<{
    readonly name: string;
    readonly mutate: (result: Record<string, unknown>) => void;
  }> = [
    {
      name: 'duplicate loaded account key',
      mutate: (result) => {
        const meta = result.meta as { loadedAddresses: { readonly: string[] } };
        meta.loadedAddresses.readonly = [key(1)];
      },
    },
    {
      name: 'instruction program index outside resolved keys',
      mutate: (result) => {
        const transaction = result.transaction as { message: { instructions: Array<{ programIdIndex: number }> } };
        const instruction = transaction.message.instructions[0];
        if (instruction === undefined) throw new Error('instruction fixture is missing');
        instruction.programIdIndex = 5;
      },
    },
    {
      name: 'instruction account index outside resolved keys',
      mutate: (result) => {
        const transaction = result.transaction as { message: { instructions: Array<{ accounts: number[] }> } };
        const instruction = transaction.message.instructions[0];
        if (instruction === undefined) throw new Error('instruction fixture is missing');
        instruction.accounts = [0, 3, 5];
      },
    },
    {
      name: 'invalid instruction base58 data',
      mutate: (result) => {
        const transaction = result.transaction as { message: { instructions: Array<{ data: string }> } };
        const instruction = transaction.message.instructions[0];
        if (instruction === undefined) throw new Error('instruction fixture is missing');
        instruction.data = '0OIl';
      },
    },
    {
      name: 'lamport balance count differs from resolved keys',
      mutate: (result) => {
        const meta = result.meta as { postBalances: number[] };
        meta.postBalances = [90, 200, 300, 410];
      },
    },
    {
      name: 'token account index outside resolved keys',
      mutate: (result) => {
        const meta = result.meta as { preTokenBalances: Array<{ accountIndex: number }> };
        const balance = meta.preTokenBalances[0];
        if (balance === undefined) throw new Error('token balance fixture is missing');
        balance.accountIndex = 5;
      },
    },
    {
      name: 'token amount is not an atomic decimal string',
      mutate: (result) => {
        const meta = result.meta as { preTokenBalances: Array<{ uiTokenAmount: { amount: string } }> };
        const balance = meta.preTokenBalances[0];
        if (balance === undefined) throw new Error('token balance fixture is missing');
        balance.uiTokenAmount.amount = '7.0';
      },
    },
  ];

  for (const item of cases) {
    await context.test(item.name, async () => {
      // Given an otherwise valid response with one adversarial mutation.
      const result = transactionResult();
      item.mutate(result);

      // When the RPC producer parses the response, then it fails closed.
      await assert.rejects(readResult(result), (error: unknown) => (
        error instanceof EscrowControlError && error.exitCode === EXIT.mismatch
      ));
    });
  }
});
