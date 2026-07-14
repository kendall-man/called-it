use anchor_lang::prelude::*;

pub mod constants;
pub mod encoding;
pub mod errors;
pub mod events;
pub mod instructions;
pub mod math;
pub mod state;

declare_id!("7rfzH5Wvo7YjCavDqNu7c18671xSBguZYTkRrn98uq7q");

// Value-moving handlers are intentionally introduced in Wave 2. Keeping the
// program module empty in this foundation wave still produces a valid Anchor
// entrypoint and IDL while the account and math contracts are frozen first.
#[program]
pub mod calledit_escrow {}
