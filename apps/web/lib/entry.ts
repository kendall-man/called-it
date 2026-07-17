import { z } from 'zod';

export const TELEGRAM_STARTGROUP = 'calledit_v1';
export const TELEGRAM_GROUP_ADMIN_RIGHTS = 'manage_chat';

const BotUsernameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/);

export function buildTelegramGroupAddUrl(botUsername: string | undefined): string | null {
  const parsedBotUsername = BotUsernameSchema.safeParse(botUsername);
  if (!parsedBotUsername.success) return null;

  const url = new URL(`https://t.me/${parsedBotUsername.data}`);
  url.searchParams.set('startgroup', TELEGRAM_STARTGROUP);
  url.searchParams.set('admin', TELEGRAM_GROUP_ADMIN_RIGHTS);
  return url.toString();
}
