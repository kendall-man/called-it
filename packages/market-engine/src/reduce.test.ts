import { describe, expect, it } from 'vitest';
import { checkDebounce, reduceMarket } from './reduce.js';
import type {
  MarketEffect,
  MarketState,
  MatchEvent,
  SettlementOutcome,
} from './types.js';
import { PENDING_TAP_WINDOW_MS } from './constants.js';
import {
  DEBOUNCE_MS,
  FEED_DELAY_MS,
  KICKOFF_MS,
  OTHER_FIXTURE_ID,
  PLAYER_MBAPPE,
  PLAYER_MESSI,
  mkEvent,
  mkPosition,
  mkScore,
  mkSpec,
  mkState,
  playerRef,
  teamRef,
} from './testkit.js';

/** Run a scripted seq-ordered event list through the reducer. */
function run(
  initial: MarketState,
  events: MatchEvent[],
): { state: MarketState; effects: MarketEffect[] } {
  let state = initial;
  const effects: MarketEffect[] = [];
  for (const event of events) {
    const result = reduceMarket(state, event);
    state = result.state;
    effects.push(...result.effects);
  }
  return { state, effects };
}

function effectKinds(effects: MarketEffect[]): string[] {
  return effects.map((e) => e.kind);
}

function settleEffect(
  effects: MarketEffect[],
): Extract<MarketEffect, { kind: 'settle' }> | undefined {
  return effects.find(
    (e): e is Extract<MarketEffect, { kind: 'settle' }> => e.kind === 'settle',
  );
}

function debounceDeadline(event: MatchEvent): number {
  return event.receivedAtMs + DEBOUNCE_MS;
}

const OVER_25 = mkSpec({
  claimType: 'totals_ou',
  comparator: 'gte',
  threshold: 2.5,
  period: 'FT_90',
});
const UNDER_25 = mkSpec({
  claimType: 'totals_ou',
  comparator: 'lte',
  threshold: 2.5,
  period: 'FT_90',
});
const WINNER_90 = mkSpec({
  claimType: 'match_winner',
  entityRef: teamRef(1),
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
});
const WINNER_FT = { ...WINNER_90, period: 'FT' as const };
const MBAPPE_BRACE = mkSpec({
  claimType: 'player_scores_n',
  entityRef: playerRef(1),
  comparator: 'gte',
  threshold: 2,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
});

describe('reduceMarket — debounced settlement core', () => {
  it('a deciding goal opens a pending settlement, not an instant settle', () => {
    const goal3 = mkEvent('goal', 3, {
      score: mkScore(2, 1),
      detail: { participant: 1 },
    });
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0), detail: { participant: 1 } }),
      mkEvent('goal', 2, { score: mkScore(1, 1), detail: { participant: 2 } }),
      goal3,
    ]);
    expect(state.status).toBe('settling');
    expect(settleEffect(effects)).toBeUndefined();
    expect(state.pendingSettlement).not.toBeNull();
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    expect(state.pendingSettlement?.decidingSeq).toBe(3);
    expect(state.pendingSettlement?.evidenceSeqs).toEqual([1, 2, 3]);
    expect(state.pendingSettlement?.debounceUntilMs).toBe(debounceDeadline(goal3));
  });

  it('checkDebounce holds before the window and settles at the boundary', () => {
    const goal3 = mkEvent('goal', 3, { score: mkScore(2, 1) });
    const { state } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(1, 1) }),
      goal3,
    ]);

    const early = checkDebounce(state, debounceDeadline(goal3) - 1);
    expect(early.state.status).toBe('settling');
    expect(settleEffect(early.effects)).toBeUndefined();

    const due = checkDebounce(state, debounceDeadline(goal3));
    expect(due.state.status).toBe('settled');
    const settle = settleEffect(due.effects);
    expect(settle?.outcome).toBe('claim_won');
    expect(settle?.decidingSeq).toBe(3);
  });

  it('any later event settles the pending candidate immediately', () => {
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(2, 0) }),
      mkEvent('goal', 3, { score: mkScore(3, 0) }),
      mkEvent('card', 4, { score: mkScore(3, 0), detail: { card: 'yellow' } }),
    ]);
    expect(state.status).toBe('settled');
    const settle = settleEffect(effects);
    expect(settle?.outcome).toBe('claim_won');
    expect(settle?.decidingSeq).toBe(3);
  });

  it('settlement never fires from an unconfirmed event', () => {
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(2, 0) }),
      mkEvent('goal', 2, { score: mkScore(3, 0), confirmed: false }),
    ]);
    expect(state.status).toBe('frozen');
    expect(state.pendingSettlement).toBeNull();
    expect(settleEffect(effects)).toBeUndefined();
  });
});

