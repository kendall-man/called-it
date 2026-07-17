use anchor_lang::prelude::*;

use crate::constants::ORACLE_SIGNER_COUNT_V1;

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum Asset {
    #[default]
    Sol,
    Usdc,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum MarketState {
    #[default]
    Opening,
    Open,
    Frozen,
    Settling,
    Settled,
    Voided,
    Closed,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum PositionSide {
    #[default]
    Back,
    Doubt,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum LotState {
    #[default]
    Pending,
    Active,
    Voided,
}

#[derive(
    AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, Default, PartialEq, Eq, InitSpace,
)]
pub enum SettlementOutcome {
    #[default]
    Unresolved,
    ClaimWon,
    ClaimLost,
    Void,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct ProtocolConfig {
    pub version: u8,
    pub bump: u8,
    pub paused: bool,
    pub config_authority: Pubkey,
    pub pause_authority: Pubkey,
    pub market_creation_authority: Pubkey,
    pub feed_operator_authority: Pubkey,
    pub oracle_set: Pubkey,
    pub relayer_fee_payer: Pubkey,
    pub residual_recipient: Pubkey,
    pub cluster_genesis_hash: [u8; 32],
    /// The one canonical classic SPL USDC mint for `cluster_genesis_hash`.
    pub canonical_usdc_mint: Pubkey,
    pub allowed_token_program: Pubkey,
    pub max_sol_position: u64,
    pub max_usdc_position: u64,
    pub min_sol_position: u64,
    pub min_usdc_position: u64,
    pub max_market_duration_seconds: u64,
    pub max_resolution_delay_seconds: u64,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct OracleSet {
    pub version: u8,
    pub bump: u8,
    pub epoch: u64,
    #[max_len(ORACLE_SIGNER_COUNT_V1)]
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub activation_slot: u64,
    pub retirement_slot: Option<u64>,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct Market {
    pub version: u8,
    pub bump: u8,
    pub market_uuid: [u8; 16],
    pub fixture_id: u64,
    pub claim_spec_hash: [u8; 32],
    pub display_terms_hash: [u8; 32],
    pub odds_source_message_hash: [u8; 32],
    pub market_document_hash: [u8; 32],
    pub quote_timestamp: i64,
    pub probability_ppm: u32,
    pub ratio_milli: u32,
    pub asset: Asset,
    pub token_mint: Pubkey,
    pub fee_bps: u16,
    pub state: MarketState,
    pub replay: bool,
    /// Pinned at market creation. Neither close instruction callers nor later
    /// config rotations can redirect residual dust or reclaimed account rent.
    pub residual_recipient: Pubkey,
    pub created_timestamp: i64,
    /// Immutable kickoff boundary. Placements at or after this timestamp enter
    /// the pending anti-snipe state.
    pub in_play_start_timestamp: i64,
    pub activation_delay_seconds: u64,
    pub position_cutoff_timestamp: i64,
    pub resolution_deadline: i64,
    pub oracle_set_epoch: u64,
    pub event_epoch: u64,
    pub active_back_total: u64,
    pub active_doubt_total: u64,
    pub pending_back_total: u64,
    pub pending_doubt_total: u64,
    pub final_matched_back_total: u64,
    pub final_matched_doubt_total: u64,
    /// Sum of per-owner aggregate losing forfeits after floor division. This
    /// cannot be reconstructed from matched totals alone when multiple losing
    /// owners exist.
    pub final_forfeited_total: u64,
    /// Number of aggregate positions whose deterministic base entitlement has
    /// been calculated permissionlessly after threshold settlement.
    pub settlement_processed_position_count: u64,
    pub settlement_outcome: SettlementOutcome,
    pub settlement_evidence_hash: [u8; 32],
    pub position_count: u64,
    pub claimed_position_count: u64,
    pub vault: Pubkey,
    pub vault_bump: u8,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct UserPosition {
    pub version: u8,
    pub bump: u8,
    pub market: Pubkey,
    pub owner: Pubkey,
    pub side: PositionSide,
    pub active_amount: u64,
    pub pending_amount: u64,
    pub refundable_amount: u64,
    /// Active stake/refund component fixed by program math before winner
    /// winnings are derived from the finalized forfeited total.
    pub settlement_base_entitlement: u64,
    pub settlement_processed: bool,
    pub next_lot_nonce: u64,
    pub claimed: bool,
    pub total_paid_amount: u64,
    pub created_slot: u64,
    pub updated_slot: u64,
}

#[account]
#[derive(Debug, InitSpace)]
pub struct PositionLot {
    pub version: u8,
    pub bump: u8,
    pub market: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub side: PositionSide,
    pub amount: u64,
    pub placed_timestamp: i64,
    pub placed_slot: u64,
    pub observed_event_epoch: u64,
    pub state: LotState,
    pub activation_timestamp: Option<i64>,
    pub invalidation_evidence_hash: Option<[u8; 32]>,
}

pub const PROTOCOL_CONFIG_ACCOUNT_SPACE: usize = 8 + ProtocolConfig::INIT_SPACE;
pub const ORACLE_SET_ACCOUNT_SPACE: usize = 8 + OracleSet::INIT_SPACE;
pub const MARKET_ACCOUNT_SPACE: usize = 8 + Market::INIT_SPACE;
pub const USER_POSITION_ACCOUNT_SPACE: usize = 8 + UserPosition::INIT_SPACE;
pub const POSITION_LOT_ACCOUNT_SPACE: usize = 8 + PositionLot::INIT_SPACE;
