use anchor_lang::{
    prelude::*,
    solana_program::{
        ed25519_program,
        sysvar::instructions::{load_current_index_checked, load_instruction_at_checked},
    },
};

use crate::{
    constants::{ORACLE_SET_SEED, ORACLE_SIGNER_COUNT_V1, ORACLE_THRESHOLD_V1, SCHEMA_VERSION_V1},
    errors::EscrowError,
    state::OracleSet,
};

const ED25519_HEADER_BYTES: usize = 16;
const ED25519_SIGNATURE_BYTES: usize = 64;
const ED25519_PUBLIC_KEY_BYTES: usize = 32;
const SELF_INSTRUCTION_INDEX: u16 = u16::MAX;

pub(crate) fn validate_pinned_oracle_set(
    oracle_set: &Account<OracleSet>,
    expected_epoch: u64,
) -> Result<()> {
    let (expected_key, expected_bump) = Pubkey::find_program_address(
        &[ORACLE_SET_SEED, &expected_epoch.to_le_bytes()],
        &crate::ID,
    );
    require_keys_eq!(
        oracle_set.key(),
        expected_key,
        EscrowError::InvalidOracleSet
    );
    require!(
        oracle_set.version == SCHEMA_VERSION_V1
            && oracle_set.bump == expected_bump
            && oracle_set.epoch == expected_epoch
            && oracle_set.signers.len() == ORACLE_SIGNER_COUNT_V1
            && oracle_set.threshold == ORACLE_THRESHOLD_V1,
        EscrowError::InvalidOracleSet
    );
    Ok(())
}

pub(crate) fn verify_threshold_signatures(
    oracle_set: &Account<OracleSet>,
    instructions_sysvar: &AccountInfo,
    message: &[u8],
    now: i64,
    issued_at: i64,
    expires_at: i64,
) -> Result<()> {
    require!(issued_at <= now, EscrowError::AttestationExpired);
    require!(now <= expires_at, EscrowError::AttestationExpired);
    require!(expires_at > issued_at, EscrowError::AttestationExpired);

    let current_index = usize::from(load_current_index_checked(instructions_sysvar)?);
    let mut matched = [false; ORACLE_SIGNER_COUNT_V1];
    let mut matched_count = 0usize;

    for index in 0..current_index {
        let instruction = load_instruction_at_checked(index, instructions_sysvar)?;
        if instruction.program_id != ed25519_program::ID {
            continue;
        }
        let public_key = parse_verified_ed25519_instruction(&instruction.data, message)?;
        let Some(signer_index) = oracle_set
            .signers
            .iter()
            .position(|signer| signer.to_bytes() == public_key)
        else {
            continue;
        };
        if !matched[signer_index] {
            matched[signer_index] = true;
            matched_count = matched_count
                .checked_add(1)
                .ok_or(EscrowError::ArithmeticOverflow)?;
        }
    }

    require!(
        matched_count >= usize::from(oracle_set.threshold),
        EscrowError::SignatureThresholdNotMet
    );
    Ok(())
}

fn parse_verified_ed25519_instruction(data: &[u8], expected_message: &[u8]) -> Result<[u8; 32]> {
    require!(
        data.len() >= ED25519_HEADER_BYTES && data[0] == 1 && data[1] == 0,
        EscrowError::InvalidEd25519Instruction
    );

    let signature_offset = usize::from(read_u16(data, 2)?);
    let signature_instruction_index = read_u16(data, 4)?;
    let public_key_offset = usize::from(read_u16(data, 6)?);
    let public_key_instruction_index = read_u16(data, 8)?;
    let message_offset = usize::from(read_u16(data, 10)?);
    let message_size = usize::from(read_u16(data, 12)?);
    let message_instruction_index = read_u16(data, 14)?;

    require!(
        signature_instruction_index == SELF_INSTRUCTION_INDEX
            && public_key_instruction_index == SELF_INSTRUCTION_INDEX
            && message_instruction_index == SELF_INSTRUCTION_INDEX,
        EscrowError::InvalidEd25519Instruction
    );
    checked_slice(data, signature_offset, ED25519_SIGNATURE_BYTES)?;
    let public_key = checked_slice(data, public_key_offset, ED25519_PUBLIC_KEY_BYTES)?;
    let message = checked_slice(data, message_offset, message_size)?;
    require!(
        message == expected_message,
        EscrowError::InvalidAttestationDomain
    );

    public_key
        .try_into()
        .map_err(|_| error!(EscrowError::InvalidEd25519Instruction))
}

fn read_u16(data: &[u8], offset: usize) -> Result<u16> {
    let bytes: [u8; 2] = checked_slice(data, offset, 2)?
        .try_into()
        .map_err(|_| error!(EscrowError::InvalidEd25519Instruction))?;
    Ok(u16::from_le_bytes(bytes))
}

fn checked_slice(data: &[u8], offset: usize, length: usize) -> Result<&[u8]> {
    let end = offset
        .checked_add(length)
        .ok_or(EscrowError::InvalidEd25519Instruction)?;
    data.get(offset..end)
        .ok_or_else(|| error!(EscrowError::InvalidEd25519Instruction))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_only_self_contained_single_signature_instructions() {
        let message = b"calledit-message";
        let public_key = [7u8; 32];
        let public_key_offset = ED25519_HEADER_BYTES;
        let signature_offset = public_key_offset + ED25519_PUBLIC_KEY_BYTES;
        let message_offset = public_key_offset + ED25519_PUBLIC_KEY_BYTES;
        let message_offset = message_offset + ED25519_SIGNATURE_BYTES;
        let mut data = vec![1, 0];
        for value in [
            signature_offset as u16,
            SELF_INSTRUCTION_INDEX,
            public_key_offset as u16,
            SELF_INSTRUCTION_INDEX,
            message_offset as u16,
            message.len() as u16,
            SELF_INSTRUCTION_INDEX,
        ] {
            data.extend_from_slice(&value.to_le_bytes());
        }
        data.extend_from_slice(&public_key);
        data.extend_from_slice(&[9; ED25519_SIGNATURE_BYTES]);
        data.extend_from_slice(message);

        assert_eq!(
            parse_verified_ed25519_instruction(&data, message).unwrap(),
            public_key
        );
        assert!(parse_verified_ed25519_instruction(&data, b"other").is_err());

        let mut cross_instruction = data.clone();
        cross_instruction[4..6].copy_from_slice(&0u16.to_le_bytes());
        assert!(parse_verified_ed25519_instruction(&cross_instruction, message).is_err());

        let mut multiple_signatures = data;
        multiple_signatures[0] = 2;
        assert!(parse_verified_ed25519_instruction(&multiple_signatures, message).is_err());
    }
}
