use anchor_lang::{prelude::*, solana_program::program_pack::Pack, system_program};
use anchor_spl::token::{self, Token};

use crate::{
    constants::{
        CONFIG_SEED, LOT_SEED, MARKET_SEED, POSITION_SEED, SCHEMA_VERSION_V1, USDC_DECIMALS,
    },
    encoding::PositionInvalidationAttestationV1,
    errors::EscrowError,
    events::{PositionActivated, PositionInvalidated, PositionPlaced},
    state::{
        Asset, LotState, Market, MarketState, OracleSet, PositionLot, PositionSide, ProtocolConfig,
        UserPosition, POSITION_LOT_ACCOUNT_SPACE, USER_POSITION_ACCOUNT_SPACE,
    },
};

use super::{
    attestations::{validate_pinned_oracle_set, verify_threshold_signatures},
    market::{
        market_attestation_common, sol_vault_address, usdc_vault_address, validate_usdc_mint,
    },
    ActivatePositionLotArgs, InvalidatePositionLotArgs, PlacePositionArgs,
};

#[derive(Accounts)]
#[instruction(args: PlacePositionArgs)]
pub struct PlacePosition<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        mut,
        seeds = [MARKET_SEED, &args.market_uuid],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(
        init_if_needed,
        payer = payer,
        space = USER_POSITION_ACCOUNT_SPACE,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump
    )]
    pub position: Account<'info, UserPosition>,
    #[account(
        init,
        payer = payer,
        space = POSITION_LOT_ACCOUNT_SPACE,
        seeds = [
            LOT_SEED,
            market.key().as_ref(),
            owner.key().as_ref(),
            &args.expected_lot_nonce.to_le_bytes()
        ],
        bump
    )]
    pub lot: Account<'info, PositionLot>,
    /// CHECK: Validated against the market's immutable vault and parsed for
    /// classic SPL markets.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Parsed as a classic SPL source account for USDC markets.
    #[account(mut)]
    pub asset_source: UncheckedAccount<'info>,
    /// CHECK: Parsed as the canonical classic SPL mint for USDC markets.
    pub token_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn place_position(ctx: Context<PlacePosition>, args: PlacePositionArgs) -> Result<()> {
    let clock = Clock::get()?;
    validate_place(&ctx, &args, &clock)?;
    let is_new_position = ctx.accounts.position.version == 0;
    initialize_or_validate_position(
        &mut ctx.accounts.position,
        ctx.accounts.market.key(),
        ctx.accounts.owner.key(),
        ctx.bumps.position,
        &args,
        clock.slot,
    )?;

    transfer_principal(&ctx, &args)?;

    let (pending, activation_after) = classify_placement(
        clock.unix_timestamp,
        ctx.accounts.market.in_play_start_timestamp,
        ctx.accounts.market.activation_delay_seconds,
    )?;
    apply_position_deposit(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        args.side,
        args.amount,
        pending,
        is_new_position,
        clock.slot,
    )?;

    let lot = &mut ctx.accounts.lot;
    lot.version = SCHEMA_VERSION_V1;
    lot.bump = ctx.bumps.lot;
    lot.market = ctx.accounts.market.key();
    lot.owner = ctx.accounts.owner.key();
    lot.nonce = args.expected_lot_nonce;
    lot.side = args.side;
    lot.amount = args.amount;
    lot.placed_timestamp = clock.unix_timestamp;
    lot.placed_slot = clock.slot;
    lot.observed_event_epoch = ctx.accounts.market.event_epoch;
    lot.state = if pending {
        LotState::Pending
    } else {
        LotState::Active
    };
    lot.activation_timestamp = activation_after;
    lot.invalidation_evidence_hash = None;

    emit!(PositionPlaced {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        lot: lot.key(),
        owner: ctx.accounts.owner.key(),
        nonce: lot.nonce,
        side: lot.side,
        amount: lot.amount,
        asset: ctx.accounts.market.asset,
        pending,
        event_epoch: lot.observed_event_epoch,
        activation_after,
        client_intent_hash: args.client_intent_hash,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: ActivatePositionLotArgs)]
pub struct ActivatePositionLot<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch
    )]
    pub position: Account<'info, UserPosition>,
    #[account(
        mut,
        seeds = [
            LOT_SEED,
            market.key().as_ref(),
            position.owner.as_ref(),
            &args.nonce.to_le_bytes()
        ],
        bump = lot.bump,
        constraint = lot.market == market.key() @ EscrowError::ConfigMismatch,
        constraint = lot.owner == position.owner @ EscrowError::InvalidUserSigner,
        constraint = lot.nonce == args.nonce @ EscrowError::LotNonceMismatch
    )]
    pub lot: Account<'info, PositionLot>,
}

