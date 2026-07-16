use anchor_lang::prelude::*;

use crate::{
    constants::{
        CONFIG_SEED, ORACLE_SET_SEED, ORACLE_SIGNER_COUNT_V1, ORACLE_THRESHOLD_V1,
        SCHEMA_VERSION_V1,
    },
    errors::EscrowError,
    events::{
        OracleSetRotated, ProtocolConfigInitialized, ProtocolConfigRotated, ProtocolPauseChanged,
    },
    program::CalleditEscrow,
    state::{OracleSet, ProtocolConfig, ORACLE_SET_ACCOUNT_SPACE, PROTOCOL_CONFIG_ACCOUNT_SPACE},
};

use super::{InitializeConfigArgs, RotateConfigArgs, RotateOracleSetArgs, SetPauseArgs};

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub initializer: Signer<'info>,
    #[account(
        init,
        payer = initializer,
        space = PROTOCOL_CONFIG_ACCOUNT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub escrow_program: Program<'info, CalleditEscrow>,
    #[account(
        constraint = escrow_program.programdata_address()? == Some(program_data.key())
            @ EscrowError::InvalidConfig,
        constraint = program_data.upgrade_authority_address == Some(initializer.key())
            @ EscrowError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

pub fn initialize_config(ctx: Context<InitializeConfig>, args: InitializeConfigArgs) -> Result<()> {
    validate_config(
        args.cluster_genesis_hash,
        args.config_authority,
        args.pause_authority,
        args.market_creation_authority,
        args.feed_operator_authority,
        args.relayer_fee_payer,
        args.residual_recipient,
        args.canonical_usdc_mint,
        args.allowed_token_program,
        args.max_sol_position,
        args.max_usdc_position,
        args.min_sol_position,
        args.min_usdc_position,
        args.max_market_duration_seconds,
        args.max_resolution_delay_seconds,
    )?;

    let config = &mut ctx.accounts.config;
    config.version = SCHEMA_VERSION_V1;
    config.bump = ctx.bumps.config;
    config.paused = false;
    config.config_authority = args.config_authority;
    config.pause_authority = args.pause_authority;
    config.market_creation_authority = args.market_creation_authority;
    config.feed_operator_authority = args.feed_operator_authority;
    config.oracle_set = Pubkey::default();
    config.relayer_fee_payer = args.relayer_fee_payer;
    config.residual_recipient = args.residual_recipient;
    config.cluster_genesis_hash = args.cluster_genesis_hash;
    config.canonical_usdc_mint = args.canonical_usdc_mint;
    config.allowed_token_program = args.allowed_token_program;
    config.max_sol_position = args.max_sol_position;
    config.max_usdc_position = args.max_usdc_position;
    config.min_sol_position = args.min_sol_position;
    config.min_usdc_position = args.min_usdc_position;
    config.max_market_duration_seconds = args.max_market_duration_seconds;
    config.max_resolution_delay_seconds = args.max_resolution_delay_seconds;

    emit!(ProtocolConfigInitialized {
        config: config.key(),
        config_authority: config.config_authority,
        pause_authority: config.pause_authority,
        market_creation_authority: config.market_creation_authority,
        residual_recipient: config.residual_recipient,
        cluster_genesis_hash: config.cluster_genesis_hash,
        canonical_usdc_mint: config.canonical_usdc_mint,
        allowed_token_program: config.allowed_token_program,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct RotateConfig<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = config_authority @ EscrowError::InvalidAuthority
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub config_authority: Signer<'info>,
}

pub fn rotate_config(ctx: Context<RotateConfig>, args: RotateConfigArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(!config.paused, EscrowError::ProtocolPaused);
    validate_config(
        config.cluster_genesis_hash,
        args.config_authority,
        args.pause_authority,
        args.market_creation_authority,
        args.feed_operator_authority,
        args.relayer_fee_payer,
        args.residual_recipient,
        config.canonical_usdc_mint,
        config.allowed_token_program,
        args.max_sol_position,
        args.max_usdc_position,
        args.min_sol_position,
        args.min_usdc_position,
        args.max_market_duration_seconds,
        args.max_resolution_delay_seconds,
    )?;

    config.config_authority = args.config_authority;
    config.pause_authority = args.pause_authority;
    config.market_creation_authority = args.market_creation_authority;
    config.feed_operator_authority = args.feed_operator_authority;
    config.relayer_fee_payer = args.relayer_fee_payer;
    config.residual_recipient = args.residual_recipient;
    config.max_sol_position = args.max_sol_position;
    config.max_usdc_position = args.max_usdc_position;
    config.min_sol_position = args.min_sol_position;
    config.min_usdc_position = args.min_usdc_position;
    config.max_market_duration_seconds = args.max_market_duration_seconds;
    config.max_resolution_delay_seconds = args.max_resolution_delay_seconds;

    emit!(ProtocolConfigRotated {
        config: config.key(),
        config_authority: config.config_authority,
        pause_authority: config.pause_authority,
        market_creation_authority: config.market_creation_authority,
        feed_operator_authority: config.feed_operator_authority,
        relayer_fee_payer: config.relayer_fee_payer,
        residual_recipient: config.residual_recipient,
    });
    Ok(())
}

#[derive(Accounts)]
#[instruction(args: RotateOracleSetArgs)]
pub struct RotateOracleSet<'info> {
    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = config_authority @ EscrowError::InvalidAuthority
    )]
    pub config: Account<'info, ProtocolConfig>,
    pub config_authority: Signer<'info>,
    /// CHECK: On the first rotation there is no current set. On later rotations
    /// this account is deserialized and matched to `config.oracle_set`.
    pub current_oracle_set: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        space = ORACLE_SET_ACCOUNT_SPACE,
        seeds = [ORACLE_SET_SEED, &args.epoch.to_le_bytes()],
        bump
    )]
    pub new_oracle_set: Account<'info, OracleSet>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

