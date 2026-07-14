import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { PositionRoute } from '@/components/position-route';
import { POSITION_TOKEN_PATTERN } from '@/lib/position-contract';

export const metadata: Metadata = {
  title: 'Review position · Called It',
  description: 'Review and approve one exact Called It escrow position.',
};

export const dynamic = 'force-dynamic';

export default async function PositionPage(props: {
  readonly params: Promise<{ readonly token: string }>;
}) {
  const { token } = await props.params;
  if (!POSITION_TOKEN_PATTERN.test(token)) notFound();
  return <PositionRoute token={token} />;
}