pub fn activate_position_lot(
    ctx: Context<ActivatePositionLot>,
    args: ActivatePositionLotArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        matches!(
            ctx.accounts.market.state,
            MarketState::Open | MarketState::Frozen
        ),
        EscrowError::InvalidMarketState
    );
    require!(
        ctx.accounts.lot.state == LotState::Pending,
        EscrowError::LotNotPending
    );
    require!(
        ctx.accounts.lot.observed_event_epoch == args.expected_event_epoch
            && ctx.accounts.market.event_epoch == args.expected_event_epoch,
        EscrowError::EventEpochMismatch
    );
    let activation_after = ctx
        .accounts
        .lot
        .activation_timestamp
        .ok_or(EscrowError::InvalidLotState)?;
    require!(
        clock.unix_timestamp >= activation_after,
        EscrowError::ActivationDelayNotElapsed
    );

    move_pending_to_active(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        ctx.accounts.lot.side,
        ctx.accounts.lot.amount,
        clock.slot,
    )?;
    ctx.accounts.lot.state = LotState::Active;

    emit!(PositionActivated {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        lot: ctx.accounts.lot.key(),
        owner: ctx.accounts.position.owner,
        nonce: ctx.accounts.lot.nonce,
        amount: ctx.accounts.lot.amount,
        event_epoch: ctx.accounts.market.event_epoch,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: InvalidatePositionLotArgs)]
pub struct InvalidatePositionLot<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, ProtocolConfig>>,
    #[account(
        seeds = [crate::constants::ORACLE_SET_SEED, &market.oracle_set_epoch.to_le_bytes()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Box<Account<'info, OracleSet>>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Box<Account<'info, Market>>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch
    )]
    pub position: Box<Account<'info, UserPosition>>,
    #[account(
        mut,
        seeds = [
            LOT_SEED,
            market.key().as_ref(),
            position.owner.as_ref(),
            &args.nonce.to_le_bytes()
        ],
        bump = lot.bump,
        constraint = lot.market == market.key() @ EscrowError::ConfigMismatch,
        constraint = lot.owner == position.owner @ EscrowError::InvalidUserSigner,
        constraint = lot.nonce == args.nonce @ EscrowError::LotNonceMismatch
    )]
    pub lot: Box<Account<'info, PositionLot>>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn invalidate_position_lot(
    ctx: Context<InvalidatePositionLot>,
    args: InvalidatePositionLotArgs,
) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        matches!(
            ctx.accounts.market.state,
            MarketState::Open | MarketState::Frozen
        ),
        EscrowError::InvalidMarketState
    );
    require!(
        matches!(ctx.accounts.lot.state, LotState::Pending | LotState::Active),
        EscrowError::InvalidLotState
    );
    validate_invalidation_candidate(
        &ctx.accounts.lot,
        ctx.accounts.market.event_epoch,
        args.invalidated_event_epoch,
    )?;
    validate_pinned_oracle_set(
        &ctx.accounts.oracle_set,
        ctx.accounts.market.oracle_set_epoch,
    )?;
    let attestation = PositionInvalidationAttestationV1 {
        common: market_attestation_common(
            &ctx.accounts.config,
            &ctx.accounts.market,
            ctx.accounts.market.key(),
            args.issued_at,
            args.expires_at,
            args.evidence_hash,
        ),
        position_lot_pda: ctx.accounts.lot.key().to_bytes(),
        lot_nonce: args.nonce,
        observed_event_epoch: ctx.accounts.lot.observed_event_epoch,
        invalidated_event_epoch: args.invalidated_event_epoch,
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

    make_lot_refundable(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        ctx.accounts.lot.side,
        ctx.accounts.lot.amount,
        ctx.accounts.lot.state,
        clock.slot,
    )?;
    ctx.accounts.lot.state = LotState::Voided;
    ctx.accounts.lot.invalidation_evidence_hash = Some(args.evidence_hash);

    emit!(PositionInvalidated {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        lot: ctx.accounts.lot.key(),
        owner: ctx.accounts.position.owner,
        nonce: ctx.accounts.lot.nonce,
        amount: ctx.accounts.lot.amount,
        event_epoch: args.invalidated_event_epoch,
        evidence_hash: args.evidence_hash,
    });
    Ok(())
}

