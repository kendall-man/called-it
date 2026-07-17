import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { CreateChallengeSchema, VerifyChallengeSchema } from './account-protocol.js';
import type { AccountApiContext } from './account-api.js';
import { sendJson } from './server-http.js';

const CHALLENGE_TTL_MS = 5 * 60_000;

export async function handleCreateChallenge(
  context: AccountApiContext,
  rawBody: unknown,
  res: ServerResponse,
): Promise<true> {
  const body = CreateChallengeSchema.safeParse(rawBody);
  if (!body.success) {
    sendJson(res, 400, { error: 'bad_request' });
    return true;
  }
  if (!context.rateLimiter.allow({ operation: 'challenge', principal: body.data.principal })) {
    sendJson(res, 429, { error: 'rate_limited' });
    return true;
  }
  const wager = context.deps.wager;
  if (wager === null) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return true;
  }
  pruneExpiredChallenges(context);
  const challengeId = randomUUID();
  const issuedAt = new Date(context.deps.now()).toISOString();
  const expiresAt = new Date(context.deps.now() + CHALLENGE_TTL_MS).toISOString();
  const nonce = randomBytes(32).toString('base64url');
  const challenge = {
    webBaseUrl: context.env.WEB_BASE_URL,
    telegramUserId: body.data.principal.userId,
    pubkey: body.data.pubkey,
    cluster: 'devnet',
    nonce,
    issuedAt,
    expiresAt,
    challengeId,
  };
  const message = context.walletLinkVerifier.build(challenge);
  if (!message.ok) {
    sendJson(res, 503, { error: 'challenge_unavailable' });
    return true;
  }
  const challengeHashHex = createHash('sha256').update(nonce).digest('hex');
  await wager.account.createWalletLinkChallenge({
    id: challengeId,
    user_id: body.data.principal.userId,
    pubkey: body.data.pubkey,
    challenge_hash_hex: challengeHashHex,
    expires_at: expiresAt,
  });
  context.challenges.set(challengeId, { challenge, challengeHashHex });
  sendJson(res, 201, { challengeId, issuedAt, expiresAt, message: message.message });
  return true;
}

export async function handleVerifyChallenge(
  context: AccountApiContext,
  rawBody: unknown,
  res: ServerResponse,
): Promise<true> {
  const body = VerifyChallengeSchema.safeParse(rawBody);
  if (!body.success) {
    sendJson(res, 400, { error: 'bad_request' });
    return true;
  }
  if (!context.rateLimiter.allow({ operation: 'verification', principal: body.data.principal })) {
    sendJson(res, 429, { error: 'rate_limited' });
    return true;
  }
  const wager = context.deps.wager;
  if (wager === null) {
    sendJson(res, 503, { error: 'wager_unavailable' });
    return true;
  }
  const stored = context.challenges.get(body.data.challengeId);
  if (stored === undefined) {
    sendJson(res, 409, { error: 'challenge_invalid' });
    return true;
  }
  if (Date.parse(stored.challenge.expiresAt) <= context.deps.now()) {
    context.challenges.delete(body.data.challengeId);
    sendJson(res, 410, { error: 'challenge_expired' });
    return true;
  }
  if (
    stored.challenge.telegramUserId !== body.data.principal.userId ||
    stored.challenge.pubkey !== body.data.pubkey
  ) {
    sendJson(res, 403, { error: 'principal_mismatch' });
    return true;
  }
  const verification = context.walletLinkVerifier.verify(
    { pubkey: body.data.pubkey, signature: body.data.signature },
    stored.challenge,
    { now: () => new Date(context.deps.now()) },
  );
  if (!verification.ok) {
    sendJson(res, verification.code === 'challenge_expired' ? 410 : 400, {
      error: verification.code === 'challenge_expired' ? 'challenge_expired' : 'signature_invalid',
    });
    return true;
  }
  const linked = await wager.account.verifyWalletLink({
    challenge_id: body.data.challengeId,
    user_id: body.data.principal.userId,
    pubkey: body.data.pubkey,
    challenge_hash_hex: stored.challengeHashHex,
  });
  context.challenges.delete(body.data.challengeId);
  if (!linked.ok) {
    sendJson(res, linked.code === 'challenge_expired' ? 410 : 409, { error: linked.code });
    return true;
  }
  sendJson(res, 200, { wallet: { status: 'verified' } });
  return true;
}

function pruneExpiredChallenges(context: AccountApiContext): void {
  const now = context.deps.now();
  for (const [id, stored] of context.challenges) {
    if (Date.parse(stored.challenge.expiresAt) <= now) context.challenges.delete(id);
  }
}
