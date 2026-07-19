import { renderToStaticMarkup } from 'react-dom/server';
import React, { type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EvidenceList } from './evidence-list';

vi.mock('./ui', () => ({
  Badge: ({ children }: { readonly children: ReactNode }) => <span>{children}</span>,
}));

describe('EvidenceList', () => {
  it('does not promise later evidence for a terminal replay without a deciding event', () => {
    const html = renderToStaticMarkup(
      <EvidenceList facts={[]} decidingSeq={null} state="not_recorded" />,
    );

    expect(html).toContain('finalized replay has no public deciding-event record');
    expect(html).not.toContain('Evidence appears after the match is settled');
  });
});