fn validate_place(
    ctx: &Context<PlacePosition>,
    args: &PlacePositionArgs,
    clock: &Clock,
) -> Result<()> {
    validate_position_window(
        ctx.accounts.config.paused,
        ctx.accounts.market.state,
        clock.unix_timestamp,
        ctx.accounts.market.position_cutoff_timestamp,
        ctx.accounts.market.event_epoch,
        args.expected_event_epoch,
    )?;
    validate_client_expiry(
        clock.unix_timestamp,
        args.client_expiry_timestamp,
        ctx.accounts.market.position_cutoff_timestamp,
    )?;
    require!(
        args.expected_asset == ctx.accounts.market.asset,
        EscrowError::AssetMismatch
    );
    require!(
        args.expected_ratio_milli == ctx.accounts.market.ratio_milli,
        EscrowError::RatioMismatch
    );
    require!(
        args.expected_market_document_hash == ctx.accounts.market.market_document_hash,
        EscrowError::MarketDocumentHashMismatch
    );
    require_keys_eq!(
        ctx.accounts.vault.key(),
        ctx.accounts.market.vault,
        EscrowError::InvalidVault
    );
    require_keys_eq!(
        ctx.accounts.token_program.key(),
        ctx.accounts.config.allowed_token_program,
        EscrowError::InvalidTokenProgram
    );
    require!(
        *ctx.accounts.owner.owner == system_program::ID
            && ctx.accounts.owner.to_account_info().data_is_empty(),
        EscrowError::InvalidUserSigner
    );
    validate_wallet_key(ctx.accounts.owner.key())?;
    validate_position_amount(
        &ctx.accounts.config,
        ctx.accounts.market.asset,
        ctx.accounts.position.total_paid_amount,
        args.amount,
    )?;
    Ok(())
}

fn initialize_or_validate_position(
    position: &mut Account<UserPosition>,
    market_key: Pubkey,
    user_key: Pubkey,
    position_bump: u8,
    args: &PlacePositionArgs,
    slot: u64,
) -> Result<()> {
    if position.version == 0 {
        require!(args.expected_lot_nonce == 0, EscrowError::LotNonceMismatch);
        position.version = SCHEMA_VERSION_V1;
        position.bump = position_bump;
        position.market = market_key;
        position.owner = user_key;
        position.side = args.side;
        position.active_amount = 0;
        position.pending_amount = 0;
        position.refundable_amount = 0;
        position.settlement_base_entitlement = 0;
        position.settlement_processed = false;
        position.next_lot_nonce = 0;
        position.claimed = false;
        position.total_paid_amount = 0;
        position.created_slot = slot;
        position.updated_slot = slot;
    } else {
        validate_existing_position(position, market_key, user_key, args.side)?;
    }
    validate_lot_nonce(position, args.expected_lot_nonce)?;
    Ok(())
}

fn transfer_principal(ctx: &Context<PlacePosition>, args: &PlacePositionArgs) -> Result<()> {
    match ctx.accounts.market.asset {
        Asset::Sol => transfer_sol_principal(ctx, args.amount),
        Asset::Usdc => transfer_usdc_principal(ctx, args.amount),
    }
}

