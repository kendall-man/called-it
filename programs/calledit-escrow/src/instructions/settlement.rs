use anchor_lang::prelude::*;

use crate::{
    constants::{CONFIG_SEED, MARKET_SEED, ORACLE_SET_SEED},
    encoding::{SettlementAttestationV1, VoidAttestationV1},
    errors::EscrowError,
    events::{MarketSettled, MarketSettlementStarted, MarketVoided, PositionEntitlementCalculated},
    math::{compute_pots, loser_forfeit, MathError},
    state::{
        Market, MarketState, OracleSet, PositionSide, ProtocolConfig, SettlementOutcome,
        UserPosition,
    },
};

use super::{
    attestations::{validate_pinned_oracle_set, verify_threshold_signatures},
    market::market_attestation_common,
    CalculatePositionEntitlementArgs, SettleMarketArgs, VoidMarketArgs,
};

#[derive(Accounts)]
pub struct SettleMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [ORACLE_SET_SEED, &market.oracle_set_epoch.to_le_bytes()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Box<Account<'info, OracleSet>>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn settle_market(ctx: Context<SettleMarket>, args: SettleMarketArgs) -> Result<()> {
    let clock = Clock::get()?;
    validate_terminal_phase(&args.terminal_phase)?;
    validate_settlement_start(&ctx.accounts.market, args.outcome, args.evidence_hash)?;
    validate_market_oracle(&ctx.accounts.oracle_set, &ctx.accounts.market, clock.slot)?;

    let attestation = SettlementAttestationV1 {
        common: market_attestation_common(
            &ctx.accounts.config,
            &ctx.accounts.market,
            ctx.accounts.market.key(),
            args.issued_at,
            args.expires_at,
            args.evidence_hash,
        ),
        outcome: args.outcome,
        deciding_sequence: args.deciding_sequence,
        terminal_phase: &args.terminal_phase,
        regulation_score: args.regulation_score,
        full_match_score: args.full_match_score,
        evidence_sequence_commitment: args.evidence_sequence_commitment,
        normalized_evidence_root: args.normalized_evidence_root,
    };
    let message = attestation
        .encode()
        .map_err(|_| error!(EscrowError::InvalidAttestationDomain))?;
    verify_threshold_signatures(
        &ctx.accounts.oracle_set,
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &message,
        clock.unix_timestamp,
        args.issued_at,
        args.expires_at,
    )?;

    begin_settlement(&mut ctx.accounts.market, args.outcome, args.evidence_hash)?;
    let market = &ctx.accounts.market;
    match initial_settlement_event(market) {
        InitialSettlementEvent::Started => emit!(MarketSettlementStarted {
            market: market.key(),
            outcome: market.settlement_outcome,
            matched_back: market.final_matched_back_total,
            matched_doubt: market.final_matched_doubt_total,
            position_count: market.position_count,
            evidence_hash: market.settlement_evidence_hash,
        }),
        InitialSettlementEvent::Settled => emit_settled(market, None),
    }
    Ok(())
}

fn validate_terminal_phase(terminal_phase: &str) -> Result<()> {
    require!(
        matches!(terminal_phase, "F" | "FET" | "FPE"),
        EscrowError::InvalidTerminalPhase
    );
    Ok(())
}

#[derive(Accounts)]
pub struct CalculatePositionEntitlement<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [crate::constants::POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch
    )]
    pub position: Account<'info, UserPosition>,
}

pub fn calculate_position_entitlement(
    ctx: Context<CalculatePositionEntitlement>,
    _args: CalculatePositionEntitlementArgs,
) -> Result<()> {
    let position_key = ctx.accounts.position.key();
    let calculation = calculate_entitlement(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        Clock::get()?.slot,
    )?;
    match entitlement_event(calculation) {
        EntitlementEvent::Calculated => emit!(PositionEntitlementCalculated {
            market: ctx.accounts.market.key(),
            position: position_key,
            owner: ctx.accounts.position.owner,
            base_entitlement: ctx.accounts.position.settlement_base_entitlement,
            forfeited_amount: calculation.forfeited,
            processed_position_count: ctx.accounts.market.settlement_processed_position_count,
        }),
        EntitlementEvent::Settled => emit_settled(
            &ctx.accounts.market,
            Some(FinalPositionSettlement {
                position: position_key,
                owner: ctx.accounts.position.owner,
                base_entitlement: ctx.accounts.position.settlement_base_entitlement,
                forfeited: calculation.forfeited,
            }),
        ),
    }
    Ok(())
}

