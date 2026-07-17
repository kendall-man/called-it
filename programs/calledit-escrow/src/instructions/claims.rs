use anchor_lang::{
    prelude::*,
    solana_program::{program_pack::Pack, system_program},
};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::{self, Token},
};

use crate::{
    constants::{CONFIG_SEED, LOT_SEED, MARKET_SEED, POSITION_SEED, USDC_DECIMALS},
    errors::EscrowError,
    events::{MarketClosed, PositionClaimed, PositionClosed, PositionLotsClosed},
    math::{winner_winnings, MathError},
    state::{
        Asset, Market, MarketState, PositionLot, PositionSide, ProtocolConfig, SettlementOutcome,
        UserPosition,
    },
};

use super::{
    market::{sol_vault_address, usdc_vault_address, validate_usdc_mint},
    ClosePositionLotsArgs,
};

#[derive(Accounts)]
pub struct ClaimPosition<'info> {
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch,
        constraint = position.owner == owner.key() @ EscrowError::InvalidClaimDestination
    )]
    pub position: Account<'info, UserPosition>,
    #[account(mut)]
    pub owner: Signer<'info>,
    /// CHECK: Validated against the immutable market vault and asset type.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Parsed and validated for USDC; the system program placeholder is required for SOL.
    pub token_mint: UncheckedAccount<'info>,
    /// CHECK: Canonical owner ATA for USDC; aliases the recorded owner for SOL.
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_position(ctx: Context<ClaimPosition>) -> Result<()> {
    let market_info = ctx.accounts.market.to_account_info();
    let payer_info = ctx.accounts.owner.to_account_info();
    let owner_info = ctx.accounts.owner.to_account_info();
    process_claim(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        &market_info,
        &payer_info,
        &owner_info,
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.owner_token_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
    )
}

#[derive(Accounts)]
pub struct ClaimPositionFor<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), owner.key().as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch,
        constraint = position.owner == owner.key() @ EscrowError::InvalidClaimDestination
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: Address-bound to `position.owner`; receives SOL or owns the canonical USDC ATA.
    #[account(mut)]
    pub owner: UncheckedAccount<'info>,
    /// CHECK: Validated against the immutable market vault and asset type.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Parsed and validated for USDC; the system program placeholder is required for SOL.
    pub token_mint: UncheckedAccount<'info>,
    /// CHECK: Canonical owner ATA for USDC; aliases the recorded owner for SOL.
    #[account(mut)]
    pub owner_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn claim_position_for(ctx: Context<ClaimPositionFor>) -> Result<()> {
    let market_info = ctx.accounts.market.to_account_info();
    process_claim(
        &mut ctx.accounts.market,
        &mut ctx.accounts.position,
        &market_info,
        &ctx.accounts.payer.to_account_info(),
        &ctx.accounts.owner.to_account_info(),
        &ctx.accounts.vault.to_account_info(),
        &ctx.accounts.token_mint.to_account_info(),
        &ctx.accounts.owner_token_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.associated_token_program.to_account_info(),
        &ctx.accounts.system_program.to_account_info(),
    )
}

#[allow(clippy::too_many_arguments)]
fn process_claim<'info>(
    market: &mut Account<'info, Market>,
    position: &mut Account<'info, UserPosition>,
    market_info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_mint: &AccountInfo<'info>,
    owner_token_account: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
) -> Result<()> {
    let market_key = market.key();
    require_keys_eq!(
        owner.key(),
        position.owner,
        EscrowError::InvalidClaimDestination
    );
    require_keys_eq!(vault.key(), market.vault, EscrowError::InvalidVault);
    require_keys_eq!(
        token_program.key(),
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );

    let amount = prepare_claim(market, position)?;
    let destination = claim_destination(market.asset, owner.key(), owner_token_account.key());
    match market.asset {
        Asset::Sol => transfer_sol_claim(
            market,
            market_key,
            owner,
            vault,
            token_mint,
            owner_token_account,
            amount,
        )?,
        Asset::Usdc => transfer_usdc_claim(
            market,
            market_key,
            market_info,
            payer,
            owner,
            vault,
            token_mint,
            owner_token_account,
            token_program,
            associated_token_program,
            system_program_info,
            amount,
        )?,
    }

    emit!(PositionClaimed {
        market: market.key(),
        position: position.key(),
        owner: position.owner,
        amount,
        asset: market.asset,
        destination,
    });
    Ok(())
}

