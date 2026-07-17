import { describe, expect, it } from 'vitest';
import {
  DRAFT_TEXT_MAX_CHARS,
  DRAFT_THROTTLE_MS,
  DraftStreamPlanner,
  draftChatId,
  isPrivateDraftTarget,
} from './draft-stream.js';

const CHAT = '881234';
const TURN = 'turn-1';
const START_MS = 5_000;

describe('draft stream planner', () => {
  it('sends the first delta immediately', () => {
    // Given a chat with no draft history
    const planner = new DraftStreamPlanner();

    // When the first assistant delta arrives
    const send = planner.plan(CHAT, TURN, 'On it', START_MS);

    // Then a draft goes out at once with a non-zero id
    expect(send).toEqual({ draftId: 1, text: 'On it' });
  });

  it('throttles deltas inside the per-chat window', () => {
    // Given a chat that just sent a draft
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'On it', START_MS);

    // When another delta lands before the window elapses
    const send = planner.plan(
      CHAT,
      TURN,
      'On it, checking',
      START_MS + DRAFT_THROTTLE_MS - 1,
    );

    // Then no draft call is made
    expect(send).toBeNull();
  });

  it('sends the latest text once the window elapses', () => {
    // Given a throttled chat
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'On it', START_MS);
    planner.plan(CHAT, TURN, 'On it, checking', START_MS + 1);

    // When a delta lands at the window boundary
    const send = planner.plan(
      CHAT,
      TURN,
      'On it, checking the feed',
      START_MS + DRAFT_THROTTLE_MS,
    );

    // Then the same draft animates forward with the full text so far
    expect(send).toEqual({ draftId: 1, text: 'On it, checking the feed' });
  });

  it('throttles per chat, not globally', () => {
    // Given one chat that just sent a draft
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'On it', START_MS);

    // When a different chat's first delta arrives inside that window
    const send = planner.plan('99777', 'turn-9', 'Hi there', START_MS + 10);

    // Then the second chat streams immediately with its own draft id
    expect(send).toEqual({ draftId: 2, text: 'Hi there' });
  });

  it('truncates draft text to the Telegram cap', () => {
    // Given a reply longer than one Telegram message
    const planner = new DraftStreamPlanner();
    const oversized = 'a'.repeat(DRAFT_TEXT_MAX_CHARS + 500);

    // When it is planned as a draft
    const send = planner.plan(CHAT, TURN, oversized, START_MS);

    // Then the text is cut to the documented cap
    expect(send?.text).toHaveLength(DRAFT_TEXT_MAX_CHARS);
  });

  it('rotates the draft id for a new turn but keeps the chat window', () => {
    // Given a chat mid-window from a previous turn
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'First reply', START_MS);

    // When the next turn's first delta arrives inside the window
    const throttled = planner.plan(
      CHAT,
      'turn-2',
      'Second reply',
      START_MS + 200,
    );
    // And again after the window elapses
    const sent = planner.plan(
      CHAT,
      'turn-2',
      'Second reply, longer',
      START_MS + DRAFT_THROTTLE_MS,
    );

    // Then the per-chat cap holds and the new turn gets a fresh draft id
    expect(throttled).toBeNull();
    expect(sent).toEqual({ draftId: 2, text: 'Second reply, longer' });
  });

  it('prunes chat state on completion', () => {
    // Given a chat whose turn completed right after a draft
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'First reply', START_MS);
    planner.complete(CHAT);

    // When the next turn's first delta arrives inside the old window
    const send = planner.plan(CHAT, 'turn-2', 'Second reply', START_MS + 100);

    // Then the pruned chat streams immediately again
    expect(send).toEqual({ draftId: 2, text: 'Second reply' });
  });

  it('disables permanently after a failure and logs once', () => {
    // Given a chat that streamed one draft
    const planner = new DraftStreamPlanner();
    planner.plan(CHAT, TURN, 'On it', START_MS);

    // When a draft call fails
    const firstDisable = planner.disable();
    const laterDisable = planner.disable();

    // Then only the first failure asks for a log line
    expect(firstDisable).toBe(true);
    expect(laterDisable).toBe(false);

    // And no further deltas plan a draft, ever
    expect(planner.isDisabled()).toBe(true);
    expect(
      planner.plan(CHAT, 'turn-2', 'Hello again', START_MS + 60_000),
    ).toBeNull();
  });
});

describe('draft target guard', () => {
  it.each([
    { chatType: 'private', expected: true },
    { chatType: 'group', expected: false },
    { chatType: 'supergroup', expected: false },
    { chatType: 'channel', expected: false },
    { chatType: null, expected: true },
    { chatType: undefined, expected: true },
  ])('chat type $chatType → $expected', ({ chatType, expected }) => {
    expect(isPrivateDraftTarget(chatType)).toBe(expected);
  });
});

describe('draft chat id', () => {
  it('converts numeric ids to the Integer the Bot API declares', () => {
    expect(draftChatId('881234')).toBe(881_234);
    expect(draftChatId('-1001234567890')).toBe(-1_001_234_567_890);
  });

  it('passes non-numeric ids through unchanged', () => {
    expect(draftChatId('not-a-chat-id')).toBe('not-a-chat-id');
  });
});
