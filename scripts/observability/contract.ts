import { createHmac } from 'node:crypto';

export const TELEMETRY_EVENT_NAMES = [
  'entry_viewed',
  'add_group_clicked',
  'bot_added',
  'group_ready',
  'claim_detected',
  'claim_confirmed_if_required',
  'claim_priced',
  'claim_failed',
  'offer_rendered',
  'stake_tapped',
  'starter_granted',
  'wallet_required',
  'position_placed',
  'stake_refused',
  'wallet_setup_started',
  'wallet_verified',
  'deposit_confirmed',
  'pending_stake_confirmed',
  'settlement_seen',
  'receipt_opened',
  'readiness_changed',
  'alert_fired',
  'alert_resolved',
  'reconciliation_dry_run',
] as const;

export const TELEMETRY_REASON_CODES = [
  'claim_detected',
  'claim_rejected',
  'dependency_unready',
  'disabled_capability_ready',
  'duplicate_delivery',
  'hard_gate_failed',
  'no_action',
  'queue_backlog',
  'queue_stalled',
  'reconciliation_complete',
  'telemetry_privacy_sentinel',
  'unsafe_apply_rejected',
] as const;

export const BOUNDED_METADATA_FIELDS = [
  'backlog_count',
  'dead_letter_count',
  'gap_count',
  'lag_seconds',
  'retry_count',
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number];
export type TelemetryReasonCode = (typeof TELEMETRY_REASON_CODES)[number];
export type TelemetryMetadataField = (typeof BOUNDED_METADATA_FIELDS)[number];
export type PseudonymScope = 'actor' | 'group' | 'telegram_source';

export type HmacPseudonymizer = {
  readonly pseudonymize: (scope: PseudonymScope, identifier: string) => string;
};

export type TelemetryEventInput = {
  readonly occurredAt: string;
  readonly eventName: TelemetryEventName;
  readonly reasonCode: TelemetryReasonCode;
  readonly requestId?: string;
  readonly transitionId?: string;
  readonly jobId?: string;
  readonly marketId?: string;
  readonly fixtureId?: string;
  readonly activationSessionId?: string;
  readonly actorIdentifier?: string;
  readonly groupIdentifier?: string;
  readonly sourceIdentifier?: string;
  readonly attemptCount?: number;
  readonly durationMs?: number;
  readonly metadata?: unknown;
  readonly networkState?: 'enabled' | 'disabled' | 'healthy' | 'unhealthy';
  readonly proofState?: 'pending' | 'verified' | 'unavailable' | 'failed';
  readonly settlementState?: 'pending' | 'settled' | 'refunded' | 'failed';
  readonly positionState?: 'offered' | 'placed' | 'refused' | 'settled';
};

export type TelemetryEvent = {
  readonly schema_version: 1;
  readonly occurred_at: string;
  readonly event_name: TelemetryEventName;
  readonly reason_code: TelemetryReasonCode;
  readonly request_id?: string;
  readonly transition_id?: string;
  readonly job_id?: string;
  readonly market_id?: string;
  readonly fixture_id?: string;
  readonly activation_session_id?: string;
  readonly actor_pseudonym?: string;
  readonly group_pseudonym?: string;
  readonly source_pseudonym?: string;
  readonly attempt_count: number;
  readonly duration_ms: number;
  readonly metadata: Readonly<Partial<Record<TelemetryMetadataField, number>>>;
  readonly network_state?: TelemetryEventInput['networkState'];
  readonly proof_state?: TelemetryEventInput['proofState'];
  readonly settlement_state?: TelemetryEventInput['settlementState'];
  readonly position_state?: TelemetryEventInput['positionState'];
};

const MAX_BOUNDED_VALUE = 1_000_000_000;
const OPAQUE_ID_PATTERN = /^(?:[a-f0-9]{64}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu;

export function createHmacPseudonymizer(key: string): HmacPseudonymizer {
  return {
    pseudonymize(scope, identifier) {
      const digest = createHmac('sha256', key)
        .update(`calledit-observability:v1:${scope}:`, 'utf8')
        .update(identifier, 'utf8')
        .digest('hex');
      return `hmac_sha256:${digest}`;
    },
  };
}

export function createTelemetryEvent(
  input: TelemetryEventInput,
  pseudonymizer: HmacPseudonymizer,
): TelemetryEvent {
  const requestId = opaqueId(input.requestId);
  const transitionId = opaqueId(input.transitionId);
  const jobId = opaqueId(input.jobId);
  const marketId = opaqueId(input.marketId);
  const fixtureId = opaqueId(input.fixtureId);
  const activationSessionId = opaqueId(input.activationSessionId);
  const actorPseudonym = pseudonym(input.actorIdentifier, 'actor', pseudonymizer);
  const groupPseudonym = pseudonym(input.groupIdentifier, 'group', pseudonymizer);
  const sourcePseudonym = pseudonym(input.sourceIdentifier, 'telegram_source', pseudonymizer);
  return {
    schema_version: 1,
    occurred_at: canonicalTimestamp(input.occurredAt),
    event_name: input.eventName,
    reason_code: input.reasonCode,
    ...(requestId === undefined ? {} : { request_id: requestId }),
    ...(transitionId === undefined ? {} : { transition_id: transitionId }),
    ...(jobId === undefined ? {} : { job_id: jobId }),
    ...(marketId === undefined ? {} : { market_id: marketId }),
    ...(fixtureId === undefined ? {} : { fixture_id: fixtureId }),
    ...(activationSessionId === undefined ? {} : { activation_session_id: activationSessionId }),
    ...(actorPseudonym === undefined ? {} : { actor_pseudonym: actorPseudonym }),
    ...(groupPseudonym === undefined ? {} : { group_pseudonym: groupPseudonym }),
    ...(sourcePseudonym === undefined ? {} : { source_pseudonym: sourcePseudonym }),
    attempt_count: boundedNumber(input.attemptCount),
    duration_ms: boundedNumber(input.durationMs),
    metadata: sanitizeMetadata(input.metadata),
    ...(input.networkState === undefined ? {} : { network_state: input.networkState }),
    ...(input.proofState === undefined ? {} : { proof_state: input.proofState }),
    ...(input.settlementState === undefined ? {} : { settlement_state: input.settlementState }),
    ...(input.positionState === undefined ? {} : { position_state: input.positionState }),
  };
}

export function sanitizeMetadata(
  value: unknown,
): Readonly<Partial<Record<TelemetryMetadataField, number>>> {
  if (!isRecord(value)) return {};

  const sanitized: Partial<Record<TelemetryMetadataField, number>> = {};
  for (const field of BOUNDED_METADATA_FIELDS) {
    const candidate = value[field];
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0
      && candidate <= MAX_BOUNDED_VALUE) {
      sanitized[field] = candidate;
    }
  }
  return sanitized;
}

function canonicalTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '1970-01-01T00:00:00.000Z';
  return date.toISOString();
}

function opaqueId(value: string | undefined): string | undefined {
  if (value === undefined || !OPAQUE_ID_PATTERN.test(value)) return undefined;
  return value.toLowerCase();
}

function pseudonym(
  value: string | undefined,
  scope: PseudonymScope,
  pseudonymizer: HmacPseudonymizer,
): string | undefined {
  return value === undefined ? undefined : pseudonymizer.pseudonymize(scope, value);
}

function boundedNumber(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_BOUNDED_VALUE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
