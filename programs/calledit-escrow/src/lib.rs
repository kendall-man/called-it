use anchor_lang::prelude::*;

use instructions::*;

pub mod constants;
pub mod encoding;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

declare_id!("7rfzH5Wvo7YjCavDqNu7c18671xSBguZYTkRrn98uq7q");

#[program]
pub mod calledit_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        args: InitializeConfigArgs,
    ) -> Result<()> {
        instructions::initialize_config(ctx, args)
    }

    pub fn rotate_config(ctx: Context<RotateConfig>, args: RotateConfigArgs) -> Result<()> {
        instructions::rotate_config(ctx, args)
    }

    pub fn rotate_oracle_set(
        ctx: Context<RotateOracleSet>,
        args: RotateOracleSetArgs,
    ) -> Result<()> {
        instructions::rotate_oracle_set(ctx, args)
    }

    pub fn set_pause(ctx: Context<SetPause>, args: SetPauseArgs) -> Result<()> {
        instructions::set_pause(ctx, args)
    }

    pub fn initialize_market(
        ctx: Context<InitializeMarket>,
        args: InitializeMarketArgs,
    ) -> Result<()> {
        instructions::initialize_market(ctx, args)
    }

    pub fn freeze_market(ctx: Context<FreezeMarket>, args: FreezeMarketArgs) -> Result<()> {
        instructions::freeze_market(ctx, args)
    }

    pub fn unfreeze_market(ctx: Context<UnfreezeMarket>, args: UnfreezeMarketArgs) -> Result<()> {
        instructions::unfreeze_market(ctx, args)
    }

    pub fn place_position(ctx: Context<PlacePosition>, args: PlacePositionArgs) -> Result<()> {
        instructions::place_position(ctx, args)
    }

    pub fn activate_position_lot(
        ctx: Context<ActivatePositionLot>,
        args: ActivatePositionLotArgs,
    ) -> Result<()> {
        instructions::activate_position_lot(ctx, args)
    }

    pub fn invalidate_position_lot(
        ctx: Context<InvalidatePositionLot>,
        args: InvalidatePositionLotArgs,
    ) -> Result<()> {
        instructions::invalidate_position_lot(ctx, args)
    }
}
