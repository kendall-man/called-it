import { z } from 'zod';
import type { PendingStakeIntentRow } from '../wager/port.js';

const UserId = z.number().int().positive();
const GroupId = z.number().int();
const IntentId = z.string().uuid();
const Lamports = z.string().regex(/^[1-9]\d{0,15}$/).transform((value) => BigInt(value));

export const AccountPrincipalSchema = z.object({ userId: UserId }).strict();
export const GroupPrincipalSchema = AccountPrincipalSchema.extend({ groupId: GroupId }).strict();

export const CreateChallengeSchema = z.object({
  principal: AccountPrincipalSchema,
  pubkey: z.string().min(32).max(64),
}).strict();

export const VerifyChallengeSchema = z.object({
  principal: AccountPrincipalSchema,
  challengeId: z.string().uuid(),
  pubkey: z.string().min(32).max(64),
  signature: z.string().min(1).max(128),
}).strict();

export const CreateIntentSchema = z.object({
  principal: GroupPrincipalSchema,
  marketId: z.string().uuid(),
  side: z.enum(['back', 'doubt']),
  lamports: Lamports,
  correlationId: z.string().min(1).max(256).regex(/^[\x21-\x7e]+$/),
}).strict();

export const GroupIntentSchema = z.object({
  principal: GroupPrincipalSchema,
}).strict();

export const ConfirmIntentSchema = GroupIntentSchema.extend({
  finalConfirmation: z.literal(true).optional(),
}).strict();

export const IntentIdSchema = IntentId;

export type AccountPrincipal = z.infer<typeof AccountPrincipalSchema>;
export type GroupPrincipal = z.infer<typeof GroupPrincipalSchema>;
export type CreateIntent = z.infer<typeof CreateIntentSchema>;

export function intentJson(intent: PendingStakeIntentRow): {
  readonly intentId: string;
  readonly marketId: string;
  readonly side: 'back' | 'doubt';
  readonly lamports: string;
  readonly state: PendingStakeIntentRow['state'];
  readonly expiresAt: string;
} {
  return {
    intentId: intent.id,
    marketId: intent.market_id,
    side: intent.side,
    lamports: intent.lamports.toString(),
    state: intent.state,
    expiresAt: intent.expires_at,
  };
}
