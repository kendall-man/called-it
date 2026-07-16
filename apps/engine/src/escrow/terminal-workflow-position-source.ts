import type {
  EscrowTerminalPositionIdentity,
  EscrowTerminalPositionSource,
} from './terminal-workflow-orchestrator.js';

type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'>>;

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('invalid escrow terminal position projection');
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

export function createEscrowTerminalPositionSource(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly fetch?: FetchPort;
  readonly pageSize?: number;
}): EscrowTerminalPositionSource {
  const request = options.fetch ?? fetch;
  const pageSize = options.pageSize ?? 1_000;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1_000) {
    throw new TypeError('invalid escrow terminal position page size');
  }
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };

  return {
    async positions(input): Promise<readonly EscrowTerminalPositionIdentity[]> {
      const result: EscrowTerminalPositionIdentity[] = [];
      for (let offset = 0; ; offset += pageSize) {
        const url = new URL('/rest/v1/escrow_position_accounts', options.supabaseUrl);
        url.searchParams.set('select', 'owner_pubkey,position_pda');
        url.searchParams.set('market_id', `eq.${input.marketId}`);
        url.searchParams.set('commitment', 'eq.finalized');
        url.searchParams.set('canonical', 'eq.true');
        url.searchParams.set('order', 'owner_pubkey.asc');
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const response = await request(url, { headers });
        if (!response.ok) throw new TypeError('escrow terminal position projection unavailable');
        const page = rows(await response.json());
        for (const row of page) {
          if (typeof row.owner_pubkey !== 'string' || typeof row.position_pda !== 'string') {
            throw new TypeError('invalid escrow terminal position projection');
          }
          result.push({ ownerPubkey: row.owner_pubkey, positionPda: row.position_pda });
        }
        if (page.length < pageSize) return result;
      }
    },
  };
}
