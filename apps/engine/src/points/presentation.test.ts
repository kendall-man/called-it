import { describe, expect, it } from 'vitest';
import {
  formatAccuracy,
  leaderboardText,
  ordinalRank,
  participantLabel,
  personalStatsText,
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
  it('shows at most five labels followed by the exact overflow count', () => {
    // Given
    const participants = ['Alice', 'Bob', 'Carol', 'Dana', 'Eve', 'Finn', 'Gina'].map(
      (displayName) => ({ username: null, displayName }),
    );

    // When
    const text = sideListText(participants, 4_096);

    // Then
    expect(text).toBe('Alice, Bob, Carol, Dana, Eve, and 2 more');
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

describe('formatAccuracy', () => {
  it.each([
    { wins: 0, losses: 0, expected: '0%' },
    { wins: 2, losses: 1, expected: '67%' },
  ])('returns $expected for $wins wins and $losses losses', ({ wins, losses, expected }) => {
    // Given
    const record = { wins, losses };

    // When
    const accuracy = formatAccuracy(record.wins, record.losses);

    // Then
    expect(accuracy).toBe(expected);
  });

  it.each([
    { wins: -3.9, losses: 2, expected: '0%' },
    { wins: 2, losses: -3.9, expected: '100%' },
    { wins: 2.9, losses: 1.9, expected: '67%' },
    { wins: Number.NaN, losses: 1, expected: '0%' },
    { wins: 1, losses: Number.POSITIVE_INFINITY, expected: '0%' },
    { wins: Number.MAX_SAFE_INTEGER + 1, losses: 0, expected: '0%' },
    { wins: Number.MAX_SAFE_INTEGER, losses: 1, expected: '0%' },
  ])(
    'returns $expected for malformed counts $wins/$losses',
    ({ wins, losses, expected }) => {
      // Given
      const counts = { wins, losses };

      // When
      const accuracy = formatAccuracy(counts.wins, counts.losses);

      // Then
      expect(accuracy).toBe(expected);
    },
  );
});

describe('ordinalRank', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
  ])('formats rank %i as %s', (rank, expected) => {
    // Given
    const numericRank = rank;

    // When
    const label = ordinalRank(numericRank);

    // Then
    expect(label).toBe(expected);
  });

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ])('returns an unranked mark for invalid rank %s', (rank) => {
    // Given
    const malformedRank = rank;

    // When
    const label = ordinalRank(malformedRank);

    // Then
    expect(label).toBe('—');
  });
});

describe('leaderboardText', () => {
  it('shows the settled-calls empty state when the group has no rows', () => {
    // Given
    const entries: readonly [] = [];

    // When
    const text = leaderboardText({ entries, limit: 10 }, TELEGRAM_MESSAGE_LIMIT);

    // Then
    expect(text).toBe('Group leaderboard\nNo settled calls yet.');
  });

  it('preserves ordered ties and duplicate labels while showing rank and accuracy', () => {
    // Given
    const entries = [
      { username: null, displayName: 'Same Name', points: 20, wins: 2, losses: 1 },
      { username: null, displayName: 'Same Name', points: 20, wins: 2, losses: 1 },
      { username: 'third_user', displayName: 'Third', points: 0, wins: 0, losses: 0 },
    ];

    // When
    const text = leaderboardText({ entries, limit: 5 }, TELEGRAM_MESSAGE_LIMIT);

    // Then
    expect(text).toBe(
      [
        'Group leaderboard',
        '1st. Same Name - 20 points, 2 wins, 1 loss, 67% accuracy',
        '2nd. Same Name - 20 points, 2 wins, 1 loss, 67% accuracy',
        '3rd. @third_user - 0 points, 0 wins, 0 losses, 0% accuracy',
      ].join('\n'),
    );
  });

  it.each([5, 10] as const)('renders only the top %i of 100 ordered entries', (limit) => {
    // Given
    const entries = Array.from({ length: 100 }, (_, index) => ({
      username: null,
      displayName: `Rank ${String(index + 1).padStart(3, '0')}`,
      points: 1_000 - index * 10,
      wins: 100 - index,
      losses: index,
    }));

    // When
    const text = leaderboardText({ entries, limit }, TELEGRAM_MESSAGE_LIMIT);

    // Then
    expect(text.split('\n')).toHaveLength(limit + 1);
    expect(text).toContain(`Rank ${String(limit).padStart(3, '0')}`);
    expect(text).not.toContain(`Rank ${String(limit + 1).padStart(3, '0')}`);
  });
});

describe('personalStatsText', () => {
  it('shows rank, record, rounded accuracy, and both streaks', () => {
    // Given
    const stats = { rank: 2, points: 40, wins: 4, losses: 2, currentStreak: 2, bestStreak: 4 };

    // When
    const text = personalStatsText(stats, TELEGRAM_MESSAGE_LIMIT);

    // Then
    expect(text).toBe(
      [
        'Your group stats',
        'Rank: 2nd',
        'Points: 40',
        'Wins: 4',
        'Losses: 2',
        'Accuracy: 67%',
        'Current streak: 2',
        'Best streak: 4',
      ].join('\n'),
    );
  });

  it('renders an unranked zero-stats member without division artifacts', () => {
    // Given
    const stats = { rank: null, points: 0, wins: 0, losses: 0, currentStreak: 0, bestStreak: 0 };
    // When
    const text = personalStatsText(stats, TELEGRAM_MESSAGE_LIMIT);
    // Then
    expect(text).toContain('Rank: Unranked\nPoints: 0\nWins: 0\nLosses: 0\nAccuracy: 0%');
  });

  it('renders a scored member beyond the bounded lookup truthfully', () => {
    const text = personalStatsText({ rank: 'outside_top_100', points: 10, wins: 1, losses: 0, currentStreak: 1, bestStreak: 1 }, TELEGRAM_MESSAGE_LIMIT);
    expect(text).toContain('Rank: Outside top 100');
  });
});
