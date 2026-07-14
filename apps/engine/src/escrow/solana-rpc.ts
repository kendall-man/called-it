import { Connection } from '@solana/web3.js';
import type { EscrowRelayChain, EscrowRelaySignatureState } from './relayer-worker.js';

export class EscrowSolanaRpc implements EscrowRelayChain {
  constructor(readonly connection: Connection) {}

  async genesisHash(): Promise<string> {
    return this.connection.getGenesisHash();
  }

  async latestBlockhash(): Promise<{
    readonly blockhash: string;
    readonly lastValidBlockHeight: bigint;
  }> {
    const result = await this.connection.getLatestBlockhash('finalized');
    return { blockhash: result.blockhash, lastValidBlockHeight: BigInt(result.lastValidBlockHeight) };
  }

  async blockHeight(): Promise<bigint> {
    return BigInt(await this.connection.getBlockHeight('finalized'));
  }

  async isBlockhashValid(blockhash: string): Promise<boolean> {
    return (await this.connection.isBlockhashValid(blockhash, { commitment: 'finalized' })).value;
  }

  async broadcast(rawTransactionBase64: string): Promise<string> {
    return this.connection.sendRawTransaction(Buffer.from(rawTransactionBase64, 'base64'), {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
      maxRetries: 0,
    });
  }

  async signatureState(signature: string): Promise<EscrowRelaySignatureState> {
    const result = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = result.value[0];
    if (status === null || status === undefined) return { kind: 'absent' };
    if (status.err !== null) return { kind: 'failed', errorCode: 'transaction_failed' };
    const slot = BigInt(status.slot);
    switch (status.confirmationStatus) {
      case 'finalized':
        return { kind: 'finalized', slot };
      case 'confirmed':
      case 'processed':
      case undefined:
        return { kind: 'confirmed', slot };
    }
  }
}

export function createEscrowSolanaRpc(rpcUrl: string): EscrowSolanaRpc {
  return new EscrowSolanaRpc(new Connection(rpcUrl, 'finalized'));
}
