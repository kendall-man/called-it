import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import Script from 'next/script';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Rumble',
    template: '%s · Rumble',
  },
  description:
    'Big claims from the group chat, priced on the spot and settled from verified match data — with receipts anyone can check on Solana.',
};

export const viewport: Viewport = {
  themeColor: '#05070b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <Script
          src="https://telegram.org/js/telegram-web-app.js"
          strategy="beforeInteractive"
        />
      </head>
      <body className="min-h-dvh">{children}</body>
    </html>
  );
}
