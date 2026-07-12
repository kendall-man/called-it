/**
 * Composes chat cards from database rows (shared by the stake handlers and
 * the settler so a card edit always reflects persisted state).
 */

import type { Deps, MarketRow, PositionRow } from '../ports.js';
import type { PositionParticipant } from '../ports/rows.js';
import { claimCardText, type SideTally } from '../bot/cards.js';
import type { ParticipantIdentity } from '../points/presentation.js';
import { computePots } from '../wager/pot.js';

const PARTICIPANTS_PER_SIDE_LIMIT = 5;

/** Card tallies over non-void positions (a fresh in-play tap shows at once). */
export function tally(positions: PositionRow[]): { back: SideTally; doubt: SideTally } {
  const back: SideTally = { count: 0, stakeLamports: 0n };
  const doubt: SideTally = { count: 0, stakeLamports: 0n };
  for (const position of positions) {
    if (position.state === 'void') continue;
    const side = position.side === 'back' ? back : doubt;
    side.count += 1;
    side.stakeLamports += BigInt(position.stake);
  }
  return { back, doubt };
}

export function receiptUrl(deps: Deps, marketId: string): string {
  return `${deps.env.WEB_BASE_URL}/r/${marketId}`;
}

export function tableUrl(deps: Deps, slug: string): string {
  return `${deps.env.WEB_BASE_URL}/g/${slug}`;
}

export interface ComposedCard {
  chatId: number;
  messageId: number | null;
  text: string;
}

function participantKey(value: PositionParticipant): string {
  return `${value.user_id}:${value.side}`;
}

type ParticipantSides = {
  readonly back: readonly ParticipantIdentity[];
  readonly doubt: readonly ParticipantIdentity[];
  readonly backCount: number;
  readonly doubtCount: number;
};

function participantSides(
  participants: readonly PositionParticipant[],
  market: Pick<MarketRow, 'id' | 'group_id'>,
): ParticipantSides {
  const back: ParticipantIdentity[] = [];
  const doubt: ParticipantIdentity[] = [];
  const seen = new Set<string>();
  let backCount = 0;
  let doubtCount = 0;
  for (const participant of participants) {
    if (participant.market_id !== market.id || participant.group_id !== market.group_id) continue;
    if (participant.side === 'back') {
      backCount = participant.participant_count;
    } else {
      doubtCount = participant.participant_count;
    }
    const key = participantKey(participant);
    if (seen.has(key)) continue;
    seen.add(key);
    const side = participant.side === 'back' ? back : doubt;
    if (side.length < PARTICIPANTS_PER_SIDE_LIMIT) {
      side.push({
        username: participant.username,
        displayName: participant.display_name,
      });
    }
  }
  return {
    back,
    doubt,
    backCount,
    doubtCount,
  };
}

export async function composeClaimCard(deps: Deps, market: MarketRow): Promise<ComposedCard | null> {
  const [claim, positions, group, participants] = await Promise.all([
    deps.db.getClaim(market.claim_id),
    deps.db.positionsForMarket(market.id),
    deps.db.getGroup(market.group_id),
    deps.db.positionParticipantsForMarket(market.id),
  ]);
  if (!claim || !group) return null;
  const nonVoid = positions.filter((p) => p.state !== 'void');
  const claimer = await deps.db.getUser(claim.claimer_user_id);
  const identities = participantSides(participants, market);
  const { back, doubt } = tally(nonVoid);
  const pots = computePots(nonVoid, market.quote_probability);
  const footer = deps.wager?.cardFooter();
  const text = claimCardText({
    quotedText: claim.quoted_text,
    claimerName: claimer?.display_name ?? 'the claimer',
    spec: market.spec,
    status: market.status,
    probability: market.quote_probability,
    provenance: market.price_provenance,
    back,
    doubt,
    backParticipants: identities.back,
    doubtParticipants: identities.doubt,
    backParticipantCount: identities.backCount,
    doubtParticipantCount: identities.doubtCount,
    matchedPct: pots.matchedPct,
    isReplay: market.is_replay,
    receiptUrl: receiptUrl(deps, market.id),
    ...(footer !== undefined ? { footer } : {}),
  });
  return { chatId: market.group_id, messageId: market.card_tg_message_id, text };
}