describe('reduceMarket — goal → VAR → discarded (the trust story)', () => {
  it('VAR check inside the debounce window cancels the candidate and locks calls', () => {
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(1, 1) }),
      mkEvent('goal', 3, { score: mkScore(2, 1) }),
      mkEvent('var_check', 4, { score: mkScore(2, 1) }),
    ]);
    expect(state.status).toBe('frozen');
    expect(state.pendingSettlement).toBeNull();
    expect(settleEffect(effects)).toBeUndefined();
    expect(effects.at(-1)).toEqual({ kind: 'freeze', reason: 'var' });
  });

  it('VAR ends, goal stands: unfreeze and re-arm settlement from the var_end evidence', () => {
    const varEnd = mkEvent('var_end', 5, { score: mkScore(2, 1) });
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(1, 1) }),
      mkEvent('goal', 3, { score: mkScore(2, 1) }),
      mkEvent('var_check', 4, { score: mkScore(2, 1) }),
      varEnd,
    ]);
    expect(effectKinds(effects)).toContain('unfreeze');
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    expect(state.pendingSettlement?.decidingSeq).toBe(5);
    expect(state.pendingSettlement?.evidenceSeqs).toEqual([1, 2, 3, 5]);

    const due = checkDebounce(state, debounceDeadline(varEnd));
    expect(due.state.status).toBe('settled');
    expect(settleEffect(due.effects)?.outcome).toBe('claim_won');
  });

  it('goal chalked off: discard cancels the candidate and the market never pays', () => {
    const { state: afterDiscard, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(1, 1) }),
      mkEvent('goal', 3, { score: mkScore(2, 1) }),
      mkEvent('var_check', 4, { score: mkScore(2, 1) }),
      mkEvent('goal_discarded', 5, {
        score: mkScore(1, 1),
        detail: { reversesSeq: 3 },
      }),
    ]);
    expect(settleEffect(effects)).toBeUndefined();
    expect(afterDiscard.pendingSettlement).toBeNull();
    expect(afterDiscard.status).toBe('open');

    // Match ends 1-1: the over-2.5 call loses.
    const fullTime = mkEvent('phase_change', 6, {
      phase: 'F',
      minute: 90,
      score: mkScore(1, 1),
    });
    const final = reduceMarket(afterDiscard, fullTime);
    expect(final.state.pendingSettlement?.outcome).toBe('claim_lost');
    const settled = checkDebounce(final.state, debounceDeadline(fullTime));
    expect(settleEffect(settled.effects)?.outcome).toBe('claim_lost');
  });

  it('discard without a preceding var_check also cancels a pending candidate', () => {
    const { state } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(2, 0) }),
      mkEvent('goal', 2, { score: mkScore(3, 0) }),
      mkEvent('goal_discarded', 3, {
        score: mkScore(2, 0),
        detail: { reversesSeq: 2 },
      }),
    ]);
    expect(state.pendingSettlement).toBeNull();
    expect(state.status).toBe('open');
  });
});

