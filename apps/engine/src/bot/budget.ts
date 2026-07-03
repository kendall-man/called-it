/**
 * Per-group daily LLM budget (PRD story 51): when a group burns through its
 * allowance the bot degrades in character to trigger-only behavior for the
 * rest of the UTC day. Counting model calls is a good-enough cost proxy.
 */

import { ENGINE } from '../engineConstants.js';

export class LlmBudget {
  private day = '';
  private counts = new Map<number, number>();

  constructor(
    private readonly maxPerDay: number = ENGINE.MAX_LLM_CALLS_PER_GROUP_PER_DAY,
    private readonly now: () => number = Date.now,
  ) {}

  /** Registers one intended model call; false = budget exhausted, skip it. */
  allow(groupId: number): boolean {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }
    const used = this.counts.get(groupId) ?? 0;
    if (used >= this.maxPerDay) return false;
    this.counts.set(groupId, used + 1);
    return true;
  }
}