#[derive(Accounts)]
pub struct VoidMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [ORACLE_SET_SEED, &market.oracle_set_epoch.to_le_bytes()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Box<Account<'info, OracleSet>>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn void_market(ctx: Context<VoidMarket>, args: VoidMarketArgs) -> Result<()> {
    let clock = Clock::get()?;
    validate_void_start(ctx.accounts.market.state)?;
    validate_market_oracle(&ctx.accounts.oracle_set, &ctx.accounts.market, clock.slot)?;
    let attestation = VoidAttestationV1 {
        common: market_attestation_common(
            &ctx.accounts.config,
            &ctx.accounts.market,
            ctx.accounts.market.key(),
            args.issued_at,
            args.expires_at,
            args.evidence_hash,
        ),
        reason: args.reason,
        deciding_sequence: args.deciding_sequence,
    };
    let message = attestation
        .encode()
        .map_err(|_| error!(EscrowError::InvalidAttestationDomain))?;
    verify_threshold_signatures(
        &ctx.accounts.oracle_set,
        &ctx.accounts.instructions_sysvar.to_account_info(),
        &message,
        clock.unix_timestamp,
        args.issued_at,
        args.expires_at,
    )?;

    transition_to_void(&mut ctx.accounts.market, args.evidence_hash)?;
    emit!(MarketVoided {
        market: ctx.accounts.market.key(),
        evidence_hash: args.evidence_hash,
        timed_out: false,
        reason: Some(args.reason),
        deciding_sequence: Some(args.deciding_sequence),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct TimeoutVoid<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
}

pub fn timeout_void(ctx: Context<TimeoutVoid>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    validate_timeout_deadline(now, ctx.accounts.market.resolution_deadline)?;
    transition_to_void(&mut ctx.accounts.market, [0; 32])?;
    emit!(MarketVoided {
        market: ctx.accounts.market.key(),
        evidence_hash: [0; 32],
        timed_out: true,
        reason: None,
        deciding_sequence: None,
    });
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EntitlementCalculation {
    pub(crate) forfeited: u64,
    pub(crate) finalized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum InitialSettlementEvent {
    Started,
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum EntitlementEvent {
    Calculated,
    Settled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FinalPositionSettlement {
    position: Pubkey,
    owner: Pubkey,
    base_entitlement: u64,
    forfeited: u64,
}

fn validate_market_oracle(
    oracle_set: &Account<OracleSet>,
    market: &Market,
    slot: u64,
) -> Result<()> {
    validate_pinned_oracle_set(oracle_set, market.oracle_set_epoch)?;
    require!(
        oracle_set.activation_slot <= slot,
        EscrowError::OracleSetInactive
    );
    Ok(())
}

fn validate_settlement_start(
    market: &Market,
    outcome: SettlementOutcome,
    evidence_hash: [u8; 32],
) -> Result<()> {
    require!(
        matches!(
            outcome,
            SettlementOutcome::ClaimWon | SettlementOutcome::ClaimLost
        ),
        EscrowError::InvalidSettlementOutcome
    );
    match market.state {
        MarketState::Open | MarketState::Frozen => Ok(()),
        MarketState::Settling | MarketState::Settled
            if market.settlement_outcome == outcome
                && market.settlement_evidence_hash == evidence_hash =>
        {
            err!(EscrowError::AlreadySettled)
        }
        MarketState::Settling | MarketState::Settled => err!(EscrowError::ConflictingSettlement),
        MarketState::Voided => err!(EscrowError::AlreadyVoided),
        MarketState::Opening | MarketState::Closed => err!(EscrowError::InvalidMarketState),
    }
}

pub(crate) fn begin_settlement(
    market: &mut Market,
    outcome: SettlementOutcome,
    evidence_hash: [u8; 32],
) -> Result<()> {
    validate_settlement_start(market, outcome, evidence_hash)?;
    let pots = compute_pots(
        market.active_back_total,
        market.active_doubt_total,
        market.ratio_milli,
    )
    .map_err(map_math_error)?;
    market.final_matched_back_total = pots.matched_back;
    market.final_matched_doubt_total = pots.matched_doubt;
    market.final_forfeited_total = 0;
    market.settlement_processed_position_count = 0;
    market.settlement_outcome = outcome;
    market.settlement_evidence_hash = evidence_hash;
    market.state = if market.position_count == 0 {
        MarketState::Settled
    } else {
        MarketState::Settling
    };
    Ok(())
}

pub(crate) fn calculate_entitlement(
    market: &mut Market,
    position: &mut UserPosition,
    slot: u64,
) -> Result<EntitlementCalculation> {
    require!(!position.claimed, EscrowError::AlreadyClaimed);
    require!(
        !position.settlement_processed,
        EscrowError::EntitlementAlreadyCalculated
    );
    require!(
        market.state == MarketState::Settling,
        EscrowError::InvalidMarketState
    );
    validate_position_principal(position)?;

    let winning_side = winning_side(market.settlement_outcome)?;
    let refund_buckets = position
        .pending_amount
        .checked_add(position.refundable_amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let forfeited = if position.side == winning_side {
        position.settlement_base_entitlement = position
            .active_amount
            .checked_add(refund_buckets)
            .ok_or(EscrowError::ArithmeticOverflow)?;
        0
    } else {
        let (matched_losing, total_losing) = if position.side == PositionSide::Back {
            (market.final_matched_back_total, market.active_back_total)
        } else {
            (market.final_matched_doubt_total, market.active_doubt_total)
        };
        let forfeited = loser_forfeit(position.active_amount, matched_losing, total_losing)
            .map_err(map_math_error)?;
        position.settlement_base_entitlement = position
            .active_amount
            .checked_sub(forfeited)
            .and_then(|value| value.checked_add(refund_buckets))
            .ok_or(EscrowError::AccountingInvariant)?;
        forfeited
    };

    market.final_forfeited_total = market
        .final_forfeited_total
        .checked_add(forfeited)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    market.settlement_processed_position_count = market
        .settlement_processed_position_count
        .checked_add(1)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(
        market.settlement_processed_position_count <= market.position_count,
        EscrowError::AccountingInvariant
    );
    position.settlement_processed = true;
    position.updated_slot = slot;

    let finalized = market.settlement_processed_position_count == market.position_count;
    if finalized {
        market.state = MarketState::Settled;
    }
    Ok(EntitlementCalculation {
        forfeited,
        finalized,
    })
}

fn transition_to_void(market: &mut Market, evidence_hash: [u8; 32]) -> Result<()> {
    validate_void_start(market.state)?;
    market.state = MarketState::Voided;
    market.final_matched_back_total = 0;
    market.final_matched_doubt_total = 0;
    market.final_forfeited_total = 0;
    // Once terminal, this field tracks aggregate position accounts that must
    // be closed before the market can close. Settled markets naturally reach
    // the same value after permissionless entitlement calculation.
    market.settlement_processed_position_count = market.position_count;
    market.settlement_outcome = SettlementOutcome::Void;
    market.settlement_evidence_hash = evidence_hash;
    Ok(())
}

fn validate_timeout_deadline(now: i64, resolution_deadline: i64) -> Result<()> {
    require!(now >= resolution_deadline, EscrowError::TimeoutNotReached);
    Ok(())
}

fn validate_void_start(state: MarketState) -> Result<()> {
    match state {
        MarketState::Open | MarketState::Frozen => Ok(()),
        MarketState::Voided => err!(EscrowError::AlreadyVoided),
        MarketState::Settling | MarketState::Settled => err!(EscrowError::ConflictingSettlement),
        MarketState::Opening | MarketState::Closed => err!(EscrowError::InvalidMarketState),
    }
}

fn validate_position_principal(position: &UserPosition) -> Result<()> {
    let accounted = position
        .active_amount
        .checked_add(position.pending_amount)
        .and_then(|value| value.checked_add(position.refundable_amount))
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(
        accounted == position.total_paid_amount,
        EscrowError::AccountingInvariant
    );
    Ok(())
}

fn winning_side(outcome: SettlementOutcome) -> Result<PositionSide> {
    match outcome {
        SettlementOutcome::ClaimWon => Ok(PositionSide::Back),
        SettlementOutcome::ClaimLost => Ok(PositionSide::Doubt),
        SettlementOutcome::Unresolved | SettlementOutcome::Void => {
            err!(EscrowError::InvalidSettlementOutcome)
        }
    }
}

fn map_math_error(error: MathError) -> anchor_lang::error::Error {
    match error {
        MathError::Overflow => error!(EscrowError::ArithmeticOverflow),
        MathError::InvalidOutcome | MathError::InvalidProbability | MathError::InvalidRatio => {
            error!(EscrowError::InvalidSettlementOutcome)
        }
        MathError::InconsistentTotals | MathError::DuplicateOwner | MathError::OppositeSide => {
            error!(EscrowError::AccountingInvariant)
        }
    }
}

fn initial_settlement_event(market: &Market) -> InitialSettlementEvent {
    if market.state == MarketState::Settled {
        InitialSettlementEvent::Settled
    } else {
        InitialSettlementEvent::Started
    }
}

fn entitlement_event(calculation: EntitlementCalculation) -> EntitlementEvent {
    if calculation.finalized {
        EntitlementEvent::Settled
    } else {
        EntitlementEvent::Calculated
    }
}

fn emit_settled(market: &Account<Market>, final_position: Option<FinalPositionSettlement>) {
    emit!(MarketSettled {
        market: market.key(),
        outcome: market.settlement_outcome,
        matched_back: market.final_matched_back_total,
        matched_doubt: market.final_matched_doubt_total,
        forfeited_total: market.final_forfeited_total,
        evidence_hash: market.settlement_evidence_hash,
        final_position: final_position.map(|position| position.position),
        final_owner: final_position.map(|position| position.owner),
        final_base_entitlement: final_position.map(|position| position.base_entitlement),
        final_forfeited_amount: final_position.map(|position| position.forfeited),
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        instructions::claims::settled_claim_amount,
        math::{settle_positions, SettlementInput},
    };
    use proptest::prelude::*;

    fn market(state: MarketState) -> Market {
        Market {
            version: 1,
            bump: 1,
            market_uuid: [1; 16],
            fixture_id: 1,
            claim_spec_hash: [2; 32],
            display_terms_hash: [3; 32],
            odds_source_message_hash: [4; 32],
            market_document_hash: [5; 32],
            quote_timestamp: 10,
            probability_ppm: 500_000,
            ratio_milli: 1_000,
            asset: crate::state::Asset::Sol,
            token_mint: Pubkey::default(),
            fee_bps: 0,
            state,
            replay: false,
            residual_recipient: Pubkey::new_unique(),
            created_timestamp: 10,
            in_play_start_timestamp: 20,
            activation_delay_seconds: 150,
            position_cutoff_timestamp: 30,
            resolution_deadline: 40,
            oracle_set_epoch: 1,
            event_epoch: 0,
            active_back_total: 60,
            active_doubt_total: 40,
            pending_back_total: 0,
            pending_doubt_total: 0,
            final_matched_back_total: 0,
            final_matched_doubt_total: 0,
            final_forfeited_total: 0,
            settlement_processed_position_count: 0,
            settlement_outcome: SettlementOutcome::Unresolved,
            settlement_evidence_hash: [0; 32],
            position_count: 2,
            claimed_position_count: 0,
            vault: Pubkey::new_unique(),
            vault_bump: 1,
        }
    }

    fn position(side: PositionSide, active: u64, pending: u64, refundable: u64) -> UserPosition {
        UserPosition {
            version: 1,
            bump: 1,
            market: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            side,
            active_amount: active,
            pending_amount: pending,
            refundable_amount: refundable,
            settlement_base_entitlement: 0,
            settlement_processed: false,
            next_lot_nonce: 1,
            claimed: false,
            total_paid_amount: active + pending + refundable,
            created_slot: 1,
            updated_slot: 1,
        }
    }

    #[test]
    fn canonical_terminal_phases_are_accepted() {
        for phase in ["F", "FET", "FPE"] {
            assert!(validate_terminal_phase(phase).is_ok(), "rejected {phase}");
        }
    }

    #[test]
    fn noncanonical_terminal_phases_are_rejected() {
        for phase in ["", "FT", "FINAL", "f", "FET ", " FPE"] {
            assert!(
                validate_terminal_phase(phase).is_err(),
                "accepted {phase:?}"
            );
        }
    }

    #[test]
    fn settlement_is_two_phase_and_accumulates_only_loser_forfeits() {
        let mut market = market(MarketState::Open);
        begin_settlement(&mut market, SettlementOutcome::ClaimWon, [9; 32]).unwrap();
        assert_eq!(market.state, MarketState::Settling);
        assert_eq!(market.final_matched_back_total, 40);
        assert_eq!(market.final_matched_doubt_total, 40);

        let mut winner = position(PositionSide::Back, 60, 5, 1);
        calculate_entitlement(&mut market, &mut winner, 2).unwrap();
        assert_eq!(winner.settlement_base_entitlement, 66);
        assert_eq!(market.final_forfeited_total, 0);
        assert_eq!(market.state, MarketState::Settling);

        let mut loser = position(PositionSide::Doubt, 40, 2, 3);
        let result = calculate_entitlement(&mut market, &mut loser, 3).unwrap();
        assert_eq!(loser.settlement_base_entitlement, 5);
        assert_eq!(market.final_forfeited_total, 40);
        assert!(result.finalized);
        assert_eq!(market.state, MarketState::Settled);
    }

    #[test]
    fn duplicate_and_contradictory_settlement_fail_explicitly() {
        let mut market = market(MarketState::Open);
        begin_settlement(&mut market, SettlementOutcome::ClaimWon, [9; 32]).unwrap();
        assert!(begin_settlement(&mut market, SettlementOutcome::ClaimWon, [9; 32]).is_err());
        assert!(begin_settlement(&mut market, SettlementOutcome::ClaimLost, [9; 32]).is_err());
        assert!(begin_settlement(&mut market, SettlementOutcome::Void, [9; 32]).is_err());
    }

    #[test]
    fn zero_position_settlement_is_immediately_terminal() {
        let mut market = market(MarketState::Frozen);
        market.position_count = 0;
        market.active_back_total = 0;
        market.active_doubt_total = 0;
        begin_settlement(&mut market, SettlementOutcome::ClaimLost, [7; 32]).unwrap();
        assert_eq!(market.state, MarketState::Settled);
        assert_eq!(market.settlement_processed_position_count, 0);
    }

    #[test]
    fn void_is_terminal_from_open_or_frozen_and_preserves_close_count() {
        for state in [MarketState::Open, MarketState::Frozen] {
            let mut market = market(state);
            transition_to_void(&mut market, [8; 32]).unwrap();
            assert_eq!(market.state, MarketState::Voided);
            assert_eq!(market.settlement_outcome, SettlementOutcome::Void);
            assert_eq!(market.settlement_processed_position_count, 2);
            assert!(transition_to_void(&mut market, [8; 32]).is_err());
        }
    }

    #[test]
    fn entitlement_rejects_replay_and_inconsistent_principal() {
        let mut first_market = market(MarketState::Open);
        begin_settlement(&mut first_market, SettlementOutcome::ClaimWon, [1; 32]).unwrap();
        let mut first_position = position(PositionSide::Back, 60, 0, 0);
        calculate_entitlement(&mut first_market, &mut first_position, 2).unwrap();
        assert!(calculate_entitlement(&mut first_market, &mut first_position, 3).is_err());

        let mut second_market = market(MarketState::Open);
        begin_settlement(&mut second_market, SettlementOutcome::ClaimWon, [1; 32]).unwrap();
        let mut broken = position(PositionSide::Doubt, 40, 0, 0);
        broken.total_paid_amount = 39;
        assert!(calculate_entitlement(&mut second_market, &mut broken, 2).is_err());
    }

    #[test]
    fn timeout_is_permissionless_at_the_exact_deadline_boundary() {
        assert!(validate_timeout_deadline(39, 40).is_err());
        assert!(validate_timeout_deadline(40, 40).is_ok());
        assert!(validate_timeout_deadline(41, 40).is_ok());
    }

    #[test]
    fn settlement_event_selection_is_exactly_one_per_instruction() {
        let mut empty = market(MarketState::Settled);
        empty.position_count = 0;
        assert_eq!(
            initial_settlement_event(&empty),
            InitialSettlementEvent::Settled
        );
        let nonempty = market(MarketState::Settling);
        assert_eq!(
            initial_settlement_event(&nonempty),
            InitialSettlementEvent::Started
        );
        assert_eq!(
            entitlement_event(EntitlementCalculation {
                forfeited: 0,
                finalized: false,
            }),
            EntitlementEvent::Calculated
        );
        assert_eq!(
            entitlement_event(EntitlementCalculation {
                forfeited: 1,
                finalized: true,
            }),
            EntitlementEvent::Settled
        );
    }

    #[test]
    fn settlement_and_void_recovery_helpers_have_no_pause_dependency() {
        let mut settling = market(MarketState::Open);
        begin_settlement(&mut settling, SettlementOutcome::ClaimWon, [1; 32]).unwrap();
        let mut voided = market(MarketState::Frozen);
        transition_to_void(&mut voided, [2; 32]).unwrap();
        assert_eq!(settling.state, MarketState::Settling);
        assert_eq!(voided.state, MarketState::Voided);
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(1_000))]

        #[test]
        fn staged_on_chain_entitlements_match_reference_math(
            raw in prop::collection::vec((any::<bool>(), 1u64..1_000_000, 0u8..5), 1..12),
            claim_won in any::<bool>(),
            ratio in 1u32..10_000,
        ) {
            let inputs: Vec<_> = raw
                .iter()
                .enumerate()
                .map(|(index, (back, amount, bucket))| {
                    let side = if *back { PositionSide::Back } else { PositionSide::Doubt };
                    match bucket {
                        0..=2 => SettlementInput::active(index as u64, side, *amount),
                        3 => SettlementInput::pending(index as u64, side, *amount),
                        _ => SettlementInput::refundable(index as u64, side, *amount),
                    }
                })
                .collect();
            let outcome = if claim_won {
                SettlementOutcome::ClaimWon
            } else {
                SettlementOutcome::ClaimLost
            };
            let reference = settle_positions(&inputs, outcome, ratio).unwrap();
            let mut staged_market = market(MarketState::Open);
            staged_market.ratio_milli = ratio;
            staged_market.active_back_total = inputs
                .iter()
                .filter(|position| position.side == PositionSide::Back)
                .map(|position| position.active_amount)
                .sum();
            staged_market.active_doubt_total = inputs
                .iter()
                .filter(|position| position.side == PositionSide::Doubt)
                .map(|position| position.active_amount)
                .sum();
            staged_market.position_count = inputs.len() as u64;
            begin_settlement(&mut staged_market, outcome, [7; 32]).unwrap();

            let mut positions: Vec<_> = inputs
                .iter()
                .map(|input| position(
                    input.side,
                    input.active_amount,
                    input.pending_amount,
                    input.refundable_amount,
                ))
                .collect();
            for aggregate in &mut positions {
                calculate_entitlement(&mut staged_market, aggregate, 2).unwrap();
            }
            prop_assert_eq!(staged_market.state, MarketState::Settled);
            prop_assert_eq!(staged_market.final_forfeited_total, reference.forfeited_pot);
            for (aggregate, credit) in positions.iter().zip(&reference.credits) {
                let actual = settled_claim_amount(&staged_market, aggregate).unwrap();
                prop_assert_eq!(actual, credit.refund + credit.payout);
            }
        }
    }
}
