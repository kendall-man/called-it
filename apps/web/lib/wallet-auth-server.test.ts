import { generateKeyPairSync } from 'node:crypto';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import { signWalletAuthJwt } from './wallet-auth-server';

describe('wallet custom-auth JWT', () => {
  it('signs a short-lived ES256 identity bound to app, origin, network, and Telegram user', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const privateKeyBase64 = privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
    const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const expiresAt = Date.now() + 60_000;
    const jwt = await signWalletAuthJwt({
      appId: 'clp_123456789012345678901',
      issuer: 'https://called-it.example',
      keyId: 'calledit-wallet-v1',
      network: 'devnet',
      privateKeyBase64,
    }, {
      userId: 123_456_789,
      expiresAt,
    });

    expect(decodeProtectedHeader(jwt)).toMatchObject({
      alg: 'ES256',
      kid: 'calledit-wallet-v1',
      typ: 'JWT',
    });
    const verificationKey = await importSPKI(publicKeyPem, 'ES256');
    const verified = await jwtVerify(jwt, verificationKey, {
      audience: 'clp_123456789012345678901',
      issuer: 'https://called-it.example',
    });
    expect(verified.payload.sub).toBe('calledit:devnet:telegram:123456789');
    expect(verified.payload.exp).toBe(Math.floor(expiresAt / 1_000));
    expect(verified.payload.jti).toEqual(expect.any(String));
  });
});
