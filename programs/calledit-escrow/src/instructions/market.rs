use anchor_lang::{prelude::*, solana_program::program_pack::Pack, system_program};
use anchor_spl::{
    associated_token::{self, AssociatedToken},
    token::Token,
};

use crate::{
    constants::{
        CONFIG_SEED, FEE_BPS_V1, MARKET_SEED, POSITION_ACTIVATION_DELAY_SECONDS_V1,
        SCHEMA_VERSION_V1, SOL_VAULT_SEED, USDC_DECIMALS,
    },
    encoding::{
        AttestationCommonV1, EncodingError, FeedEventAttestationV1, FeedEventKind, MarketDocumentV1,
    },
    errors::EscrowError,
    events::{MarketFrozen, MarketInitialized, MarketUnfrozen},
    state::{
        Asset, Market, MarketState, OracleSet, ProtocolConfig, SettlementOutcome,
        MARKET_ACCOUNT_SPACE,
    },
};

use super::{
    attestations::{validate_pinned_oracle_set, verify_threshold_signatures},
    FreezeMarketArgs, InitializeMarketArgs, UnfreezeMarketArgs,
};

#[derive(Accounts)]
#[instruction(args: InitializeMarketArgs)]
pub struct InitializeMarket<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = market_creation_authority @ EscrowError::InvalidAuthority
    )]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        seeds = [crate::constants::ORACLE_SET_SEED, &args.oracle_set_epoch.to_le_bytes()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Account<'info, OracleSet>,
    pub market_creation_authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(
        init,
        payer = payer,
        space = MARKET_ACCOUNT_SPACE,
        seeds = [MARKET_SEED, &args.market_uuid],
        bump
    )]
    pub market: Account<'info, Market>,
    /// CHECK: The handler creates and validates either the SOL vault PDA or
    /// the market's canonical classic-SPL ATA.
    #[account(mut)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: Required and parsed as a classic SPL mint only for USDC markets.
    pub token_mint: UncheckedAccount<'info>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_market(ctx: Context<InitializeMarket>, args: InitializeMarketArgs) -> Result<()> {
    let clock = Clock::get()?;
    validate_market_domain(&ctx, &args, &clock)?;
    validate_market_terms(&ctx.accounts.config, &args, clock.unix_timestamp)?;
    validate_pinned_oracle_set(&ctx.accounts.oracle_set, args.oracle_set_epoch)?;
    require_keys_eq!(
        ctx.accounts.config.oracle_set,
        ctx.accounts.oracle_set.key(),
        EscrowError::InvalidOracleSet
    );
    require!(
        ctx.accounts.oracle_set.activation_slot <= clock.slot
            && ctx
                .accounts
                .oracle_set
                .retirement_slot
                .map_or(true, |slot| clock.slot < slot),
        EscrowError::OracleSetInactive
    );

    let document_hash = canonical_market_document_hash(&args)?;
    require!(
        document_hash == args.market_document_hash,
        EscrowError::MarketDocumentHashMismatch
    );

    let (vault, vault_bump) = match args.asset {
        Asset::Sol => initialize_sol_vault(&ctx, &args)?,
        Asset::Usdc => initialize_usdc_vault(&ctx, &args)?,
    };

    let market = &mut ctx.accounts.market;
    market.version = SCHEMA_VERSION_V1;
    market.bump = ctx.bumps.market;
    market.market_uuid = args.market_uuid;
    market.fixture_id = args.fixture_id;
    market.claim_spec_hash = args.claim_spec_hash;
    market.display_terms_hash = args.display_terms_hash;
    market.odds_source_message_hash = args.odds_source_message_hash;
    market.market_document_hash = document_hash;
    market.quote_timestamp = args.quote_timestamp;
    market.probability_ppm = args.probability_ppm;
    market.ratio_milli = args.ratio_milli;
    market.asset = args.asset;
    market.token_mint = args.token_mint;
    market.fee_bps = args.fee_bps;
    market.state = MarketState::Open;
    market.replay = args.replay;
    market.residual_recipient = ctx.accounts.config.residual_recipient;
    market.created_timestamp = clock.unix_timestamp;
    market.in_play_start_timestamp = args.in_play_start_timestamp;
    market.activation_delay_seconds = args.activation_delay_seconds;
    market.position_cutoff_timestamp = args.position_cutoff_timestamp;
    market.resolution_deadline = args.resolution_deadline;
    market.oracle_set_epoch = args.oracle_set_epoch;
    market.event_epoch = 0;
    market.active_back_total = 0;
    market.active_doubt_total = 0;
    market.pending_back_total = 0;
    market.pending_doubt_total = 0;
    market.final_matched_back_total = 0;
    market.final_matched_doubt_total = 0;
    market.final_forfeited_total = 0;
    market.settlement_processed_position_count = 0;
    market.settlement_outcome = SettlementOutcome::Unresolved;
    market.settlement_evidence_hash = [0; 32];
    market.position_count = 0;
    market.claimed_position_count = 0;
    market.vault = vault;
    market.vault_bump = vault_bump;

    emit!(MarketInitialized {
        market: market.key(),
        market_uuid: market.market_uuid,
        fixture_id: market.fixture_id,
        asset: market.asset,
        ratio_milli: market.ratio_milli,
        market_document_hash: market.market_document_hash,
        residual_recipient: market.residual_recipient,
        oracle_set: ctx.accounts.oracle_set.key(),
        vault: market.vault,
        in_play_start_timestamp: market.in_play_start_timestamp,
        activation_delay_seconds: market.activation_delay_seconds,
        position_cutoff_timestamp: market.position_cutoff_timestamp,
        resolution_deadline: market.resolution_deadline,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct FreezeMarket<'info> {
    #[account(
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = feed_operator_authority @ EscrowError::InvalidAuthority
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub feed_operator_authority: Signer<'info>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
}

pub fn freeze_market(ctx: Context<FreezeMarket>, args: FreezeMarketArgs) -> Result<()> {
    let market = &mut ctx.accounts.market;
    require!(
        market.state == MarketState::Open,
        EscrowError::InvalidMarketState
    );
    require!(
        market.event_epoch == args.expected_event_epoch,
        EscrowError::EventEpochMismatch
    );
    market.event_epoch = next_event_epoch(market.event_epoch, args.expected_event_epoch)?;
    market.state = MarketState::Frozen;
    emit!(MarketFrozen {
        market: market.key(),
        event_epoch: market.event_epoch,
        evidence_hash: args.evidence_hash,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct UnfreezeMarket<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    #[account(
        seeds = [crate::constants::ORACLE_SET_SEED, &market.oracle_set_epoch.to_le_bytes()],
        bump = oracle_set.bump
    )]
    pub oracle_set: Account<'info, OracleSet>,
    #[account(mut, seeds = [MARKET_SEED, &market.market_uuid], bump = market.bump)]
    pub market: Account<'info, Market>,
    /// CHECK: Address-constrained to the transaction instructions sysvar.
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions_sysvar: UncheckedAccount<'info>,
}

pub fn unfreeze_market(ctx: Context<UnfreezeMarket>, args: UnfreezeMarketArgs) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        ctx.accounts.market.state == MarketState::Frozen,
        EscrowError::InvalidMarketState
    );
    require!(
        ctx.accounts.market.event_epoch == args.expected_event_epoch,
        EscrowError::EventEpochMismatch
    );
    require!(
        args.observed_at <= args.issued_at,
        EscrowError::InvalidAttestationDomain
    );
    validate_pinned_oracle_set(
        &ctx.accounts.oracle_set,
        ctx.accounts.market.oracle_set_epoch,
    )?;
    let next_epoch = next_event_epoch(ctx.accounts.market.event_epoch, args.expected_event_epoch)?;
    let attestation = FeedEventAttestationV1 {
        common: market_attestation_common(
            &ctx.accounts.config,
            &ctx.accounts.market,
            ctx.accounts.market.key(),
            args.issued_at,
            args.expires_at,
            args.evidence_hash,
        ),
        event_kind: FeedEventKind::Unfreeze,
        event_epoch: next_epoch,
        deciding_sequence: args.deciding_sequence,
        observed_at: args.observed_at,
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

    let market = &mut ctx.accounts.market;
    market.event_epoch = next_epoch;
    market.state = MarketState::Open;
    emit!(MarketUnfrozen {
        market: market.key(),
        event_epoch: market.event_epoch,
        evidence_hash: args.evidence_hash,
    });
    Ok(())
}

