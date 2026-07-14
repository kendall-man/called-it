import { EscrowControlError, EXIT } from './types.js';
import {
  asAtomicString,
  asBoolean,
  asInteger,
  asRecord,
  asString,
  rejectExtraKeys,
} from './util.js';

export interface OpsStatusResult {
  readonly healthy: boolean;
  readonly lines: readonly string[];
  readonly failures: readonly string[];
}

function signedAtomic(value: unknown, label: string): bigint {
  const text = asString(value, label);
  if (!/^-?(0|[1-9][0-9]*)$/.test(text)) throw new EscrowControlError(EXIT.input, `${label} must be a signed decimal string`);
  return BigInt(text);
}

function nonNegativeInteger(value: unknown, label: string): number {
  const result = asInteger(value, label);
  if (result < 0) throw new EscrowControlError(EXIT.input, `${label} must be non-negative`);
  return result;
}

export function formatOpsStatus(value: unknown): OpsStatusResult {
  const root = asRecord(value, 'ops status');
  rejectExtraKeys(root, ['schemaVersion', 'cluster', 'capturedAt', 'assets', 'signers', 'relayer', 'indexer', 'rpc', 'claims', 'legacy'], 'ops status');
  if (asInteger(root.schemaVersion, 'ops status.schemaVersion') !== 1) throw new EscrowControlError(EXIT.input, 'ops status schemaVersion must be 1');
  const cluster = asString(root.cluster, 'ops status.cluster');
  const capturedAt = asString(root.capturedAt, 'ops status.capturedAt');
  if (Number.isNaN(Date.parse(capturedAt))) throw new EscrowControlError(EXIT.input, 'ops status capturedAt is invalid');
  const failures: string[] = [];
  const lines = [`ESCROW STATUS ${cluster} ${capturedAt}`];

  const assets = asRecord(root.assets, 'ops status.assets');
  rejectExtraKeys(assets, ['sol', 'usdc'], 'ops status.assets');
  for (const asset of ['sol', 'usdc'] as const) {
    const record = asRecord(assets[asset], `ops status.assets.${asset}`);
    rejectExtraKeys(record, ['vaultBalanceAtomic', 'calculatedLiabilityAtomic', 'expectedResidualAtomic'], `ops status.assets.${asset}`);
    const vault = BigInt(asAtomicString(record.vaultBalanceAtomic, `${asset}.vaultBalanceAtomic`));
    const liability = BigInt(asAtomicString(record.calculatedLiabilityAtomic, `${asset}.calculatedLiabilityAtomic`));
    const residual = BigInt(asAtomicString(record.expectedResidualAtomic, `${asset}.expectedResidualAtomic`));
    const drift = vault - liability - residual;
    lines.push(`${asset.toUpperCase()} vault=${vault} liability=${liability} residual=${residual} drift=${drift}`);
    if (drift !== 0n) failures.push(`${asset} accounting drift=${drift}`);
  }

  const signers = asRecord(root.signers, 'ops status.signers');
  rejectExtraKeys(signers, ['configured', 'required', 'agreeing', 'disagreement', 'outage'], 'ops status.signers');
  const configured = nonNegativeInteger(signers.configured, 'signers.configured');
  const required = nonNegativeInteger(signers.required, 'signers.required');
  const agreeing = nonNegativeInteger(signers.agreeing, 'signers.agreeing');
  const disagreement = asBoolean(signers.disagreement, 'signers.disagreement');
  const signerOutage = asBoolean(signers.outage, 'signers.outage');
  lines.push(`SIGNERS agreeing=${agreeing}/${configured} required=${required}`);
  if (configured !== 3 || required !== 2 || agreeing < required || disagreement || signerOutage) failures.push('settlement signer disagreement/outage');

  const relayer = asRecord(root.relayer, 'ops status.relayer');
  rejectExtraKeys(relayer, ['deadJobs', 'unknownJobs', 'oldestUnknownAgeSeconds', 'maxUnknownAgeSeconds', 'feeBalanceLamports', 'minFeeReserveLamports'], 'ops status.relayer');
  const deadJobs = nonNegativeInteger(relayer.deadJobs, 'relayer.deadJobs');
  const unknownJobs = nonNegativeInteger(relayer.unknownJobs, 'relayer.unknownJobs');
  const oldestUnknown = nonNegativeInteger(relayer.oldestUnknownAgeSeconds, 'relayer.oldestUnknownAgeSeconds');
  const maxUnknown = nonNegativeInteger(relayer.maxUnknownAgeSeconds, 'relayer.maxUnknownAgeSeconds');
  const feeBalance = BigInt(asAtomicString(relayer.feeBalanceLamports, 'relayer.feeBalanceLamports'));
  const feeReserve = BigInt(asAtomicString(relayer.minFeeReserveLamports, 'relayer.minFeeReserveLamports'));
  lines.push(`RELAYER dead=${deadJobs} unknown=${unknownJobs} oldest_unknown_s=${oldestUnknown} fee_lamports=${feeBalance}`);
  if (deadJobs > 0) failures.push(`relayer dead jobs=${deadJobs}`);
  if (unknownJobs > 0 && oldestUnknown > maxUnknown) failures.push(`relayer unknown jobs are stale (${oldestUnknown}s)`);
  if (feeBalance < feeReserve) failures.push(`relayer fee balance below reserve by ${feeReserve - feeBalance} lamports`);

  const indexer = asRecord(root.indexer, 'ops status.indexer');
  rejectExtraKeys(indexer, ['cursorLagSlots', 'maxCursorLagSlots'], 'ops status.indexer');
  const lag = nonNegativeInteger(indexer.cursorLagSlots, 'indexer.cursorLagSlots');
  const maxLag = nonNegativeInteger(indexer.maxCursorLagSlots, 'indexer.maxCursorLagSlots');
  lines.push(`INDEXER cursor_lag_slots=${lag}/${maxLag}`);
  if (lag > maxLag) failures.push(`indexer cursor lag=${lag} slots`);

  const rpc = asRecord(root.rpc, 'ops status.rpc');
  rejectExtraKeys(rpc, ['genesisMatch', 'programMatch', 'configMatch', 'providerAgreement'], 'ops status.rpc');
  for (const field of ['genesisMatch', 'programMatch', 'configMatch', 'providerAgreement'] as const) {
    if (!asBoolean(rpc[field], `rpc.${field}`)) failures.push(`RPC ${field} failed`);
  }
  lines.push(`RPC identity=${failures.some((failure) => failure.startsWith('RPC ')) ? 'MISMATCH' : 'OK'}`);

  const claims = asRecord(root.claims, 'ops status.claims');
  rejectExtraKeys(claims, ['backlogCount', 'maxBacklogCount', 'oldestAgeSeconds', 'maxOldestAgeSeconds'], 'ops status.claims');
  const backlog = nonNegativeInteger(claims.backlogCount, 'claims.backlogCount');
  const maxBacklog = nonNegativeInteger(claims.maxBacklogCount, 'claims.maxBacklogCount');
  const claimAge = nonNegativeInteger(claims.oldestAgeSeconds, 'claims.oldestAgeSeconds');
  const maxClaimAge = nonNegativeInteger(claims.maxOldestAgeSeconds, 'claims.maxOldestAgeSeconds');
  lines.push(`CLAIMS backlog=${backlog}/${maxBacklog} oldest_s=${claimAge}/${maxClaimAge}`);
  if (backlog > maxBacklog || claimAge > maxClaimAge) failures.push(`claim backlog unhealthy count=${backlog} age=${claimAge}s`);

  const legacy = asRecord(root.legacy, 'ops status.legacy');
  rejectExtraKeys(legacy, ['recordedLiabilityAtomic', 'reconciledLiabilityAtomic', 'availableTreasuryAtomic', 'withdrawalsAvailable', 'newIntakeDisabled'], 'ops status.legacy');
  const recorded = BigInt(asAtomicString(legacy.recordedLiabilityAtomic, 'legacy.recordedLiabilityAtomic'));
  const reconciled = BigInt(asAtomicString(legacy.reconciledLiabilityAtomic, 'legacy.reconciledLiabilityAtomic'));
  const treasury = BigInt(asAtomicString(legacy.availableTreasuryAtomic, 'legacy.availableTreasuryAtomic'));
  const withdrawals = asBoolean(legacy.withdrawalsAvailable, 'legacy.withdrawalsAvailable');
  const intakeDisabled = asBoolean(legacy.newIntakeDisabled, 'legacy.newIntakeDisabled');
  const liabilityDelta = signedAtomic((reconciled - recorded).toString(), 'legacy liability delta');
  lines.push(`LEGACY recorded=${recorded} reconciled=${reconciled} treasury=${treasury} liability_delta=${liabilityDelta}`);
  if (liabilityDelta !== 0n) failures.push(`legacy liability mismatch=${liabilityDelta}`);
  if (treasury < recorded) failures.push(`legacy treasury underfunded by ${recorded - treasury}`);
  if (!withdrawals) failures.push('legacy withdrawals unavailable');
  if (!intakeDisabled) failures.push('legacy new custody intake is still enabled');

  lines.push(failures.length === 0 ? 'RESULT HEALTHY' : `RESULT UNHEALTHY failures=${failures.length}`);
  return { healthy: failures.length === 0, lines, failures };
}