fn prepare_claim(market: &mut Market, position: &mut UserPosition) -> Result<u64> {
    require!(!position.claimed, EscrowError::AlreadyClaimed);
    validate_position_principal(position)?;
    let amount = match market.state {
        MarketState::Settled => {
            require!(
                position.settlement_processed,
                EscrowError::EntitlementNotCalculated
            );
            settled_claim_amount(market, position)?
        }
        MarketState::Voided => position.total_paid_amount,
        MarketState::Settling => return err!(EscrowError::SettlementInProgress),
        MarketState::Opening | MarketState::Open | MarketState::Frozen | MarketState::Closed => {
            return err!(EscrowError::PositionNotClaimable)
        }
    };
    require!(
        market.claimed_position_count < market.position_count,
        EscrowError::AccountingInvariant
    );
    position.claimed = true;
    market.claimed_position_count = market
        .claimed_position_count
        .checked_add(1)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    Ok(amount)
}

fn claim_destination(asset: Asset, owner: Pubkey, owner_token_account: Pubkey) -> Pubkey {
    match asset {
        Asset::Sol => owner,
        Asset::Usdc => owner_token_account,
    }
}

pub(crate) fn settled_claim_amount(market: &Market, position: &UserPosition) -> Result<u64> {
    let winning_side = match market.settlement_outcome {
        SettlementOutcome::ClaimWon => PositionSide::Back,
        SettlementOutcome::ClaimLost => PositionSide::Doubt,
        SettlementOutcome::Unresolved | SettlementOutcome::Void => {
            return err!(EscrowError::AccountingInvariant)
        }
    };
    if position.side != winning_side {
        return Ok(position.settlement_base_entitlement);
    }
    let total_winning = if winning_side == PositionSide::Back {
        market.active_back_total
    } else {
        market.active_doubt_total
    };
    let winnings = winner_winnings(
        position.active_amount,
        market.final_forfeited_total,
        total_winning,
    )
    .map_err(map_math_error)?;
    position
        .settlement_base_entitlement
        .checked_add(winnings)
        .ok_or_else(|| error!(EscrowError::ArithmeticOverflow))
}

