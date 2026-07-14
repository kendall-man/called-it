use anchor_lang::prelude::*;

use crate::{
    encoding::VoidReason,
    state::{Asset, PositionSide, SettlementOutcome},
};

#[event]
pub struct ProtocolConfigInitialized {
    pub config: Pubkey,
    pub config_authority: Pubkey,
    pub pause_authority: Pubkey,
    pub market_creation_authority: Pubkey,
    pub residual_recipient: Pubkey,
    pub cluster_genesis_hash: [u8; 32],
    pub canonical_usdc_mint: Pubkey,
    pub allowed_token_program: Pubkey,
}

#[event]
pub struct ProtocolConfigRotated {
    pub config: Pubkey,
    pub config_authority: Pubkey,
    pub pause_authority: Pubkey,
    pub market_creation_authority: Pubkey,
    pub feed_operator_authority: Pubkey,
    pub relayer_fee_payer: Pubkey,
    pub residual_recipient: Pubkey,
}

#[event]
pub struct OracleSetRotated {
    pub oracle_set: Pubkey,
    pub epoch: u64,
    pub threshold: u8,
    pub activation_slot: u64,
}

#[event]
pub struct ProtocolPauseChanged {
    pub paused: bool,
    pub authority: Pubkey,
}

#[event]
pub struct MarketInitialized {
    pub market: Pubkey,
    pub market_uuid: [u8; 16],
    pub fixture_id: u64,
    pub asset: Asset,
    pub ratio_milli: u32,
    pub market_document_hash: [u8; 32],
    pub residual_recipient: Pubkey,
    pub oracle_set: Pubkey,
    pub vault: Pubkey,
    pub in_play_start_timestamp: i64,
    pub activation_delay_seconds: u64,
    pub position_cutoff_timestamp: i64,
    pub resolution_deadline: i64,
}

#[event]
pub struct MarketFrozen {
    pub market: Pubkey,
    pub event_epoch: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct MarketUnfrozen {
    pub market: Pubkey,
    pub event_epoch: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct PositionPlaced {
    pub market: Pubkey,
    pub position: Pubkey,
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub side: PositionSide,
    pub amount: u64,
    pub asset: Asset,
    pub pending: bool,
    pub event_epoch: u64,
    pub activation_after: Option<i64>,
    pub client_intent_hash: [u8; 32],
}

#[event]
pub struct PositionActivated {
    pub market: Pubkey,
    pub position: Pubkey,
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub event_epoch: u64,
}

#[event]
pub struct PositionInvalidated {
    pub market: Pubkey,
    pub position: Pubkey,
    pub lot: Pubkey,
    pub owner: Pubkey,
    pub nonce: u64,
    pub amount: u64,
    pub event_epoch: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub outcome: SettlementOutcome,
    pub matched_back: u64,
    pub matched_doubt: u64,
    pub forfeited_total: u64,
    pub evidence_hash: [u8; 32],
    pub final_position: Option<Pubkey>,
    pub final_owner: Option<Pubkey>,
    pub final_base_entitlement: Option<u64>,
    pub final_forfeited_amount: Option<u64>,
}

#[event]
pub struct MarketSettlementStarted {
    pub market: Pubkey,
    pub outcome: SettlementOutcome,
    pub matched_back: u64,
    pub matched_doubt: u64,
    pub position_count: u64,
    pub evidence_hash: [u8; 32],
}

#[event]
pub struct PositionEntitlementCalculated {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub base_entitlement: u64,
    pub forfeited_amount: u64,
    pub processed_position_count: u64,
}

#[event]
pub struct MarketVoided {
    pub market: Pubkey,
    pub evidence_hash: [u8; 32],
    pub timed_out: bool,
    pub reason: Option<VoidReason>,
    pub deciding_sequence: Option<u64>,
}

#[event]
pub struct PositionClaimed {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub asset: Asset,
    pub destination: Pubkey,
}

#[event]
pub struct MarketClosed {
    pub market: Pubkey,
    pub dust_amount: u64,
    pub asset: Asset,
}

#[event]
pub struct PositionLotsClosed {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub nonces: Vec<u64>,
    pub rent_recipient: Pubkey,
}

#[event]
pub struct PositionClosed {
    pub market: Pubkey,
    pub position: Pubkey,
    pub owner: Pubkey,
    pub rent_recipient: Pubkey,
}
