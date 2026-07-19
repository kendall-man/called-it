import { randomBytes } from 'node:crypto';
import {
  buildSponsoredPositionTransaction,
  deriveMarketPda,
  deriveUserPositionPda,
  hexToBytes,
} from '@calledit/escrow-sdk';
import { sponsorTransaction } from './transaction-signatures.js';
import { hashPlacementToken, presentPlacementAuthorization } from './placement-presentation.js';
import {
  EscrowPlacementError,
  type CreateEscrowPlacementInput,
  type CreateEscrowPlacementResult,
  type EscrowPlacementDeployment,
  type EscrowPlacementDatabase,
  type EscrowPlacementMarketLinkResult,
  type EscrowPlacementMarket,
  type EscrowPlacementServiceDependencies,
} from './placement-types.js';

function amountBounds(deployment: EscrowPlacementDeployment, asset: 'sol' | 'usdc') {
  return asset === 'sol'
    ? { minimum: deployment.minimumSolPosition, maximum: deployment.maximumSolPosition }
    : { minimum: deployment.minimumUsdcPosition, maximum: deployment.maximumUsdcPosition };
}

function assertMarket(
  market: EscrowPlacementMarket,
  input: CreateEscrowPlacementInput,
  dependencies: EscrowPlacementServiceDependencies,
  marketPda: string,
): void {
  const expectedMint = market.asset === 'usdc' ? dependencies.deployment.canonicalUsdcMint : null;
  if (
    market.custodyMode !== 'escrow' ||
    market.ownerProgramId !== dependencies.deployment.programId ||
    market.marketPda !== marketPda ||
    market.marketId !== input.marketId ||
    !/^[0-9a-fA-F]{64}$/.test(market.documentHashHex)
  ) {
    throw new EscrowPlacementError('market_identity_mismatch');
  }
  if (input.expectedAsset !== undefined && market.asset !== input.expectedAsset) {
    throw new EscrowPlacementError('asset_mismatch');
  }
  if (input.expectedReplay !== undefined && market.replay !== input.expectedReplay) {
    throw new EscrowPlacementError('replay_mismatch');
  }
  if (market.tokenMint !== expectedMint) throw new EscrowPlacementError('asset_mismatch');
  if (market.state !== 'open' || dependencies.clock().unix >= market.positionCutoffTimestamp) {
    throw new EscrowPlacementError('market_unavailable');
  }
}

function assertMarketLink(
  link: EscrowPlacementMarketLinkResult,
  market: EscrowPlacementMarket,
  dependencies: EscrowPlacementServiceDependencies,
): void {
  if (!link.ok || !link.found) throw new EscrowPlacementError('market_identity_mismatch');
  const expectedMint = market.asset === 'usdc' ? dependencies.deployment.canonicalUsdcMint : null;
  if (
    link.custodyMode !== 'escrow' ||
    link.custodyVersion !== dependencies.deployment.custodyVersion ||
    link.cluster !== dependencies.deployment.cluster ||
    link.genesisHash !== dependencies.deployment.genesisHash ||
    link.programId !== dependencies.deployment.programId ||
    link.marketPda !== market.marketPda ||
    link.marketId !== market.marketId ||
    link.asset !== market.asset ||
    link.mintPubkey !== expectedMint ||
    link.documentHashHex.toLowerCase() !== market.documentHashHex.toLowerCase() ||
    link.oracleEpoch !== market.oracleSetEpoch ||
    link.ratioMilli !== BigInt(market.ratioMilli) ||
    link.chainState !== 'open' ||
    link.commitment !== 'finalized' ||
    link.projectionStale
  ) throw new EscrowPlacementError('market_identity_mismatch');
}