fn transfer_sol_claim(
    market: &Market,
    market_key: Pubkey,
    owner: &AccountInfo,
    vault: &AccountInfo,
    token_mint: &AccountInfo,
    owner_token_account: &AccountInfo,
    amount: u64,
) -> Result<()> {
    require_keys_eq!(
        market.token_mint,
        Pubkey::default(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        token_mint.key(),
        Pubkey::default(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        owner_token_account.key(),
        owner.key(),
        EscrowError::InvalidClaimDestination
    );
    let (expected_vault, bump) = sol_vault_address(market_key);
    require_keys_eq!(vault.key(), expected_vault, EscrowError::InvalidVault);
    require!(bump == market.vault_bump, EscrowError::InvalidVault);
    require_keys_eq!(*vault.owner, crate::ID, EscrowError::InvalidVaultOwner);
    require!(vault.data_is_empty(), EscrowError::InvalidVaultOwner);

    let reserve = Rent::get()?.minimum_balance(0);
    let principal = vault
        .lamports()
        .checked_sub(reserve)
        .ok_or(EscrowError::InvalidVaultRentReserve)?;
    require!(principal >= amount, EscrowError::VaultUnderfunded);
    move_lamports(vault, owner, amount)
}

#[allow(clippy::too_many_arguments)]
fn transfer_usdc_claim<'info>(
    market: &Market,
    market_key: Pubkey,
    market_info: &AccountInfo<'info>,
    payer: &AccountInfo<'info>,
    owner: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    token_mint: &AccountInfo<'info>,
    owner_token_account: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    associated_token_program: &AccountInfo<'info>,
    system_program_info: &AccountInfo<'info>,
    amount: u64,
) -> Result<()> {
    validate_claim_token_accounts(
        market,
        market_key,
        owner.key(),
        vault,
        token_mint,
        owner_token_account,
    )?;
    associated_token::create_idempotent(CpiContext::new(
        associated_token_program.clone(),
        associated_token::Create {
            payer: payer.clone(),
            associated_token: owner_token_account.clone(),
            authority: owner.clone(),
            mint: token_mint.clone(),
            system_program: system_program_info.clone(),
            token_program: token_program.clone(),
        },
    ))?;
    let destination = spl_token::state::Account::unpack(&owner_token_account.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require_keys_eq!(
        destination.owner,
        owner.key(),
        EscrowError::InvalidClaimDestination
    );
    require_keys_eq!(
        destination.mint,
        market.token_mint,
        EscrowError::InvalidMint
    );
    require!(
        destination.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );
    let source = spl_token::state::Account::unpack(&vault.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require!(source.amount >= amount, EscrowError::VaultUnderfunded);

    let bump = [market.bump];
    let signer_seeds: &[&[u8]] = &[MARKET_SEED, &market.market_uuid, &bump];
    token::transfer_checked(
        CpiContext::new_with_signer(
            token_program.clone(),
            token::TransferChecked {
                from: vault.clone(),
                mint: token_mint.clone(),
                to: owner_token_account.clone(),
                authority: market_info.clone(),
            },
            &[signer_seeds],
        ),
        amount,
        USDC_DECIMALS,
    )
}

fn validate_claim_token_accounts(
    market: &Market,
    market_key: Pubkey,
    owner: Pubkey,
    vault: &AccountInfo,
    token_mint: &AccountInfo,
    owner_token_account: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(
        market.token_mint,
        token_mint.key(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        *token_mint.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let mint = spl_token::state::Mint::unpack(&token_mint.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidMint))?;
    validate_usdc_mint(&mint)?;
    require_keys_eq!(
        vault.key(),
        usdc_vault_address(market_key, market.token_mint),
        EscrowError::InvalidVault
    );
    require_keys_eq!(
        *vault.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let source = spl_token::state::Account::unpack(&vault.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require_keys_eq!(source.owner, market_key, EscrowError::InvalidVaultOwner);
    require_keys_eq!(source.mint, market.token_mint, EscrowError::InvalidMint);
    require!(
        source.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );
    require!(
        source.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );
    let expected_destination = associated_token::get_associated_token_address_with_program_id(
        &owner,
        &market.token_mint,
        &spl_token::ID,
    );
    require_keys_eq!(
        owner_token_account.key(),
        expected_destination,
        EscrowError::InvalidClaimDestination
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ClosePositionLots<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: The documented relayer rent recipient from protocol config.
    #[account(mut, address = config.relayer_fee_payer @ EscrowError::InvalidRentRecipient)]
    pub rent_recipient: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

pub fn close_position_lots(
    ctx: Context<ClosePositionLots>,
    args: ClosePositionLotsArgs,
) -> Result<()> {
    require_terminal_market(ctx.accounts.market.state)?;
    require!(
        ctx.accounts.position.claimed,
        EscrowError::PositionNotClaimable
    );
    validate_lot_close_batch(
        ctx.accounts.position.next_lot_nonce,
        &args.nonces,
        ctx.remaining_accounts.len(),
    )?;

    for (nonce, lot_info) in args.nonces.iter().zip(ctx.remaining_accounts) {
        let expected_nonce = ctx
            .accounts
            .position
            .next_lot_nonce
            .checked_sub(1)
            .ok_or(EscrowError::LotCloseOrderMismatch)?;
        require!(*nonce == expected_nonce, EscrowError::LotCloseOrderMismatch);
        close_one_lot(
            &ctx.accounts.market,
            &ctx.accounts.position,
            lot_info,
            *nonce,
            &ctx.accounts.rent_recipient.to_account_info(),
        )?;
        ctx.accounts.position.next_lot_nonce = expected_nonce;
    }
    emit!(PositionLotsClosed {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        owner: ctx.accounts.position.owner,
        nonces: args.nonces,
        rent_recipient: ctx.accounts.rent_recipient.key(),
    });
    Ok(())
}

fn validate_lot_close_batch(
    next_lot_nonce: u64,
    nonces: &[u64],
    account_count: usize,
) -> Result<()> {
    require!(
        !nonces.is_empty() && nonces.len() == account_count,
        EscrowError::LotCloseOrderMismatch
    );
    let mut expected = next_lot_nonce;
    for nonce in nonces {
        expected = expected
            .checked_sub(1)
            .ok_or(EscrowError::LotCloseOrderMismatch)?;
        require!(*nonce == expected, EscrowError::LotCloseOrderMismatch);
    }
    Ok(())
}

fn close_one_lot(
    market: &Account<Market>,
    position: &Account<UserPosition>,
    lot_info: &AccountInfo,
    nonce: u64,
    rent_recipient: &AccountInfo,
) -> Result<()> {
    require_keys_eq!(*lot_info.owner, crate::ID, EscrowError::InvalidLotState);
    require!(lot_info.is_writable, EscrowError::InvalidLotState);
    let (expected_key, expected_bump) = Pubkey::find_program_address(
        &[
            LOT_SEED,
            market.key().as_ref(),
            position.owner.as_ref(),
            &nonce.to_le_bytes(),
        ],
        &crate::ID,
    );
    require_keys_eq!(lot_info.key(), expected_key, EscrowError::LotNonceMismatch);
    let lot = {
        let data = lot_info.try_borrow_data()?;
        PositionLot::try_deserialize(&mut data.as_ref())?
    };
    require!(
        lot.bump == expected_bump
            && lot.market == market.key()
            && lot.owner == position.owner
            && lot.nonce == nonce,
        EscrowError::LotNonceMismatch
    );
    close_program_account(lot_info, rent_recipient)
}

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    #[account(
        mut,
        close = rent_recipient,
        seeds = [POSITION_SEED, market.key().as_ref(), position.owner.as_ref()],
        bump = position.bump,
        constraint = position.market == market.key() @ EscrowError::ConfigMismatch
    )]
    pub position: Account<'info, UserPosition>,
    /// CHECK: The documented relayer rent recipient from protocol config.
    #[account(mut, address = config.relayer_fee_payer @ EscrowError::InvalidRentRecipient)]
    pub rent_recipient: UncheckedAccount<'info>,
}

pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
    require_terminal_market(ctx.accounts.market.state)?;
    require!(
        ctx.accounts.position.claimed,
        EscrowError::PositionNotClaimable
    );
    require!(
        ctx.accounts.position.next_lot_nonce == 0,
        EscrowError::OutstandingLots
    );
    require!(
        ctx.accounts.market.settlement_processed_position_count > 0,
        EscrowError::AccountingInvariant
    );
    ctx.accounts.market.settlement_processed_position_count = ctx
        .accounts
        .market
        .settlement_processed_position_count
        .checked_sub(1)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    emit!(PositionClosed {
        market: ctx.accounts.market.key(),
        position: ctx.accounts.position.key(),
        owner: ctx.accounts.position.owner,
        rent_recipient: ctx.accounts.rent_recipient.key(),
    });
    Ok(())
}

#[derive(Accounts)]
pub struct CloseMarket<'info> {
    #[account(
        mut,
        close = residual_recipient,
        seeds = [MARKET_SEED, &market.market_uuid],
        bump = market.bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: Validated against the market's immutable vault and closed by the handler.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Address-bound to the recipient pinned into the market at initialization.
    #[account(mut, address = market.residual_recipient @ EscrowError::InvalidResidualRecipient)]
    pub residual_recipient: UncheckedAccount<'info>,
    /// CHECK: Parsed and validated for USDC; the system program placeholder is required for SOL.
    pub token_mint: UncheckedAccount<'info>,
    /// CHECK: Canonical pinned-recipient ATA for USDC; aliases that recipient for SOL.
    #[account(mut)]
    pub residual_token_account: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
    validate_market_close(&ctx.accounts.market)?;
    require_keys_eq!(
        ctx.accounts.vault.key(),
        ctx.accounts.market.vault,
        EscrowError::InvalidVault
    );
    let market_info = ctx.accounts.market.to_account_info();
    let market_key = ctx.accounts.market.key();
    let dust = match ctx.accounts.market.asset {
        Asset::Sol => close_sol_vault(
            &ctx.accounts.market,
            market_key,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.residual_recipient.to_account_info(),
            &ctx.accounts.token_mint.to_account_info(),
            &ctx.accounts.residual_token_account.to_account_info(),
        )?,
        Asset::Usdc => close_usdc_vault(
            &ctx.accounts.market,
            market_key,
            &market_info,
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.residual_recipient.to_account_info(),
            &ctx.accounts.token_mint.to_account_info(),
            &ctx.accounts.residual_token_account.to_account_info(),
            &ctx.accounts.token_program.to_account_info(),
        )?,
    };
    ctx.accounts.market.state = MarketState::Closed;
    emit!(MarketClosed {
        market: ctx.accounts.market.key(),
        dust_amount: dust,
        asset: ctx.accounts.market.asset,
    });
    Ok(())
}

fn validate_market_close(market: &Market) -> Result<()> {
    require_terminal_market(market.state)?;
    require!(
        market.claimed_position_count == market.position_count,
        EscrowError::OutstandingClaims
    );
    require!(
        market.settlement_processed_position_count == 0,
        EscrowError::OutstandingPositions
    );
    Ok(())
}

fn close_sol_vault(
    market: &Market,
    market_key: Pubkey,
    vault: &AccountInfo,
    residual_recipient: &AccountInfo,
    token_mint: &AccountInfo,
    residual_token_account: &AccountInfo,
) -> Result<u64> {
    require_keys_eq!(
        market.token_mint,
        Pubkey::default(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        token_mint.key(),
        Pubkey::default(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        residual_token_account.key(),
        residual_recipient.key(),
        EscrowError::InvalidResidualRecipient
    );
    let (expected_vault, bump) = sol_vault_address(market_key);
    require_keys_eq!(vault.key(), expected_vault, EscrowError::InvalidVault);
    require!(bump == market.vault_bump, EscrowError::InvalidVault);
    require_keys_eq!(*vault.owner, crate::ID, EscrowError::InvalidVaultOwner);
    require!(vault.data_is_empty(), EscrowError::InvalidVaultOwner);
    let reserve = Rent::get()?.minimum_balance(0);
    let balance = vault.lamports();
    let dust = balance
        .checked_sub(reserve)
        .ok_or(EscrowError::InvalidVaultRentReserve)?;
    close_program_account(vault, residual_recipient)?;
    Ok(dust)
}

#[allow(clippy::too_many_arguments)]
fn close_usdc_vault<'info>(
    market: &Market,
    market_key: Pubkey,
    market_info: &AccountInfo<'info>,
    vault: &AccountInfo<'info>,
    residual_recipient: &AccountInfo<'info>,
    token_mint: &AccountInfo<'info>,
    residual_token_account: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
) -> Result<u64> {
    require_keys_eq!(
        market.token_mint,
        token_mint.key(),
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        *token_mint.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    require_keys_eq!(
        token_program.key(),
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let mint = spl_token::state::Mint::unpack(&token_mint.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidMint))?;
    validate_usdc_mint(&mint)?;
    require_keys_eq!(
        vault.key(),
        usdc_vault_address(market_key, market.token_mint),
        EscrowError::InvalidVault
    );
    require_keys_eq!(
        *vault.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let source = spl_token::state::Account::unpack(&vault.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require_keys_eq!(source.owner, market_key, EscrowError::InvalidVaultOwner);
    require_keys_eq!(source.mint, market.token_mint, EscrowError::InvalidMint);
    let expected_destination = associated_token::get_associated_token_address_with_program_id(
        &market.residual_recipient,
        &market.token_mint,
        &spl_token::ID,
    );
    require_keys_eq!(
        residual_token_account.key(),
        expected_destination,
        EscrowError::InvalidResidualRecipient
    );
    require_keys_eq!(
        *residual_token_account.owner,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    let destination = spl_token::state::Account::unpack(&residual_token_account.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require_keys_eq!(
        destination.owner,
        market.residual_recipient,
        EscrowError::InvalidResidualRecipient
    );
    require_keys_eq!(
        destination.mint,
        market.token_mint,
        EscrowError::InvalidMint
    );
    require!(
        destination.state == spl_token::state::AccountState::Initialized,
        EscrowError::InvalidTokenAccount
    );

    let bump = [market.bump];
    let signer_seeds: &[&[u8]] = &[MARKET_SEED, &market.market_uuid, &bump];
    if source.amount > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program.clone(),
                token::TransferChecked {
                    from: vault.clone(),
                    mint: token_mint.clone(),
                    to: residual_token_account.clone(),
                    authority: market_info.clone(),
                },
                &[signer_seeds],
            ),
            source.amount,
            USDC_DECIMALS,
        )?;
    }
    token::close_account(CpiContext::new_with_signer(
        token_program.clone(),
        token::CloseAccount {
            account: vault.clone(),
            destination: residual_recipient.clone(),
            authority: market_info.clone(),
        },
        &[signer_seeds],
    ))?;
    Ok(source.amount)
}

fn require_terminal_market(state: MarketState) -> Result<()> {
    require!(
        matches!(state, MarketState::Settled | MarketState::Voided),
        EscrowError::InvalidMarketState
    );
    Ok(())
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

fn move_lamports(source: &AccountInfo, destination: &AccountInfo, amount: u64) -> Result<()> {
    let destination_balance = destination
        .lamports()
        .checked_add(amount)
        .ok_or(EscrowError::ArithmeticOverflow)?;
    let source_balance = source
        .lamports()
        .checked_sub(amount)
        .ok_or(EscrowError::VaultUnderfunded)?;
    **source.try_borrow_mut_lamports()? = source_balance;
    **destination.try_borrow_mut_lamports()? = destination_balance;
    Ok(())
}

fn close_program_account(source: &AccountInfo, destination: &AccountInfo) -> Result<()> {
    require!(
        source.key() != destination.key(),
        EscrowError::AccountingInvariant
    );
    move_lamports(source, destination, source.lamports())?;
    source.assign(&system_program::ID);
    source.realloc(0, false)?;
    Ok(())
}

fn map_math_error(error: MathError) -> anchor_lang::error::Error {
    match error {
        MathError::Overflow => error!(EscrowError::ArithmeticOverflow),
        _ => error!(EscrowError::AccountingInvariant),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_option::COption;

    fn market(state: MarketState, outcome: SettlementOutcome) -> Market {
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
            asset: Asset::Sol,
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
            pending_back_total: 5,
            pending_doubt_total: 2,
            final_matched_back_total: 40,
            final_matched_doubt_total: 40,
            final_forfeited_total: 40,
            settlement_processed_position_count: 2,
            settlement_outcome: outcome,
            settlement_evidence_hash: [9; 32],
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
            settlement_base_entitlement: active + pending + refundable,
            settlement_processed: true,
            next_lot_nonce: 0,
            claimed: false,
            total_paid_amount: active + pending + refundable,
            created_slot: 1,
            updated_slot: 1,
        }
    }

    #[test]
    fn settled_claims_use_final_forfeits_and_refund_nonactive_buckets() {
        let mut market = market(MarketState::Settled, SettlementOutcome::ClaimWon);
        let mut winner = position(PositionSide::Back, 60, 5, 1);
        assert_eq!(prepare_claim(&mut market, &mut winner).unwrap(), 106);
        assert!(prepare_claim(&mut market, &mut winner).is_err());

        let mut loser = position(PositionSide::Doubt, 40, 2, 3);
        loser.settlement_base_entitlement = 5;
        assert_eq!(prepare_claim(&mut market, &mut loser).unwrap(), 5);
        assert_eq!(market.claimed_position_count, 2);
    }

    #[test]
    fn void_claim_refunds_every_bucket_without_entitlement_calculation() {
        let mut market = market(MarketState::Voided, SettlementOutcome::Void);
        let mut position = position(PositionSide::Back, 10, 20, 30);
        position.settlement_processed = false;
        position.settlement_base_entitlement = 0;
        assert_eq!(prepare_claim(&mut market, &mut position).unwrap(), 60);
    }

    #[test]
    fn claim_rejects_settling_replay_and_corrupt_principal() {
        let mut market = market(MarketState::Settling, SettlementOutcome::ClaimWon);
        let mut position = position(PositionSide::Back, 10, 0, 0);
        assert!(prepare_claim(&mut market, &mut position).is_err());

        market.state = MarketState::Voided;
        position.total_paid_amount = 11;
        assert!(prepare_claim(&mut market, &mut position).is_err());
    }

    #[test]
    fn close_guards_require_claims_and_closed_aggregate_positions() {
        let mut market = market(MarketState::Settled, SettlementOutcome::ClaimWon);
        assert!(validate_market_close(&market).is_err());
        market.claimed_position_count = market.position_count;
        assert!(validate_market_close(&market).is_err());
        market.settlement_processed_position_count = 0;
        assert!(validate_market_close(&market).is_ok());
        market.state = MarketState::Closed;
        assert!(validate_market_close(&market).is_err());
    }

    #[test]
    fn lot_closure_is_contiguous_descending_and_replay_safe() {
        assert!(validate_lot_close_batch(3, &[2, 1, 0], 3).is_ok());
        assert!(validate_lot_close_batch(3, &[1, 2], 2).is_err());
        assert!(validate_lot_close_batch(3, &[2, 2], 2).is_err());
        assert!(validate_lot_close_batch(1, &[], 0).is_err());
        assert!(validate_lot_close_batch(0, &[0], 1).is_err());
    }

    #[test]
    fn winner_claim_overflow_is_rejected() {
        let mut market = market(MarketState::Settled, SettlementOutcome::ClaimWon);
        market.active_back_total = 1;
        market.final_forfeited_total = u64::MAX;
        let mut position = position(PositionSide::Back, 1, 0, 0);
        position.settlement_base_entitlement = u64::MAX;
        assert!(prepare_claim(&mut market, &mut position).is_err());
    }

    #[test]
    fn claim_events_use_the_exact_value_transfer_destination() {
        let owner = Pubkey::new_unique();
        let owner_ata = Pubkey::new_unique();
        assert_eq!(claim_destination(Asset::Sol, owner, owner_ata), owner);
        assert_eq!(claim_destination(Asset::Usdc, owner, owner_ata), owner_ata);
    }

    #[test]
    fn claim_and_close_code_has_one_event_site_per_transition_path() {
        let source = include_str!("claims.rs");
        assert_eq!(source.matches(concat!("emit", "!(")).count(), 4);
    }

    #[test]
    fn usdc_claim_validation_rejects_fake_mint_vault_and_destination() {
        let market_key = Pubkey::new_unique();
        let mint_key = Pubkey::new_unique();
        let owner_key = Pubkey::new_unique();
        let vault_key = usdc_vault_address(market_key, mint_key);
        let destination_key = associated_token::get_associated_token_address_with_program_id(
            &owner_key,
            &mint_key,
            &spl_token::ID,
        );
        let mut market = market(MarketState::Settled, SettlementOutcome::ClaimWon);
        market.asset = Asset::Usdc;
        market.token_mint = mint_key;
        market.vault = vault_key;

        let mint = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 1_000_000,
            decimals: USDC_DECIMALS,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        let source = spl_token::state::Account {
            mint: mint_key,
            owner: market_key,
            amount: 1_000_000,
            delegate: COption::None,
            state: spl_token::state::AccountState::Initialized,
            is_native: COption::None,
            delegated_amount: 0,
            close_authority: COption::None,
        };
        let mut mint_data = vec![0; spl_token::state::Mint::LEN];
        let mut source_data = vec![0; spl_token::state::Account::LEN];
        spl_token::state::Mint::pack(mint, &mut mint_data).unwrap();
        spl_token::state::Account::pack(source, &mut source_data).unwrap();
        let token_owner = spl_token::ID;
        let system_owner = system_program::ID;

        {
            let mut mint_lamports = 1;
            let mut source_lamports = 1;
            let mut destination_lamports = 0;
            let mut destination_data = Vec::new();
            let mint_info = AccountInfo::new(
                &mint_key,
                false,
                false,
                &mut mint_lamports,
                &mut mint_data,
                &token_owner,
                false,
                0,
            );
            let source_info = AccountInfo::new(
                &vault_key,
                false,
                true,
                &mut source_lamports,
                &mut source_data,
                &token_owner,
                false,
                0,
            );
            let destination_info = AccountInfo::new(
                &destination_key,
                false,
                true,
                &mut destination_lamports,
                &mut destination_data,
                &system_owner,
                false,
                0,
            );
            assert!(validate_claim_token_accounts(
                &market,
                market_key,
                owner_key,
                &source_info,
                &mint_info,
                &destination_info,
            )
            .is_ok());
        }

        let wrong_destination_key = Pubkey::new_unique();
        {
            let mut mint_lamports = 1;
            let mut source_lamports = 1;
            let mut destination_lamports = 0;
            let mut destination_data = Vec::new();
            let mint_info = AccountInfo::new(
                &mint_key,
                false,
                false,
                &mut mint_lamports,
                &mut mint_data,
                &token_owner,
                false,
                0,
            );
            let source_info = AccountInfo::new(
                &vault_key,
                false,
                true,
                &mut source_lamports,
                &mut source_data,
                &token_owner,
                false,
                0,
            );
            let destination_info = AccountInfo::new(
                &wrong_destination_key,
                false,
                true,
                &mut destination_lamports,
                &mut destination_data,
                &system_owner,
                false,
                0,
            );
            assert!(validate_claim_token_accounts(
                &market,
                market_key,
                owner_key,
                &source_info,
                &mint_info,
                &destination_info,
            )
            .is_err());
        }

        let fake_vault_key = Pubkey::new_unique();
        {
            let mut mint_lamports = 1;
            let mut source_lamports = 1;
            let mut destination_lamports = 0;
            let mut destination_data = Vec::new();
            let mint_info = AccountInfo::new(
                &mint_key,
                false,
                false,
                &mut mint_lamports,
                &mut mint_data,
                &token_owner,
                false,
                0,
            );
            let source_info = AccountInfo::new(
                &fake_vault_key,
                false,
                true,
                &mut source_lamports,
                &mut source_data,
                &token_owner,
                false,
                0,
            );
            let destination_info = AccountInfo::new(
                &destination_key,
                false,
                true,
                &mut destination_lamports,
                &mut destination_data,
                &system_owner,
                false,
                0,
            );
            assert!(validate_claim_token_accounts(
                &market,
                market_key,
                owner_key,
                &source_info,
                &mint_info,
                &destination_info,
            )
            .is_err());
        }

        let token_2022_owner = Pubkey::new_unique();
        {
            let mut mint_lamports = 1;
            let mut source_lamports = 1;
            let mut destination_lamports = 0;
            let mut destination_data = Vec::new();
            let mint_info = AccountInfo::new(
                &mint_key,
                false,
                false,
                &mut mint_lamports,
                &mut mint_data,
                &token_2022_owner,
                false,
                0,
            );
            let source_info = AccountInfo::new(
                &vault_key,
                false,
                true,
                &mut source_lamports,
                &mut source_data,
                &token_owner,
                false,
                0,
            );
            let destination_info = AccountInfo::new(
                &destination_key,
                false,
                true,
                &mut destination_lamports,
                &mut destination_data,
                &system_owner,
                false,
                0,
            );
            assert!(validate_claim_token_accounts(
                &market,
                market_key,
                owner_key,
                &source_info,
                &mint_info,
                &destination_info,
            )
            .is_err());
        }
    }
}
