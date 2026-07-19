import type { Metadata } from 'next';
import QRCode from 'qrcode';
import { RumbleLanding } from '@/components/landing-page';
import { buildTelegramGroupAddUrl } from '@/lib/entry';
import { isMainnet } from '@/lib/solana-network';

const RUMBLE_TELEGRAM_BOT_USERNAME = 'getrumble_bot';

export const metadata: Metadata = {
  title: 'Rumble — Football predictions with friends',
  description:
    'Put SOL on football predictions with friends. Pick yes or no, and Rumble settles it in Telegram after the match.',
};

export default async function LandingPage() {
  const mainnet = isMainnet();
  const telegramGroupUrl = buildTelegramGroupAddUrl(RUMBLE_TELEGRAM_BOT_USERNAME);
  const qrCodeDataUrl = telegramGroupUrl
    ? await QRCode.toDataURL(telegramGroupUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 320,
        color: {
          dark: `${String.fromCharCode(35)}0b0e14`,
          light: `${String.fromCharCode(35)}ffffff`,
        },
      })
    : null;

  return (
    <RumbleLanding
      mainnet={mainnet}
      qrCodeDataUrl={qrCodeDataUrl}
      telegramGroupUrl={telegramGroupUrl}
    />
  );
}
