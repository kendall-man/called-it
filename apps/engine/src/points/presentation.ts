export type ParticipantIdentity = {
  readonly username: string | null;
  readonly displayName: string | null;
};

export type SettlementPointsInput = {
  readonly winners: readonly ParticipantIdentity[];
  readonly misses: readonly ParticipantIdentity[];
};

export type LeaderboardPlayer = ParticipantIdentity & {
  readonly points: number;
  readonly wins: number;
  readonly losses: number;
};

export type LeaderboardInput = {
  readonly entries: readonly LeaderboardPlayer[];
  readonly limit: 5 | 10;
};

export type PersonalStats = {
  readonly rank: number | null;
  readonly points: number;
  readonly wins: number;
  readonly losses: number;
  readonly currentStreak: number;
  readonly bestStreak: number;
};

export const TELEGRAM_MESSAGE_LIMIT = 4_096;

const TELEGRAM_USERNAME = /^(?![0-9]{5,32}$)[A-Za-z0-9_]{5,32}$/;
const NON_VISIBLE_RUN = /[\p{White_Space}\p{Cc}\p{Cf}\p{Cs}]+/gu;
const PARTICIPANT_LABEL_CODE_POINTS = 32;
const SIDE_LIST_LIMIT = 5;
const SETTLEMENT_LIST_LIMIT = 10;
const TRUNCATION_MARKER = '...';

function utf16Prefix(text: string, maxLength: number): string {
  let prefix = '';
  for (const character of text) {
    if (prefix.length + character.length > maxLength) break;
    prefix += character;
  }
  return prefix;
}

function withinBudget(text: string, maxLength: number): string {
  const budget = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
  if (text.length <= budget) return text;
  if (budget <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, budget);
  return `${utf16Prefix(text, budget - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function participantList(participants: readonly ParticipantIdentity[], limit: number): string {
  const labels = participants.slice(0, limit).map(participantLabel);
  const overflow = participants.length - labels.length;
  return overflow > 0 ? [...labels, `and ${overflow} more`].join(', ') : labels.join(', ');
}

function normalizedCount(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const integer = Math.trunc(value);
  if (!Number.isSafeInteger(integer)) return null;
  return Math.max(0, integer);
}

export function participantLabel(participant: unknown): string {
  if (typeof participant !== 'object' || participant === null) return 'Player';
  const username = 'username' in participant ? participant.username : null;
  if (
    typeof username === 'string' &&
    username.toLowerCase() !== 'undefined' &&
    TELEGRAM_USERNAME.test(username)
  ) {
    return `@${username}`;
  }
  const rawDisplayName = 'displayName' in participant ? participant.displayName : null;
  const displayName =
    typeof rawDisplayName === 'string'
      ? rawDisplayName.replace(NON_VISIBLE_RUN, ' ').trim()
      : '';
  if (displayName.length > 0) {
    return Array.from(displayName).slice(0, PARTICIPANT_LABEL_CODE_POINTS).join('');
  }
  return 'Player';
}

export function sideListText(
  participants: readonly ParticipantIdentity[],
  maxLength: number,
): string {
  if (participants.length > 0) {
    return withinBudget(participantList(participants, SIDE_LIST_LIMIT), maxLength);
  }
  return withinBudget('No one yet', maxLength);
}

export function settlementPointsText(
  input: SettlementPointsInput,
  maxLength: number,
): string {
  const lines = ['Points'];
  if (input.winners.length > 0) {
    lines.push(`Winners (+10 points): ${participantList(input.winners, SETTLEMENT_LIST_LIMIT)}`);
  }
  if (input.misses.length > 0) {
    lines.push(`Misses (+0 points): ${participantList(input.misses, SETTLEMENT_LIST_LIMIT)}`);
  }
  if (lines.length === 1) return '';
  return withinBudget(lines.join('\n'), maxLength);
}

export function formatAccuracy(wins: number, losses: number): string {
  const safeWins = normalizedCount(wins);
  const safeLosses = normalizedCount(losses);
  if (safeWins === null || safeLosses === null) return '0%';
  const decisions = safeWins + safeLosses;
  if (decisions === 0 || !Number.isSafeInteger(decisions)) return '0%';
  return `${Math.round((safeWins / decisions) * 100)}%`;
}

export function ordinalRank(rank: number): string {
  if (!Number.isSafeInteger(rank) || rank <= 0) return '—';
  const lastTwoDigits = rank % 100;
  if (lastTwoDigits >= 11 && lastTwoDigits <= 13) return `${rank}th`;
  switch (rank % 10) {
    case 1:
      return `${rank}st`;
    case 2:
      return `${rank}nd`;
    case 3:
      return `${rank}rd`;
    default:
      return `${rank}th`;
  }
}

export function emptyLeaderboardText(maxLength: number): string {
  return withinBudget('Group leaderboard\nNo settled calls yet.', maxLength);
}

export function leaderboardText(input: LeaderboardInput, maxLength: number): string {
  if (input.entries.length === 0) return emptyLeaderboardText(maxLength);
  const rows = input.entries.slice(0, input.limit).map((entry, index) => {
    const wins = `${entry.wins} ${entry.wins === 1 ? 'win' : 'wins'}`;
    const losses = `${entry.losses} ${entry.losses === 1 ? 'loss' : 'losses'}`;
    return `${ordinalRank(index + 1)}. ${participantLabel(entry)} - ${entry.points} points, ${wins}, ${losses}, ${formatAccuracy(entry.wins, entry.losses)} accuracy`;
  });
  return withinBudget(['Group leaderboard', ...rows].join('\n'), maxLength);
}

export function personalStatsText(stats: PersonalStats, maxLength: number): string {
  const rank = stats.rank === null ? 'Unranked' : ordinalRank(stats.rank);
  return withinBudget(
    [
      'Your group stats',
      `Rank: ${rank}`,
      `Points: ${stats.points}`,
      `Wins: ${stats.wins}`,
      `Losses: ${stats.losses}`,
      `Accuracy: ${formatAccuracy(stats.wins, stats.losses)}`,
      `Current streak: ${stats.currentStreak}`,
      `Best streak: ${stats.bestStreak}`,
    ].join('\n'),
    maxLength,
  );
}