fn validate_market_domain(
    ctx: &Context<InitializeMarket>,
    args: &InitializeMarketArgs,
    _clock: &Clock,
) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    require!(
        args.expected_cluster_genesis_hash == ctx.accounts.config.cluster_genesis_hash,
        EscrowError::GenesisHashMismatch
    );
    require_keys_eq!(
        args.expected_program_id,
        crate::ID,
        EscrowError::ProgramIdMismatch
    );
    require_keys_eq!(
        args.expected_config,
        ctx.accounts.config.key(),
        EscrowError::ConfigMismatch
    );
    require_keys_eq!(
        args.expected_oracle_set,
        ctx.accounts.oracle_set.key(),
        EscrowError::InvalidOracleSet
    );
    require_keys_eq!(
        ctx.accounts.token_program.key(),
        ctx.accounts.config.allowed_token_program,
        EscrowError::InvalidTokenProgram
    );
    Ok(())
}

pub(crate) fn validate_market_terms(
    config: &ProtocolConfig,
    args: &InitializeMarketArgs,
    now: i64,
) -> Result<()> {
    require!(args.fee_bps == FEE_BPS_V1, EscrowError::InvalidFeeBps);
    require!(
        args.activation_delay_seconds == POSITION_ACTIVATION_DELAY_SECONDS_V1,
        EscrowError::InvalidConfig
    );
    require!(
        args.quote_timestamp <= now && now < args.position_cutoff_timestamp,
        EscrowError::InvalidMarketTimestamps
    );
    let duration = args
        .position_cutoff_timestamp
        .checked_sub(now)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(EscrowError::InvalidMarketTimestamps)?;
    require!(
        duration <= config.max_market_duration_seconds,
        EscrowError::MarketDurationExceeded
    );
    let resolution_delay = args
        .resolution_deadline
        .checked_sub(args.position_cutoff_timestamp)
        .and_then(|value| u64::try_from(value).ok())
        .ok_or(EscrowError::InvalidMarketTimestamps)?;
    require!(
        resolution_delay <= config.max_resolution_delay_seconds,
        EscrowError::ResolutionDelayExceeded
    );
    Ok(())
}