fn transfer_sol_principal(ctx: &Context<PlacePosition>, amount: u64) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.market.token_mint,
        Pubkey::default(),
        EscrowError::InvalidMint
    );
    let (expected_vault, bump) = sol_vault_address(ctx.accounts.market.key());
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault,
        EscrowError::InvalidVault
    );
    require!(
        bump == ctx.accounts.market.vault_bump,
        EscrowError::InvalidVault
    );
    require_keys_eq!(
        *ctx.accounts.vault.owner,
        crate::ID,
        EscrowError::InvalidVaultOwner
    );
    let rent_reserve = Rent::get()?.minimum_balance(0);
    require!(
        ctx.accounts.vault.lamports() >= rent_reserve,
        EscrowError::InvalidVaultRentReserve
    );
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        ),
        amount,
    )
}

fn transfer_usdc_principal(ctx: &Context<PlacePosition>, amount: u64) -> Result<()> {
    require_keys_eq!(
        ctx.accounts.market.token_mint,
        ctx.accounts.config.canonical_usdc_mint,
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.token_mint.key(),
        ctx.accounts.market.token_mint,
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        *ctx.accounts.token_mint.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let mint = spl_token::state::Mint::unpack(&ctx.accounts.token_mint.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidMint))?;
    validate_usdc_mint(&mint)?;
    let expected_vault =
        usdc_vault_address(ctx.accounts.market.key(), ctx.accounts.market.token_mint);
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault,
        EscrowError::InvalidVault
    );
    require_keys_eq!(
        *ctx.accounts.vault.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    require_keys_eq!(
        *ctx.accounts.asset_source.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let vault = spl_token::state::Account::unpack(&ctx.accounts.vault.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    let source = spl_token::state::Account::unpack(&ctx.accounts.asset_source.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    validate_usdc_transfer_accounts(
        &vault,
        &source,
        ctx.accounts.market.key(),
        ctx.accounts.owner.key(),
        ctx.accounts.market.token_mint,
    )?;

    token::transfer_checked(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            token::TransferChecked {
                from: ctx.accounts.asset_source.to_account_info(),
                mint: ctx.accounts.token_mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            },
        ),
        amount,
        USDC_DECIMALS,
    )
}

fn validate_usdc_transfer_accounts(
    vault: &spl_token::state::Account,
    source: &spl_token::state::Account,
    market: Pubkey,
    owner: Pubkey,
    mint: Pubkey,
) -> Result<()> {
    require!(
        vault.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );
    require_keys_eq!(vault.owner, market, EscrowError::InvalidTokenAccount);
    require_keys_eq!(vault.mint, mint, EscrowError::InvalidMint);
    require!(
        source.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );
    require_keys_eq!(source.owner, owner, EscrowError::InvalidUserSigner);
    require_keys_eq!(source.mint, mint, EscrowError::InvalidMint);
    Ok(())
}

fn apply_position_deposit(
    market: &mut Market,
    position: &mut UserPosition,
    side: PositionSide,
    amount: u64,
    pending: bool,
    is_new_position: bool,
    slot: u64,
) -> Result<()> {
    if pending {
        position.pending_amount = checked_add(position.pending_amount, amount)?;
        let total = pending_total_mut(market, side);
        *total = checked_add(*total, amount)?;
    } else {
        position.active_amount = checked_add(position.active_amount, amount)?;
        let total = active_total_mut(market, side);
        *total = checked_add(*total, amount)?;
    }
    position.total_paid_amount = checked_add(position.total_paid_amount, amount)?;
    position.next_lot_nonce = checked_add(position.next_lot_nonce, 1)?;
    position.updated_slot = slot;
    if is_new_position {
        market.position_count = checked_add(market.position_count, 1)?;
    }
    Ok(())
}

fn move_pending_to_active(
    market: &mut Market,
    position: &mut UserPosition,
    side: PositionSide,
    amount: u64,
    slot: u64,
) -> Result<()> {
    position.pending_amount = checked_sub(position.pending_amount, amount)?;
    position.active_amount = checked_add(position.active_amount, amount)?;
    let pending = pending_total_mut(market, side);
    *pending = checked_sub(*pending, amount)?;
    let active = active_total_mut(market, side);
    *active = checked_add(*active, amount)?;
    position.updated_slot = slot;
    Ok(())
}

fn make_lot_refundable(
    market: &mut Market,
    position: &mut UserPosition,
    side: PositionSide,
    amount: u64,
    state: LotState,
    slot: u64,
) -> Result<()> {
    match state {
        LotState::Pending => {
            position.pending_amount = checked_sub(position.pending_amount, amount)?;
            let pending = pending_total_mut(market, side);
            *pending = checked_sub(*pending, amount)?;
        }
        LotState::Active => {
            position.active_amount = checked_sub(position.active_amount, amount)?;
            let active = active_total_mut(market, side);
            *active = checked_sub(*active, amount)?;
        }
        LotState::Voided => return err!(EscrowError::InvalidLotState),
    }
    position.refundable_amount = checked_add(position.refundable_amount, amount)?;
    position.updated_slot = slot;
    Ok(())
}

fn validate_invalidation_candidate(
    lot: &PositionLot,
    current_event_epoch: u64,
    invalidated_event_epoch: u64,
) -> Result<()> {
    require!(
        lot.activation_timestamp.is_some(),
        EscrowError::InvalidLotState
    );
    require!(
        invalidated_event_epoch > lot.observed_event_epoch
            && current_event_epoch >= invalidated_event_epoch,
        EscrowError::EventEpochMismatch
    );
    Ok(())
}

fn validate_client_expiry(now: i64, client_expiry: i64, cutoff: i64) -> Result<()> {
    require!(now <= client_expiry, EscrowError::ClientIntentExpired);
    require!(client_expiry <= cutoff, EscrowError::ClientIntentExpired);
    Ok(())
}

fn validate_position_window(
    paused: bool,
    state: MarketState,
    now: i64,
    cutoff: i64,
    current_event_epoch: u64,
    expected_event_epoch: u64,
) -> Result<()> {
    require!(!paused, EscrowError::ProtocolPaused);
    if state == MarketState::Frozen {
        return err!(EscrowError::MarketFrozen);
    }
    require!(state == MarketState::Open, EscrowError::InvalidMarketState);
    require!(now < cutoff, EscrowError::PositionCutoffPassed);
    require!(
        current_event_epoch == expected_event_epoch,
        EscrowError::EventEpochMismatch
    );
    Ok(())
}

fn validate_position_amount(
    config: &ProtocolConfig,
    asset: Asset,
    total_paid_amount: u64,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, EscrowError::InvalidPositionAmount);
    let (minimum, maximum) = match asset {
        Asset::Sol => (config.min_sol_position, config.max_sol_position),
        Asset::Usdc => (config.min_usdc_position, config.max_usdc_position),
    };
    require!(amount >= minimum, EscrowError::InvalidPositionAmount);
    let cumulative = total_paid_amount
        .checked_add(amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    require!(cumulative <= maximum, EscrowError::InvalidPositionAmount);
    Ok(())
}

fn validate_existing_position(
    position: &UserPosition,
    market_key: Pubkey,
    user_key: Pubkey,
    side: PositionSide,
) -> Result<()> {
    require_keys_eq!(position.market, market_key, EscrowError::ConfigMismatch);
    require_keys_eq!(position.owner, user_key, EscrowError::InvalidUserSigner);
    require!(position.side == side, EscrowError::OppositeSidePosition);
    require!(!position.claimed, EscrowError::AlreadyClaimed);
    require!(
        !position.settlement_processed,
        EscrowError::InvalidMarketState
    );
    Ok(())
}

fn validate_lot_nonce(position: &UserPosition, expected_lot_nonce: u64) -> Result<()> {
    require!(
        position.next_lot_nonce == expected_lot_nonce,
        EscrowError::LotNonceMismatch
    );
    Ok(())
}

fn validate_wallet_key(owner: Pubkey) -> Result<()> {
    require!(owner.is_on_curve(), EscrowError::InvalidUserSigner);
    Ok(())
}

fn classify_placement(
    now: i64,
    in_play_start_timestamp: i64,
    activation_delay_seconds: u64,
) -> Result<(bool, Option<i64>)> {
    if now < in_play_start_timestamp {
        return Ok((false, None));
    }
    let delay =
        i64::try_from(activation_delay_seconds).map_err(|_| EscrowError::ArithmeticOverflow)?;
    let activation_after = now
        .checked_add(delay)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    Ok((true, Some(activation_after)))
}

fn active_total_mut(market: &mut Market, side: PositionSide) -> &mut u64 {
    match side {
        PositionSide::Back => &mut market.active_back_total,
        PositionSide::Doubt => &mut market.active_doubt_total,
    }
}

fn pending_total_mut(market: &mut Market, side: PositionSide) -> &mut u64 {
    match side {
        PositionSide::Back => &mut market.pending_back_total,
        PositionSide::Doubt => &mut market.pending_doubt_total,
    }
}

fn checked_add(left: u64, right: u64) -> Result<u64> {
    left.checked_add(right)
        .ok_or_else(|| error!(EscrowError::ArithmeticOverflow))
}

fn checked_sub(left: u64, right: u64) -> Result<u64> {
    left.checked_sub(right)
        .ok_or_else(|| error!(EscrowError::AccountingInvariant))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_option::COption;

    fn market() -> Market {
        Market {
            version: 1,
            bump: 0,
            market_uuid: [0; 16],
            fixture_id: 1,
            claim_spec_hash: [0; 32],
            display_terms_hash: [0; 32],
            odds_source_message_hash: [0; 32],
            market_document_hash: [0; 32],
            quote_timestamp: 0,
            probability_ppm: 500_000,
            ratio_milli: 1_000,
            asset: Asset::Sol,
            token_mint: Pubkey::default(),
            fee_bps: 0,
            state: MarketState::Open,
            replay: false,
            residual_recipient: Pubkey::new_unique(),
            created_timestamp: 0,
            in_play_start_timestamp: 100,
            activation_delay_seconds: 150,
            position_cutoff_timestamp: 200,
            resolution_deadline: 300,
            oracle_set_epoch: 1,
            event_epoch: 0,
            active_back_total: 0,
            active_doubt_total: 0,
            pending_back_total: 0,
            pending_doubt_total: 0,
            final_matched_back_total: 0,
            final_matched_doubt_total: 0,
            final_forfeited_total: 0,
            settlement_processed_position_count: 0,
            settlement_outcome: crate::state::SettlementOutcome::Unresolved,
            settlement_evidence_hash: [0; 32],
            position_count: 0,
            claimed_position_count: 0,
            vault: Pubkey::new_unique(),
            vault_bump: 1,
        }
    }

    fn config() -> ProtocolConfig {
        ProtocolConfig {
            version: 1,
            bump: 1,
            paused: false,
            config_authority: Pubkey::new_unique(),
            pause_authority: Pubkey::new_unique(),
            market_creation_authority: Pubkey::new_unique(),
            feed_operator_authority: Pubkey::new_unique(),
            oracle_set: Pubkey::new_unique(),
            relayer_fee_payer: Pubkey::new_unique(),
            residual_recipient: Pubkey::new_unique(),
            cluster_genesis_hash: [1; 32],
            canonical_usdc_mint: Pubkey::new_unique(),
            allowed_token_program: spl_token::ID,
            max_sol_position: 100,
            max_usdc_position: 1_000,
            min_sol_position: 10,
            min_usdc_position: 100,
            max_market_duration_seconds: 1_000,
            max_resolution_delay_seconds: 1_000,
        }
    }

    fn position(side: PositionSide) -> UserPosition {
        UserPosition {
            version: 1,
            bump: 0,
            market: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            side,
            active_amount: 0,
            pending_amount: 0,
            refundable_amount: 0,
            settlement_base_entitlement: 0,
            settlement_processed: false,
            next_lot_nonce: 0,
            claimed: false,
            total_paid_amount: 0,
            created_slot: 1,
            updated_slot: 1,
        }
    }

    fn lot(state: LotState, activation_timestamp: Option<i64>) -> PositionLot {
        PositionLot {
            version: 1,
            bump: 0,
            market: Pubkey::new_unique(),
            owner: Pubkey::new_unique(),
            nonce: 0,
            side: PositionSide::Back,
            amount: 10,
            placed_timestamp: 100,
            placed_slot: 1,
            observed_event_epoch: 4,
            state,
            activation_timestamp,
            invalidation_evidence_hash: None,
        }
    }

    fn token_account(
        mint: Pubkey,
        owner: Pubkey,
        state: spl_token::state::AccountState,
    ) -> spl_token::state::Account {
        spl_token::state::Account {
            mint,
            owner,
            amount: 1_000_000,
            delegate: COption::None,
            state,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        }
    }

    #[test]
    fn aggregate_deposit_counts_each_wallet_once_and_nonces_every_lot() {
        let mut market = market();
        let mut position = position(PositionSide::Back);
        apply_position_deposit(
            &mut market,
            &mut position,
            PositionSide::Back,
            10,
            false,
            true,
            2,
        )
        .unwrap();
        apply_position_deposit(
            &mut market,
            &mut position,
            PositionSide::Back,
            5,
            true,
            false,
            3,
        )
        .unwrap();
        assert_eq!(market.position_count, 1);
        assert_eq!(market.active_back_total, 10);
        assert_eq!(market.pending_back_total, 5);
        assert_eq!(position.next_lot_nonce, 2);
        assert_eq!(position.total_paid_amount, 15);
    }

    #[test]
    fn pending_activation_and_invalidation_conserve_aggregate_principal() {
        let mut market = market();
        let mut position = position(PositionSide::Doubt);
        apply_position_deposit(
            &mut market,
            &mut position,
            PositionSide::Doubt,
            25,
            true,
            true,
            2,
        )
        .unwrap();
        move_pending_to_active(&mut market, &mut position, PositionSide::Doubt, 25, 3).unwrap();
        make_lot_refundable(
            &mut market,
            &mut position,
            PositionSide::Doubt,
            25,
            LotState::Active,
            4,
        )
        .unwrap();
        assert_eq!(market.active_doubt_total, 0);
        assert_eq!(market.pending_doubt_total, 0);
        assert_eq!(position.refundable_amount, 25);
        assert_eq!(position.total_paid_amount, 25);
    }

    #[test]
    fn invalidation_rejects_pre_kickoff_active_lots() {
        let prematch = lot(LotState::Active, None);
        assert!(validate_invalidation_candidate(&prematch, 5, 5).is_err());

        let activated_in_play = lot(LotState::Active, Some(250));
        assert!(validate_invalidation_candidate(&activated_in_play, 5, 5).is_ok());
    }

    #[test]
    fn client_intent_expiry_cannot_outlive_market_cutoff() {
        assert!(validate_client_expiry(100, 200, 200).is_ok());
        assert!(validate_client_expiry(100, 201, 200).is_err());
        assert!(validate_client_expiry(101, 100, 200).is_err());
    }

    #[test]
    fn placement_boundary_is_active_before_kickoff_and_pending_at_kickoff() {
        assert_eq!(classify_placement(99, 100, 150).unwrap(), (false, None));
        assert_eq!(
            classify_placement(100, 100, 150).unwrap(),
            (true, Some(250))
        );
        assert_eq!(
            classify_placement(110, 100, 150).unwrap(),
            (true, Some(260))
        );
    }

    #[test]
    fn intake_guards_pause_freeze_cutoff_and_event_epoch() {
        assert!(validate_position_window(false, MarketState::Open, 99, 100, 3, 3).is_ok());
        assert!(validate_position_window(true, MarketState::Open, 99, 100, 3, 3).is_err());
        assert!(validate_position_window(false, MarketState::Frozen, 99, 100, 3, 3).is_err());
        assert!(validate_position_window(false, MarketState::Open, 100, 100, 3, 3).is_err());
        assert!(validate_position_window(false, MarketState::Open, 99, 100, 4, 3).is_err());
    }

    #[test]
    fn asset_limits_use_cumulative_checked_math() {
        let config = config();
        assert!(validate_position_amount(&config, Asset::Sol, 0, 10).is_ok());
        assert!(validate_position_amount(&config, Asset::Sol, 91, 10).is_err());
        assert!(validate_position_amount(&config, Asset::Usdc, 0, 99).is_err());
        assert!(validate_position_amount(&config, Asset::Usdc, 900, 100).is_ok());
        assert!(validate_position_amount(&config, Asset::Usdc, u64::MAX, 100).is_err());
    }

    #[test]
    fn existing_position_rejects_opposite_side_and_replayed_nonce() {
        let mut position = position(PositionSide::Back);
        position.next_lot_nonce = 3;
        assert!(validate_existing_position(
            &position,
            position.market,
            position.owner,
            PositionSide::Back
        )
        .is_ok());
        assert!(validate_existing_position(
            &position,
            position.market,
            position.owner,
            PositionSide::Doubt
        )
        .is_err());
        assert!(validate_lot_nonce(&position, 2).is_err());
        assert!(validate_lot_nonce(&position, 3).is_ok());
    }

    #[test]
    fn repeated_refund_transition_has_no_second_effect() {
        let mut market = market();
        let mut position = position(PositionSide::Back);
        apply_position_deposit(
            &mut market,
            &mut position,
            PositionSide::Back,
            10,
            false,
            true,
            2,
        )
        .unwrap();
        make_lot_refundable(
            &mut market,
            &mut position,
            PositionSide::Back,
            10,
            LotState::Active,
            3,
        )
        .unwrap();
        assert!(make_lot_refundable(
            &mut market,
            &mut position,
            PositionSide::Back,
            10,
            LotState::Active,
            4,
        )
        .is_err());
        assert_eq!(position.refundable_amount, 10);
        assert_eq!(position.total_paid_amount, 10);
    }

    #[test]
    fn wallet_signer_must_be_on_curve_and_cannot_be_a_cpi_pda() {
        let wallet = core::iter::repeat_with(Pubkey::new_unique)
            .find(|key| key.is_on_curve())
            .unwrap();
        let (pda, _) = Pubkey::find_program_address(&[b"not-a-wallet"], &crate::ID);
        assert!(validate_wallet_key(wallet).is_ok());
        assert!(validate_wallet_key(pda).is_err());
    }

    #[test]
    fn usdc_transfer_accounts_bind_mint_market_vault_and_wallet_source() {
        let mint = Pubkey::new_unique();
        let market = Pubkey::new_unique();
        let owner = Pubkey::new_unique();
        let vault = token_account(mint, market, spl_token::state::AccountState::Initialized);
        let source = token_account(mint, owner, spl_token::state::AccountState::Initialized);
        assert!(validate_usdc_transfer_accounts(&vault, &source, market, owner, mint).is_ok());

        let wrong_source = token_account(
            mint,
            Pubkey::new_unique(),
            spl_token::state::AccountState::Initialized,
        );
        assert!(
            validate_usdc_transfer_accounts(&vault, &wrong_source, market, owner, mint).is_err()
        );

        let wrong_vault = token_account(
            mint,
            Pubkey::new_unique(),
            spl_token::state::AccountState::Initialized,
        );
        assert!(
            validate_usdc_transfer_accounts(&wrong_vault, &source, market, owner, mint).is_err()
        );

        let frozen_source = token_account(mint, owner, spl_token::state::AccountState::Frozen);
        assert!(
            validate_usdc_transfer_accounts(&vault, &frozen_source, market, owner, mint).is_err()
        );
    }
}
