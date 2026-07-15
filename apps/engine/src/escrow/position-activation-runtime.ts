import {
  EscrowPositionActivationError,
  type createEscrowPositionActivationService,
} from './position-activation-service.js';

type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'>>;

type ActivationService = ReturnType<typeof createEscrowPositionActivationService>;

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((item) =>
    item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('invalid pending escrow lot projection');
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

function unsigned(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new TypeError('invalid pending escrow lot projection');
}

export function createProductionEscrowPositionActivationScheduler(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly activation: Pick<ActivationService, 'schedule'>;
  readonly fetch?: FetchPort;
  readonly pageSize?: number;
}) {
  const request = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 1_000;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new TypeError('invalid pending escrow lot page size');
  }
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };

  return {
    async schedulePending(input: { readonly marketId: string; readonly marketPda: string }) {
      let attempted = 0;
      let enqueued = 0;
      let skipped = 0;
      for (let offset = 0; ; offset += pageSize) {
        const url = new URL('/rest/v1/escrow_position_lots', options.supabaseUrl);
        url.searchParams.set('select', 'owner_pubkey,lot_nonce,event_epoch');
        url.searchParams.set('market_id', `eq.${input.marketId}`);
        url.searchParams.set('commitment', 'eq.finalized');
        url.searchParams.set('canonical', 'eq.true');
        url.searchParams.set('state', 'eq.pending');
        url.searchParams.set('order', 'owner_pubkey.asc,lot_nonce.asc');
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const response = await request(url, { headers });
        if (!response.ok) throw new TypeError('pending escrow lots unavailable');
        const page = rows(await response.json());
        for (const row of page) {
          if (typeof row.owner_pubkey !== 'string') {
            throw new TypeError('invalid pending escrow lot projection');
          }
          attempted += 1;
          let result: Awaited<ReturnType<ActivationService['schedule']>>;
          try {
            result = await options.activation.schedule({
              marketPda: input.marketPda,
              owner: row.owner_pubkey,
              lotNonce: unsigned(row.lot_nonce),
              expectedEventEpoch: unsigned(row.event_epoch),
            });
          } catch (error) {
            if (
              error instanceof EscrowPositionActivationError &&
              (error.code === 'market_unavailable' || error.code === 'stale_epoch' ||
                error.code === 'lot_invalidated')
            ) {
              skipped += 1;
              continue;
            }
            throw error;
          }
          if (result.kind === 'blocked') {
            throw new TypeError('escrow position activation blocked');
          }
          if (result.kind === 'enqueued') enqueued += 1;
          else skipped += 1;
        }
        if (page.length < pageSize) return { attempted, enqueued, skipped };
      }
    },
  };
}