fn canonical_market_document_hash(args: &InitializeMarketArgs) -> Result<[u8; 32]> {
    MarketDocumentV1 {
        market_uuid: args.market_uuid,
        fixture_id: args.fixture_id,
        claim_specification_hash: args.claim_spec_hash,
        display_terms_hash: args.display_terms_hash,
        asset: args.asset,
        probability_ppm: args.probability_ppm,
        ratio_milli: args.ratio_milli,
        odds_message_hash: args.odds_source_message_hash,
        odds_timestamp: args.quote_timestamp,
        in_play_start_timestamp: args.in_play_start_timestamp,
        activation_delay_seconds: args.activation_delay_seconds,
        position_cutoff: args.position_cutoff_timestamp,
        resolution_deadline: args.resolution_deadline,
        fee_bps: args.fee_bps,
        oracle_set_epoch: args.oracle_set_epoch,
        replay_flag: args.replay,
    }
    .hash()
    .map_err(|error| match error {
        EncodingError::InvalidProbability => error!(EscrowError::InvalidProbability),
        EncodingError::RatioMismatch => error!(EscrowError::RatioMismatch),
        EncodingError::NonzeroFee => error!(EscrowError::InvalidFeeBps),
        EncodingError::InvalidActivationDelay => error!(EscrowError::InvalidConfig),
        _ => error!(EscrowError::InvalidMarketTimestamps),
    })
}