export function createPlacementSessionCreator(
  db: Pick<EscrowPlacementDatabase, 'createSigningSession' | 'getMarketLink'>,
  dependencies: EscrowPlacementServiceDependencies,
): (input: CreateEscrowPlacementInput) => Promise<CreateEscrowPlacementResult> {
  return async (input) => {
    if (
      !Number.isSafeInteger(input.groupId) ||
      (!dependencies.deployment.allowAnyGroup &&
        !dependencies.deployment.allowedGroupIds.includes(input.groupId))
    ) {
      throw new EscrowPlacementError('group_not_allowed');
    }
    const readiness = await dependencies.readiness();
    if (readiness.status === 'not_ready') return { kind: 'blocked', reasons: readiness.reasons };
    const observedGenesis = await dependencies.chain.genesisHash();
    if (observedGenesis !== dependencies.deployment.genesisHash) {
      throw new EscrowPlacementError('network_mismatch');
    }
    if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 300) {
      throw new EscrowPlacementError('invalid_session_ttl');
    }
    const marketPda = deriveMarketPda(dependencies.deployment.programId, input.marketId).address;
    const market = await dependencies.chain.readMarket(marketPda);
    if (market === null) throw new EscrowPlacementError('market_not_found');
    assertMarket(market, input, dependencies, marketPda);
    const marketLink = await db.getMarketLink({
      cluster: dependencies.deployment.cluster,
      genesisHash: dependencies.deployment.genesisHash,
      programId: dependencies.deployment.programId,
      marketPda,
    });
    assertMarketLink(marketLink, market, dependencies);

    const positionPda = deriveUserPositionPda(
      dependencies.deployment.programId,
      marketPda,
      input.ownerPubkey,
    ).address;
    const position = await dependencies.chain.readPosition(positionPda);
    if (position !== null && (
      position.ownerProgramId !== dependencies.deployment.programId ||
      position.positionPda !== positionPda ||
      position.marketPda !== marketPda ||
      position.ownerPubkey !== input.ownerPubkey
    )) {
      throw new EscrowPlacementError('position_identity_mismatch');
    }
    if (position?.claimed === true) throw new EscrowPlacementError('position_claimed');
    if (position !== null && position.side !== input.side) {
      throw new EscrowPlacementError('opposite_side_position');
    }
    const bounds = amountBounds(dependencies.deployment, market.asset);
    const cumulativeAmount = (position?.totalPaidAmount ?? 0n) + input.amountAtomic;
    if (input.amountAtomic < bounds.minimum || cumulativeAmount > bounds.maximum) {
      throw new EscrowPlacementError('amount_out_of_range');
    }

    const now = dependencies.clock();
    const requestedExpiry = now.unix + BigInt(input.ttlSeconds);
    // Replay markets use accelerated historical match time. Their authorization must
    // still expire on wall-clock time, while live markets remain cutoff-bound.
    const expiresAt = market.replay
      ? requestedExpiry
      : requestedExpiry < market.positionCutoffTimestamp
        ? requestedExpiry
        : market.positionCutoffTimestamp;
    const blockhash = await dependencies.chain.latestBlockhash();
    const built = buildSponsoredPositionTransaction({
      programId: dependencies.deployment.programId,
      relayerFeePayer: dependencies.sponsor.publicKey,
      userWallet: input.ownerPubkey,
      canonicalUsdcMint: dependencies.deployment.canonicalUsdcMint,
      marketUuid: input.marketId,
      marketDocumentHash: hexToBytes(market.documentHashHex),
      side: input.side,
      amount: input.amountAtomic,
      asset: market.asset,
      expectedRatioMilli: market.ratioMilli,
      expectedEventEpoch: market.eventEpoch,
      expectedLotNonce: position?.nextLotNonce ?? 0n,
      expiresAt,
      genesisHash: dependencies.deployment.genesisHash,
      recentBlockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    });
    const prepared = sponsorTransaction(built.transaction, dependencies.sponsor);
    const tokenBytes = dependencies.tokenBytes?.() ?? Uint8Array.from(randomBytes(32));
    if (tokenBytes.length !== 32) throw new EscrowPlacementError('signing_session_rejected');
    const token = Buffer.from(tokenBytes).toString('base64url');
    const tokenHashHex = hashPlacementToken(token);
    const authorization = {
      programId: dependencies.deployment.programId,
      relayerFeePayer: dependencies.sponsor.publicKey.toBase58(),
      canonicalUsdcMint: dependencies.deployment.canonicalUsdcMint,
      marketUuid: input.marketId,
      marketPda,
      marketDocumentHashHex: market.documentHashHex.toLowerCase(),
      side: input.side,
      amount: input.amountAtomic,
      asset: market.asset,
      expectedRatioMilli: market.ratioMilli,
      expectedEventEpoch: market.eventEpoch,
      expectedLotNonce: built.intent.expectedLotNonce,
      expiresAt,
      genesisHash: dependencies.deployment.genesisHash,
      recentBlockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
      messageHashHex: prepared.messageHashHex,
    };
    const persisted = await db.createSigningSession({
      tokenHashHex,
      userId: input.telegramUserId,
      providerUserId: input.privyUserId,
      providerWalletId: input.privyWalletId,
      ownerPubkey: input.ownerPubkey,
      marketId: input.marketId,
      side: input.side,
      asset: market.asset,
      amountAtomic: input.amountAtomic,
      lotNonce: built.intent.expectedLotNonce,
      eventEpoch: market.eventEpoch,
      documentHashHex: market.documentHashHex,
      transactionMessageHashHex: prepared.messageHashHex,
      rawTransactionBase64: prepared.rawTransactionBase64,
      authorization: presentPlacementAuthorization(authorization),
      expiresAtIso: new Date(Number(expiresAt) * 1_000).toISOString(),
      nowIso: now.iso,
    });
    if (!persisted.ok) throw new EscrowPlacementError('signing_session_rejected');
    return { kind: 'created', token, rawTransactionBase64: prepared.rawTransactionBase64, authorization };
  };
}
