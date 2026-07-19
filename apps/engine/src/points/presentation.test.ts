import { describe, expect, it } from 'vitest';
import {
  participantLabel,
  settlementPointsText,
  sideListText,
  TELEGRAM_MESSAGE_LIMIT,
} from './presentation.js';

describe('participantLabel', () => {
  it('uses a valid Telegram username when one is available', () => {
    // Given
    const participant = { username: 'alice_7', displayName: 'Alice Example' };

    // When
    const label = participantLabel(participant);

    // Then
    expect(label).toBe('@alice_7');
  });

  it('collapses whitespace and control characters in the display-name fallback', () => {
    // Given
    const participant = {
      username: 'bad-name',
      displayName: '  Alice\n\t\u0000Bob\u202E  Carol  ',
    };

    // When
    const label = participantLabel(participant);

    // Then
    expect(label).toBe('Alice Bob Carol');
  });

  it('truncates display names to 32 Unicode code points', () => {
    // Given
    const first32CodePoints = `${'😀'.repeat(16)}${'e\u0301'.repeat(8)}`;
    const participant = { username: null, displayName: `${first32CodePoints}EXTRA` };

    // When
    const label = participantLabel(participant);

    // Then
    expect(label).toBe(first32CodePoints);
    expect(Array.from(label)).toHaveLength(32);
  });

  it.each([
    [{ username: 'tiny', displayName: null }, 'Player'],
    [{ username: 'a'.repeat(33), displayName: 'Fallback' }, 'Fallback'],
    [{ username: null, displayName: '\u0000\u202E\n' }, 'Player'],
  ])('rejects malformed identity data without leaking structure', (participant, expected) => {
    // Given
    const identity = participant;
    // When
    const label = participantLabel(identity);
    // Then
    expect(label).toBe(expected);
  });

  it('safely handles unknown identity shapes without coercing IDs or undefined', () => {
    // Given
    const malformed: readonly unknown[] = [
      undefined,
      null,
      {},
      { username: undefined, displayName: undefined },
      { username: 123_456_789, displayName: 987_654_321 },
      { username: 'undefined', displayName: null },
      { username: '123456789', displayName: null },
      { username: 123_456_789, displayName: 'Safe Name' },
      { username: 'valid_name', displayName: 42 },
    ];

    // When
    const labels = malformed.map(participantLabel);

    // Then
    expect(labels).toEqual([
      'Player', 'Player', 'Player', 'Player', 'Player', 'Player', 'Player',
      'Safe Name', '@valid_name',
    ]);
  });
});

describe('sideListText', () => {
  it('shows at most three labels followed by a compact exact overflow count', () => {
    // Given
    const participants = ['Alice', 'Bob', 'Carol', 'Dana', 'Eve', 'Finn', 'Gina'].map(
      (displayName) => ({ username: null, displayName }),
    );

    // When
    const text = sideListText(participants, 4_096);

    // Then
    expect(text).toBe('Alice, Bob, Carol +4');
    expect(text).not.toContain('Dana');
    expect(text).not.toContain('Eve');
    expect(text).not.toContain('Finn');
    expect(text).not.toContain('Gina');
  });

  it('stays within the supplied UTF-16 budget without splitting an emoji', () => {
    // Given
    const participants = [{ username: null, displayName: '😀'.repeat(32) }];

    // When
    const text = sideListText(participants, 12);

    // Then
    expect(text.length).toBeLessThanOrEqual(12);
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
  });
});

describe('settlementPointsText', () => {
  it('shows a three-player result with point deltas in plain text', () => {
    // Given
    const result = {
      winnerCount: 2,
      missCount: 1,
      winners: [
        { username: 'alice_7', displayName: 'Alice' },
        { username: null, displayName: 'Bob' },
      ],
      misses: [{ username: null, displayName: 'Carol' }],
    };

    // When
    const text = settlementPointsText(result, TELEGRAM_MESSAGE_LIMIT);

    // Then
    expect(text).toBe(
      ['Points', 'Winners (+10 points): @alice_7, Bob', 'Misses (+0 points): Carol'].join('\n'),
    );
  });

  it('uses authoritative totals when identity projections are bounded to ten per side', () => {
    // Given
    const participants = (prefix: string) =>
      Array.from({ length: 10 }, (_, index) => ({
        username: null,
        displayName: `${prefix} ${String(index + 1).padStart(3, '0')}`,
      }));

    // When
    const text = settlementPointsText(
      {
        winnerCount: 100, missCount: 100,
        winners: participants('Winner'), misses: participants('Miss'),
      },
      TELEGRAM_MESSAGE_LIMIT,
    );

    // Then
    expect(text.match(/and 90 more/g) ?? []).toHaveLength(2);
    expect(text).toContain('Winner 010');
    expect(text).not.toContain('Winner 011');
    expect(text).toContain('Miss 010');
    expect(text).not.toContain('Miss 011');
  });
});
