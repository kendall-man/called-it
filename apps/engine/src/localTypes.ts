/**
 * Tiny dependency-free types shared across bot modules. Kept separate from
 * ports.ts so pure modules (callback encoding, send queue, copy bank) can be
 * unit-tested before sibling workspace packages are built.
 */

export type Chattiness = 'nudge' | 'react_only' | 'trigger_only';

export const CHATTINESS_MODES: readonly Chattiness[] = [
  'nudge',
  'react_only',
  'trigger_only',
];
