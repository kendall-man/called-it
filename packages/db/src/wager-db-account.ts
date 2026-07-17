import { assertOk } from './errors.js';
import {
  assertSafeInteger,
  depositFromRaw,
  lamportsFromDb,
  lamportsToDb,
  nowIso,
} from './wager-db-core.js';
import type { WagerDb, WagerDbClient } from './wager-db-contract.js';
import { ledgerDbMethods } from './wager-db-ledger.js';
import {
  manyRows,
  maybeRow,
  parseDepositRow,
  parseDefaultAssetRow,
  parseEnabledRow,
  parseLamportsRow,
  parseNumericIdRow,
  parseWalletLinkRow,
} from './wager-db-row-parsers.js';

type AccountDb = Pick<
  WagerDb,
  | 'setGroupEnabled'
  | 'isGroupEnabled'
  | 'setGroupDefaultAsset'
  | 'groupDefaultAsset'
  | 'getWalletLink'
  | 'getWalletLinkByPubkey'
  | 'setLastWagerGroup'
  | 'postWagerLedger'
  | 'stakeDebitedLamportsForMarket'
  | 'balanceLamports'
  | 'totalLedgerLamports'
  | 'upsertDeposit'
  | 'markDepositCredited'
  | 'orphanDepositsBySender'
>;

export function accountDbMethods(client: WagerDbClient): AccountDb {
  return {
    ...ledgerDbMethods(client),

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

    async setGroupDefaultAsset(groupId, asset, byUserId) {
      assertOk(
        'setGroupDefaultAsset',
        await client.from('wager_groups').upsert(
          {
            group_id: groupId,
            enabled: true,
            enabled_by: byUserId,
            default_asset: asset,
            updated_at: nowIso(),
          },
          { onConflict: 'group_id' },
        ),
      );
    },

    async groupDefaultAsset(groupId) {
      const row = await maybeRow(
        'groupDefaultAsset',
        client.from('wager_groups').select('default_asset').eq('group_id', groupId).maybeSingle(),
        parseDefaultAssetRow,
      );
      return row?.default_asset ?? 'sol';
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

    async balanceLamports(userId, asset) {
      const selectedAsset = asset ?? 'sol';
      const rows = await manyRows(
        'balanceLamports',
        client
          .from('wager_ledger_entries')
          .select('lamports')
          .eq('user_id', userId)
          .eq('asset', selectedAsset),
        parseLamportsRow,
      );
      return rows.reduce((sum, row) => sum + lamportsFromDb('balanceLamports', row.lamports), 0n);
    },

    async totalLedgerLamports(asset) {
      const selectedAsset = asset ?? 'sol';
      const rows = await manyRows(
        'totalLedgerLamports',
        client.from('wager_ledger_entries').select('lamports').eq('asset', selectedAsset),
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
            {
              ...row,
              asset: row.asset ?? 'sol',
              mint_pubkey: row.mint_pubkey ?? null,
              lamports: lamportsToDb('upsertDeposit.lamports', row.lamports),
            },
            { onConflict: 'tx_sig,ix_index', ignoreDuplicates: true },
          )
          .select('id'),
        parseNumericIdRow,
      );
      return { inserted: rows.length > 0 };
    },

    async markDepositCredited(txSig, ixIndex, userId) {
      // .is(null) guard: a deposit row is credited exactly once. The ledger's
      // idempotency key is the money guard; this keeps attribution stable.
      assertOk(
        'markDepositCredited',
        await client
          .from('wager_deposits')
          .update({ user_id: userId, credited_at: nowIso() })
          .eq('tx_sig', txSig)
          .eq('ix_index', ixIndex)
          .is('credited_at', null),
      );
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
