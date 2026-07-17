//! Checked integer implementation of the existing peer-matched pot model.
//!
//! The input probability is canonicalized to parts-per-million before it
//! reaches the program. All value arithmetic uses checked `u128`
//! intermediates and floors division exactly where the TypeScript reference
//! uses bigint division.

use crate::{
    constants::{MULTIPLIER_SCALE, PROBABILITY_PPM_SCALE},
    state::{PositionSide, SettlementOutcome},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MathError {
    InvalidProbability,
    InvalidRatio,
    InvalidOutcome,
    Overflow,
    InconsistentTotals,
    DuplicateOwner,
    OppositeSide,
}

pub type MathResult<T> = core::result::Result<T, MathError>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Pots {
    pub back: u64,
    pub doubt: u64,
    pub matched_back: u64,
    pub matched_doubt: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SettlementInput {
    pub user_key: u64,
    pub side: PositionSide,
    pub active_amount: u64,
    pub pending_amount: u64,
    pub refundable_amount: u64,
}

impl SettlementInput {
    pub const fn new(
        user_key: u64,
        side: PositionSide,
        active_amount: u64,
        pending_amount: u64,
        refundable_amount: u64,
    ) -> Self {
        Self {
            user_key,
            side,
            active_amount,
            pending_amount,
            refundable_amount,
        }
    }

    pub const fn active(user_key: u64, side: PositionSide, amount: u64) -> Self {
        Self::new(user_key, side, amount, 0, 0)
    }

    pub const fn pending(user_key: u64, side: PositionSide, amount: u64) -> Self {
        Self::new(user_key, side, 0, amount, 0)
    }

    pub const fn refundable(user_key: u64, side: PositionSide, amount: u64) -> Self {
        Self::new(user_key, side, 0, 0, amount)
    }

    pub fn total_amount(&self) -> MathResult<u64> {
        self.active_amount
            .checked_add(self.pending_amount)
            .and_then(|amount| amount.checked_add(self.refundable_amount))
            .ok_or(MathError::Overflow)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PositionCredit {
    pub user_key: u64,
    pub refund: u64,
    pub payout: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettlementResult {
    pub pots: Pots,
    pub forfeited_pot: u64,
    pub credits: Vec<PositionCredit>,
    pub dust: u64,
}

impl SettlementResult {
    pub fn total_credited(&self) -> MathResult<u64> {
        self.credits.iter().try_fold(0u64, |total, credit| {
            total
                .checked_add(credit.refund)
                .and_then(|value| value.checked_add(credit.payout))
                .ok_or(MathError::Overflow)
        })
    }
}

/// Derives AGAINST atomic units required per 1,000 FOR atomic units.
/// Rounding is nearest with positive ties rounded upward, matching
/// `Math.round` for the protocol's positive domain without using floats.
pub fn ratio_milli(probability_ppm: u32) -> MathResult<u32> {
    if probability_ppm == 0 || probability_ppm >= PROBABILITY_PPM_SCALE {
        return Err(MathError::InvalidProbability);
    }

    let denominator = u64::from(probability_ppm);
    let numerator = u64::from(PROBABILITY_PPM_SCALE - probability_ppm)
        .checked_mul(MULTIPLIER_SCALE)
        .ok_or(MathError::Overflow)?;
    let rounded = numerator
        .checked_add(denominator / 2)
        .ok_or(MathError::Overflow)?
        / denominator;
    let rounded = rounded.max(1);
    u32::try_from(rounded).map_err(|_| MathError::Overflow)
}

pub fn compute_pots(back: u64, doubt: u64, ratio_milli: u32) -> MathResult<Pots> {
    if ratio_milli == 0 {
        return Err(MathError::InvalidRatio);
    }

    let matched_back = back.min(mul_div_floor(
        doubt,
        MULTIPLIER_SCALE,
        u64::from(ratio_milli),
    )?);
    let matched_doubt = doubt.min(mul_div_floor(
        matched_back,
        u64::from(ratio_milli),
        MULTIPLIER_SCALE,
    )?);

    Ok(Pots {
        back,
        doubt,
        matched_back,
        matched_doubt,
    })
}

pub fn loser_forfeit(stake: u64, matched_losing: u64, total_losing: u64) -> MathResult<u64> {
    if total_losing == 0 {
        return Ok(0);
    }
    if matched_losing > total_losing {
        return Err(MathError::InconsistentTotals);
    }
    mul_div_floor(stake, matched_losing, total_losing)
}

pub fn winner_winnings(stake: u64, forfeited_pot: u64, total_winning: u64) -> MathResult<u64> {
    if total_winning == 0 {
        return Ok(0);
    }
    mul_div_floor(stake, forfeited_pot, total_winning)
}

/// Reference settlement over aggregate `UserPosition` accounts. Each owner may
/// appear exactly once, and floor division is applied once to that aggregate.
/// Position lots only feed these active/pending/refundable buckets and are not
/// iterated during settlement or claim.
pub fn settle_positions(
    positions: &[SettlementInput],
    outcome: SettlementOutcome,
    ratio_milli: u32,
) -> MathResult<SettlementResult> {
    if ratio_milli == 0 {
        return Err(MathError::InvalidRatio);
    }
    if outcome == SettlementOutcome::Unresolved {
        return Err(MathError::InvalidOutcome);
    }
    validate_unique_owners(positions)?;

    let escrowed = positions.iter().try_fold(0u64, |total, position| {
        total
            .checked_add(position.total_amount()?)
            .ok_or(MathError::Overflow)
    })?;
    if outcome == SettlementOutcome::Void {
        let credits = positions
            .iter()
            .map(|position| {
                Ok(PositionCredit {
                    user_key: position.user_key,
                    refund: position.total_amount()?,
                    payout: 0,
                })
            })
            .collect::<MathResult<Vec<_>>>()?;
        return Ok(SettlementResult {
            pots: compute_pots(0, 0, ratio_milli)?,
            forfeited_pot: 0,
            credits,
            dust: 0,
        });
    }

    let active_back = checked_amount_sum(
        positions
            .iter()
            .filter(|position| position.side == PositionSide::Back)
            .map(|position| position.active_amount),
    )?;
    let active_doubt = checked_amount_sum(
        positions
            .iter()
            .filter(|position| position.side == PositionSide::Doubt)
            .map(|position| position.active_amount),
    )?;
    let pots = compute_pots(active_back, active_doubt, ratio_milli)?;
    let winning_side = match outcome {
        SettlementOutcome::ClaimWon => PositionSide::Back,
        SettlementOutcome::ClaimLost => PositionSide::Doubt,
        SettlementOutcome::Unresolved | SettlementOutcome::Void => {
            return Err(MathError::InvalidOutcome)
        }
    };
    let (winning_stakes, losing_stakes, matched_losing) = if winning_side == PositionSide::Back {
        (pots.back, pots.doubt, pots.matched_doubt)
    } else {
        (pots.doubt, pots.back, pots.matched_back)
    };

    let mut forfeited_pot = 0u64;
    for position in positions
        .iter()
        .filter(|position| position.side != winning_side)
    {
        forfeited_pot = forfeited_pot
            .checked_add(loser_forfeit(
                position.active_amount,
                matched_losing,
                losing_stakes,
            )?)
            .ok_or(MathError::Overflow)?;
    }

    let mut credits = Vec::with_capacity(positions.len());
    for position in positions {
        let base_refund = position
            .pending_amount
            .checked_add(position.refundable_amount)
            .ok_or(MathError::Overflow)?;
        let (refund, payout) = if position.side == winning_side {
            let winnings = winner_winnings(position.active_amount, forfeited_pot, winning_stakes)?;
            (
                base_refund,
                position
                    .active_amount
                    .checked_add(winnings)
                    .ok_or(MathError::Overflow)?,
            )
        } else {
            let forfeit = loser_forfeit(position.active_amount, matched_losing, losing_stakes)?;
            let active_refund = position
                .active_amount
                .checked_sub(forfeit)
                .ok_or(MathError::InconsistentTotals)?;
            (
                active_refund
                    .checked_add(base_refund)
                    .ok_or(MathError::Overflow)?,
                0,
            )
        };
        credits.push(PositionCredit {
            user_key: position.user_key,
            refund,
            payout,
        });
    }

    let credited = credits.iter().try_fold(0u64, |total, credit| {
        total
            .checked_add(credit.refund)
            .and_then(|value| value.checked_add(credit.payout))
            .ok_or(MathError::Overflow)
    })?;
    let dust = escrowed
        .checked_sub(credited)
        .ok_or(MathError::InconsistentTotals)?;

    Ok(SettlementResult {
        pots,
        forfeited_pot,
        credits,
        dust,
    })
}

fn validate_unique_owners(positions: &[SettlementInput]) -> MathResult<()> {
    for (index, position) in positions.iter().enumerate() {
        for duplicate in &positions[index + 1..] {
            if position.user_key != duplicate.user_key {
                continue;
            }
            return if position.side == duplicate.side {
                Err(MathError::DuplicateOwner)
            } else {
                Err(MathError::OppositeSide)
            };
        }
    }
    Ok(())
}

fn checked_amount_sum(mut values: impl Iterator<Item = u64>) -> MathResult<u64> {
    values.try_fold(0u64, |total, value| {
        total.checked_add(value).ok_or(MathError::Overflow)
    })
}

fn mul_div_floor(value: u64, multiplier: u64, divisor: u64) -> MathResult<u64> {
    if divisor == 0 {
        return Err(MathError::InvalidRatio);
    }
    let result = u128::from(value)
        .checked_mul(u128::from(multiplier))
        .ok_or(MathError::Overflow)?
        / u128::from(divisor);
    u64::try_from(result).map_err(|_| MathError::Overflow)
}
