import type {
  TelegramPersistPort,
  TelegramPersistResult,
  TelegramRoutingDecision,
  TelegramSourceFingerprint,
  TelegramValidatedUpdate,
} from './ports.js';
import { deriveTelegramSourceIdentity } from './source-identity.js';

export interface PersistAndRouteResult extends TelegramPersistResult {
  readonly sourceFingerprint: TelegramSourceFingerprint;
}

export function createPersistAndRoute(input: {
  readonly analyticsHmacSecretBase64: string;
  readonly db: TelegramPersistPort;
  readonly route: (update: TelegramValidatedUpdate) => Promise<TelegramRoutingDecision>;
}): (update: TelegramValidatedUpdate) => Promise<PersistAndRouteResult> {
  return async (update) => {
    const identity = deriveTelegramSourceIdentity(update, input.analyticsHmacSecretBase64);
    const routingDecision = await input.route(update);
    const persisted = await input.db.persistUpdate({
      sourceKey: identity.sourceKey,
      sourceFingerprint: identity.sourceFingerprint,
      telegramUpdateId: identity.telegramUpdateId,
      updateType: identity.updateType,
      payload: update,
      routingDecision,
    });
    return {
      ...persisted,
      sourceFingerprint: identity.sourceFingerprint,
    };
  };
}
