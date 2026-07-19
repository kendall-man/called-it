import {
  createPrivateKey,
  sign as signBytes,
  timingSafeEqual,
} from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Keypair } from '@solana/web3.js';
import {
  journalKey,
  parseOracleSigningEnvelope,
  terminalSemanticDecisionHash,
  type OracleSigningEnvelope,
} from './contracts.js';
import type { OracleSignatureJournal } from './journal.js';
import type { OracleReadinessProbe } from './readiness.js';
import type { OracleAttestationVerifier } from './verifier.js';

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const MAX_BODY_BYTES = 64 * 1024;

function authorized(request: IncomingMessage, expected: string): boolean {
  const value = request.headers.authorization;
  const supplied = typeof value === 'string' && value.startsWith('Bearer ')
    ? value.slice('Bearer '.length)
    : '';
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  const encoded = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(encoded),
  });
  response.end(encoded);
}

function sign(message: Uint8Array, signer: Keypair): string {
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, Buffer.from(signer.secretKey.subarray(0, 32))]),
    format: 'der', type: 'pkcs8',
  });
  return signBytes(null, message, privateKey).toString('base64');
}

export function createOracleSignerServer(options: {
  readonly bearerToken: string;
  readonly signer: Keypair;
  readonly verifier: Pick<OracleAttestationVerifier, 'verify'>;
  readonly journal: Pick<OracleSignatureJournal, 'record'>;
  readonly readiness: OracleReadinessProbe;
  readonly now?: () => Date;
  readonly log?: (event: string, context?: Readonly<Record<string, unknown>>) => void;
}) {
  const log = options.log ?? (() => undefined);
  return createServer(async (request, response) => {
    if (request.url === '/api/live' && request.method === 'GET') {
      reply(response, 200, { status: 'live' });
      return;
    }
    if (request.url === '/api/ready' && request.method === 'GET') {
      try {
        const reasons = await options.readiness.check();
        if (reasons.length > 0) {
          reply(response, 503, { status: 'not_ready', reasons });
        } else {
          reply(response, 200, {
            status: 'ready',
            signerPubkey: options.signer.publicKey.toBase58(),
          });
        }
      } catch {
        reply(response, 503, { status: 'not_ready', reasons: ['readiness_check_failed'] });
      }
      return;
    }
    if (request.url !== '/sign' || (request.method !== 'GET' && request.method !== 'POST')) {
      reply(response, 404, { error: 'not_found' });
      return;
    }
    if (!authorized(request, options.bearerToken)) {
      reply(response, 401, { error: 'unauthorized' });
      return;
    }
    if (request.method === 'GET') {
      reply(response, 200, { schemaVersion: 1, signerPubkey: options.signer.publicKey.toBase58() });
      return;
    }

    try {
      const reasons = await options.readiness.check();
      if (reasons.length > 0) {
        reply(response, 503, { error: 'signer_not_ready', reasons });
        return;
      }
    } catch {
      reply(response, 503, { error: 'signer_not_ready', reasons: ['readiness_check_failed'] });
      return;
    }

    let envelope: OracleSigningEnvelope | null = null;
    try {
      const parsed = parseOracleSigningEnvelope(await body(request));
      envelope = parsed.envelope;
      await options.verifier.verify(parsed.request, parsed.envelope.claimSpecificationJson);
      await options.journal.record(
        journalKey(parsed.request),
        parsed.request.kind === 'settlement' || parsed.request.kind === 'void'
          ? terminalSemanticDecisionHash(parsed.request)
          : parsed.envelope.canonicalSha256Hex,
        options.now?.() ?? new Date(),
      );
      const signatureBase64 = sign(parsed.canonicalBytes, options.signer);
      reply(response, 200, {
        ...parsed.envelope,
        signerPubkey: options.signer.publicKey.toBase58(),
        signatureBase64,
      });
      log('oracle_attestation_signed', {
        kind: parsed.envelope.kind,
        marketPdaHex: parsed.envelope.marketPdaHex,
        canonicalSha256Hex: parsed.envelope.canonicalSha256Hex,
      });
    } catch (error) {
      log('oracle_attestation_rejected', {
        kind: envelope?.kind ?? null,
        marketPdaHex: envelope?.marketPdaHex ?? null,
        error: error instanceof Error ? error.message : 'unknown',
      });
      reply(response, 422, { error: 'attestation_rejected' });
    }
  });
}