fn initialize_sol_vault(
    ctx: &Context<InitializeMarket>,
    args: &InitializeMarketArgs,
) -> Result<(Pubkey, u8)> {
    require_keys_eq!(args.token_mint, Pubkey::default(), EscrowError::InvalidMint);
    let market_key = ctx.accounts.market.key();
    let (expected_vault, vault_bump) = sol_vault_address(market_key);
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault,
        EscrowError::InvalidVault
    );
    let rent_reserve = Rent::get()?.minimum_balance(0);
    let bump = [vault_bump];
    let signer_seeds: &[&[u8]] = &[SOL_VAULT_SEED, market_key.as_ref(), &bump];
    system_program::create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            system_program::CreateAccount {
                from: ctx.accounts.payer.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
            &[signer_seeds],
        ),
        rent_reserve,
        0,
        &crate::ID,
    )?;
    require_keys_eq!(
        *ctx.accounts.vault.owner,
        crate::ID,
        EscrowError::InvalidVaultOwner
    );
    require!(
        ctx.accounts.vault.lamports() >= rent_reserve,
        EscrowError::InvalidVaultRentReserve
    );
    Ok((expected_vault, vault_bump))
}

fn initialize_usdc_vault(
    ctx: &Context<InitializeMarket>,
    args: &InitializeMarketArgs,
) -> Result<(Pubkey, u8)> {
    require_keys_eq!(
        args.token_mint,
        ctx.accounts.config.canonical_usdc_mint,
        EscrowError::InvalidMint
    );
    require_keys_eq!(
        ctx.accounts.token_mint.key(),
        args.token_mint,
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

    let expected_vault = usdc_vault_address(ctx.accounts.market.key(), args.token_mint);
    require_keys_eq!(
        ctx.accounts.vault.key(),
        expected_vault,
        EscrowError::InvalidVault
    );
    associated_token::create_idempotent(CpiContext::new(
        ctx.accounts.associated_token_program.to_account_info(),
        associated_token::Create {
            payer: ctx.accounts.payer.to_account_info(),
            associated_token: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.market.to_account_info(),
            mint: ctx.accounts.token_mint.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
            token_program: ctx.accounts.token_program.to_account_info(),
        },
    ))?;
    let vault = spl_token::state::Account::unpack(&ctx.accounts.vault.try_borrow_data()?)
        .map_err(|_| error!(EscrowError::InvalidTokenAccount))?;
    require_keys_eq!(vault.mint, args.token_mint, EscrowError::InvalidMint);
    require_keys_eq!(
        vault.owner,
        ctx.accounts.market.key(),
        EscrowError::InvalidTokenAccount
    );
    Ok((expected_vault, 0))
}

pub(crate) fn market_attestation_common(
    config: &ProtocolConfig,
    market: &Market,
    market_key: Pubkey,
    issued_at: i64,
    expires_at: i64,
    evidence_hash: [u8; 32],
) -> AttestationCommonV1 {
    AttestationCommonV1 {
        cluster_genesis_hash: config.cluster_genesis_hash,
        escrow_program_id: crate::ID.to_bytes(),
        market_pda: market_key.to_bytes(),
        market_document_hash: market.market_document_hash,
        fixture_id: market.fixture_id,
        oracle_set_epoch: market.oracle_set_epoch,
        issued_at,
        expires_at,
        evidence_hash,
    }
}

pub(crate) fn sol_vault_address(market: Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[SOL_VAULT_SEED, market.as_ref()], &crate::ID)
}

pub(crate) fn usdc_vault_address(market: Pubkey, mint: Pubkey) -> Pubkey {
    associated_token::get_associated_token_address_with_program_id(&market, &mint, &spl_token::ID)
}

pub(crate) fn validate_usdc_mint(mint: &spl_token::state::Mint) -> Result<()> {
    require!(mint.is_initialized, EscrowError::InvalidMint);
    require!(
        mint.decimals == USDC_DECIMALS,
        EscrowError::InvalidMintDecimals
    );
    Ok(())
}

