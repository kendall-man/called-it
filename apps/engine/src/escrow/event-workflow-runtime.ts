import { bytesToHex, deriveMarketPda, deriveOracleSetPda, derivePositionLotPda } from '@calledit/escrow-sdk';
import type { MarketRow } from '../ports.js';
import type { EscrowEventWorkflowPort, EscrowWorkflowMarketContext } from './event-workflow-scheduler.js';
import type { EscrowPlacementMarketLinkResult } from './placement-types.js';
import type { SolanaEscrowAccountReader } from './solana-accounts.js';

type FetchPort = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'json'>>;

function rows(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  if (!Array.isArray(value) || value.some((item) => item === null || typeof item !== 'object' || Array.isArray(item))) {
    throw new TypeError('invalid escrow lot projection');
  }
  return value as readonly Readonly<Record<string, unknown>>[];
}

function unsigned(value: unknown): bigint {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new TypeError('invalid escrow lot integer');
  return BigInt(value);
}

function requireLink(
  link: EscrowPlacementMarketLinkResult,
  market: MarketRow,
  input: { readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta'; readonly genesisHash: string; readonly programId: string; readonly custodyVersion: number },
) {
  const marketPda = deriveMarketPda(input.programId, market.id).address;
  if (
    !link.ok || !link.found || link.marketId !== market.id || link.marketPda !== marketPda ||
    link.custodyMode !== 'escrow' || link.custodyVersion !== input.custodyVersion ||
    link.cluster !== input.cluster || link.genesisHash !== input.genesisHash || link.programId !== input.programId ||
    link.commitment !== 'finalized' || link.projectionStale || link.chainState === 'closed'
  ) throw new TypeError('escrow workflow market link mismatch');
  return link;
}

export function createProductionEscrowEventWorkflowPort(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly db: {
    getMarketLink(input: {
      readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
      readonly genesisHash: string;
      readonly programId: string;
      readonly marketPda: string;
    }): Promise<EscrowPlacementMarketLinkResult>;
  };
  readonly accounts: SolanaEscrowAccountReader;
  readonly deployment: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
  };
  readonly fetch?: FetchPort;
}): EscrowEventWorkflowPort {
  const request = options.fetch ?? fetch;
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };

  async function marketContext(market: MarketRow): Promise<EscrowWorkflowMarketContext | null> {
    const marketPda = deriveMarketPda(options.deployment.programId, market.id).address;
    const [linkValue, account] = await Promise.all([
      options.db.getMarketLink({
        cluster: options.deployment.cluster,
        genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId,
        marketPda,
      }),
      options.accounts.market(marketPda),
    ]);
    const link = requireLink(linkValue, market, options.deployment);
    if (account === null || account.value.state === 'closed' || account.value.state === 'settled' || account.value.state === 'voided') {
      return null;
    }
    const oracle = await options.accounts.oracleSet(
      deriveOracleSetPda(options.deployment.programId, account.value.oracleSetEpoch).address,
    );
    if (
      account.ownerProgramId !== options.deployment.programId || account.address !== marketPda ||
      account.value.marketUuid !== market.id || account.value.fixtureId !== BigInt(market.fixture_id) ||
      bytesToHex(account.value.marketDocumentHash) !== link.documentHashHex.toLowerCase() ||
      account.value.oracleSetEpoch !== link.oracleEpoch || account.value.asset !== link.asset ||
      account.value.tokenMint !== link.mintPubkey || account.value.replay !== market.is_replay ||
      (account.value.state !== 'open' && account.value.state !== 'frozen') ||
      oracle === null || oracle.ownerProgramId !== options.deployment.programId ||
      oracle.value.epoch !== account.value.oracleSetEpoch || oracle.value.signatureThreshold !== 2 ||
      oracle.value.signers.length !== 3 || new Set(oracle.value.signers).size !== 3
    ) throw new TypeError('escrow workflow chain identity mismatch');
    return {
      chainState: account.value.state,
      replay: account.value.replay,
      oraclePolicy: {
        oracleSetEpoch: oracle.value.epoch,
        signers: oracle.value.signers,
        threshold: oracle.value.signatureThreshold,
      },
      binding: {
        marketId: market.id,
        marketPda,
        marketDocumentHashHex: link.documentHashHex,
        fixtureId: account.value.fixtureId,
        oracleSetEpoch: account.value.oracleSetEpoch,
        eventEpoch: account.value.eventEpoch,
      },
    };
  }

  return {
    loadMarket: marketContext,
    async positionLots(context) {
      const url = new URL('/rest/v1/escrow_position_lots', options.supabaseUrl);
      url.searchParams.set('select', 'owner_pubkey,lot_nonce,event_epoch,state');
      url.searchParams.set('market_id', `eq.${context.binding.marketId}`);
      url.searchParams.set('commitment', 'eq.finalized');
      url.searchParams.set('canonical', 'eq.true');
      url.searchParams.set('state', 'in.(pending,active)');
      const response = await request(url, { headers });
      if (!response.ok) throw new TypeError('escrow lot projection unavailable');
      const result = [];
      for (const row of rows(await response.json())) {
        if (
          typeof row.owner_pubkey !== 'string' ||
          (row.state !== 'pending' && row.state !== 'active')
        ) throw new TypeError('invalid escrow lot projection');
        const nonce = unsigned(row.lot_nonce);
        const eventEpoch = unsigned(row.event_epoch);
        const lotPda = derivePositionLotPda(
          options.deployment.programId,
          context.binding.marketPda,
          row.owner_pubkey,
          nonce,
        ).address;
        const account = await options.accounts.lot(lotPda);
        if (
          account === null || account.ownerProgramId !== options.deployment.programId ||
          account.address !== lotPda || account.value.market !== context.binding.marketPda ||
          account.value.owner !== row.owner_pubkey || account.value.nonce !== nonce ||
          account.value.observedEventEpoch !== eventEpoch || account.value.state !== row.state
        ) throw new TypeError('escrow lot chain identity mismatch');
        result.push({
          ownerPubkey: account.value.owner,
          lotNonce: account.value.nonce,
          positionLotPda: lotPda,
          placedTimestamp: account.value.placedTimestamp,
          observedEventEpoch: account.value.observedEventEpoch,
          activationTimestamp: account.value.activationTimestamp,
          state: account.value.state,
        });
      }
      return result;
    },
  };
}
