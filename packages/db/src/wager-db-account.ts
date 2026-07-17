import { assertOk } from './errors.js';
import {
  assertSafeInteger,
  depositFromRaw,
  lamportsFromDb,
  lamportsToDb,
  nowIso,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import {
  manyRows,
  maybeRow,
  parseDepositRow,
  parseEnabledRow,
  parseLamportsRow,
  parseNumericIdRow,
  parseWalletLinkRow,
} from './wager-db-row-parsers.js';

type AccountDb = Pick<
  WagerDb,
  | 'setGroupEnabled'
  | 'isGroupEnabled'
  | 'getWalletLink'
  | 'getWalletLinkByPubkey'
  | 'setLastWagerGroup'
  | 'postWagerLedger'
  | 'balanceLamports'
  | 'totalLedgerLamports'
  | 'upsertDeposit'
  | 'orphanDepositsBySender'
>;

export function accountDbMethods(client: WagerDbClient): AccountDb {
  return {
    async setGroupEnabled(groupId, enabled, byUserId) {
      assertOk(
        'setGroupEnabled',
        await client.from('wager_groups').upsert(
          { group_id: groupId, enabled, enabled_by: byUserId, updated_at: nowIso() },
          { onConflict: 'group_id' },
        ),
      );
    },

    async isGroupEnabled(groupId) {
      const row = await maybeRow(
        'isGroupEnabled',
        client.from('wager_groups').select('enabled').eq('group_id', groupId).maybeSingle(),
        parseEnabledRow,
      );
      return row?.enabled ?? false;
    },

    // ── wallet links ───────────────────────────────────────────────────────

    async getWalletLink(userId) {
      return maybeRow(
        'getWalletLink',
        client.from('wager_wallet_links').select('*').eq('user_id', userId).maybeSingle(),
        parseWalletLinkRow,
      );
    },

    async getWalletLinkByPubkey(pubkey) {
      return maybeRow(
        'getWalletLinkByPubkey',
        client.from('wager_wallet_links').select('*').eq('pubkey', pubkey).maybeSingle(),
        parseWalletLinkRow,
      );
    },

    async setLastWagerGroup(userId, groupId) {
      assertOk(
        'setLastWagerGroup',
        await client
          .from('wager_wallet_links')
          .update({ last_wager_group_id: groupId })
          .eq('user_id', userId),
      );
    },

    // ── ledger ─────────────────────────────────────────────────────────────

    async postWagerLedger(entry) {
      const rows = await manyRows(
        'postWagerLedger',
        client
          .from('wager_ledger_entries')
          .upsert(
            { ...entry, lamports: lamportsToDb('postWagerLedger.lamports', entry.lamports) },
            { onConflict: 'idempotency_key', ignoreDuplicates: true },
          )
          .select('id'),
        parseNumericIdRow,
      );
      return { inserted: rows.length > 0 };
    },

    async balanceLamports(userId) {
      const rows = await manyRows(
        'balanceLamports',
        client.from('wager_ledger_entries').select('lamports').eq('user_id', userId),
        parseLamportsRow,
      );
      return rows.reduce((sum, row) => sum + lamportsFromDb('balanceLamports', row.lamports), 0n);
    },

    async totalLedgerLamports() {
      const rows = await manyRows(
        'totalLedgerLamports',
        client.from('wager_ledger_entries').select('lamports'),
        parseLamportsRow,
      );
      return rows.reduce(
        (sum, row) => sum + lamportsFromDb('totalLedgerLamports', row.lamports),
        0n,
      );
    },

    // ── deposits ───────────────────────────────────────────────────────────

    async upsertDeposit(row) {
      assertSafeInteger('upsertDeposit.slot', row.slot);
      const rows = await manyRows(
        'upsertDeposit',
        client
          .from('wager_deposits')
          .upsert(
            { ...row, lamports: lamportsToDb('upsertDeposit.lamports', row.lamports) },
            { onConflict: 'tx_sig,ix_index', ignoreDuplicates: true },
          )
          .select('id'),
        parseNumericIdRow,
      );
      return { inserted: rows.length > 0 };
    },

    async orphanDepositsBySender(pubkey) {
      const rows = await manyRows(
        'orphanDepositsBySender',
        client
          .from('wager_deposits')
          .select('*')
          .eq('sender_pubkey', pubkey)
          .is('user_id', null),
        parseDepositRow,
      );
      return rows.map((row) => depositFromRaw('orphanDepositsBySender', row));
    },

  };
}
