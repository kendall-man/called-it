//! Protocol constants shared by account validation and canonical clients.

pub const SCHEMA_VERSION_V1: u8 = 1;
pub const MULTIPLIER_SCALE: u64 = 1_000;
pub const PROBABILITY_PPM_SCALE: u32 = 1_000_000;
pub const FEE_BPS_V1: u16 = 0;
pub const USDC_DECIMALS: u8 = 6;

pub const CONFIG_SEED: &[u8] = b"config";
pub const ORACLE_SET_SEED: &[u8] = b"oracle-set";
pub const MARKET_SEED: &[u8] = b"market";
pub const POSITION_SEED: &[u8] = b"position";
pub const LOT_SEED: &[u8] = b"lot";
pub const SOL_VAULT_SEED: &[u8] = b"vault";

pub const MARKET_UUID_BYTES: usize = 16;
pub const HASH_BYTES: usize = 32;
pub const ORACLE_SIGNER_COUNT_V1: usize = 3;
pub const ORACLE_THRESHOLD_V1: u8 = 2;

pub const MARKET_DOCUMENT_DOMAIN_V1: &str = "calledit.escrow.market.v1";
pub const QUOTE_ATTESTATION_DOMAIN_V1: &str = "calledit.escrow.attestation.quote.v1";
pub const FEED_EVENT_ATTESTATION_DOMAIN_V1: &str = "calledit.escrow.attestation.feed-event.v1";
pub const POSITION_INVALIDATION_DOMAIN_V1: &str =
    "calledit.escrow.attestation.position-invalidation.v1";
pub const SETTLEMENT_ATTESTATION_DOMAIN_V1: &str = "calledit.escrow.attestation.settlement.v1";
pub const VOID_ATTESTATION_DOMAIN_V1: &str = "calledit.escrow.attestation.void.v1";
pub const POSITION_INTENT_DOMAIN_V1: &str = "calledit.escrow.position-intent.v1";
