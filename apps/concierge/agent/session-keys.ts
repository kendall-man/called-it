import { hkdfSync } from 'node:crypto';

export const ACCOUNT_JWE_HKDF_LABEL = 'calledit/account-jwe/v1';
export const ACCOUNT_CSRF_HKDF_LABEL = 'calledit/account-csrf/v1';

export type DerivedAccountSessionKey = {
  readonly kid: string;
  readonly jweKey: Uint8Array;
  readonly csrfKey: Uint8Array;
};

export type PreviousAccountSessionKey = DerivedAccountSessionKey & {
  readonly acceptUntilEpochMs: number;
};

export type AccountSessionKeyring = {
  readonly current: DerivedAccountSessionKey;
  readonly previous: PreviousAccountSessionKey | null;
};

export type AccountSessionKeyringMetadata = {
  readonly current: {
    readonly kid: string;
    readonly encrypts: true;
    readonly accepts: true;
  };
  readonly previous: {
    readonly kid: string;
    readonly encrypts: false;
    readonly acceptUntil: string;
  } | null;
};

export function deriveAccountSessionKey(
  master: Uint8Array,
  kid: string,
): DerivedAccountSessionKey {
  const salt = Buffer.alloc(0);
  return {
    kid,
    jweKey: new Uint8Array(
      hkdfSync('sha256', master, salt, ACCOUNT_JWE_HKDF_LABEL, 32),
    ),
    csrfKey: new Uint8Array(
      hkdfSync('sha256', master, salt, ACCOUNT_CSRF_HKDF_LABEL, 32),
    ),
  };
}

export function accountSessionKeyringMetadata(
  keyring: AccountSessionKeyring,
): AccountSessionKeyringMetadata {
  return {
    current: {
      kid: keyring.current.kid,
      encrypts: true,
      accepts: true,
    },
    previous: keyring.previous === null
      ? null
      : {
          kid: keyring.previous.kid,
          encrypts: false,
          acceptUntil: new Date(keyring.previous.acceptUntilEpochMs).toISOString(),
        },
  };
}