describe('reduceMarket — goal amended (scorer corrected)', () => {
  it('re-crediting the scorer cancels a player payout inside the window', () => {
    const state0 = mkState(MBAPPE_BRACE, { status: 'open' });
    const { state: pendingState } = run(state0, [
      mkEvent('goal', 1, {
        score: mkScore(1, 0),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
      mkEvent('goal', 2, {
        score: mkScore(2, 0),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
    ]);
    expect(pendingState.status).toBe('settling');
    expect(pendingState.pendingSettlement?.outcome).toBe('claim_won');

    // VAR-style correction: the second goal was actually Giroud's.
    const amend = mkEvent('goal_amended', 3, {
      score: mkScore(2, 0),
      detail: { participant: 1, playerNormativeId: 999, reversesSeq: 2 },
    });
    const amended = reduceMarket(pendingState, amend);
    expect(amended.state.pendingSettlement).toBeNull();
    expect(settleEffect(amended.effects)).toBeUndefined();

    // Full time at 2-0 — brace never happened, claim lost.
    const fullTime = mkEvent('phase_change', 4, {
      phase: 'F',
      minute: 90,
      score: mkScore(2, 0),
    });
    const final = reduceMarket(amended.state, fullTime);
    expect(final.state.pendingSettlement?.outcome).toBe('claim_lost');
  });

  it('an amend that flips team attribution reverses a match_winner candidate', () => {
    const { state } = run(mkState(WINNER_90), [
      mkEvent('goal', 10, { score: mkScore(1, 0), detail: { participant: 1 } }),
      mkEvent('phase_change', 11, { phase: 'F', minute: 90, score: mkScore(1, 0) }),
      mkEvent('goal_amended', 12, {
        phase: 'F',
        minute: 90,
        score: mkScore(0, 1),
        detail: { participant: 2, reversesSeq: 10 },
      }),
    ]);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_lost');
    expect(state.pendingSettlement?.decidingSeq).toBe(12);
  });
});

describe('reduceMarket — idempotency & isolation', () => {
  it('a duplicate seq is a no-op (never double-counts a goal)', () => {
    const goal = mkEvent('goal', 5, {
      score: mkScore(1, 0),
      detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
    });
    const once = reduceMarket(mkState(MBAPPE_BRACE), goal);
    const twice = reduceMarket(once.state, goal);
    expect(twice.effects).toEqual([]);
    expect(twice.state).toBe(once.state);

    // Tally stayed at 1: full time at 1-0 loses the brace claim.
    const fullTime = mkEvent('phase_change', 6, {
      phase: 'F',
      minute: 90,
      score: mkScore(1, 0),
    });
    const final = reduceMarket(twice.state, fullTime);
    expect(final.state.pendingSettlement?.outcome).toBe('claim_lost');
  });

  it('stale (lower-seq) events after a restart are ignored', () => {
    const { state } = run(mkState(OVER_25), [
      mkEvent('goal', 8, { score: mkScore(1, 0) }),
      mkEvent('goal', 4, { score: mkScore(9, 9) }),
    ]);
    expect(state.status).toBe('open');
    expect(state.pendingSettlement).toBeNull();
  });

  it('events for another fixture are ignored', () => {
    const result = reduceMarket(
      mkState(OVER_25),
      mkEvent('goal', 1, { fixtureId: OTHER_FIXTURE_ID, score: mkScore(5, 5) }),
    );
    expect(result.effects).toEqual([]);
    expect(result.state.status).toBe('open');
  });

  it('settled and voided markets never move again', () => {
    const goal3 = mkEvent('goal', 3, { score: mkScore(3, 0) });
    const { state } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(2, 0) }),
      goal3,
    ]);
    const settled = checkDebounce(state, debounceDeadline(goal3)).state;
    expect(settled.status).toBe('settled');
    const after = reduceMarket(
      settled,
      mkEvent('goal_discarded', 9, { score: mkScore(2, 0), detail: { reversesSeq: 3 } }),
    );
    expect(after.effects).toEqual([]);
    expect(after.state.status).toBe('settled');
  });
});

describe('reduceMarket — abandonment, postponement, coverage', () => {
  const fatalPhases = ['ABD', 'CAN', 'POST', 'COV_LOST'] as const;
  for (const phase of fatalPhases) {
    it(`${phase} voids the market`, () => {
      const { state, effects } = run(mkState(OVER_25), [
        mkEvent('goal', 1, { score: mkScore(1, 0) }),
        mkEvent('phase_change', 2, { phase, minute: null, score: mkScore(1, 0) }),
      ]);
      expect(state.status).toBe('voided');
      expect(effectKinds(effects)).toContain('void');
    });
  }

  it('abandonment voids even a market mid-debounce', () => {
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(2, 0) }),
      mkEvent('goal', 3, { score: mkScore(3, 0) }),
      mkEvent('phase_change', 4, { phase: 'ABD', minute: null, score: mkScore(3, 0) }),
    ]);
    expect(state.status).toBe('voided');
    expect(settleEffect(effects)).toBeUndefined();
  });

  it('a coverage warning voids affected markets', () => {
    const { state, effects } = run(mkState(OVER_25), [
      mkEvent('coverage_warning', 1, { score: mkScore(0, 0) }),
    ]);
    expect(state.status).toBe('voided');
    const voidEffect = effects.find((e) => e.kind === 'void');
    expect(voidEffect).toBeDefined();
  });
});

