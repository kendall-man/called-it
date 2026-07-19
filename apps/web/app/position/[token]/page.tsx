import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PositionRoute } from '@/components/position-route';
import { POSITION_TOKEN_PATTERN } from '@/lib/position-contract';

export const metadata: Metadata = {
  title: 'Review position · Rumble',
  description: 'Review and approve one exact Rumble escrow position.',
  referrer: 'no-referrer',
  robots: { index: false, follow: false, noarchive: true },
};

export const dynamic = 'force-dynamic';

export default async function PositionPage(props: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await props.params;
  if (!POSITION_TOKEN_PATTERN.test(token)) notFound();
  return <PositionRoute token={token} />;
}
