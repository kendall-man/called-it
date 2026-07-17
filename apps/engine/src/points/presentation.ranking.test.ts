import { describe, expect, it } from 'vitest';
import {
  formatAccuracy,
  leaderboardText,
  ordinalRank,
  personalStatsText,
  TELEGRAM_MESSAGE_LIMIT,
} from './presentation.js';

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
