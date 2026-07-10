import { assertOk } from './errors.js';
import {
  assertSafeInteger,
  depositFromRaw,
  lamportsFromDb,
  lamportsToDb,
  manyRows,
  maybeRow,
  nowIso,
  UNIQUE_VIOLATION,
  type RawDepositRow,
  type Row,
  type WagerDb,
  type WagerDbClient,
} from './wager-db-core.js';
import type { WagerWalletLinkRow } from './wager-types.js';

type AccountDb = Pick<
  WagerDb,
  | 'setGroupEnabled'
  | 'isGroupEnabled'
  | 'getWalletLink'
  | 'getWalletLinkByPubkey'
  | 'linkWallet'
  | 'setLastWagerGroup'
  | 'markWalletVerified'
  | 'unlinkWallet'
  | 'postWagerLedger'
  | 'balanceLamports'
  | 'totalLedgerLamports'
  | 'upsertDeposit'
  | 'markDepositCredited'
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
      const row = await maybeRow<{ enabled: boolean }>(
        'isGroupEnabled',
        client.from('wager_groups').select('enabled').eq('group_id', groupId).maybeSingle(),
      );
      return row?.enabled ?? false;
    },

    // ── wallet links ───────────────────────────────────────────────────────

    async getWalletLink(userId) {
      return maybeRow<WagerWalletLinkRow>(
        'getWalletLink',
        client.from('wager_wallet_links').select('*').eq('user_id', userId).maybeSingle(),
      );
    },

    async getWalletLinkByPubkey(pubkey) {
      return maybeRow<WagerWalletLinkRow>(
        'getWalletLinkByPubkey',
        client.from('wager_wallet_links').select('*').eq('pubkey', pubkey).maybeSingle(),
      );
    },

    async linkWallet(input) {
      // Lookup-then-upsert: the lookup only feeds the cosmetic relinked flag,
      // so its benign race window costs nothing. verified_at resets on every
      // (re-)link — verification belongs to the linked pubkey, not the user.
      const existing = await maybeRow<{ pubkey: string }>(
        'linkWallet.lookup',
        client.from('wager_wallet_links').select('pubkey').eq('user_id', input.user_id).maybeSingle(),
      );
      const row: Row = { user_id: input.user_id, pubkey: input.pubkey, verified_at: null };
      if (input.last_wager_group_id !== undefined) {
        row.last_wager_group_id = input.last_wager_group_id;
      }
      const result = await client
        .from('wager_wallet_links')
        .upsert(row, { onConflict: 'user_id' });
      if (result.error?.code === UNIQUE_VIOLATION) return { ok: false, reason: 'pubkey_taken' };
      assertOk('linkWallet', result);
      return { ok: true, relinked: existing !== null && existing.pubkey !== input.pubkey };
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

    async markWalletVerified(userId) {
      // .is(null) guard keeps the FIRST verification timestamp.
      assertOk(
        'markWalletVerified',
        await client
          .from('wager_wallet_links')
          .update({ verified_at: nowIso() })
          .eq('user_id', userId)
          .is('verified_at', null),
      );
    },

    async unlinkWallet(userId) {
      assertOk(
        'unlinkWallet',
        await client.from('wager_wallet_links').delete().eq('user_id', userId),
      );
    },

    // ── ledger ─────────────────────────────────────────────────────────────

    async postWagerLedger(entry) {
      const rows = await manyRows<Array<{ id: number }>>(
        'postWagerLedger',
        client
          .from('wager_ledger_entries')
          .upsert(
            { ...entry, lamports: lamportsToDb('postWagerLedger.lamports', entry.lamports) },
            { onConflict: 'idempotency_key', ignoreDuplicates: true },
          )
          .select('id'),
      );
      return { inserted: rows.length > 0 };
    },

    async balanceLamports(userId) {
      const rows = await manyRows<Array<{ lamports: number }>>(
        'balanceLamports',
        client.from('wager_ledger_entries').select('lamports').eq('user_id', userId),
      );
      return rows.reduce((sum, row) => sum + lamportsFromDb('balanceLamports', row.lamports), 0n);
    },

    async totalLedgerLamports() {
      const rows = await manyRows<Array<{ lamports: number }>>(
        'totalLedgerLamports',
        client.from('wager_ledger_entries').select('lamports'),
      );
      return rows.reduce(
        (sum, row) => sum + lamportsFromDb('totalLedgerLamports', row.lamports),
        0n,
      );
    },

    // ── deposits ───────────────────────────────────────────────────────────

    async upsertDeposit(row) {
      assertSafeInteger('upsertDeposit.slot', row.slot);
      const rows = await manyRows<Array<{ id: number }>>(
        'upsertDeposit',
        client
          .from('wager_deposits')
          .upsert(
            { ...row, lamports: lamportsToDb('upsertDeposit.lamports', row.lamports) },
            { onConflict: 'tx_sig,ix_index', ignoreDuplicates: true },
          )
          .select('id'),
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
      const rows = await manyRows<RawDepositRow[]>(
        'orphanDepositsBySender',
        client
          .from('wager_deposits')
          .select('*')
          .eq('sender_pubkey', pubkey)
          .is('user_id', null),
      );
      return rows.map((row) => depositFromRaw('orphanDepositsBySender', row));
    },

  };
}
