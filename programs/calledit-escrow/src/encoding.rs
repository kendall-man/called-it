//! Canonical V1 document and attestation encodings.
//!
//! These are deliberately manual rather than Borsh-derived: signatures bind
//! the exact documented field order, widths, endianness, and domain prefix.

use anchor_lang::solana_program::hash::hash;

use crate::{
    constants::{
        FEED_EVENT_ATTESTATION_DOMAIN_V1, FEE_BPS_V1, MARKET_DOCUMENT_DOMAIN_V1,
        POSITION_INVALIDATION_DOMAIN_V1, QUOTE_ATTESTATION_DOMAIN_V1, SCHEMA_VERSION_V1,
        SETTLEMENT_ATTESTATION_DOMAIN_V1, VOID_ATTESTATION_DOMAIN_V1,
    },
    math::ratio_milli,
    state::{Asset, SettlementOutcome},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingError {
    InvalidProbability,
    RatioMismatch,
    NonzeroFee,
    InvalidDeadlineOrder,
    InvalidValidityWindow,
    InvalidEventEpoch,
    InvalidOutcome,
    EmptyTerminalPhase,
    StringTooLong,
}

pub type EncodingResult<T> = core::result::Result<T, EncodingError>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MarketDocumentV1 {
    pub market_uuid: [u8; 16],
    pub fixture_id: u64,
    pub claim_specification_hash: [u8; 32],
    pub display_terms_hash: [u8; 32],
    pub asset: Asset,
    pub probability_ppm: u32,
    pub ratio_milli: u32,
    pub odds_message_hash: [u8; 32],
    pub odds_timestamp: i64,
    pub position_cutoff: i64,
    pub resolution_deadline: i64,
    pub fee_bps: u16,
    pub oracle_set_epoch: u64,
    pub replay_flag: bool,
}

impl MarketDocumentV1 {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        let expected_ratio =
            ratio_milli(self.probability_ppm).map_err(|_| EncodingError::InvalidProbability)?;
        if self.ratio_milli != expected_ratio {
            return Err(EncodingError::RatioMismatch);
        }
        if self.fee_bps != FEE_BPS_V1 {
            return Err(EncodingError::NonzeroFee);
        }
        if self.position_cutoff <= self.odds_timestamp
            || self.resolution_deadline <= self.position_cutoff
        {
            return Err(EncodingError::InvalidDeadlineOrder);
        }

        let mut writer = CanonicalWriter::for_domain(MARKET_DOCUMENT_DOMAIN_V1)?;
        writer.fixed(&self.market_uuid);
        writer.u64(self.fixture_id);
        writer.fixed(&self.claim_specification_hash);
        writer.fixed(&self.display_terms_hash);
        writer.u8(asset_tag(self.asset));
        writer.u32(self.probability_ppm);
        writer.u32(self.ratio_milli);
        writer.fixed(&self.odds_message_hash);
        writer.i64(self.odds_timestamp);
        writer.i64(self.position_cutoff);
        writer.i64(self.resolution_deadline);
        writer.u16(self.fee_bps);
        writer.u64(self.oracle_set_epoch);
        writer.bool(self.replay_flag);
        Ok(writer.finish())
    }

    pub fn hash(&self) -> EncodingResult<[u8; 32]> {
        Ok(hash_canonical_bytes(&self.encode()?))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AttestationCommonV1 {
    pub cluster_genesis_hash: [u8; 32],
    pub escrow_program_id: [u8; 32],
    pub market_pda: [u8; 32],
    pub market_document_hash: [u8; 32],
    pub fixture_id: u64,
    pub oracle_set_epoch: u64,
    pub issued_at: i64,
    pub expires_at: i64,
    pub evidence_hash: [u8; 32],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct QuoteAttestationV1 {
    pub common: AttestationCommonV1,
    pub probability_ppm: u32,
    pub ratio_milli: u32,
    pub odds_timestamp: i64,
}

impl QuoteAttestationV1 {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        let expected_ratio =
            ratio_milli(self.probability_ppm).map_err(|_| EncodingError::InvalidProbability)?;
        if self.ratio_milli != expected_ratio {
            return Err(EncodingError::RatioMismatch);
        }
        let mut writer = writer_for_attestation(QUOTE_ATTESTATION_DOMAIN_V1, &self.common)?;
        writer.u32(self.probability_ppm);
        writer.u32(self.ratio_milli);
        writer.i64(self.odds_timestamp);
        Ok(writer.finish())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FeedEventKind {
    Freeze,
    Unfreeze,
    PriceMoving,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FeedEventAttestationV1 {
    pub common: AttestationCommonV1,
    pub event_kind: FeedEventKind,
    pub event_epoch: u64,
    pub deciding_sequence: u64,
    pub observed_at: i64,
}

impl FeedEventAttestationV1 {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        let mut writer = writer_for_attestation(FEED_EVENT_ATTESTATION_DOMAIN_V1, &self.common)?;
        writer.u8(match self.event_kind {
            FeedEventKind::Freeze => 0,
            FeedEventKind::Unfreeze => 1,
            FeedEventKind::PriceMoving => 2,
        });
        writer.u64(self.event_epoch);
        writer.u64(self.deciding_sequence);
        writer.i64(self.observed_at);
        Ok(writer.finish())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PositionInvalidationAttestationV1 {
    pub common: AttestationCommonV1,
    pub position_lot_pda: [u8; 32],
    pub lot_nonce: u64,
    pub observed_event_epoch: u64,
    pub invalidated_event_epoch: u64,
    pub deciding_sequence: u64,
}

impl PositionInvalidationAttestationV1 {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        if self.invalidated_event_epoch <= self.observed_event_epoch {
            return Err(EncodingError::InvalidEventEpoch);
        }
        let mut writer = writer_for_attestation(POSITION_INVALIDATION_DOMAIN_V1, &self.common)?;
        writer.fixed(&self.position_lot_pda);
        writer.u64(self.lot_nonce);
        writer.u64(self.observed_event_epoch);
        writer.u64(self.invalidated_event_epoch);
        writer.u64(self.deciding_sequence);
        Ok(writer.finish())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ScoreV1 {
    pub home: u16,
    pub away: u16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementAttestationV1<'a> {
    pub common: AttestationCommonV1,
    pub outcome: SettlementOutcome,
    pub deciding_sequence: u64,
    pub terminal_phase: &'a str,
    pub regulation_score: Option<ScoreV1>,
    pub full_match_score: Option<ScoreV1>,
    pub evidence_sequence_commitment: [u8; 32],
    pub normalized_evidence_root: [u8; 32],
}

impl SettlementAttestationV1<'_> {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        if self.terminal_phase.is_empty() {
            return Err(EncodingError::EmptyTerminalPhase);
        }
        let outcome_tag = match self.outcome {
            SettlementOutcome::ClaimWon => 0,
            SettlementOutcome::ClaimLost => 1,
            SettlementOutcome::Unresolved | SettlementOutcome::Void => {
                return Err(EncodingError::InvalidOutcome)
            }
        };
        let mut writer = writer_for_attestation(SETTLEMENT_ATTESTATION_DOMAIN_V1, &self.common)?;
        writer.u8(outcome_tag);
        writer.u64(self.deciding_sequence);
        writer.string16(self.terminal_phase, 32)?;
        writer.optional_score(self.regulation_score);
        writer.optional_score(self.full_match_score);
        writer.fixed(&self.evidence_sequence_commitment);
        writer.fixed(&self.normalized_evidence_root);
        Ok(writer.finish())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum VoidReason {
    Cancelled,
    Abandoned,
    CoverageLoss,
    Undecidable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VoidAttestationV1 {
    pub common: AttestationCommonV1,
    pub reason: VoidReason,
    pub deciding_sequence: u64,
}

impl VoidAttestationV1 {
    pub fn encode(&self) -> EncodingResult<Vec<u8>> {
        let mut writer = writer_for_attestation(VOID_ATTESTATION_DOMAIN_V1, &self.common)?;
        writer.u8(match self.reason {
            VoidReason::Cancelled => 0,
            VoidReason::Abandoned => 1,
            VoidReason::CoverageLoss => 2,
            VoidReason::Undecidable => 3,
        });
        writer.u64(self.deciding_sequence);
        Ok(writer.finish())
    }
}

pub fn hash_canonical_bytes(bytes: &[u8]) -> [u8; 32] {
    hash(bytes).to_bytes()
}

fn writer_for_attestation(
    domain: &str,
    common: &AttestationCommonV1,
) -> EncodingResult<CanonicalWriter> {
    if common.expires_at <= common.issued_at {
        return Err(EncodingError::InvalidValidityWindow);
    }
    let mut writer = CanonicalWriter::for_domain(domain)?;
    writer.fixed(&common.cluster_genesis_hash);
    writer.fixed(&common.escrow_program_id);
    writer.fixed(&common.market_pda);
    writer.fixed(&common.market_document_hash);
    writer.u64(common.fixture_id);
    writer.u64(common.oracle_set_epoch);
    writer.i64(common.issued_at);
    writer.i64(common.expires_at);
    writer.fixed(&common.evidence_hash);
    Ok(writer)
}

fn asset_tag(asset: Asset) -> u8 {
    match asset {
        Asset::Sol => 0,
        Asset::Usdc => 1,
    }
}

struct CanonicalWriter {
    bytes: Vec<u8>,
}

impl CanonicalWriter {
    fn for_domain(domain: &str) -> EncodingResult<Self> {
        let mut writer = Self { bytes: Vec::new() };
        writer.string16(domain, 96)?;
        writer.u8(SCHEMA_VERSION_V1);
        Ok(writer)
    }

    fn fixed(&mut self, bytes: &[u8]) {
        self.bytes.extend_from_slice(bytes);
    }

    fn u8(&mut self, value: u8) {
        self.bytes.push(value);
    }

    fn bool(&mut self, value: bool) {
        self.u8(u8::from(value));
    }

    fn u16(&mut self, value: u16) {
        self.fixed(&value.to_le_bytes());
    }

    fn u32(&mut self, value: u32) {
        self.fixed(&value.to_le_bytes());
    }

    fn u64(&mut self, value: u64) {
        self.fixed(&value.to_le_bytes());
    }

    fn i64(&mut self, value: i64) {
        self.fixed(&value.to_le_bytes());
    }

    fn string16(&mut self, value: &str, maximum_bytes: usize) -> EncodingResult<()> {
        let bytes = value.as_bytes();
        if bytes.len() > maximum_bytes || bytes.len() > usize::from(u16::MAX) {
            return Err(EncodingError::StringTooLong);
        }
        self.u16(bytes.len() as u16);
        self.fixed(bytes);
        Ok(())
    }

    fn optional_score(&mut self, score: Option<ScoreV1>) {
        self.bool(score.is_some());
        if let Some(score) = score {
            self.u16(score.home);
            self.u16(score.away);
        }
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}
