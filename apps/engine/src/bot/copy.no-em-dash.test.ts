/**
 * Product-owner rule: no em dashes (—) or en dashes (–) in user-facing engine
 * copy. This guards the rendered output of every touched copy surface so the
 * ban cannot regress. Code comments are out of scope (they never reach chat).
 */

import { describe, expect, it } from 'vitest';
import type { MarketSpec, MarketStatus, SettlementOutcome } from '@calledit/market-engine';
import {
  FALLBACK_TEMPLATES,
  renderFallback,
  type CopyVars,
  type TemplateKey,
} from './copy.js';
import {
  CLAIM_DECLINED_LINE,
  CLAIM_EXPIRED_LINE,
  FAIR_PLAY_PENDING_LINE,
  describeTerms,
  outcomeLine,
  readingCardText,
  skeletonCardText,
  statusLine,
  trustTierLine,
} from './cards.js';
import {
  STAKE_BACK_LABEL,
  confirmButtonLabel,
  settlementPingText,
  signButtonLabel,
  stepperNote,
} from './stake-step-cards.js';
import {
  escrowApprovalLapsedDmText,
  escrowOpsDeadLetterAlertText,
  escrowOpsRuntimeAlertText,
  escrowPlacementRejectionText,
  escrowSigningPrompt,
  type EscrowPlacementRejectionCode,
} from './escrow-ux.js';
import { createWagerCopy } from '../wager/copy.js';

const DASHES = /[–—]/u;

// Clean vars: SAMPLE inputs never inject a dash of their own so the assertion
// tests the TEMPLATE copy, not a caller-supplied string.
const CLEAN_VARS: CopyVars = {
  webUrl: 'https://example.test',
  addLink: 'https://t.me/callit_bot?startgroup=calledit_v1',
  claimer: 'Dee',
  probabilityPct: 9,
  question: 'in 90 minutes, or advancing on pens?',
  reason: 'on-chain stats are team-level.',
  message: "Can't ground that fixture today.",
  terms: 'France to score 2 or more goals (90 minutes)',
  multiplier: '9',
  scorer: 'Mbappe',
  minute: 63,
  note: '2 open calls are feeling it.',
  payouts: 'Dee collects 0.01 test SOL.',
  names: '@mark',
  balance: 40,
  cap: 100,
  name: 'Ana',
  side: 'Backing',
  stake: 50,
  summary: 'priced nudges are on',
  groupTitle: 'Sunday Legends',
  fixture: 'France vs Brazil',
  speed: '20',
  p1: 'France',
  p2: 'Brazil',
  offer: 'the upgrade',
  call: 'France to win',
};

const SPEC: MarketSpec = {
  claimType: 'match_winner',
  fixtureId: 42,
  entityRef: { kind: 'team', participant: 1, name: 'France' },
  comparator: 'gte',
  threshold: 1,
  period: 'FT_90',
  trustTier: 'oracle_resolved',
};

const STATUSES: readonly MarketStatus[] = [
  'pending_lineup', 'open', 'frozen', 'settling', 'settled', 'voided',
];
const OUTCOMES: readonly SettlementOutcome[] = ['claim_won', 'claim_lost', 'void'];

describe('no em or en dashes in user-facing engine copy', () => {
  it('renders every fallback template dash-free on both networks', () => {
    const keys = Object.keys(FALLBACK_TEMPLATES) as TemplateKey[];
    for (const key of keys) {
      for (const network of ['devnet', 'mainnet-beta'] as const) {
        const rendered = renderFallback(key, CLEAN_VARS, network);
        expect(rendered, `${key} (${network})`).not.toMatch(DASHES);
      }
    }
  });

  it('renders card, board, and stepper copy dash-free', () => {
    const lines: string[] = [
      FAIR_PLAY_PENDING_LINE,
      CLAIM_DECLINED_LINE,
      CLAIM_EXPIRED_LINE,
      STAKE_BACK_LABEL,
      describeTerms(SPEC),
      trustTierLine('chain_proven'),
      trustTierLine('oracle_resolved'),
      stepperNote('France to win', '0.02 SOL'),
      signButtonLabel('0.02 SOL'),
      confirmButtonLabel('0.02 SOL'),
      skeletonCardText({ quotedText: 'France win it', claimerName: 'Dee', isReplay: false }),
      readingCardText({ quotedText: 'France win it', claimerName: 'Dee', isReplay: true }),
    ];
    for (const asset of ['sol', 'usdc'] as const) {
      for (const status of STATUSES) lines.push(statusLine(status, asset));
      for (const outcome of OUTCOMES) {
        lines.push(outcomeLine(outcome, 'Dee', asset));
        lines.push(settlementPingText(outcome, 'https://example.test/r/abc'));
      }
    }
    for (const line of lines) expect(line).not.toMatch(DASHES);
  });

  it('renders wager money copy dash-free on both networks', () => {
    for (const network of ['devnet', 'mainnet-beta'] as const) {
      const copy = createWagerCopy(network, 'sol');
      const lines: string[] = [
        copy.unlinkedOnboarding(),
        copy.paused(),
        copy.marketClosed(),
        copy.starterUnavailable(),
        copy.budgetExhausted(),
        copy.walletRequired(),
        copy.insufficient(1_000n),
        copy.pickALane(),
        copy.capReached(100_000_000n),
        copy.stakePlaced('Ana', 'It happens', 10_000_000n, '2'),
        copy.stakeReplayed(),
        copy.staleTap(),
        copy.confirmationPrompt('Ana', 'It happens', 10_000_000n, '2', describeTerms(SPEC)),
        copy.confirmationSent(),
        copy.confirmationCancelled(),
        copy.confirmationExpired(),
        copy.walletSetupReady(),
        copy.walletStatus('SoLPubKey1111111111111111111111111111111111', 10_000_000n),
        copy.groupAssetStatus(),
        copy.depositInstructions('TreaSuryPubKey11111111111111111111111111111', true),
        copy.depositInstructions('TreaSuryPubKey11111111111111111111111111111', false),
        copy.depositCredited('Ana', 10_000_000n, 20_000_000n),
        copy.withdrawUsage(),
        copy.withdrawQueued(10_000_000n),
        copy.withdrawFailed('Ana', 10_000_000n),
        copy.cardFooter(),
        copy.payoutsLineVoid(),
        copy.payoutsLineNone(),
        copy.opsSolvencyAlert(1_000n, 2_000n),
        copy.opsSolvencyRecovered(),
      ];
      for (const line of lines) expect(line, network).not.toMatch(DASHES);
    }
  });

  it('renders escrow ops and signing copy dash-free', () => {
    const codes: readonly EscrowPlacementRejectionCode[] = [
      'callback_expired', 'market_closed', 'paused', 'wallet_required',
      'amount_out_of_range', 'temporarily_unavailable',
    ];
    const lines: string[] = [
      escrowApprovalLapsedDmText(),
      escrowOpsDeadLetterAlertText('user_signature_expired'),
      escrowOpsRuntimeAlertText('oracle_threshold_unavailable'),
      escrowOpsRuntimeAlertText('indexer_lagging'),
      escrowOpsRuntimeAlertText('rpc_unavailable'),
      escrowOpsRuntimeAlertText('something_else'),
      escrowSigningPrompt({
        network: 'devnet', side: 'back', asset: 'sol',
        amountAtomic: 10_000_000n, expiresAt: '2026-07-19T00:00:00.000Z', replay: true,
      }),
      ...codes.map((code) => escrowPlacementRejectionText(code)),
    ];
    for (const line of lines) expect(line).not.toMatch(DASHES);
  });
});
