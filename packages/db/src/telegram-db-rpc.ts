import type { TelegramDbClient } from './telegram-db-core.js';
import {
  parseHeartbeat,
  parsePrune,
  parseSnapshot,
} from './telegram-db-delivery-parsers.js';
import {
  parseLeaseUpdates,
  parsePersistResult,
  parseUpdateAction,
} from './telegram-db-ingress-parsers.js';
import {
  parseCount,
  parseLeaseCompletion,
  parseLeaseOwnership,
  parseOutboundAction,
  parsePlanOutbound,
  parseResolveOwnedMessage,
  parseStartOutbound,
} from './telegram-db-outbound-parsers.js';
import { invokeTelegramRpc } from './telegram-db-rpc-response.js';

type TelegramRpcMethods = import('./telegram-db.js').TelegramDb;

export function telegramRpcMethods(client: TelegramDbClient): TelegramRpcMethods {
  return {
    persistUpdate(input) {
      return invokeTelegramRpc(client, {
        op: 'telegram_persist_update',
        args: {
          p_source_key: input.sourceKey,
          p_source_fingerprint: input.sourceFingerprint,
          p_telegram_update_id: input.telegramUpdateId,
          p_update_type: input.updateType,
          p_payload: input.payload,
          p_routing_decision: input.routingDecision,
        },
        parse: parsePersistResult,
      });
    },

    leaseUpdates(workerId, limit, leaseMs) {
      return invokeTelegramRpc(client, {
        op: 'telegram_lease_updates',
        args: { p_worker_id: workerId, p_limit: limit, p_lease_ms: leaseMs },
        parse: parseLeaseUpdates,
      });
    },

    completeUpdate(updateRowId, workerId) {
      return invokeTelegramRpc(client, {
        op: 'telegram_complete_update',
        args: { p_update_row_id: updateRowId, p_worker_id: workerId },
        parse: parseUpdateAction,
      });
    },

    retryUpdate(input) {
      return invokeTelegramRpc(client, {
        op: 'telegram_retry_update',
        args: {
          p_update_row_id: input.updateRowId,
          p_worker_id: input.workerId,
          p_error_code: input.errorCode,
          p_retry_at: input.retryAt,
          p_max_attempts: input.maxAttempts,
        },
        parse: parseUpdateAction,
      });
    },

    deadLetterUpdate(updateRowId, workerId, errorCode) {
      return invokeTelegramRpc(client, {
        op: 'telegram_dead_letter_update',
        args: { p_update_row_id: updateRowId, p_worker_id: workerId, p_error_code: errorCode },
        parse: parseUpdateAction,
      });
    },

    planOutbound(input) {
      return invokeTelegramRpc(client, {
        op: 'telegram_plan_outbound',
        args: {
          p_logical_key: input.logicalKey,
          p_chat_id: input.chatId,
          p_domain_kind: input.domainKind,
          p_domain_id: input.domainId,
        },
        parse: parsePlanOutbound,
      });
    },

    startOutbound(jobId, workerId, leaseMs) {
      return invokeTelegramRpc(client, {
        op: 'telegram_start_outbound',
        args: { p_job_id: jobId, p_worker_id: workerId, p_lease_ms: leaseMs },
        parse: parseStartOutbound,
      });
    },

    markOutboundOwned(jobId, workerId, messageId) {
      return invokeTelegramRpc(client, {
        op: 'telegram_mark_outbound_owned',
        args: { p_job_id: jobId, p_worker_id: workerId, p_message_id: messageId },
        parse: parseOutboundAction,
      });
    },

    completeOutbound(jobId, workerId) {
      return invokeTelegramRpc(client, {
        op: 'telegram_complete_outbound',
        args: { p_job_id: jobId, p_worker_id: workerId },
        parse: parseOutboundAction,
      });
    },

    markOutboundUncertain(jobId, workerId, errorCode) {
      return invokeTelegramRpc(client, {
        op: 'telegram_mark_outbound_uncertain',
        args: { p_job_id: jobId, p_worker_id: workerId, p_error_code: errorCode },
        parse: parseOutboundAction,
      });
    },

    sweepExpiredOutbound(limit) {
      return invokeTelegramRpc(client, {
        op: 'telegram_sweep_expired_outbound',
        args: { p_limit: limit },
        parse: parseCount,
      });
    },

    leaseUncertainOwnership(workerId, limit, leaseMs) {
      return invokeTelegramRpc(client, {
        op: 'telegram_lease_uncertain_ownership',
        args: { p_worker_id: workerId, p_limit: limit, p_lease_ms: leaseMs },
        parse: parseLeaseOwnership,
      });
    },

    leaseOutboundCompletion(workerId, limit, leaseMs) {
      return invokeTelegramRpc(client, {
        op: 'telegram_lease_outbound_completion',
        args: { p_worker_id: workerId, p_limit: limit, p_lease_ms: leaseMs },
        parse: parseLeaseCompletion,
      });
    },

    reconcileOutbound(jobId, workerId, messageId) {
      return invokeTelegramRpc(client, {
        op: 'telegram_reconcile_outbound',
        args: { p_job_id: jobId, p_worker_id: workerId, p_message_id: messageId },
        parse: parseOutboundAction,
      });
    },

    manualReviewOutbound(jobId, workerId, errorCode) {
      return invokeTelegramRpc(client, {
        op: 'telegram_manual_review_outbound',
        args: { p_job_id: jobId, p_worker_id: workerId, p_error_code: errorCode },
        parse: parseOutboundAction,
      });
    },

    resolveOwnedMessage(chatId, messageId) {
      return invokeTelegramRpc(client, {
        op: 'telegram_resolve_owned_message',
        args: { p_chat_id: chatId, p_message_id: messageId },
        parse: parseResolveOwnedMessage,
      });
    },

    heartbeatWorker(workerKind, workerId, stopping) {
      return invokeTelegramRpc(client, {
        op: 'engine_heartbeat_worker',
        args: { p_worker_kind: workerKind, p_worker_id: workerId, p_stopping: stopping },
        parse: parseHeartbeat,
      });
    },

    deliverySnapshot(observedAt) {
      return invokeTelegramRpc(client, {
        op: 'telegram_delivery_snapshot',
        args: { p_observed_at: observedAt },
        parse: parseSnapshot,
      });
    },

    pruneDelivery(limit) {
      return invokeTelegramRpc(client, {
        op: 'telegram_prune_delivery',
        args: { p_limit: limit },
        parse: parsePrune,
      });
    },
  };
}
