import type { Update } from 'grammy/types';
import { z } from 'zod';

type TelegramIngressMutation = (update: Update) => Promise<void>;

export interface TrackedTelegramIngress {
  accept(input: unknown): Promise<void>;
  stop(): void;
  drain(): Promise<void>;
  unfinished(): number;
}

const telegramUserSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean(),
  first_name: z.string(),
  last_name: z.string().optional(),
  username: z.string().optional(),
  language_code: z.string().optional(),
  is_premium: z.literal(true).optional(),
  added_to_attachment_menu: z.literal(true).optional(),
});

const privateChatSchema = z.object({
  id: z.number().int(),
  type: z.literal('private'),
  username: z.string().optional(),
  first_name: z.string(),
  last_name: z.string().optional(),
});
const groupChatSchema = z.object({
  id: z.number().int(),
  type: z.literal('group'),
  title: z.string(),
});
const supergroupChatSchema = z.object({
  id: z.number().int(),
  type: z.literal('supergroup'),
  title: z.string(),
  username: z.string().optional(),
  is_forum: z.literal(true).optional(),
  is_direct_messages: z.literal(true).optional(),
});
const channelChatSchema = z.object({
  id: z.number().int(),
  type: z.literal('channel'),
  title: z.string(),
  username: z.string().optional(),
});
const telegramChatSchema = z.discriminatedUnion('type', [
  privateChatSchema,
  groupChatSchema,
  supergroupChatSchema,
  channelChatSchema,
]);
const nonChannelChatSchema = z.discriminatedUnion('type', [
  privateChatSchema,
  groupChatSchema,
  supergroupChatSchema,
]);

const callbackMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  chat: telegramChatSchema,
});

const botCommandEntitySchema = z.object({
  type: z.literal('bot_command'),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive(),
});
const commandEntitiesSchema = z.array(z.unknown()).transform((entities) =>
  entities.flatMap((entity) => {
    const result = botCommandEntitySchema.safeParse(entity);
    return result.success ? [result.data] : [];
  }),
);

const replyMessageSchema = z.object({
  message_id: z.number().int().nonnegative(),
  date: z.number().int().nonnegative(),
  chat: telegramChatSchema,
  from: telegramUserSchema.optional(),
  text: z.string().optional(),
  entities: commandEntitiesSchema.optional(),
}).transform((message) => ({ ...message, reply_to_message: undefined }));

const textMessageUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  message: z.object({
    message_id: z.number().int().nonnegative(),
    date: z.number().int().nonnegative(),
    chat: nonChannelChatSchema,
    from: telegramUserSchema,
    text: z.string(),
    entities: commandEntitiesSchema.optional(),
    reply_to_message: replyMessageSchema.optional(),
  }),
}).strict();

const callbackUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  callback_query: z.object({
    id: z.string(),
    from: telegramUserSchema,
    message: callbackMessageSchema.optional(),
    inline_message_id: z.string().optional(),
    chat_instance: z.string(),
    data: z.string(),
  }),
}).strict();

const chatMemberSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('creator'),
    user: telegramUserSchema,
    is_anonymous: z.boolean(),
    custom_title: z.string().optional(),
  }),
  z.object({
    status: z.literal('administrator'),
    user: telegramUserSchema,
    can_be_edited: z.boolean(),
    is_anonymous: z.boolean(),
    can_manage_chat: z.boolean(),
    can_delete_messages: z.boolean(),
    can_manage_video_chats: z.boolean(),
    can_restrict_members: z.boolean(),
    can_promote_members: z.boolean(),
    can_change_info: z.boolean(),
    can_invite_users: z.boolean(),
    can_post_stories: z.boolean(),
    can_edit_stories: z.boolean(),
    can_delete_stories: z.boolean(),
    can_post_messages: z.boolean().optional(),
    can_edit_messages: z.boolean().optional(),
    can_pin_messages: z.boolean().optional(),
    can_manage_topics: z.boolean().optional(),
  }),
  z.object({
    status: z.literal('member'),
    user: telegramUserSchema,
    tag: z.string().optional(),
    until_date: z.number().int().optional(),
  }),
  z.object({
    status: z.literal('restricted'),
    user: telegramUserSchema,
    is_member: z.boolean(),
    can_send_messages: z.boolean(),
    can_send_audios: z.boolean(),
    can_send_documents: z.boolean(),
    can_send_photos: z.boolean(),
    can_send_videos: z.boolean(),
    can_send_video_notes: z.boolean(),
    can_send_voice_notes: z.boolean(),
    can_send_polls: z.boolean(),
    can_send_other_messages: z.boolean(),
    can_add_web_page_previews: z.boolean(),
    can_react_to_messages: z.boolean(),
    can_change_info: z.boolean(),
    can_invite_users: z.boolean(),
    can_edit_tag: z.boolean(),
    can_pin_messages: z.boolean(),
    can_manage_topics: z.boolean(),
    until_date: z.number().int(),
  }),
  z.object({
    status: z.literal('left'),
    user: telegramUserSchema,
  }),
  z.object({
    status: z.literal('kicked'),
    user: telegramUserSchema,
    until_date: z.number().int(),
  }),
]);

const membershipUpdateSchema = z.object({
  update_id: z.number().int().nonnegative(),
  my_chat_member: z.object({
    chat: telegramChatSchema,
    from: telegramUserSchema,
    date: z.number().int().nonnegative(),
    old_chat_member: chatMemberSchema,
    new_chat_member: chatMemberSchema,
    via_join_request: z.boolean().optional(),
    via_chat_folder_invite_link: z.boolean().optional(),
  }),
}).strict();

const dispatchableUpdateSchema = z.union([
  textMessageUpdateSchema,
  callbackUpdateSchema,
  membershipUpdateSchema,
]);

export function createTelegramIngressHandler(
  mutate: TelegramIngressMutation,
): (input: unknown) => Promise<void> {
  return async (input) => {
    const update: Update = dispatchableUpdateSchema.parse(input);
    await mutate(update);
  };
}

/**
 * Validates and accepts a forwarded webhook update without coupling the HTTP
 * acknowledgement to the full bot callback. Telegram has already received a
 * 200 from the concierge at this point, so holding this response until the bot
 * finishes makes a 15-second engine timeout permanently lose the user's tap.
 *
 * Accepted work remains tracked and is drained during a normal shutdown. The
 * mutation owns its own domain idempotency; this wrapper never retries or
 * duplicates an update.
 */
export function createTrackedTelegramIngress(options: {
  readonly mutate: TelegramIngressMutation;
  readonly onError: (cause: unknown) => void;
  readonly maxInFlight?: number;
}): TrackedTelegramIngress {
  const inFlight = new Set<Promise<void>>();
  const maxInFlight = options.maxInFlight ?? 64;
  let accepting = true;
  const accept = createTelegramIngressHandler(async (update) => {
    if (!accepting) throw new Error('telegram ingress is draining');
    if (inFlight.size >= maxInFlight) throw new Error('telegram ingress is full');
    let task: Promise<void>;
    task = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => options.mutate(update))
      .catch(options.onError)
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
  return {
    accept,
    stop() {
      accepting = false;
    },
    async drain() {
      await Promise.allSettled([...inFlight]);
    },
    unfinished() {
      return inFlight.size;
    },
  };
}
