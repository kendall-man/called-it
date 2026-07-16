const WALLET_SESSION_TOKEN = /^[A-Za-z0-9_-]{43}$/;

type WalletLocation = {
  readonly pathname: string;
  readonly search: string;
};

export function walletSessionTokenFromLocation(location: WalletLocation): string | null {
  const pathToken = location.pathname.match(/^\/wallet\/([A-Za-z0-9_-]{43})\/?$/)?.[1];
  if (pathToken !== undefined) return pathToken;

  // Keep query support for links already issued during the rollout.
  const queryToken = new URLSearchParams(location.search).get('token') ?? '';
  return WALLET_SESSION_TOKEN.test(queryToken) ? queryToken : null;
}