describe('reduceMarket — extra time & penalties (FT vs FT_90)', () => {
  /** 1-1 after 90; France wins 2-1 in extra time. */
  function etEvents(): MatchEvent[] {
    return [
      mkEvent('goal', 1, { minute: 20, score: mkScore(1, 0), detail: { participant: 1 } }),
      mkEvent('goal', 2, { minute: 70, score: mkScore(1, 1), detail: { participant: 2 } }),
      mkEvent('phase_change', 3, {
        phase: 'ET1',
        minute: 91,
        score: mkScore(1, 1, { p1Goals90: 1, p2Goals90: 1 }),
      }),
      mkEvent('goal', 4, {
        phase: 'ET2',
        minute: 108,
        score: mkScore(2, 1, { p1Goals90: 1, p2Goals90: 1 }),
        detail: { participant: 1 },
      }),
      mkEvent('phase_change', 5, {
        phase: 'FET',
        minute: 120,
        score: mkScore(2, 1, { p1Goals90: 1, p2Goals90: 1 }),
      }),
    ];
  }

  it('FT_90 win claim loses the moment extra time starts (draw in 90)', () => {
    const { state } = run(mkState(WINNER_90), etEvents().slice(0, 3));
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_lost');
    expect(state.pendingSettlement?.decidingSeq).toBe(3);
  });

  it('FT (advancing) claim wins at the end of extra time', () => {
    const { state, effects } = run(mkState(WINNER_FT), etEvents());
    // ET goal (seq 4) is a later event but must NOT settle an FT claim early —
    // there was no pending candidate (FT undecidable during ET).
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    expect(state.pendingSettlement?.decidingSeq).toBe(5);
    expect(settleEffect(effects)).toBeUndefined();
  });

  it('same stream settles FT_90 lost and FT won — the period rule in one match', () => {
    const lost90 = run(mkState(WINNER_90), etEvents());
    // The FT_90 candidate (created at ET1) was confirmed by the next event.
    expect(lost90.state.status).toBe('settled');
    expect(settleEffect(lost90.effects)?.outcome).toBe('claim_lost');

    const wonFt = run(mkState(WINNER_FT), etEvents());
    expect(wonFt.state.pendingSettlement?.outcome).toBe('claim_won');
  });

  it('FT claim level after pens voids honestly (advancing side not derivable)', () => {
    const { state, effects } = run(mkState(WINNER_FT), [
      mkEvent('phase_change', 1, {
        phase: 'FPE',
        minute: null,
        score: mkScore(2, 2, { p1Goals90: 1, p2Goals90: 1 }),
      }),
    ]);
    expect(state.status).toBe('voided');
    expect(effectKinds(effects)).toContain('void');
  });

  it('FT_90 claim in extra time without a 90-minute split voids at terminal', () => {
    const { state } = run(mkState(WINNER_90), [
      mkEvent('phase_change', 1, {
        phase: 'FET',
        minute: 120,
        score: mkScore(2, 1), // p1Goals90/p2Goals90 missing
      }),
    ]);
    expect(state.status).toBe('voided');
  });
});

