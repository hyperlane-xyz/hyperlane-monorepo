//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

// #![deny(warnings)] // FIXME
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

mod accounts;
mod error;
mod instruction;
mod metadata;
mod multisig;

use hyperlane_core::{Checkpoint, HyperlaneMessage, Decode};

// use hyperlane_sealevel_mailbox::instruction::IsmInstruction;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    // msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    program::{invoke_signed, set_return_data},
    sysvar::rent::Rent,
};

use crate::{
    accounts::{
        DomainData,
        DomainDataAccount,
    },
    error::Error,
    instruction::{
        Instruction,
        Domained,
        ValidatorsAndThreshold,
    },
    metadata::MultisigIsmMessageIdMetadata,
    multisig::MultisigIsm,
};

use borsh::BorshSerialize;

// FIXME Read these in at compile time? And don't use harcoded test keys.
// TODO this needs changing
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[macro_export]
macro_rules! validators_and_threshold_pda_seeds {
    ($domain:expr) => {{
        &[b"hyperlane_multisig_ism_message_id", b"-", &$domain.to_le_bytes(), b"-", b"validators_and_threshold"]
    }};

    ($domain:expr, $bump_seed:expr) => {{
        &[b"hyperlane_multisig_ism_message_id", b"-", &$domain.to_le_bytes(), b"-", b"validators_and_threshold", &[$bump_seed]]
    }};
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match Instruction::try_from(instruction_data)? {
        Instruction::IsmVerify(ism_verify) => verify(
            program_id,
            accounts,
            ism_verify.metadata,
            ism_verify.message,
        ),
        Instruction::IsmType => {
            // TODO
            Ok(())
        },
        Instruction::GetValidatorsAndThreshold(domain) => get_validators_and_threshold(program_id, accounts, domain),
        Instruction::SetValidatorsAndThreshold(config) => set_validators_and_threshold(program_id, accounts, config),
        
        // _ => {
        //     Ok(())
        // }
    }
}

/// Set the validators and threshold for a given domain.
///
/// Accounts:
/// 0. `[signer]` The owner of this program and payer of the domain PDA.
/// 1. `[executable]` This program.
/// 2. `[executable]` The system program.
/// 3. `[writable]` The PDA relating to the provided domain.
fn set_validators_and_threshold(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: Domained<ValidatorsAndThreshold>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The owner of this program.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: This program.
    let self_account = next_account_info(accounts_iter)?;
    if *self_account.key != id() || !self_account.executable {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Ensure the owner account is the owner of this program.
    if owner_account.key != self_account.owner {
        return Err(Error::AccountNotOwner.into());
    }

    // Account 2: System program.
    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: The PDA relating to the provided domain.
    let domain_pda_account = next_account_info(accounts_iter)?;

    let domain_pda_size: usize = 1024;

    let domain_data = DomainDataAccount::fetch_data(
        &mut &domain_pda_account.data.borrow_mut()[..]
    )?;

    let bump_seed = match domain_data {
        Some(domain_data) => {
            // The PDA account exists already, we need to confirm the key of the domain_pda_account
            // is the PDA with the stored bump seed.
            let domain_pda_key = Pubkey::create_program_address(
                validators_and_threshold_pda_seeds!(config.domain, domain_data.bump_seed),
                program_id,
            )?;
            // This check validates that the provided domain_pda_account is valid
            if *domain_pda_account.key != domain_pda_key {
                return Err(Error::AccountOutOfOrder.into());
            }
            // Extra sanity check that the owner of the PDA account is this program
            if *domain_pda_account.owner != id() {
                return Err(Error::ProgramIdNotOwner.into());
            }

            domain_data.bump_seed
        },
        None => {
            // Create the domain PDA account if it doesn't exist.

            // First find the key and bump seed for the domain PDA, and ensure
            // it matches the provided account.
            let (domain_pda_key, domain_pda_bump) = Pubkey::find_program_address(
                validators_and_threshold_pda_seeds!(config.domain),
                program_id,
            );
            if *domain_pda_account.key != domain_pda_key {
                return Err(Error::AccountOutOfOrder.into());
            }

            // Create the domain PDA account.
            invoke_signed(
                &system_instruction::create_account(
                    owner_account.key,
                    domain_pda_account.key,
                    Rent::default().minimum_balance(domain_pda_size),
                    domain_pda_size as u64,
                    program_id,
                ),
                &[
                    owner_account.clone(),
                    domain_pda_account.clone(),
                ],
                &[validators_and_threshold_pda_seeds!(config.domain, domain_pda_bump)],
            )?;

            domain_pda_bump
        }
    };

    // Now store the new domain data according to the config:
    DomainDataAccount::from(DomainData {
        bump_seed,
        validators_and_threshold: config.data,
    }).store(domain_pda_account, true)?;

    Ok(())
}

fn get_validators_and_threshold(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> ProgramResult {
    let validators_and_threshold = validators_and_threshold(
        program_id,
        accounts,
        domain,
    )?;
    set_return_data(
        &validators_and_threshold.try_to_vec().map_err(|err| ProgramError::BorshIoError(err.to_string()))?,
    );
    Ok(())
}

/// Set the validators and threshold for a given domain.
///
/// Accounts:
/// 0. `[]` The PDA relating to the provided domain.
fn validators_and_threshold(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> Result<ValidatorsAndThreshold, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The PDA relating to the provided domain.
    let domain_pda_account = next_account_info(accounts_iter)?;
    if *domain_pda_account.owner != id() {
        return Err(Error::ProgramIdNotOwner.into());
    }

    let domain_data = DomainDataAccount::fetch_data(
        &mut &domain_pda_account.data.borrow_mut()[..]
    )?.ok_or(Error::AccountNotInitialized)?;

    let domain_pda_key = Pubkey::create_program_address(
        validators_and_threshold_pda_seeds!(domain, domain_data.bump_seed),
        program_id,
    )?;
    // This check validates that the provided domain_pda_account is valid
    if *domain_pda_account.key != domain_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(domain_data.validators_and_threshold)
}

fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> ProgramResult {
    let metadata = MultisigIsmMessageIdMetadata::try_from(metadata_bytes)?;
    let message = HyperlaneMessage::read_from(&mut &message_bytes[..]).map_err(|_| ProgramError::InvalidArgument)?;

    let validators_and_threshold = validators_and_threshold(
        program_id,
        accounts,
        message.origin,
    )?;

    let multisig_ism = MultisigIsm::new(
        Checkpoint {
            mailbox_address: metadata.origin_mailbox,
            mailbox_domain: message.origin,
            root: metadata.merkle_root,
            index: message.nonce,
            message_id: message.id(),
        },
        metadata.validator_signatures,
        validators_and_threshold.validators,
        validators_and_threshold.threshold,
    );

    multisig_ism.verify().map_err(|err| Into::<Error>::into(err).into())
}
