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
    #[msg("The supplied cluster genesis hash does not match protocol configuration")]
    GenesisHashMismatch,
    #[msg("The supplied escrow program ID does not match this program")]
    ProgramIdMismatch,
    #[msg("The supplied protocol config account is not canonical")]
    ConfigMismatch,
    #[msg("The requested pause state is already active")]
    PauseStateUnchanged,
    #[msg("The oracle set is invalid")]
    InvalidOracleSet,
    #[msg("The oracle set epoch must increase")]
    OracleEpochNotIncreasing,
    #[msg("The oracle signer set contains a duplicate or default key")]
    InvalidOracleSigner,
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
    #[msg("The SOL vault is not owned by this program")]
    InvalidVaultOwner,
    #[msg("The SOL vault rent reserve is below the rent-exempt minimum")]
    InvalidVaultRentReserve,
    #[msg("The supplied token mint must use six decimals")]
    InvalidMintDecimals,
    #[msg("The supplied token account is not canonical for its owner and mint")]
    InvalidTokenAccount,
    #[msg("The position owner must be a system-owned transaction signer")]
    InvalidUserSigner,
    #[msg("The market is not in the required state")]
    InvalidMarketState,
    #[msg("The market is frozen")]
    MarketFrozen,
    #[msg("Replay markets are test-only and cannot accept value-bearing positions")]
    ReplayMarketNoFunds,
    #[msg("The position cutoff has passed")]
    PositionCutoffPassed,
    #[msg("The market duration exceeds protocol limits")]
    MarketDurationExceeded,
    #[msg("The resolution deadline exceeds protocol limits")]
    ResolutionDelayExceeded,
    #[msg("The market timestamps are stale or not strictly ordered")]
    InvalidMarketTimestamps,
    #[msg("The canonical market document hash does not match the supplied hash")]
    MarketDocumentHashMismatch,
    #[msg("The position amount is outside protocol limits")]
    InvalidPositionAmount,
    #[msg("A wallet cannot take both sides of the same market")]
    OppositeSidePosition,
    #[msg("The lot nonce is stale or has already been used")]
    LotNonceMismatch,
    #[msg("The market event epoch changed")]
    EventEpochMismatch,
    #[msg("The position lot is not pending")]
    LotNotPending,
    #[msg("The position lot cannot transition from its current state")]
    InvalidLotState,
    #[msg("The position activation delay has not elapsed")]
    ActivationDelayNotElapsed,
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
    #[msg("The Ed25519 verification instruction is malformed")]
    InvalidEd25519Instruction,
    #[msg("The market was already settled with this outcome")]
    AlreadySettled,
    #[msg("The market was already settled with a contradictory outcome")]
    ConflictingSettlement,
    #[msg("Only claim-won or claim-lost is valid for settlement")]
    InvalidSettlementOutcome,
    #[msg("The market is still calculating aggregate position entitlements")]
    SettlementInProgress,
    #[msg("This aggregate position entitlement was already calculated")]
    EntitlementAlreadyCalculated,
    #[msg("This aggregate position entitlement has not been calculated")]
    EntitlementNotCalculated,
    #[msg("The market was already voided")]
    AlreadyVoided,
    #[msg("The immutable resolution deadline has not been reached")]
    TimeoutNotReached,
    #[msg("The position is not claimable in the current market state")]
    PositionNotClaimable,
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
    #[msg("The rent recipient is not the configured relayer rent recipient")]
    InvalidRentRecipient,
    #[msg("The residual recipient is not the market-pinned recipient")]
    InvalidResidualRecipient,
    #[msg("Position lots must be closed exactly once in descending nonce order")]
    LotCloseOrderMismatch,
    #[msg("Every position lot must be closed before its aggregate position")]
    OutstandingLots,
    #[msg("Every claimed aggregate position must be closed before the market")]
    OutstandingPositions,
    #[msg("This account is already terminal or closed")]
    TerminalState,
    #[msg("The terminal phase must be F, FET, or FPE")]
    InvalidTerminalPhase,
}