describe('reduceMarket — own goals', () => {
  it('an own goal never credits a player claim', () => {
    const { state } = run(mkState(MBAPPE_BRACE), [
      mkEvent('goal', 1, {
        score: mkScore(1, 0),
        detail: {
          participant: 1,
          playerNormativeId: PLAYER_MBAPPE.normativeId,
          goalType: 'shot',
        },
      }),
      mkEvent('goal', 2, {
        score: mkScore(2, 0),
        detail: {
          participant: 1,
          playerNormativeId: PLAYER_MESSI.normativeId,
          goalType: 'own_goal',
        },
      }),
      mkEvent('phase_change', 3, { phase: 'F', minute: 90, score: mkScore(2, 0) }),
    ]);
    // One real Mbappé goal + one own goal: the brace claim loses.
    expect(state.pendingSettlement?.outcome).toBe('claim_lost');
  });

  it('own goals still count for team totals (they are in the feed score)', () => {
    const teamTwo = mkSpec({
      claimType: 'team_scores_n',
      entityRef: teamRef(1),
      comparator: 'gte',
      threshold: 2,
    });
    const { state } = run(mkState(teamTwo), [
      mkEvent('goal', 1, { score: mkScore(1, 0), detail: { participant: 1 } }),
      mkEvent('goal', 2, {
        score: mkScore(2, 0),
        detail: { participant: 1, goalType: 'own_goal' },
      }),
    ]);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
  });

  it('an amend that reclassifies a goal as an own goal drops the player credit', () => {
    const braceOne = mkSpec({ ...MBAPPE_BRACE, threshold: 1 });
    const { state } = run(mkState(braceOne), [
      mkEvent('goal', 1, {
        score: mkScore(1, 0),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
      mkEvent('goal_amended', 2, {
        score: mkScore(1, 0),
        detail: {
          participant: 1,
          playerNormativeId: PLAYER_MBAPPE.normativeId,
          goalType: 'own_goal',
          reversesSeq: 1,
        },
      }),
      mkEvent('phase_change', 3, { phase: 'F', minute: 90, score: mkScore(1, 0) }),
    ]);
    expect(state.pendingSettlement?.outcome).toBe('claim_lost');
  });
});

describe('reduceMarket — comeback anchor semantics', () => {
  const comeback = mkSpec({
    claimType: 'comeback',
    entityRef: teamRef(1),
    comparator: 'gte',
    threshold: 1,
    period: 'FT',
    anchor: { seq: 20, scoreP1: 0, scoreP2: 1 },
  });

  it('ignores events at or before the anchor seq', () => {
    const { state } = run(mkState(comeback), [
      mkEvent('goal', 15, { score: mkScore(0, 1), detail: { participant: 2 } }),
      mkEvent('goal', 20, { score: mkScore(0, 1), detail: { participant: 2 } }),
    ]);
    expect(state.status).toBe('open');
    expect(state.pendingSettlement).toBeNull();
  });

  it('settles won when the anchored side turns it around', () => {
    const fullTime = mkEvent('phase_change', 23, {
      phase: 'F',
      minute: 90,
      score: mkScore(2, 1),
    });
    const { state } = run(mkState(comeback), [
      mkEvent('goal', 21, { minute: 60, score: mkScore(1, 1), detail: { participant: 1 } }),
      mkEvent('goal', 22, { minute: 80, score: mkScore(2, 1), detail: { participant: 1 } }),
      fullTime,
    ]);
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    const settled = checkDebounce(state, debounceDeadline(fullTime));
    expect(settleEffect(settled.effects)?.outcome).toBe('claim_won');
  });

  it('a draw is not a comeback', () => {
    const { state } = run(mkState(comeback), [
      mkEvent('goal', 21, { minute: 60, score: mkScore(1, 1), detail: { participant: 1 } }),
      mkEvent('phase_change', 22, { phase: 'F', minute: 90, score: mkScore(1, 1) }),
    ]);
    expect(state.pendingSettlement?.outcome).toBe('claim_lost');
  });
});

describe('reduceMarket — delay-snipe guard & position activation', () => {
  it('voids pending taps placed after the on-pitch moment of a goal', () => {
    const goal = mkEvent('goal', 1, { minute: 30, score: mkScore(1, 0) });
    const sniper = mkPosition('sniper', { placedAtMs: goal.tsMs + 5_000 });
    const honest = mkPosition('honest', { placedAtMs: goal.tsMs - 5_000 });
    const { state, effects } = run(
      mkState(OVER_25, { positions: [sniper, honest] }),
      [goal],
    );
    const voided = effects.find(
      (e): e is Extract<MarketEffect, { kind: 'void_positions' }> =>
        e.kind === 'void_positions',
    );
    expect(voided?.positionIds).toEqual(['sniper']);
    expect(voided?.reason).toBe('delay_snipe');
    expect(state.positions.find((p) => p.id === 'sniper')?.state).toBe('void');
    expect(state.positions.find((p) => p.id === 'honest')?.state).toBe('pending');
  });

  it('a red card is also a price-moving snipe check', () => {
    const red = mkEvent('card', 1, {
      minute: 30,
      score: mkScore(0, 0),
      detail: { card: 'red', participant: 2 },
    });
    const sniper = mkPosition('sniper', { placedAtMs: red.tsMs + 1 });
    const { effects } = run(mkState(WINNER_90, { positions: [sniper] }), [red]);
    expect(effectKinds(effects)).toContain('void_positions');
  });

  it('a yellow card is not price-moving — no snipe voiding', () => {
    const yellow = mkEvent('card', 1, {
      minute: 30,
      score: mkScore(0, 0),
      detail: { card: 'yellow' },
    });
    const late = mkPosition('late', { placedAtMs: yellow.tsMs + 1 });
    const { state, effects } = run(mkState(WINNER_90, { positions: [late] }), [yellow]);
    expect(effectKinds(effects)).not.toContain('void_positions');
    expect(state.positions[0]?.state).toBe('pending');
  });

  it('taps that outlive the pending window activate on the next event', () => {
    const placed = KICKOFF_MS + 10_000;
    const position = mkPosition('patient', { placedAtMs: placed });
    const lateEvent = mkEvent('stat_update', 2, {
      tsMs: placed + PENDING_TAP_WINDOW_MS,
      receivedAtMs: placed + PENDING_TAP_WINDOW_MS + FEED_DELAY_MS,
      score: mkScore(0, 0),
    });
    const { state, effects } = run(mkState(OVER_25, { positions: [position] }), [
      lateEvent,
    ]);
    const activated = effects.find(
      (e): e is Extract<MarketEffect, { kind: 'activate_positions' }> =>
        e.kind === 'activate_positions',
    );
    expect(activated?.positionIds).toEqual(['patient']);
    expect(state.positions[0]?.state).toBe('active');
  });

  it('checkDebounce also matures pending taps by the clock', () => {
    const position = mkPosition('patient', { placedAtMs: KICKOFF_MS });
    const state = mkState(OVER_25, { positions: [position] });
    const early = checkDebounce(state, KICKOFF_MS + PENDING_TAP_WINDOW_MS - 1);
    expect(early.effects).toEqual([]);
    const due = checkDebounce(state, KICKOFF_MS + PENDING_TAP_WINDOW_MS);
    expect(effectKinds(due.effects)).toContain('activate_positions');
    expect(due.state.positions[0]?.state).toBe('active');
  });

  it('surviving pending taps activate when the market settles', () => {
    const goal = mkEvent('goal', 1, { score: mkScore(3, 0) });
    const survivor = mkPosition('survivor', { placedAtMs: goal.tsMs - 1_000 });
    const afterGoal = reduceMarket(
      mkState(OVER_25, { positions: [survivor] }),
      goal,
    );
    expect(afterGoal.state.positions[0]?.state).toBe('pending');
    const settled = checkDebounce(afterGoal.state, debounceDeadline(goal));
    expect(settled.state.status).toBe('settled');
    expect(effectKinds(settled.effects)).toContain('activate_positions');
    expect(settled.state.positions[0]?.state).toBe('active');
  });
});

describe('reduceMarket — freezes & cutoffs', () => {
  it('possible_event freezes immediately; the confirmed follow-up resolves it', () => {
    const flag = mkEvent('possible_event', 1, { confirmed: false, score: mkScore(0, 0) });
    const frozen = reduceMarket(mkState(WINNER_90), flag);
    expect(frozen.state.status).toBe('frozen');
    expect(frozen.effects).toContainEqual({ kind: 'freeze', reason: 'possible_event' });

    const confirmedGoal = mkEvent('goal', 2, {
      score: mkScore(1, 0),
      detail: { participant: 1 },
    });
    const resolved = reduceMarket(frozen.state, confirmedGoal);
    expect(resolved.state.status).toBe('open');
    expect(effectKinds(resolved.effects)).toContain('unfreeze');
  });

  it('an unconfirmed goal freezes like a possible event', () => {
    const ghostGoal = mkEvent('goal', 1, { confirmed: false, score: mkScore(1, 0) });
    const { state, effects } = run(mkState(OVER_25), [ghostGoal]);
    expect(state.status).toBe('frozen');
    expect(effects).toContainEqual({ kind: 'freeze', reason: 'possible_event' });
  });

  it('odds suspension freezes and its lift unfreezes', () => {
    const suspend = mkEvent('odds_suspension', 1, { score: mkScore(0, 0) });
    const resume = mkEvent('odds_suspension', 2, { confirmed: false, score: mkScore(0, 0) });
    const frozen = reduceMarket(mkState(WINNER_90), suspend);
    expect(frozen.state.status).toBe('frozen');
    expect(frozen.effects).toContainEqual({ kind: 'freeze', reason: 'odds_suspension' });
    const lifted = reduceMarket(frozen.state, resume);
    expect(lifted.state.status).toBe('open');
    expect(effectKinds(lifted.effects)).toContain('unfreeze');
  });

  it('settlement still proceeds under an odds-suspension freeze', () => {
    const { state } = run(mkState(OVER_25), [
      mkEvent('odds_suspension', 1, { score: mkScore(2, 0) }),
      mkEvent('goal', 2, { score: mkScore(3, 0) }),
    ]);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
  });

  it('the 85-minute cutoff freezes staking permanently', () => {
    const cutoff = mkEvent('stat_update', 1, { minute: 85, score: mkScore(0, 0) });
    const frozen = reduceMarket(mkState(WINNER_90), cutoff);
    expect(frozen.state.status).toBe('frozen');
    expect(frozen.effects).toContainEqual({ kind: 'freeze', reason: 'cutoff' });

    // A VAR cycle after the cutoff must not reopen staking.
    const varCheck = mkEvent('var_check', 2, { minute: 87, score: mkScore(0, 0) });
    const varEnd = mkEvent('var_end', 3, { minute: 88, score: mkScore(0, 0) });
    const afterVar = run(frozen.state, [varCheck, varEnd]);
    expect(afterVar.state.status).toBe('frozen');
    expect(effectKinds(afterVar.effects)).not.toContain('unfreeze');
  });

  it('a cutoff-frozen market still settles at full time', () => {
    const fullTime = mkEvent('phase_change', 2, {
      phase: 'F',
      minute: 90,
      score: mkScore(1, 0),
    });
    const { state } = run(mkState(WINNER_90), [
      mkEvent('stat_update', 1, { minute: 86, score: mkScore(1, 0) }),
      fullTime,
    ]);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
  });

  it('a goal under an open VAR doubt does not settle until the doubt resolves', () => {
    const { state } = run(mkState(OVER_25), [
      mkEvent('goal', 1, { score: mkScore(1, 0) }),
      mkEvent('goal', 2, { score: mkScore(2, 0) }),
      mkEvent('var_check', 3, { score: mkScore(2, 0) }),
    ]);
    expect(state.status).toBe('frozen');
    // A goal event arriving mid-VAR: tracked, but no settlement is armed until
    // the VAR verdict lands.
    const midVarGoal = mkEvent('goal', 4, { score: mkScore(3, 0) });
    const next = reduceMarket(state, midVarGoal);
    expect(next.state.pendingSettlement).toBeNull();
    expect(next.state.status).toBe('frozen');

    const verdict = mkEvent('var_end', 5, { score: mkScore(3, 0) });
    const after = reduceMarket(next.state, verdict);
    expect(after.state.status).toBe('settling');
    expect(after.state.pendingSettlement?.outcome).toBe('claim_won');
  });

  it('player markets freeze for staking at kickoff', () => {
    const kickoff = mkEvent('phase_change', 1, { phase: 'H1', minute: 0, score: mkScore(0, 0) });
    const { state, effects } = run(mkState(MBAPPE_BRACE), [kickoff]);
    expect(state.status).toBe('frozen');
    expect(effects).toContainEqual({ kind: 'freeze', reason: 'cutoff' });
  });
});

describe('reduceMarket — pending_lineup lifecycle', () => {
  const pendingLineup = mkState(
    mkSpec({
      claimType: 'player_scores_n',
      entityRef: playerRef(null),
      comparator: 'gte',
      threshold: 1,
      trustTier: 'oracle_resolved',
    }),
    { status: 'pending_lineup', positions: [mkPosition('early-tap')] },
  );

  it('activates and binds the side when the lineup names the player', () => {
    const lineup = mkEvent('lineup', 1, {
      phase: 'NS',
      minute: null,
      score: mkScore(0, 0),
      detail: { playerNormativeId: PLAYER_MBAPPE.normativeId, participant: 1 },
    });
    const { state, effects } = run(pendingLineup, [lineup]);
    expect(state.status).toBe('open');
    expect(effectKinds(effects)).toContain('activate_market');
    expect(state.spec.entityRef.participant).toBe(1);
    // Pre-kickoff taps activate with the market.
    expect(effectKinds(effects)).toContain('activate_positions');
    expect(state.positions[0]?.state).toBe('active');
  });

  it('a lineup naming someone else does not activate', () => {
    const lineup = mkEvent('lineup', 1, {
      phase: 'NS',
      minute: null,
      score: mkScore(0, 0),
      detail: { playerNormativeId: 12345, participant: 1 },
    });
    const { state } = run(pendingLineup, [lineup]);
    expect(state.status).toBe('pending_lineup');
  });

  it('voids with refunds when kickoff arrives without the player (DNP)', () => {
    const kickoff = mkEvent('phase_change', 2, {
      phase: 'H1',
      minute: 0,
      score: mkScore(0, 0),
    });
    const { state, effects } = run(pendingLineup, [kickoff]);
    expect(state.status).toBe('voided');
    expect(effectKinds(effects)).toContain('void');
  });

  it('a postponement voids a pending_lineup market too', () => {
    const postponed = mkEvent('phase_change', 1, {
      phase: 'POST',
      minute: null,
      score: mkScore(0, 0),
    });
    const { state } = run(pendingLineup, [postponed]);
    expect(state.status).toBe('voided');
  });
});

describe('reduceMarket — live narration hooks', () => {
  it('emits a reprice hint on a goal that does not settle the market', () => {
    const { effects } = run(mkState(WINNER_90), [
      mkEvent('goal', 1, { score: mkScore(1, 0), detail: { participant: 1 } }),
    ]);
    expect(effectKinds(effects)).toContain('reprice_hint');
  });

  it('does not emit reprice hints once frozen', () => {
    const { effects } = run(mkState(WINNER_90), [
      mkEvent('stat_update', 1, { minute: 86, score: mkScore(0, 0) }),
      mkEvent('goal', 2, { minute: 87, score: mkScore(1, 0), detail: { participant: 1 } }),
    ]);
    const kinds = effectKinds(effects.slice(1));
    expect(kinds).not.toContain('reprice_hint');
  });
});

describe('reduceMarket — full-match adversarial storylines', () => {
  it('goal burst → VAR chaos → late equalizer: under-2.5 survives it all', () => {
    // Under 2.5: goals at 10 and 40, a third goal at 80 chalked off by VAR,
    // full time at 2-1... wait — 1-1 then a disallowed second for team 1.
    const events: MatchEvent[] = [
      mkEvent('goal', 1, { minute: 10, score: mkScore(1, 0), detail: { participant: 1 } }),
      mkEvent('goal', 2, { minute: 40, score: mkScore(1, 1), detail: { participant: 2 } }),
      mkEvent('goal', 3, { minute: 80, score: mkScore(2, 1), detail: { participant: 1 } }),
      mkEvent('var_check', 4, { minute: 80, score: mkScore(2, 1) }),
      mkEvent('goal_discarded', 5, {
        minute: 82,
        score: mkScore(1, 1),
        detail: { reversesSeq: 3 },
      }),
      mkEvent('phase_change', 6, { phase: 'F', minute: 90, score: mkScore(1, 1) }),
    ];
    const under = run(mkState(UNDER_25), events);
    expect(under.state.pendingSettlement?.outcome).toBe('claim_won');

    const over = run(mkState(OVER_25), events);
    expect(over.state.pendingSettlement?.outcome).toBe('claim_lost');
    // The over market armed claim_won at seq 3, then VAR cancelled it —
    // no settle effect ever fired before full time.
    expect(settleEffect(over.effects)).toBeUndefined();
  });

  it('btts: early goal, own-goal equalizer, settles won mid-match', () => {
    const btts = mkSpec({ claimType: 'btts', comparator: 'gte', threshold: 1 });
    const secondGoal = mkEvent('goal', 2, {
      minute: 55,
      score: mkScore(1, 1),
      detail: { participant: 2, goalType: 'own_goal' },
    });
    const { state } = run(mkState(btts), [
      mkEvent('goal', 1, { minute: 12, score: mkScore(1, 0), detail: { participant: 1 } }),
      secondGoal,
    ]);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    const settled = checkDebounce(state, debounceDeadline(secondGoal));
    expect(settled.state.status).toBe('settled');
  });

  it('a player brace with an amend war settles on the corrected tally', () => {
    const events: MatchEvent[] = [
      mkEvent('goal', 1, {
        minute: 15,
        score: mkScore(1, 0),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
      // Initially credited to Giroud…
      mkEvent('goal', 2, {
        minute: 60,
        score: mkScore(2, 0),
        detail: { participant: 1, playerNormativeId: 999 },
      }),
      // …then amended to Mbappé: the brace completes on the amend.
      mkEvent('goal_amended', 3, {
        minute: 61,
        score: mkScore(2, 0),
        detail: {
          participant: 1,
          playerNormativeId: PLAYER_MBAPPE.normativeId,
          reversesSeq: 2,
        },
      }),
    ];
    const { state } = run(mkState(MBAPPE_BRACE), events);
    expect(state.status).toBe('settling');
    expect(state.pendingSettlement?.outcome).toBe('claim_won');
    expect(state.pendingSettlement?.decidingSeq).toBe(3);
  });

  it('FT_90 player brace: an extra-time goal does not complete it', () => {
    const events: MatchEvent[] = [
      mkEvent('goal', 1, {
        minute: 15,
        score: mkScore(1, 0),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
      mkEvent('phase_change', 2, {
        phase: 'ET1',
        minute: 91,
        score: mkScore(1, 1, { p1Goals90: 1, p2Goals90: 1 }),
      }),
      mkEvent('goal', 3, {
        phase: 'ET2',
        minute: 105,
        score: mkScore(2, 1, { p1Goals90: 1, p2Goals90: 1 }),
        detail: { participant: 1, playerNormativeId: PLAYER_MBAPPE.normativeId },
      }),
    ];
    const { state } = run(mkState(MBAPPE_BRACE), events);
    // The FT_90 brace claim armed claim_lost when regulation ended 1-1 with a
    // single Mbappé goal; the ET goal (a later event) confirmed that candidate.
    expect(state.status).toBe('settled');
  });
});
