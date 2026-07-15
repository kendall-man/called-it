import { loadOracleSignerEnv } from './env.js';
import { OracleSignatureJournal } from './journal.js';
import { createOracleSignerServer } from './server.js';
import {
  createOracleChainReader,
  createOracleFeedReader,
  OracleAttestationVerifier,
} from './verifier.js';

function log(event: string, context: Readonly<Record<string, unknown>> = {}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), app: 'calledit-oracle-signer', event, ...context,
  }));
}

const env = loadOracleSignerEnv();
const journal = await OracleSignatureJournal.open(env.ORACLE_SIGNER_JOURNAL_PATH);
const verifier = new OracleAttestationVerifier({
  env,
  chain: createOracleChainReader(env),
  feed: createOracleFeedReader(env),
});
const server = createOracleSignerServer({
  bearerToken: env.ORACLE_SIGNER_BEARER_TOKEN,
  signer: env.signer,
  verifier,
  journal,
  log,
});
server.listen(env.PORT, '0.0.0.0', () => {
  log('oracle_signer_up', {
    port: env.PORT,
    network: env.ORACLE_SIGNER_NETWORK,
    signerPubkey: env.signer.publicKey.toBase58(),
  });
});