fn next_event_epoch(current: u64, expected: u64) -> Result<u64> {
    require!(current == expected, EscrowError::EventEpochMismatch);
    current
        .checked_add(1)
        .ok_or_else(|| error!(EscrowError::ArithmeticOverflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::solana_program::program_option::COption;

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
            max_sol_position: 1_000_000_000,
            max_usdc_position: 1_000_000_000,
            min_sol_position: 1,
            min_usdc_position: 1,
            max_market_duration_seconds: 100,
            max_resolution_delay_seconds: 200,
        }
    }

    fn args() -> InitializeMarketArgs {
        InitializeMarketArgs {
            expected_cluster_genesis_hash: [1; 32],
            expected_program_id: crate::ID,
            expected_config: Pubkey::new_unique(),
            expected_oracle_set: Pubkey::new_unique(),
            market_uuid: [7; 16],
            fixture_id: 42,
            claim_spec_hash: [2; 32],
            display_terms_hash: [3; 32],
            odds_source_message_hash: [4; 32],
            market_document_hash: [0; 32],
            quote_timestamp: 240,
            probability_ppm: 500_000,
            ratio_milli: 1_000,
            asset: Asset::Sol,
            token_mint: Pubkey::default(),
            fee_bps: 0,
            replay: false,
            in_play_start_timestamp: 200,
            activation_delay_seconds: 150,
            position_cutoff_timestamp: 300,
            resolution_deadline: 400,
            oracle_set_epoch: 7,
        }
    }

    #[test]
    fn market_terms_accept_in_play_quotes_and_enforce_protocol_horizons() {
        let config = config();
        let args = args();
        assert!(validate_market_terms(&config, &args, 250).is_ok());

        let mut too_long = args.clone();
        too_long.position_cutoff_timestamp = 351;
        too_long.resolution_deadline = 451;
        assert!(validate_market_terms(&config, &too_long, 250).is_err());

        let mut stale = args;
        stale.position_cutoff_timestamp = 250;
        assert!(validate_market_terms(&config, &stale, 250).is_err());
    }

    #[test]
    fn canonical_hash_is_recomputed_and_rejects_quote_tampering() {
        let args = args();
        let hash = canonical_market_document_hash(&args).unwrap();
        assert_ne!(hash, [0; 32]);

        let mut wrong_ratio = args.clone();
        wrong_ratio.ratio_milli = 999;
        assert!(canonical_market_document_hash(&wrong_ratio).is_err());

        let mut changed_fixture = args;
        changed_fixture.fixture_id += 1;
        assert_ne!(
            canonical_market_document_hash(&changed_fixture).unwrap(),
            hash
        );
    }

    #[test]
    fn vault_addresses_are_asset_specific_and_canonical() {
        let market = Pubkey::new_unique();
        let mint = Pubkey::new_unique();
        let other_mint = Pubkey::new_unique();
        let (sol_vault, _) = sol_vault_address(market);
        let usdc_vault = usdc_vault_address(market, mint);

        assert_ne!(sol_vault, usdc_vault);
        assert_eq!(
            usdc_vault,
            associated_token::get_associated_token_address_with_program_id(
                &market,
                &mint,
                &spl_token::ID
            )
        );
        assert_ne!(usdc_vault, usdc_vault_address(market, other_mint));
    }

    #[test]
    fn usdc_mint_must_be_initialized_with_six_decimals() {
        let mut mint = spl_token::state::Mint {
            mint_authority: COption::None,
            supply: 1_000_000,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        };
        assert!(validate_usdc_mint(&mint).is_ok());
        mint.decimals = 9;
        assert!(validate_usdc_mint(&mint).is_err());
        mint.decimals = 6;
        mint.is_initialized = false;
        assert!(validate_usdc_mint(&mint).is_err());
    }

    #[test]
    fn freeze_and_unfreeze_epochs_are_checked_and_monotonic() {
        assert_eq!(next_event_epoch(4, 4).unwrap(), 5);
        assert!(next_event_epoch(4, 3).is_err());
        assert!(next_event_epoch(u64::MAX, u64::MAX).is_err());
    }
}
