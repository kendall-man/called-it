/**
 * Throttle and fail-open state for streaming Callie's in-progress reply to a
 * private chat with Telegram's `sendMessageDraft` (the native "Thinking…"
 * draft preview). Pure decision logic so it stays unit-testable; the telegram
 * channel owns the actual Bot API call. Drafts are ephemeral ~30s previews,
 * so the channel's default `message.completed` send remains the source of
 * truth and every failure here only stops future draft attempts.
 */

/** Telegram's documented `sendMessageDraft` text cap. */
export const DRAFT_TEXT_MAX_CHARS = 4096;

/** Minimum gap between draft calls per chat. The first delta always sends. */
export const DRAFT_THROTTLE_MS = 1000;

export interface DraftSend {
  /** Non-zero id Telegram uses to animate successive updates of one draft. */
  readonly draftId: number;
  readonly text: string;
}

interface ChatDraftState {
  draftId: number;
  lastSentAtMs: number;
  turnId: string;
}

/**
 * `sendMessageDraft` only exists for private chats. Unknown chat types pass
 * because the channel only starts sessions for private conversational
 * messages; a wrong guess still fails open via the planner's disable path.
 */
export function isPrivateDraftTarget(
  chatType: string | null | undefined,
): boolean {
  return chatType === undefined || chatType === null || chatType === 'private';
}

/**
 * The Bot API declares the draft `chat_id` as Integer while eve's handle
 * carries a string. Non-numeric ids are passed through for Telegram to reject.
 */
export function draftChatId(chatId: string): number | string {
  const numeric = Number(chatId);
  return Number.isSafeInteger(numeric) ? numeric : chatId;
}

export class DraftStreamPlanner {
  private disabled = false;
  private disableLogged = false;
  private nextDraftId = 1;
  private readonly chats = new Map<string, ChatDraftState>();

  /**
   * Decides whether this delta reaches Telegram now. Returns the draft to
   * send, or null when streaming is disabled or the chat is inside its
   * throttle window. A new turn in a known chat rotates the draft id (so a
   * fresh reply does not animate out of the previous one) but keeps the
   * chat's window: the per-chat rate cap outranks per-turn eagerness.
   */
  plan(
    chatKey: string,
    turnId: string,
    messageSoFar: string,
    nowMs: number,
  ): DraftSend | null {
    if (this.disabled) return null;
    let chat = this.chats.get(chatKey);
    if (chat === undefined) {
      chat = {
        draftId: this.allocateDraftId(),
        lastSentAtMs: Number.NEGATIVE_INFINITY,
        turnId,
      };
      this.chats.set(chatKey, chat);
    } else if (chat.turnId !== turnId) {
      chat.draftId = this.allocateDraftId();
      chat.turnId = turnId;
    }
    if (nowMs - chat.lastSentAtMs < DRAFT_THROTTLE_MS) return null;
    chat.lastSentAtMs = nowMs;
    return {
      draftId: chat.draftId,
      text: messageSoFar.slice(0, DRAFT_TEXT_MAX_CHARS),
    };
  }

  /**
   * Any draft failure (method unavailable, network, HTTP error) turns
   * streaming off for the process lifetime. Returns true exactly once so the
   * caller logs a single line instead of one per delta.
   */
  disable(): boolean {
    this.disabled = true;
    this.chats.clear();
    if (this.disableLogged) return false;
    this.disableLogged = true;
    return true;
  }

  isDisabled(): boolean {
    return this.disabled;
  }

  /** Drops a chat's throttle state once its turn completes. */
  complete(chatKey: string): void {
    this.chats.delete(chatKey);
  }

  private allocateDraftId(): number {
    const id = this.nextDraftId;
    this.nextDraftId += 1;
    return id;
  }
}

/** Process-wide planner shared by the telegram channel's event handlers. */
export const telegramDraftPlanner = new DraftStreamPlanner();
