import type { EscrowDb } from '@calledit/db';
import type {
  EscrowPeriodicReconciliationLink,
  EscrowPeriodicReconciliationLinkPort,
} from './periodic-reconciliation-runner.js';

type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'>>;

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((item) =>
    item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('invalid escrow reconciliation link projection');
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

function link(row: Readonly<Record<string, unknown>>): EscrowPeriodicReconciliationLink {
  if (
    typeof row.market_id !== 'string' || typeof row.market_pda !== 'string' ||
    typeof row.vault_pda !== 'string' || row.custody_mode !== 'escrow' ||
    (row.asset !== 'sol' && row.asset !== 'usdc')
  ) throw new TypeError('invalid escrow reconciliation link projection');
  return {
    marketId: row.market_id,
    custodyMode: row.custody_mode,
    marketPda: row.market_pda,
    vaultPda: row.vault_pda,
    asset: row.asset,
  };
}

export function createProductionEscrowReconciliationLinkPort(options: {
  readonly db?: Pick<EscrowDb, 'listReconciliationLinks'>;
  readonly supabaseUrl?: string;
  readonly serviceRoleKey?: string;
  readonly deployment: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
  };
  readonly fetch?: FetchPort;
}): EscrowPeriodicReconciliationLinkPort {
  if (options.db !== undefined) {
    return {
      async listReconciliationLinks(input) {
        return options.db!.listReconciliationLinks({
          cluster: options.deployment.cluster,
          genesisHash: options.deployment.genesisHash,
          programId: options.deployment.programId,
          custodyVersion: options.deployment.custodyVersion,
          cursor: input.cursor,
          limit: input.limit,
        });
      },
    };
  }
  if (options.supabaseUrl === undefined || options.serviceRoleKey === undefined) {
    throw new TypeError('escrow reconciliation database unavailable');
  }
  const request = options.fetch ?? fetch;
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };

  return {
    async listReconciliationLinks(input) {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000) {
        throw new TypeError('invalid escrow reconciliation page limit');
      }
      const url = new URL('/rest/v1/escrow_market_links', options.supabaseUrl);
      url.searchParams.set('select', 'market_id,custody_mode,market_pda,vault_pda,asset');
      url.searchParams.set('custody_mode', 'eq.escrow');
      url.searchParams.set('custody_version', `eq.${options.deployment.custodyVersion}`);
      url.searchParams.set('cluster', `eq.${options.deployment.cluster}`);
      url.searchParams.set('genesis_hash', `eq.${options.deployment.genesisHash}`);
      url.searchParams.set('program_id', `eq.${options.deployment.programId}`);
      url.searchParams.set('commitment', 'eq.finalized');
      url.searchParams.set('canonical', 'eq.true');
      url.searchParams.set('projection_stale', 'eq.false');
      url.searchParams.set('chain_state', 'neq.closed');
      if (input.cursor !== null) url.searchParams.set('market_id', `gt.${input.cursor}`);
      url.searchParams.set('order', 'market_id.asc');
      url.searchParams.set('limit', String(input.limit));

      const response = await request(url, { headers });
      if (!response.ok) throw new TypeError('escrow reconciliation links unavailable');
      const page = rows(await response.json()).map(link);
      const last = page.at(-1);
      return {
        links: page,
        nextCursor: page.length === input.limit && last !== undefined ? last.marketId : null,
      };
    },
  };
}
