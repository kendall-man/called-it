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
    verify_threshold_signatures_for_set(
        oracle_set,
        instructions_sysvar,
        message,
        now,
        issued_at,
        expires_at,
    )
}

fn verify_threshold_signatures_for_set(
    oracle_set: &OracleSet,
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
    use anchor_lang::solana_program::sysvar::instructions::{
        construct_instructions_data, store_current_index, BorrowedInstruction,
    };

    fn ed25519_data(public_key: [u8; 32], message: &[u8]) -> Vec<u8> {
        let public_key_offset = ED25519_HEADER_BYTES;
        let signature_offset = public_key_offset + ED25519_PUBLIC_KEY_BYTES;
        let message_offset = signature_offset + ED25519_SIGNATURE_BYTES;
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
        data
    }

    fn oracle_set(signers: [[u8; 32]; ORACLE_SIGNER_COUNT_V1]) -> OracleSet {
        OracleSet {
            version: SCHEMA_VERSION_V1,
            bump: 1,
            epoch: 7,
            signers: signers.into_iter().map(Pubkey::new_from_array).collect(),
            threshold: ORACLE_THRESHOLD_V1,
            activation_slot: 1,
            retirement_slot: None,
        }
    }

    fn with_instruction_sysvar<T>(data: &[Vec<u8>], callback: impl FnOnce(&AccountInfo) -> T) -> T {
        let borrowed: Vec<_> = data
            .iter()
            .map(|instruction_data| BorrowedInstruction {
                program_id: &ed25519_program::ID,
                accounts: Vec::new(),
                data: instruction_data,
            })
            .collect();
        let mut sysvar_data = construct_instructions_data(&borrowed);
        store_current_index(&mut sysvar_data, data.len() as u16);
        let key = anchor_lang::solana_program::sysvar::instructions::ID;
        let owner = anchor_lang::solana_program::sysvar::ID;
        let mut lamports = 0;
        let account = AccountInfo::new(
            &key,
            false,
            false,
            &mut lamports,
            &mut sysvar_data,
            &owner,
            false,
            0,
        );
        callback(&account)
    }

    #[test]
    fn parses_only_self_contained_single_signature_instructions() {
        let message = b"calledit-message";
        let public_key = [7u8; 32];
        let data = ed25519_data(public_key, message);

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

    #[test]
    fn threshold_requires_two_unique_pinned_signers() {
        let message = b"canonical-settlement";
        let signers = [[1; 32], [2; 32], [3; 32]];
        let oracle_set = oracle_set(signers);
        let unique = [
            ed25519_data(signers[0], message),
            ed25519_data(signers[1], message),
        ];
        with_instruction_sysvar(&unique, |sysvar| {
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 15, 10, 20,)
                    .is_ok()
            );
        });

        let duplicate = [
            ed25519_data(signers[0], message),
            ed25519_data(signers[0], message),
        ];
        with_instruction_sysvar(&duplicate, |sysvar| {
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 15, 10, 20,)
                    .is_err()
            );
        });
    }

    #[test]
    fn threshold_rejects_wrong_message_outsiders_and_expiry_boundaries() {
        let message = b"canonical-settlement";
        let signers = [[1; 32], [2; 32], [3; 32]];
        let oracle_set = oracle_set(signers);
        let wrong_message = [
            ed25519_data(signers[0], b"wrong-domain"),
            ed25519_data(signers[1], b"wrong-domain"),
        ];
        with_instruction_sysvar(&wrong_message, |sysvar| {
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 15, 10, 20,)
                    .is_err()
            );
        });

        let outsider = [
            ed25519_data([8; 32], message),
            ed25519_data(signers[0], message),
        ];
        with_instruction_sysvar(&outsider, |sysvar| {
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 15, 10, 20,)
                    .is_err()
            );
        });

        let valid = [
            ed25519_data(signers[0], message),
            ed25519_data(signers[1], message),
        ];
        with_instruction_sysvar(&valid, |sysvar| {
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 20, 10, 20,)
                    .is_ok()
            );
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 21, 10, 20,)
                    .is_err()
            );
            assert!(
                verify_threshold_signatures_for_set(&oracle_set, sysvar, message, 9, 10, 20,)
                    .is_err()
            );
        });
    }
}
