use anchor_lang::prelude::*;

use instructions::*;

pub mod constants;
pub mod encoding;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

declare_id!("HrKUo8Bue31kU9sobzQGK5qDxVxBu5nBLXP3aGeKCDFL");

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

    pub fn settle_market(ctx: Context<SettleMarket>, args: SettleMarketArgs) -> Result<()> {
        instructions::settle_market(ctx, args)
    }

    pub fn calculate_position_entitlement(
        ctx: Context<CalculatePositionEntitlement>,
        args: CalculatePositionEntitlementArgs,
    ) -> Result<()> {
        instructions::calculate_position_entitlement(ctx, args)
    }

    pub fn void_market(ctx: Context<VoidMarket>, args: VoidMarketArgs) -> Result<()> {
        instructions::void_market(ctx, args)
    }

    pub fn timeout_void(ctx: Context<TimeoutVoid>) -> Result<()> {
        instructions::timeout_void(ctx)
    }

    pub fn claim_position(ctx: Context<ClaimPosition>) -> Result<()> {
        instructions::claim_position(ctx)
    }

    pub fn claim_position_for(ctx: Context<ClaimPositionFor>) -> Result<()> {
        instructions::claim_position_for(ctx)
    }

    pub fn close_position_lots(
        ctx: Context<ClosePositionLots>,
        args: ClosePositionLotsArgs,
    ) -> Result<()> {
        instructions::close_position_lots(ctx, args)
    }

    pub fn close_position(ctx: Context<ClosePosition>) -> Result<()> {
        instructions::close_position(ctx)
    }

    pub fn close_market(ctx: Context<CloseMarket>) -> Result<()> {
        instructions::close_market(ctx)
    }
}
