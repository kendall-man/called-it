import { describe, expect, it } from 'vitest';
import type { MarketSpec } from '@calledit/market-engine';
import {
  claimCardText,
  describeTerms,
  escrowRuntimeStatusLabel,
  FAIR_PLAY_PENDING_LINE,
  FALLBACK_SIDE_LABELS,
  formatMultiplier,
  formatProbabilityPct,
  receiptCardText,
  sideLabels,
  skeletonCardText,
  statusBoardText,
  type ClaimCardInput,
  type ReceiptCardInput,
} from './cards.js';

const TEAM_SPEC: MarketSpec = {
  claimType: 'team_scores_n',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 2,
  period: 'FT_90',
  trustTier: 'chain_proven',
};

const COMEBACK_SPEC: MarketSpec = {
  claimType: 'comeback',
  fixtureId: 1234,
  entityRef: { kind: 'team', participant: 2, name: 'Brazil' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT',
  anchor: { seq: 41, scoreP1: 1, scoreP2: 0 },
  trustTier: 'oracle_resolved',
};

const CLAIM_INPUT = {
  quotedText: 'France score twice today, easy',
  claimerName: 'Dee',
  spec: TEAM_SPEC,
  status: 'open',
  probability: 0.42,
  provenance: 'modelled',
  back: { count: 2, stakeLamports: 50_000_000n },
  doubt: { count: 1, stakeLamports: 30_000_000n },
  matchedPct: 60,
  isReplay: false,
  receiptUrl: 'https://example.test/r/abc',
} satisfies ClaimCardInput;

const RECEIPT_INPUT = {
  quotedText: CLAIM_INPUT.quotedText,
  claimerName: CLAIM_INPUT.claimerName,
  spec: TEAM_SPEC,
  outcome: 'claim_won',
  probability: CLAIM_INPUT.probability,
  provenance: CLAIM_INPUT.provenance,
  payoutsLine: 'Dee collects 0.08 SOL.',
  isReplay: false,
  receiptUrl: CLAIM_INPUT.receiptUrl,
} satisfies ReceiptCardInput;

describe('formatters', () => {
  it('renders multipliers as ×N, never odds notation', () => {
    expect(formatMultiplier(9.3)).toBe('×9.3');
    expect(formatMultiplier(9.0)).toBe('×9');
    expect(formatMultiplier(11.4)).toBe('×11');
    expect(formatMultiplier(1.02)).toBe('×1');
    expect(formatMultiplier(25)).toBe('×25');
  });

  it('formats probabilities as whole percentages with <1/>99 guards', () => {
    expect(formatProbabilityPct(0.09)).toBe('9');
    expect(formatProbabilityPct(0.005)).toBe('<1');
    expect(formatProbabilityPct(0.999)).toBe('>99');
  });
});

describe('sideLabels', () => {
  const specOf = (overrides: Partial<MarketSpec>): MarketSpec => ({
    ...TEAM_SPEC,
    ...overrides,
  } as MarketSpec);

  it('labels every claim taxonomy from the compiled spec entities', () => {
    expect(sideLabels(specOf({
      claimType: 'match_winner',
      entityRef: { kind: 'team', participant: 1, name: 'Brazil' },
      threshold: 1,
    }))).toEqual({ back: 'Brazil to win', doubt: 'Draw or loss' });
    expect(sideLabels(TEAM_SPEC)).toEqual({ back: 'France score 2+', doubt: "They don't" });
    expect(sideLabels(specOf({ threshold: 1 })))
      .toEqual({ back: 'France score', doubt: "They don't" });
    expect(sideLabels(specOf({
      claimType: 'player_scores_n',
      entityRef: { kind: 'player', normativeId: 9, name: 'Mbappé', participant: 1 },
      threshold: 1,
    }))).toEqual({ back: 'Mbappé scores', doubt: 'No goal' });
    expect(sideLabels(specOf({
      claimType: 'player_scores_n',
      entityRef: { kind: 'player', normativeId: 9, name: 'Mbappé', participant: 1 },
      threshold: 2,
    }))).toEqual({ back: 'Mbappé scores 2+', doubt: 'No goal' });
    expect(sideLabels(specOf({ claimType: 'btts' })))
      .toEqual({ back: 'Both teams score', doubt: "They don't" });
    expect(sideLabels(COMEBACK_SPEC))
      .toEqual({ back: 'Brazil come back', doubt: 'No comeback' });
  });

  it('falls back to the exact binary labels without a clean short subject', () => {
    expect(FALLBACK_SIDE_LABELS).toEqual({ back: 'It happens', doubt: 'It does not' });
    // Totals have no subject; non-gte comparators have no short phrasing.
    expect(sideLabels(specOf({ claimType: 'totals_ou' }))).toEqual(FALLBACK_SIDE_LABELS);
    expect(sideLabels(specOf({ comparator: 'lte' }))).toEqual(FALLBACK_SIDE_LABELS);
    expect(sideLabels(specOf({ comparator: 'eq' }))).toEqual(FALLBACK_SIDE_LABELS);
  });

  it('shortens long names at word boundaries, never mid-word', () => {
    const gladbach = sideLabels(specOf({
      claimType: 'match_winner',
      entityRef: { kind: 'team', participant: 1, name: 'Borussia Mönchengladbach' },
      threshold: 1,
    }));
    expect(gladbach.back).toBe('Mönchengladbach to win');
    // A single overlong word cannot be shortened safely — binary wins.
    expect(sideLabels(specOf({
      claimType: 'match_winner',
      entityRef: { kind: 'team', participant: 1, name: 'Abcdefghijklmnopqrstuvwxyz' },
      threshold: 1,
    }))).toEqual(FALLBACK_SIDE_LABELS);
  });

  it('keeps every generated label within the 22-character button budget', () => {
    const specs: MarketSpec[] = [
      TEAM_SPEC,
      COMEBACK_SPEC,
      specOf({ claimType: 'btts' }),
      specOf({ claimType: 'totals_ou' }),
      specOf({
        claimType: 'player_scores_n',
        entityRef: { kind: 'player', normativeId: 9, name: 'Kylian Mbappé Lottin', participant: 1 },
        threshold: 3,
      }),
    ];
    for (const spec of specs) {
      const labels = sideLabels(spec);
      expect(labels.back.length).toBeLessThanOrEqual(22);
      expect(labels.doubt.length).toBeLessThanOrEqual(22);
    }
  });

  it('sanitizes hostile entity names before they can reach a button', () => {
    const hostile = sideLabels(specOf({
      claimType: 'match_winner',
      entityRef: { kind: 'team', participant: 1, name: '\u0000\u202eFrance ' },
      threshold: 1,
    }));
    expect(hostile.back).not.toMatch(/[\u0000\u202e]/u);
    expect(hostile.back).toContain('to win');
  });
});

describe('describeTerms', () => {
  it('describes a team-goals spec in plain English', () => {
    expect(describeTerms(TEAM_SPEC)).toBe('France to score 2 or more goals (in 90 minutes)');
  });

  it('describes a comeback with its anchored deficit', () => {
    expect(describeTerms(COMEBACK_SPEC)).toContain('from 1-0 down');
    expect(describeTerms(COMEBACK_SPEC)).toContain('Brazil');
  });
});

describe('skeleton card', () => {
  const skeleton = skeletonCardText({
    quotedText: CLAIM_INPUT.quotedText,
    claimerName: CLAIM_INPUT.claimerName,
    isReplay: false,
  });

  it('shares the full card header so the edit reads as the card filling in', () => {
    const full = claimCardText(CLAIM_INPUT);
    const skeletonHeader = skeleton.split('\n').slice(0, 2);

    expect(full.split('\n').slice(0, 2)).toEqual(skeletonHeader);
    expect(skeleton).toContain('⏳ Pricing this call off the live feed…');
  });

  it('carries no money lines, no buttons vocabulary, and no receipt link yet', () => {
    expect(skeleton).not.toContain('SOL');
    expect(skeleton).not.toContain('Receipt:');
    expect(skeleton).not.toContain('It happens');
    expect(skeleton).not.toMatch(/[$£€]/);
    expect(skeleton).not.toMatch(/\b\d+\s*\/\s*\d+\b/); // no odds notation
  });

  it('marks replays and sanitizes hostile quoted text within the message limit', () => {
    const hostile = skeletonCardText({
      quotedText: `\u0000\u202e France \u{1F3C6} ${'x'.repeat(2_000)}`,
      claimerName: '\u202eDee\u0000',
      isReplay: true,
    });

    expect(hostile).toContain('\u{1F399} THE CALL \u00b7 REPLAY');
    expect(hostile).not.toMatch(/[\u0000\u202e]/u);
    expect(hostile.length).toBeLessThanOrEqual(4_096);
  });
});

describe('cards', () => {
  const card = claimCardText(CLAIM_INPUT);

  it('keeps the existing financial totals and receipt lines unchanged', () => {
    const receipt = receiptCardText(RECEIPT_INPUT);

    expect(card).toContain(
      [
        '⚡ France score 2+: 0.05 SOL (2 in)',
        "🛑 They don't: 0.03 SOL (1 in)",
        '🤝 Matched: 60%',
        '',
        'Receipt: https://example.test/r/abc',
      ].join('\n'),
    );
    expect(receipt).toContain('💠 Dee collects 0.08 SOL.');
    expect(receipt).toMatch(/Receipt: https:\/\/example\.test\/r\/abc$/);
  });

  it('claim card carries terms, feed price, SOL pots, matched %, and the receipt link', () => {
    expect(card).toContain('France to score 2 or more goals');
    expect(card).toContain('42%');
    // Full-match multipliers derive from the feed ratio (p=0.42): back ×2.4, against ×1.7.
    expect(card).toContain('×2.4');
    expect(card).toContain('×1.7');
    expect(card).toContain('modelled price');
    expect(card).toContain('0.05 SOL'); // backing pot
    expect(card).toContain('0.03 SOL'); // against pot
    expect(card).toContain('Matched: 60%');
    expect(card).toContain('https://example.test/r/abc');
  });

  it('shows participant sides under the deterministic side labels', () => {
    const namedCard = claimCardText({
      ...CLAIM_INPUT,
      backParticipants: [
        { username: 'alice_7', displayName: 'Alice' },
        { username: null, displayName: 'Bob' },
      ],
      doubtParticipants: [{ username: 'carol_9', displayName: 'Carol' }],
    });

    expect(namedCard).toContain(
      [
        'France score 2+: @alice_7, Bob',
        "They don't: @carol_9",
      ].join('\n'),
    );
    // Voice rule: no repeated group-visibility or value disclaimers on cards.
    expect(namedCard).not.toContain('Choices and results are visible in this group.');
  });

  it('keeps financial positions separate from distinct participant overflow', () => {
    const duplicateOnlyCard = claimCardText({
      ...CLAIM_INPUT,
      back: { count: 6, stakeLamports: 60_000_000n },
      doubt: { count: 0, stakeLamports: 0n },
      backParticipants: [{ username: 'alice_7', displayName: 'Alice' }],
      doubtParticipants: [],
      backParticipantCount: 1,
      doubtParticipantCount: 0,
    });

    expect(duplicateOnlyCard).toContain('⚡ France score 2+: 0.06 SOL (6 in)');
    expect(duplicateOnlyCard).toContain('France score 2+: @alice_7');
    expect(duplicateOnlyCard).not.toContain('and 5 more');
  });

  it('caps and sanitizes 100 participant identities within the Telegram limit', () => {
    const participants = Array.from({ length: 100 }, (_, index) => ({
      username: index < 5 ? `player_${index}` : 'undefined',
      displayName: `\u0000\u202e Player ${index} 🏆`.repeat(4),
    }));
    const boundedCard = claimCardText({
      ...CLAIM_INPUT,
      back: { count: 100, stakeLamports: 1_000_000_000n },
      doubt: { count: 0, stakeLamports: 0n },
      backParticipants: participants,
      doubtParticipants: [],
      backParticipantCount: 100,
      doubtParticipantCount: 0,
      matchedPct: 0,
    });

    expect(boundedCard).toContain(
      'France score 2+: @player_0, @player_1, @player_2, @player_3, @player_4, and 95 more',
    );
    expect(boundedCard).toContain("They don't: No one yet");
    expect(boundedCard).not.toMatch(/[\u0000\u202e]/u);
    expect(boundedCard.length).toBeLessThanOrEqual(4_096);
  });

  it('appends settlement points and the top five leaderboard rows to a final result', () => {
    const leaderboard = Array.from({ length: 6 }, (_, index) => ({
      username: `player_${index}`,
      displayName: `Player ${index}`,
      points: 60 - index * 10,
      wins: 6 - index,
      losses: index,
    }));
    const receipt = receiptCardText({
      ...RECEIPT_INPUT,
      points: {
        winnerCount: 1,
        missCount: 1,
        winners: [{ username: 'alice_7', displayName: 'Alice' }],
        misses: [{ username: null, displayName: 'Bob' }],
        leaderboard,
      },
    });

    expect(receipt).toContain(
      ['Points', 'Winners (+10 points): @alice_7', 'Misses (+0 points): Bob'].join('\n'),
    );
    expect(receipt).toContain('1st. @player_0 - 60 points, 6 wins, 0 losses, 100% accuracy');
    expect(receipt).toContain('5th. @player_4 - 20 points, 2 wins, 4 losses, 33% accuracy');
    expect(receipt).not.toContain('@player_5');
    expect(receipt).toContain('💠 Dee collects 0.08 SOL.');
    expect(receipt).toContain('Receipt: https://example.test/r/abc');
  });

  it('omits points sections when points are absent or the result is void', () => {
    const withoutPoints = receiptCardText({ ...RECEIPT_INPUT, outcome: 'claim_lost' });
    const voidReceipt = receiptCardText({
      ...RECEIPT_INPUT,
      outcome: 'void',
      points: {
        winnerCount: 1,
        missCount: 0,
        winners: [{ username: 'alice_7', displayName: 'Alice' }],
        misses: [{ username: null, displayName: 'Bob' }],
        leaderboard: [
          { username: 'alice_7', displayName: 'Alice', points: 10, wins: 1, losses: 0 },
        ],
      },
    });

    for (const text of [withoutPoints, voidReceipt]) {
      expect(text).not.toContain('\nPoints\n');
      expect(text).not.toContain('Group leaderboard');
    }
  });

  it('cards carry no fiat currency and no odds notation', () => {
    const receipt = receiptCardText({ ...RECEIPT_INPUT, isReplay: true });
    for (const text of [card, receipt]) {
      expect(text).not.toMatch(/[$£€]/);
      expect(text).not.toMatch(/\bRep\b/); // no play-money leftovers
      expect(text).not.toMatch(/\b\d+\s*\/\s*\d+\b/); // no "11/2" odds notation
    }
    expect(receipt).toContain('REPLAY');
    expect(receipt).toContain('CALLED IT');
    expect(receipt).toContain('0.08 SOL');
  });

  it('labels escrow cards and exposes only public transaction links', () => {
    const claim = claimCardText({
      ...CLAIM_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'mainnet-beta',
      currency: 'usdc',
    });
    const receipt = receiptCardText({
      ...RECEIPT_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'mainnet-beta',
      currency: 'usdc',
      transactionUrl: 'https://explorer.solana.com/tx/abc',
    });
    const signingToken = 'a'.repeat(43);
    const unsafeReceipt = receiptCardText({
      ...RECEIPT_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'devnet',
      transactionUrl: `https://example.test/position/${signingToken}`,
    });

    expect(claim).toContain('On-chain escrow · MAINNET · USDC');
    expect(receipt).toContain('Transaction: https://explorer.solana.com/tx/abc');
    expect(unsafeReceipt).not.toContain(signingToken);
  });

  it('labels signed completed-match replay cards as no-Points in escrow mode', () => {
    const replay = claimCardText({
      ...CLAIM_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'mainnet-beta',
      isReplay: true,
    });

    expect(replay).toContain('Completed-match replay · No Points change');
    expect(replay).toContain('On-chain escrow · MAINNET · SOL');
    expect(replay).not.toContain('No SOL or USDC moves');
  });

  it('shows the fair-play line only while escrow lots are pending activation', () => {
    const pending = claimCardText({
      ...CLAIM_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'devnet',
      pendingActivationCount: 2,
    });
    const activated = claimCardText({
      ...CLAIM_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'devnet',
      pendingActivationCount: 0,
    });
    const legacyPending = claimCardText({ ...CLAIM_INPUT, pendingActivationCount: 2 });

    expect(pending).toContain(`⏳ ${FAIR_PLAY_PENDING_LINE}`);
    expect(activated).not.toContain(FAIR_PLAY_PENDING_LINE);
    expect(claimCardText(CLAIM_INPUT)).not.toContain(FAIR_PLAY_PENDING_LINE);
    expect(legacyPending).not.toContain(FAIR_PLAY_PENDING_LINE);
  });

  it('never renders Points on an escrow replay receipt', () => {
    const replay = receiptCardText({
      ...RECEIPT_INPUT,
      custodyMode: 'escrow',
      solanaNetwork: 'devnet',
      isReplay: true,
      points: {
        winnerCount: 1,
        missCount: 0,
        winners: [{ username: 'alice_7', displayName: 'Alice' }],
        misses: [],
        leaderboard: [
          { username: 'alice_7', displayName: 'Alice', points: 10, wins: 1, losses: 0 },
        ],
      },
    });

    expect(replay).toContain('Completed-match replay · No Points changed');
    expect(replay).not.toContain('+10 points');
    expect(replay).not.toContain('Group leaderboard');
  });
});

describe('status board', () => {
  it('renders live feed, aggregate counts, escrow health, and the devnet footer', () => {
    const board = statusBoardText({
      feed: { kind: 'live' },
      openMarketCount: 3,
      pendingActivationCount: 2,
      escrowRuntime: 'ready',
      solanaNetwork: 'devnet',
    });

    expect(board).toContain('📟 STATUS');
    expect(board).toContain('📡 Feed: live matches');
    expect(board).toContain('🎙 Open calls here: 3');
    expect(board).toContain('⏳ Positions in the fair-play wait: 2');
    expect(board).toContain('🔐 Escrow desk: all clear');
    // Voice rule: no devnet value disclaimer on the routine board.
    expect(board).not.toMatch(/monetary value|\(devnet\)/);
  });

  it('names the replayed fixture with its virtual minute', () => {
    const board = statusBoardText({
      feed: {
        kind: 'replay',
        fixtureLabel: 'France vs Morocco',
        virtualMinute: 34,
      },
      openMarketCount: 1,
      pendingActivationCount: 0,
      solanaNetwork: 'devnet',
    });
    const preKickoff = statusBoardText({
      feed: { kind: 'replay', fixtureLabel: 'France vs Morocco', virtualMinute: null },
      openMarketCount: 1,
      pendingActivationCount: 0,
      solanaNetwork: 'devnet',
    });

    expect(board).toContain('completed-match replay of France vs Morocco · minute 34');
    expect(preKickoff).toContain('completed-match replay of France vs Morocco');
    expect(preKickoff).not.toContain('minute');
    expect(board).not.toContain('Escrow desk');
  });

  it('translates degraded escrow health to plain words, never raw reason codes', () => {
    expect(escrowRuntimeStatusLabel({ status: 'ready', reasons: [] })).toBe('ready');
    expect(escrowRuntimeStatusLabel({
      status: 'not_ready',
      reasons: ['indexer_lagging', 'rpc_unavailable'],
    })).toBe('rpc_unavailable');
    expect(escrowRuntimeStatusLabel({ status: 'not_ready', reasons: ['indexer_lagging'] }))
      .toBe('indexer_lagging');
    expect(escrowRuntimeStatusLabel({ status: 'not_ready', reasons: ['indexer_unavailable'] }))
      .toBe('indexer_lagging');
    expect(escrowRuntimeStatusLabel({ status: 'not_ready', reasons: ['program_paused'] }))
      .toBe('degraded');

    for (const [label, phrase] of [
      ['rpc_unavailable', 'chain connection catching up'],
      ['indexer_lagging', 'receipts catching up'],
      ['degraded', 'catching up'],
    ] as const) {
      const board = statusBoardText({
        feed: { kind: 'live' },
        openMarketCount: 0,
        pendingActivationCount: 0,
        escrowRuntime: label,
        solanaNetwork: 'devnet',
      });
      expect(board).toContain(`🔐 Escrow desk: ${phrase}`);
      expect(board).not.toContain('not_ready');
      expect(board).not.toContain('indexer_');
      expect(board).not.toContain('rpc_');
    }
  });

  it('stamps the mainnet footer on mainnet and carries no fiat or odds notation', () => {
    const board = statusBoardText({
      feed: { kind: 'live' },
      openMarketCount: 5,
      pendingActivationCount: 1,
      escrowRuntime: 'ready',
      solanaNetwork: 'mainnet-beta',
    });

    expect(board).toContain('SOL positions settle on Solana mainnet.');
    expect(board).not.toMatch(/[$£€]/);
    expect(board).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
  });
});
