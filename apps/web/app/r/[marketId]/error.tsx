'use client';

import { DataUnavailable } from '@/components/states';
import { usePathname } from 'next/navigation';

export default function Error() {
  return <DataUnavailable retryHref={usePathname()} />;
}
