use anchor_lang::prelude::*;

#[error_code]
pub enum EscrowError {
    #[msg("The signer is not authorized for this instruction")]
    Unauthorized,
    #[msg("New markets and positions are paused")]
    ProtocolPaused,
    #[msg("The supplied authority does not match protocol configuration")]
    InvalidAuthority,
    #[msg("The protocol configuration is invalid")]
    InvalidConfig,
    #[msg("The oracle set is invalid")]
    InvalidOracleSet,
    #[msg("The oracle signature threshold is invalid")]
    InvalidOracleThreshold,
    #[msg("The oracle set is not active for this slot")]
    OracleSetInactive,
    #[msg("The probability must be between zero and one million ppm, exclusively")]
    InvalidProbability,
    #[msg("The supplied matching ratio does not match the immutable quote")]
    RatioMismatch,
    #[msg("Version 1 requires a zero fee")]
    InvalidFeeBps,
    #[msg("The supplied asset does not match the market")]
    AssetMismatch,
    #[msg("The supplied mint is not the canonical mint for this cluster")]
    InvalidMint,
    #[msg("Only the configured classic SPL token program is accepted")]
    InvalidTokenProgram,
    #[msg("The supplied vault is not the canonical market vault")]
    InvalidVault,
    #[msg("The market is not in the required state")]
    InvalidMarketState,
    #[msg("The market is frozen")]
    MarketFrozen,
    #[msg("The position cutoff has passed")]
    PositionCutoffPassed,
    #[msg("The market duration exceeds protocol limits")]
    MarketDurationExceeded,
    #[msg("The resolution deadline exceeds protocol limits")]
    ResolutionDelayExceeded,
    #[msg("The position amount is outside protocol limits")]
    InvalidPositionAmount,
    #[msg("A wallet cannot take both sides of the same market")]
    OppositeSidePosition,
    #[msg("The lot nonce is stale or has already been used")]
    LotNonceMismatch,
    #[msg("The market event epoch changed")]
    EventEpochMismatch,
    #[msg("The client signing intent expired")]
    ClientIntentExpired,
    #[msg("Checked arithmetic overflowed")]
    ArithmeticOverflow,
    #[msg("The attestation domain or cluster binding is invalid")]
    InvalidAttestationDomain,
    #[msg("The attestation expired")]
    AttestationExpired,
    #[msg("The attestation does not have enough unique valid signatures")]
    SignatureThresholdNotMet,
    #[msg("The market was already settled with this outcome")]
    AlreadySettled,
    #[msg("The market was already settled with a contradictory outcome")]
    ConflictingSettlement,
    #[msg("Claims can only pay the recorded owner destination")]
    InvalidClaimDestination,
    #[msg("This position was already claimed")]
    AlreadyClaimed,
    #[msg("All positions must be claimed before the market can close")]
    OutstandingClaims,
    #[msg("The vault balance is below accounted user entitlements")]
    VaultUnderfunded,
    #[msg("A protocol accounting invariant was violated")]
    AccountingInvariant,
}
