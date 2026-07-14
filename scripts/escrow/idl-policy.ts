import { EscrowControlError, EXIT } from './types.js';
import { asRecord, asString } from './util.js';

export interface IdlPolicyResult {
  readonly ok: true;
  readonly instructions: readonly string[];
  readonly recoveryInstructions: readonly string[];
}

const REQUIRED_RECOVERY = ['claimposition', 'claimpositionfor', 'voidmarket', 'timeoutvoid', 'closepositionlots'] as const;
const VALUE_MOVING_VAULT_ALLOWLIST = new Set([
  'initializemarket',
  'placeposition',
  'claimposition',
  'claimpositionfor',
  'closemarket',
]);
const FORBIDDEN_INSTRUCTION = /(admin.*(withdraw|transfer)|withdraw.*vault|vault.*withdraw|sweep|drain|rescue.*(fund|vault)|transfer.*from.*vault|emergency.*withdraw)/;
const PAUSE_FIELD = /(^|_)(pause|paused|pauseauthority)($|_)/i;

function normalized(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
}

interface IdlAccountMeta {
  readonly name: string;
  readonly writable: boolean;
  readonly signer: boolean;
}

function flattenAccounts(value: unknown, label: string): IdlAccountMeta[] {
  if (!Array.isArray(value)) throw new EscrowControlError(EXIT.mismatch, `${label}.accounts must be an array`);
  const result: IdlAccountMeta[] = [];
  for (const [index, entry] of value.entries()) {
    const account = asRecord(entry, `${label}.accounts[${index}]`);
    const name = asString(account.name, `${label}.accounts[${index}].name`);
    if (Array.isArray(account.accounts)) {
      result.push(...flattenAccounts(account.accounts, `${label}.accounts[${index}]`));
      continue;
    }
    result.push({ name, writable: account.writable === true || account.isMut === true, signer: account.signer === true || account.isSigner === true });
  }
  return result;
}

function typeNames(value: unknown, types: Map<string, unknown>, seen = new Set<string>()): string[] {
  if (value === null || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap((entry) => typeNames(entry, types, seen));
  const record = value as Record<string, unknown>;
  const names: string[] = [];
  if (typeof record.name === 'string') names.push(record.name);
  const defined = record.defined;
  const definedName = typeof defined === 'string'
    ? defined
    : defined !== null && typeof defined === 'object' && typeof (defined as Record<string, unknown>).name === 'string'
      ? String((defined as Record<string, unknown>).name)
      : null;
  if (definedName !== null && !seen.has(definedName)) {
    seen.add(definedName);
    const definition = types.get(definedName);
    if (definition !== undefined) names.push(...typeNames(definition, types, seen));
  }
  for (const entry of Object.values(record)) names.push(...typeNames(entry, types, seen));
  return names;
}

export function verifyIdlPolicy(value: unknown): IdlPolicyResult {
  const idl = asRecord(value, 'IDL');
  if (!Array.isArray(idl.instructions) || idl.instructions.length === 0) {
    throw new EscrowControlError(EXIT.mismatch, 'IDL has no instructions');
  }
  const types = new Map<string, unknown>();
  if (Array.isArray(idl.types)) {
    for (const entry of idl.types) {
      const record = asRecord(entry, 'IDL type');
      if (typeof record.name === 'string') types.set(record.name, record);
    }
  }

  const instructions = new Map<string, { readonly rawName: string; readonly accounts: IdlAccountMeta[]; readonly args: unknown }>();
  for (const [index, entry] of idl.instructions.entries()) {
    const instruction = asRecord(entry, `IDL.instructions[${index}]`);
    const rawName = asString(instruction.name, `IDL.instructions[${index}].name`);
    const name = normalized(rawName);
    if (instructions.has(name)) throw new EscrowControlError(EXIT.mismatch, `IDL contains duplicate instruction ${rawName}`);
    if (FORBIDDEN_INSTRUCTION.test(name)) {
      throw new EscrowControlError(EXIT.mismatch, `IDL exposes forbidden vault-administration instruction ${rawName}`);
    }
    const accounts = flattenAccounts(instruction.accounts, `IDL.instructions[${index}]`);
    const writableVault = accounts.some((account) => normalized(account.name).includes('vault') && account.writable);
    const authoritySigner = accounts.some(
      (account) => account.signer && /(authority|admin|operator|config)/.test(normalized(account.name)),
    );
    if (writableVault && authoritySigner && !VALUE_MOVING_VAULT_ALLOWLIST.has(name)) {
      throw new EscrowControlError(EXIT.mismatch, `IDL instruction ${rawName} combines a writable vault with an administrative signer`);
    }
    instructions.set(name, { rawName, accounts, args: instruction.args });
  }

  for (const required of REQUIRED_RECOVERY) {
    if (!instructions.has(required)) throw new EscrowControlError(EXIT.mismatch, `IDL is missing recovery instruction ${required}`);
  }

  for (const required of REQUIRED_RECOVERY) {
    const instruction = instructions.get(required)!;
    const names = [
      ...instruction.accounts.map((account) => account.name),
      ...typeNames(instruction.args, types),
    ];
    const pauseName = names.find((name) => PAUSE_FIELD.test(name));
    if (pauseName !== undefined) {
      throw new EscrowControlError(
        EXIT.mismatch,
        `recovery instruction ${instruction.rawName} exposes pause prerequisite ${pauseName}`,
      );
    }
  }

  const timeout = instructions.get('timeoutvoid')!;
  if (timeout.accounts.some((account) => account.signer)) {
    throw new EscrowControlError(EXIT.mismatch, 'timeout_void must be permissionless');
  }
  const claimFor = instructions.get('claimpositionfor')!;
  if (claimFor.accounts.some((account) => normalized(account.name) === 'owner' && account.signer)) {
    throw new EscrowControlError(EXIT.mismatch, 'claim_position_for must not require the owner signature');
  }

  return {
    ok: true,
    instructions: [...instructions.values()].map((instruction) => instruction.rawName).sort(),
    recoveryInstructions: REQUIRED_RECOVERY.map((name) => instructions.get(name)!.rawName),
  };
}
