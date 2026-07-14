//! Stable instruction argument interfaces. Account validation and handlers are
//! added with the corresponding Wave 2 and Wave 3 value-moving slices.

use anchor_lang::prelude::*;

use crate::state::{Asset, PositionSide, SettlementOutcome};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitializeConfigArgs {
    pub cluster_genesis_hash: [u8; 32],
    pub config_authority: Pubkey,
    pub pause_authority: Pubkey,
    pub market_creation_authority: Pubkey,
    pub feed_operator_authority: Pubkey,
    pub relayer_fee_payer: Pubkey,
    pub residual_recipient: Pubkey,
    pub canonical_usdc_mint: Pubkey,
    pub allowed_token_program: Pubkey,
    pub max_sol_position: u64,
    pub max_usdc_position: u64,
    pub min_sol_position: u64,
    pub min_usdc_position: u64,
    pub max_market_duration_seconds: u64,
    pub max_resolution_delay_seconds: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct RotateOracleSetArgs {
    pub epoch: u64,
    pub signers: Vec<Pubkey>,
    pub threshold: u8,
    pub activation_slot: u64,
    pub retirement_slot: Option<u64>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SetPauseArgs {
    pub paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InitializeMarketArgs {
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
    pub replay: bool,
    pub position_cutoff_timestamp: i64,
    pub resolution_deadline: i64,
    pub oracle_set_epoch: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct FreezeMarketArgs {
    pub expected_event_epoch: u64,
    pub evidence_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct UnfreezeMarketArgs {
    pub expected_event_epoch: u64,
    pub attestation_hash: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct PlacePositionArgs {
    pub market_uuid: [u8; 16],
    pub side: PositionSide,
    pub amount: u64,
    pub expected_asset: Asset,
    pub expected_ratio_milli: u32,
    pub expected_event_epoch: u64,
    pub expected_lot_nonce: u64,
    pub client_intent_hash: [u8; 32],
    pub client_expiry_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ActivatePositionLotArgs {
    pub nonce: u64,
    pub expected_event_epoch: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct InvalidatePositionLotArgs {
    pub nonce: u64,
    pub evidence_hash: [u8; 32],
    pub attestation_expiry_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SettleMarketArgs {
    pub outcome: SettlementOutcome,
    pub deciding_sequence: u64,
    pub evidence_hash: [u8; 32],
    pub evidence_commitment: [u8; 32],
    pub attestation_expiry_timestamp: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq, Eq)]
pub struct CalculatePositionEntitlementArgs {}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct VoidMarketArgs {
    pub evidence_hash: [u8; 32],
    pub attestation_expiry_timestamp: i64,
}
