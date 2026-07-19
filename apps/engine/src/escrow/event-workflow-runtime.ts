import {
  bytesToHex,
  deriveMarketPda,
  deriveOracleSetPda,
  derivePositionLotPda,
  deriveUserPositionPda,
} from '@calledit/escrow-sdk';
import type { MarketRow } from '../ports.js';
import type {
  EscrowEventWorkflowPort,
  EscrowSettlementPositionPort,
  EscrowWorkflowMarketContext,
} from './event-workflow-scheduler.js';
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
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new TypeError('invalid escrow lot integer');
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
  readonly reconcile: (input: {
    readonly marketId: string;
    readonly custodyMode: 'escrow';
    readonly marketPda: string;
    readonly vaultPda: string;
    readonly asset: 'sol' | 'usdc';
  }) => Promise<unknown>;
  readonly deployment: {
    readonly cluster: 'localnet' | 'devnet' | 'mainnet-beta';
    readonly genesisHash: string;
    readonly programId: string;
    readonly custodyVersion: number;
  };
  readonly fetch?: FetchPort;
  readonly nowEpochSeconds?: () => bigint;
}): EscrowEventWorkflowPort {
  const request = options.fetch ?? fetch;
  const nowEpochSeconds = options.nowEpochSeconds ?? (() => BigInt(Math.floor(Date.now() / 1_000)));
  const pageSize = 1_000;
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };

  async function marketContext(market: MarketRow): Promise<EscrowWorkflowMarketContext | null> {
    const marketPda = deriveMarketPda(options.deployment.programId, market.id).address;
    const [initialLinkValue, account] = await Promise.all([
      options.db.getMarketLink({
        cluster: options.deployment.cluster,
        genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId,
        marketPda,
      }),
      options.accounts.market(marketPda),
    ]);
    let link = requireLink(initialLinkValue, market, options.deployment);
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
    if (link.chainState !== account.value.state || link.eventEpoch !== account.value.eventEpoch) {
      await options.reconcile({
        marketId: link.marketId,
        custodyMode: 'escrow',
        marketPda: link.marketPda,
        vaultPda: link.vaultPda,
        asset: link.asset,
      });
      link = requireLink(await options.db.getMarketLink({
        cluster: options.deployment.cluster,
        genesisHash: options.deployment.genesisHash,
        programId: options.deployment.programId,
        marketPda,
      }), market, options.deployment);
      if (link.chainState !== account.value.state || link.eventEpoch !== account.value.eventEpoch) {
        throw new TypeError('escrow workflow reconciliation mismatch');
      }
    }
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

  async function positionProjectionComplete(
    context: EscrowWorkflowMarketContext,
  ): Promise<boolean> {
      const jobsUrl = new URL('/rest/v1/escrow_relayer_jobs', options.supabaseUrl);
      jobsUrl.searchParams.set('select', 'state,expected_signature');
      jobsUrl.searchParams.set('market_id', `eq.${context.binding.marketId}`);
      jobsUrl.searchParams.set('kind', 'eq.position_placement');
      jobsUrl.searchParams.set('order', 'created_at.asc');
      jobsUrl.searchParams.set('limit', String(pageSize));
      const jobsResponse = await request(jobsUrl, { headers });
      if (!jobsResponse.ok) throw new TypeError('escrow placement projection unavailable');
      const jobs = rows(await jobsResponse.json());
      if (jobs.length >= pageSize) return false;
      const completedSignatures = new Set<string>();
      for (const job of jobs) {
        if (job.state === 'dead') continue;
        if (job.state !== 'complete' || typeof job.expected_signature !== 'string') {
          return false;
        }
        completedSignatures.add(job.expected_signature);
      }

      const completedLots = new Set<string>();
      if (completedSignatures.size > 0) {
        const sessionsUrl = new URL('/rest/v1/escrow_signing_sessions', options.supabaseUrl);
        sessionsUrl.searchParams.set('select', 'owner_pubkey,lot_nonce,transaction_signature');
        sessionsUrl.searchParams.set('market_id', `eq.${context.binding.marketId}`);
        sessionsUrl.searchParams.set('state', 'eq.consumed');
        sessionsUrl.searchParams.set('limit', String(pageSize));
        const sessionsResponse = await request(sessionsUrl, { headers });
        if (!sessionsResponse.ok) throw new TypeError('escrow placement projection unavailable');
        const sessions = rows(await sessionsResponse.json());
        if (sessions.length >= pageSize) return false;
        for (const session of sessions) {
          if (
            typeof session.owner_pubkey !== 'string' ||
            typeof session.transaction_signature !== 'string'
          ) throw new TypeError('invalid escrow placement projection');
          if (!completedSignatures.has(session.transaction_signature)) continue;
          completedSignatures.delete(session.transaction_signature);
          completedLots.add(`${session.owner_pubkey}:${unsigned(session.lot_nonce)}`);
        }
        if (completedSignatures.size > 0) {
          return false;
        }
      }

      const projected = new Set(
        (await positionLots(context)).map((lot) => `${lot.ownerPubkey}:${lot.lotNonce}`),
      );
      return [...completedLots].every((key) => projected.has(key));
  }

  async function terminalAttestationExists(marketId: string): Promise<boolean> {
    const url = new URL('/rest/v1/escrow_attestation_requests', options.supabaseUrl);
    url.searchParams.set('select', 'request_key,unsigned_payload');
    url.searchParams.set('market_id', `eq.${marketId}`);
    url.searchParams.set('operation_kind', 'in.(settle,void)');
    url.searchParams.set('state', 'in.(pending,leased,signed,enqueued,completed)');
    url.searchParams.set('order', 'created_at.desc');
    url.searchParams.set('limit', String(pageSize));
    const response = await request(url, { headers });
    if (!response.ok) throw new TypeError('escrow terminal attestation projection unavailable');
    return rows(await response.json()).some((row) => {
      const payload = row.unsigned_payload;
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false;
      const workflow = (payload as Readonly<Record<string, unknown>>).request;
      if (workflow === null || typeof workflow !== 'object' || Array.isArray(workflow)) return false;
      const attestation = (workflow as Readonly<Record<string, unknown>>).attestation;
      if (attestation === null || typeof attestation !== 'object' || Array.isArray(attestation)) return false;
      const expiresAt = (attestation as Readonly<Record<string, unknown>>).expiresAt;
      return typeof expiresAt === 'string' && /^-?\d+$/.test(expiresAt) &&
        BigInt(expiresAt) > nowEpochSeconds();
    });
  }

  async function positionLots(context: EscrowWorkflowMarketContext) {
      const result = [];
      for (let offset = 0; ; offset += pageSize) {
        const url = new URL('/rest/v1/escrow_position_lots', options.supabaseUrl);
        url.searchParams.set('select', 'owner_pubkey,lot_nonce,event_epoch,state');
        url.searchParams.set('market_id', `eq.${context.binding.marketId}`);
        url.searchParams.set('commitment', 'eq.finalized');
        url.searchParams.set('canonical', 'eq.true');
        url.searchParams.set('state', 'in.(pending,active)');
        url.searchParams.set('order', 'owner_pubkey.asc,lot_nonce.asc');
        url.searchParams.set('limit', String(pageSize));
        url.searchParams.set('offset', String(offset));
        const response = await request(url, { headers });
        if (!response.ok) throw new TypeError('escrow lot projection unavailable');
        const page = rows(await response.json());
        for (const row of page) {
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
        if (page.length < pageSize) return result;
      }
  }

  return {
    loadMarket: marketContext,
    positionLots,
    positionProjectionComplete,
    terminalAttestationExists,
  };
}

export function createProductionEscrowSettlementPositionPort(options: {
  readonly supabaseUrl: string;
  readonly serviceRoleKey: string;
  readonly accounts: Pick<SolanaEscrowAccountReader, 'position'>;
  readonly programId: string;
  readonly fetch?: FetchPort;
}): EscrowSettlementPositionPort {
  const request = options.fetch ?? fetch;
  const headers = {
    apikey: options.serviceRoleKey,
    authorization: `Bearer ${options.serviceRoleKey}`,
    accept: 'application/json',
  };
  const pageSize = 1_000;

  return {
    async positions(input) {
      const result: { ownerPubkey: string; settlementProcessed: boolean }[] = [];
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
        if (!response.ok) throw new TypeError('escrow position projection unavailable');
        const page = rows(await response.json());
        for (const row of page) {
          if (typeof row.owner_pubkey !== 'string' || typeof row.position_pda !== 'string') {
            throw new TypeError('invalid escrow position projection');
          }
          const positionPda = deriveUserPositionPda(
            options.programId,
            input.marketPda,
            row.owner_pubkey,
          ).address;
          const account = await options.accounts.position(positionPda);
          if (
            row.position_pda !== positionPda || account === null ||
            account.ownerProgramId !== options.programId || account.address !== positionPda ||
            account.value.market !== input.marketPda || account.value.owner !== row.owner_pubkey
          ) throw new TypeError('escrow position chain identity mismatch');
          result.push({
            ownerPubkey: account.value.owner,
            settlementProcessed: account.value.settlementProcessed,
          });
        }
        if (page.length < pageSize) return result;
      }
    },
  };
}
