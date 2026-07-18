import { describe, expect, it } from 'vitest';
import {
  createEscrowProgressObserver,
  createEscrowSignerCompletionDmOutbox,
  enqueueEscrowSignerCompletionDm,
  escrowApprovalLapsedDmText,
  ESCROW_OPS_ALERT_WINDOW_MS,
} from './escrow-ux.js';

const SIGNER = 4242;
const OPS_CHAT = -100_555;
const SILENT_LOG = { info() {}, warn() {} };

function recordingPosts(): {
  posts: Array<{ chatId: number; text: string }>;
  post: (chatId: number, text: string) => void;
} {
  const posts: Array<{ chatId: number; text: string }> = [];
  return { posts, post: (chatId, text) => posts.push({ chatId, text }) };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('escrow signer completion DMs', () => {
  it('sends one finalized DM per event key with the public receipt link', async () => {
    const { posts, post } = recordingPosts();
    const outbox = createEscrowSignerCompletionDmOutbox({ post });
    const input = {
      idempotencyKey: 'sig-1:7:placed',
      telegramUserId: SIGNER,
      network: 'devnet',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      side: 'back',
      state: 'finalized',
      receiptUrl: 'https://web.test/r/a1111111-1111-4111-8111-111111111111',
    } as const;

    await enqueueEscrowSignerCompletionDm(outbox, input);
    // The projection sink replays at-least-once; the second delivery is a no-op.
    await enqueueEscrowSignerCompletionDm(outbox, input);

    expect(posts).toHaveLength(1);
    expect(posts[0]?.chatId).toBe(SIGNER);
    expect(posts[0]?.text).toContain('It happens · 0.01 SOL · On-chain escrow · DEVNET');
    expect(posts[0]?.text).toContain('finalized on-chain');
    expect(posts[0]?.text).toContain('Receipt: https://web.test/r/a1111111-1111-4111-8111-111111111111');
  });

  it('drops a signing-token-shaped receipt URL instead of leaking it', async () => {
    const { posts, post } = recordingPosts();
    const token = 'z'.repeat(43);
    await enqueueEscrowSignerCompletionDm(createEscrowSignerCompletionDmOutbox({ post }), {
      idempotencyKey: 'sig-2:7:placed',
      telegramUserId: SIGNER,
      network: 'devnet',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      side: 'back',
      state: 'finalized',
      receiptUrl: `https://web.test/position/${token}`,
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).not.toContain(token);
    expect(posts[0]?.text).not.toContain('Receipt:');
  });

  it('tells an invalidated signer what happened, where the SOL is, and what to do', async () => {
    const { posts, post } = recordingPosts();
    await enqueueEscrowSignerCompletionDm(createEscrowSignerCompletionDmOutbox({ post }), {
      idempotencyKey: 'sig-3:7:invalidated',
      telegramUserId: SIGNER,
      network: 'devnet',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      side: 'doubt',
      state: 'recoverable',
    });

    expect(posts).toHaveLength(1);
    expect(posts[0]?.text).toContain('rolled back on-chain');
    expect(posts[0]?.text).toContain('not lost');
    expect(posts[0]?.text).toContain('Open /wallet in private chat');
  });

  it('keeps distinct event keys independent', async () => {
    const { posts, post } = recordingPosts();
    const outbox = createEscrowSignerCompletionDmOutbox({ post });
    const base = {
      telegramUserId: SIGNER,
      network: 'devnet',
      asset: 'sol',
      amountAtomic: 10_000_000n,
      side: 'back',
      state: 'finalized',
    } as const;

    await enqueueEscrowSignerCompletionDm(outbox, { ...base, idempotencyKey: 'sig-4:1:placed' });
    await enqueueEscrowSignerCompletionDm(outbox, { ...base, idempotencyKey: 'sig-4:2:placed' });

    expect(posts).toHaveLength(2);
  });
});

describe('escrow progress observer', () => {
  const terminal = (jobId: string, errorCode: string) =>
    ({ kind: 'terminal', jobId, errorCode }) as const;

  it('DMs the signer of a lapsed placement and alerts ops once per code per window', async () => {
    const { posts, post } = recordingPosts();
    let nowMs = 0;
    const observer = createEscrowProgressObserver({
      opsChatId: OPS_CHAT,
      post,
      resolveDeadLetterSigner: async () => ({
        kind: 'position_placement',
        telegramUserId: SIGNER,
      }),
      now: () => nowMs,
      log: SILENT_LOG,
    });

    observer.observeRelayerResults([
      terminal('job-1', 'user_signature_expired'),
      terminal('job-2', 'user_signature_expired'),
    ]);
    await flushAsyncWork();

    const opsPosts = posts.filter((entry) => entry.chatId === OPS_CHAT);
    const signerPosts = posts.filter((entry) => entry.chatId === SIGNER);
    expect(opsPosts).toHaveLength(1);
    expect(opsPosts[0]?.text).toContain('user_signature_expired');
    expect(signerPosts).toHaveLength(2);
    expect(signerPosts[0]?.text).toBe(escrowApprovalLapsedDmText());
    expect(signerPosts[0]?.text).toContain('No SOL moved');

    // Inside the window the same code stays silent; after it, ops hears again.
    nowMs = ESCROW_OPS_ALERT_WINDOW_MS - 1;
    observer.observeRelayerResults([terminal('job-3', 'user_signature_expired')]);
    await flushAsyncWork();
    expect(posts.filter((entry) => entry.chatId === OPS_CHAT)).toHaveLength(1);

    nowMs = ESCROW_OPS_ALERT_WINDOW_MS;
    observer.observeRelayerResults([terminal('job-4', 'user_signature_expired')]);
    await flushAsyncWork();
    expect(posts.filter((entry) => entry.chatId === OPS_CHAT)).toHaveLength(2);
  });

  it('alerts ops for every dead-letter code but only DMs user-attributable ones', async () => {
    const { posts, post } = recordingPosts();
    const observer = createEscrowProgressObserver({
      opsChatId: OPS_CHAT,
      post,
      resolveDeadLetterSigner: async () => ({
        kind: 'position_placement',
        telegramUserId: SIGNER,
      }),
      now: () => 0,
      log: SILENT_LOG,
    });

    observer.observeRelayerResults([
      terminal('job-1', 'finalized_effect_mismatch'),
      terminal('job-2', 'signature_mismatch'),
      { kind: 'complete', jobId: 'job-3', signature: 'sig' },
    ]);
    await flushAsyncWork();

    expect(posts.filter((entry) => entry.chatId === OPS_CHAT)).toHaveLength(2);
    expect(posts.filter((entry) => entry.chatId === SIGNER)).toHaveLength(0);
  });

  it('skips the signer DM when the job join is unavailable but still pages ops', async () => {
    const { posts, post } = recordingPosts();
    const warned: string[] = [];
    const observer = createEscrowProgressObserver({
      opsChatId: OPS_CHAT,
      post,
      resolveDeadLetterSigner: async () => null,
      now: () => 0,
      log: { info() {}, warn(event) { warned.push(event); } },
    });

    observer.observeRelayerResults([terminal('job-1', 'user_signature_expired')]);
    await flushAsyncWork();

    expect(posts.filter((entry) => entry.chatId === OPS_CHAT)).toHaveLength(1);
    expect(posts.filter((entry) => entry.chatId === SIGNER)).toHaveLength(0);
    expect(warned).toContain('escrow_dead_letter_signer_unresolved');
  });

  it('does not DM the signer of a non-placement dead letter', async () => {
    const { posts, post } = recordingPosts();
    const observer = createEscrowProgressObserver({
      opsChatId: null,
      post,
      resolveDeadLetterSigner: async () => ({ kind: 'freeze', telegramUserId: null }),
      now: () => 0,
      log: SILENT_LOG,
    });

    observer.observeRelayerResults([terminal('job-1', 'user_signature_expired')]);
    await flushAsyncWork();

    expect(posts).toHaveLength(0);
  });

  it('maps degraded readiness reasons to rate-limited ops alerts', () => {
    const { posts, post } = recordingPosts();
    const observer = createEscrowProgressObserver({
      opsChatId: OPS_CHAT,
      post,
      resolveDeadLetterSigner: async () => null,
      now: () => 0,
      log: SILENT_LOG,
    });

    observer.observeEscrowReadiness({ status: 'ready', reasons: [] });
    observer.observeEscrowReadiness({
      status: 'not_ready',
      reasons: ['indexer_lagging', 'oracle_threshold_unavailable', 'program_paused'],
    });
    observer.observeEscrowReadiness({ status: 'not_ready', reasons: ['indexer_lagging'] });

    expect(posts).toHaveLength(2);
    expect(posts[0]?.text).toContain('finalized indexer is behind');
    expect(posts[1]?.text).toContain('attestation quorum');
  });

  it('stays silent without a configured ops chat', () => {
    const { posts, post } = recordingPosts();
    const observer = createEscrowProgressObserver({
      opsChatId: null,
      post,
      resolveDeadLetterSigner: async () => null,
      now: () => 0,
      log: SILENT_LOG,
    });

    observer.observeRelayerResults([terminal('job-1', 'finalized_effect_mismatch')]);
    observer.observeEscrowReadiness({ status: 'not_ready', reasons: ['rpc_unavailable'] });

    expect(posts).toHaveLength(0);
  });
});