pub fn rotate_oracle_set(ctx: Context<RotateOracleSet>, args: RotateOracleSetArgs) -> Result<()> {
    require!(!ctx.accounts.config.paused, EscrowError::ProtocolPaused);
    validate_oracle_set(&args, Clock::get()?.slot)?;

    if ctx.accounts.config.oracle_set != Pubkey::default() {
        require_keys_eq!(
            ctx.accounts.current_oracle_set.key(),
            ctx.accounts.config.oracle_set,
            EscrowError::InvalidOracleSet
        );
        require_keys_eq!(
            *ctx.accounts.current_oracle_set.owner,
            crate::ID,
            EscrowError::InvalidOracleSet
        );
        let data = ctx.accounts.current_oracle_set.try_borrow_data()?;
        let current = OracleSet::try_deserialize(&mut data.as_ref())?;
        require!(
            args.epoch > current.epoch,
            EscrowError::OracleEpochNotIncreasing
        );
    }

    let oracle_set = &mut ctx.accounts.new_oracle_set;
    oracle_set.version = SCHEMA_VERSION_V1;
    oracle_set.bump = ctx.bumps.new_oracle_set;
    oracle_set.epoch = args.epoch;
    oracle_set.signers = args.signers;
    oracle_set.threshold = args.threshold;
    oracle_set.activation_slot = args.activation_slot;
    oracle_set.retirement_slot = args.retirement_slot;
    ctx.accounts.config.oracle_set = oracle_set.key();

    emit!(OracleSetRotated {
        oracle_set: oracle_set.key(),
        epoch: oracle_set.epoch,
        threshold: oracle_set.threshold,
        activation_slot: oracle_set.activation_slot,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct SetPause<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, ProtocolConfig>,
    pub authority: Signer<'info>,
}

pub fn set_pause(ctx: Context<SetPause>, args: SetPauseArgs) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(
        config.paused != args.paused,
        EscrowError::PauseStateUnchanged
    );
    let expected_authority = if args.paused {
        config.pause_authority
    } else {
        config.config_authority
    };
    require_keys_eq!(
        ctx.accounts.authority.key(),
        expected_authority,
        EscrowError::InvalidAuthority
    );
    config.paused = args.paused;
    emit!(ProtocolPauseChanged {
        paused: config.paused,
        authority: ctx.accounts.authority.key(),
    });
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn validate_config(
    cluster_genesis_hash: [u8; 32],
    config_authority: Pubkey,
    pause_authority: Pubkey,
    market_creation_authority: Pubkey,
    feed_operator_authority: Pubkey,
    relayer_fee_payer: Pubkey,
    residual_recipient: Pubkey,
    canonical_usdc_mint: Pubkey,
    allowed_token_program: Pubkey,
    max_sol_position: u64,
    max_usdc_position: u64,
    min_sol_position: u64,
    min_usdc_position: u64,
    max_market_duration_seconds: u64,
    max_resolution_delay_seconds: u64,
) -> Result<()> {
    require!(cluster_genesis_hash != [0; 32], EscrowError::InvalidConfig);
    require_keys_eq!(
        allowed_token_program,
        spl_token::ID,
        EscrowError::InvalidTokenProgram
    );
    for key in [
        config_authority,
        pause_authority,
        market_creation_authority,
        feed_operator_authority,
        relayer_fee_payer,
        residual_recipient,
        canonical_usdc_mint,
    ] {
        require!(key != Pubkey::default(), EscrowError::InvalidConfig);
    }
    let authorities = [
        config_authority,
        pause_authority,
        market_creation_authority,
        feed_operator_authority,
    ];
    for (index, authority) in authorities.iter().enumerate() {
        require!(
            !authorities[index + 1..].contains(authority),
            EscrowError::InvalidConfig
        );
    }
    require!(
        min_sol_position > 0 && min_sol_position <= max_sol_position,
        EscrowError::InvalidConfig
    );
    require!(
        min_usdc_position > 0 && min_usdc_position <= max_usdc_position,
        EscrowError::InvalidConfig
    );
    require!(
        max_market_duration_seconds > 0 && max_resolution_delay_seconds > 0,
        EscrowError::InvalidConfig
    );
    Ok(())
}

pub(crate) fn validate_oracle_set(args: &RotateOracleSetArgs, current_slot: u64) -> Result<()> {
    require!(
        args.signers.len() == ORACLE_SIGNER_COUNT_V1,
        EscrowError::InvalidOracleSet
    );
    require!(
        args.threshold == ORACLE_THRESHOLD_V1,
        EscrowError::InvalidOracleThreshold
    );
    for (index, signer) in args.signers.iter().enumerate() {
        require!(
            *signer != Pubkey::default(),
            EscrowError::InvalidOracleSigner
        );
        require!(
            !args.signers[index + 1..].contains(signer),
            EscrowError::InvalidOracleSigner
        );
    }
    require!(
        args.activation_slot >= current_slot,
        EscrowError::InvalidOracleSet
    );
    if let Some(retirement_slot) = args.retirement_slot {
        require!(
            retirement_slot > args.activation_slot,
            EscrowError::InvalidOracleSet
        );
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn validate_config_with(
        authorities: [Pubkey; 4],
        allowed_token_program: Pubkey,
        min_sol: u64,
        max_sol: u64,
    ) -> Result<()> {
        validate_config(
            [1; 32],
            authorities[0],
            authorities[1],
            authorities[2],
            authorities[3],
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            allowed_token_program,
            max_sol,
            10_000_000,
            min_sol,
            1_000_000,
            86_400,
            86_400,
        )
    }

    #[test]
    fn config_requires_classic_spl_and_separate_authorities() {
        let authorities = [
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        assert!(validate_config_with(authorities, spl_token::ID, 1, 10).is_ok());
        assert!(
            validate_config_with(authorities, Pubkey::new_unique(), 1, 10).is_err(),
            "Token-2022 or any non-classic token program must fail"
        );

        let duplicate = [
            authorities[0],
            authorities[0],
            authorities[2],
            authorities[3],
        ];
        assert!(validate_config_with(duplicate, spl_token::ID, 1, 10).is_err());
        assert!(validate_config_with(authorities, spl_token::ID, 11, 10).is_err());
    }

    #[test]
    fn oracle_set_is_exactly_two_of_three_unique_future_active_signers() {
        let signers = vec![
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            Pubkey::new_unique(),
        ];
        let valid = RotateOracleSetArgs {
            epoch: 7,
            signers: signers.clone(),
            threshold: 2,
            activation_slot: 100,
            retirement_slot: Some(200),
        };
        assert!(validate_oracle_set(&valid, 100).is_ok());

        let mut duplicate = valid.clone();
        duplicate.signers[2] = duplicate.signers[0];
        assert!(validate_oracle_set(&duplicate, 100).is_err());

        let mut wrong_threshold = valid.clone();
        wrong_threshold.threshold = 1;
        assert!(validate_oracle_set(&wrong_threshold, 100).is_err());

        let mut stale = valid;
        stale.activation_slot = 99;
        assert!(validate_oracle_set(&stale, 100).is_err());
    }
}
