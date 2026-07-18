import type { Metadata } from 'next';
import { MiniAppRoute } from '@/components/miniapp-route';

export const metadata: Metadata = {
  title: 'Open Rumble',
  description: 'Sign a Rumble position or set up your wallet from the group chat.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
};

export const dynamic = 'force-dynamic';

export default function MiniAppPage() {
  return <MiniAppRoute />;
}
