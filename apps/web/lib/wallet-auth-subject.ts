export type WalletAuthNetwork = 'devnet' | 'mainnet-beta';

export type WalletAuthSubject = {
  readonly network: WalletAuthNetwork;
  readonly telegramUserId: string;
};

const SUBJECT_PATTERN = /^calledit:(devnet|mainnet-beta):telegram:([1-9]\d{0,19})$/;

export function walletAuthSubject(
  network: WalletAuthNetwork,
  telegramUserId: number,
): string {
  if (!Number.isSafeInteger(telegramUserId) || telegramUserId <= 0) {
    throw new Error('telegram user id invalid');
  }
  return `calledit:${network}:telegram:${telegramUserId}`;
}

export function parseWalletAuthSubject(subject: string): WalletAuthSubject | null {
  const match = SUBJECT_PATTERN.exec(subject);
  if (match === null) return null;
  const network = match[1];
  const telegramUserId = match[2];
  if (
    (network !== 'devnet' && network !== 'mainnet-beta') ||
    telegramUserId === undefined
  ) {
    return null;
  }
  const numericId = Number(telegramUserId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) return null;
  return { network, telegramUserId };
}
