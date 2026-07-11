import { describe, expect, it } from 'vitest';
import {
  claimGroupReadiness,
  groupBoardUrl,
  groupInstallUrl,
  planGroupReadiness,
  readyMessageForGroup,
  type GroupReadyMarkerStore,
} from './onboarding.js';

describe('group onboarding', () => {
  it('plans exactly one ready message when Telegram delivers group readiness twice', async () => {
    // Given the database returns a created marker once and then its duplicate decision
    const decisions = [true, false];
    const store: GroupReadyMarkerStore = {
      async markGroupReady() {
        const created = decisions.shift();
        if (created === undefined) throw new Error('unexpected ready marker call');
        return {
          ok: true,
          created,
          groupId: -100123,
          onboardingVersion: 'calledit_v1',
        };
      },
    };
    const input = {
      store,
      group: { id: -100123, slug: 'sunday-legends' },
      webBaseUrl: 'https://calledit.example',
    };

    // When the group start/admin update is processed twice
    const first = await planGroupReadiness(input);
    const duplicate = await planGroupReadiness(input);

    // Then only the database-winning update yields a ready post
    expect(first).toEqual({
      kind: 'post_ready',
      text:
        'Called It is ready. Say a football call, mention me, or reply /bookit to your own message. Each offer has two fixed 0.01 test-SOL choices: "It happens" or "It does not." Test SOL is devnet-only with no monetary value. Board: https://calledit.example/g/sunday-legends',
    });
    expect(duplicate).toEqual({ kind: 'already_ready' });
  });

  it('uses the canonical least-privilege group install URL and encodes board slugs', () => {
    // Given a bot username and a group alias containing URL-reserved characters
    const username = 'calledit_bot';

    // When installation and board URLs are composed
    const install = groupInstallUrl(username);
    const board = groupBoardUrl('https://calledit.example/', 'group / ?');

    // Then neither URL grants extra bot permissions or changes the board path
    expect(install).toBe('https://t.me/calledit_bot?startgroup=calledit_v1');
    expect(install).not.toContain('admin=');
    expect(board).toBe('https://calledit.example/g/group%20%2F%20%3F');
  });

  it('keeps the durable marker decision separate from deterministic outbound content', async () => {
    // Given a marker store that already recorded this group/version
    const store: GroupReadyMarkerStore = {
      async markGroupReady() {
        return { ok: true, created: false, groupId: -100123, onboardingVersion: 'calledit_v1' };
      },
    };

    // When a durable ingress worker retries the lifecycle update
    const marker = await claimGroupReadiness(store, -100123);
    const text = readyMessageForGroup({
      group: { id: -100123, slug: 'sunday-legends' },
      webBaseUrl: 'https://calledit.example',
    });

    // Then it can retain the duplicate fact while reproducing the same outbound payload
    expect(marker).toEqual({ ok: true, created: false, groupId: -100123, onboardingVersion: 'calledit_v1' });
    expect(text).toContain('Board: https://calledit.example/g/sunday-legends');
  });
});
