use hyperlane_core::{Checkpoint, Decode, HyperlaneMessage, IsmType};

// use hyperlane_sealevel_mailbox::instruction::IsmInstruction;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    program::{invoke_signed, set_return_data},
    // msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::rent::Rent,
};

use crate::{
    accounts::{DomainData, DomainDataAccount},
    error::Error,
    instruction::{Domained, Instruction, ValidatorsAndThreshold},
    metadata::MultisigIsmMessageIdMetadata,
    multisig::MultisigIsm,
};

use borsh::BorshSerialize;

const ISM_TYPE: IsmType = IsmType::MessageIdMultisig;

// FIXME Read these in at compile time? And don't use harcoded test keys.
// TODO this needs changing
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[macro_export]
macro_rules! domain_data_pda_seeds {
    ($domain:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            &$domain.to_le_bytes(),
            b"-",
            b"domain_data",
        ]
    }};

    ($domain:expr, $bump_seed:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            &$domain.to_le_bytes(),
            b"-",
            b"domain_data",
            &[$bump_seed],
        ]
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
            set_return_data(
                &ISM_TYPE
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
            );
            Ok(())
        }
        Instruction::GetValidatorsAndThreshold(domain) => {
            get_validators_and_threshold(program_id, accounts, domain)
        }
        Instruction::SetValidatorsAndThreshold(config) => {
            set_validators_and_threshold(program_id, accounts, config)
        }
    }
}

/// Verifies a message has been signed by at least the configured threshold of the
/// configured validators for the message's origin domain.
///
/// Accounts:
/// 0. `[]` The PDA relating to the message's origin domain.
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> ProgramResult {
    let metadata = MultisigIsmMessageIdMetadata::try_from(metadata_bytes)?;
    let message = HyperlaneMessage::read_from(&mut &message_bytes[..])
        .map_err(|_| ProgramError::InvalidArgument)?;

    let validators_and_threshold = validators_and_threshold(program_id, accounts, message.origin)?;

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

    multisig_ism
        .verify()
        .map_err(|err| Into::<Error>::into(err).into())
}

/// Gets the validators and threshold for a given domain, and returns it as return data.
/// Intended to be used by instructions querying the validators and threshold.
///
/// Accounts:
/// 0. `[]` The PDA relating to the provided domain.
fn get_validators_and_threshold(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> ProgramResult {
    let validators_and_threshold = validators_and_threshold(program_id, accounts, domain)?;
    set_return_data(
        &validators_and_threshold
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?,
    );
    Ok(())
}

/// Gets the validators and threshold for a given domain.
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

    let domain_data =
        DomainDataAccount::fetch_data(&mut &domain_pda_account.data.borrow_mut()[..])?
            .ok_or(Error::AccountNotInitialized)?;

    let domain_pda_key = Pubkey::create_program_address(
        domain_data_pda_seeds!(domain, domain_data.bump_seed),
        program_id,
    )?;
    // This check validates that the provided domain_pda_account is valid
    if *domain_pda_account.key != domain_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(domain_data.validators_and_threshold)
}

/// Set the validators and threshold for a given domain.
///
/// Accounts:
/// 0. `[signer]` The owner of this program and payer of the domain PDA.
/// 1. `[executable]` This program.
/// 2. `[writable]` The PDA relating to the provided domain.
fn set_validators_and_threshold(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: Domained<ValidatorsAndThreshold>,
) -> ProgramResult {
    // Validate the provided validators and threshold.
    config.data.validate()?;

    let accounts_iter = &mut accounts.iter();

    // Account 0: The owner of this program.
    // This is verified as correct further below.
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

    // Account 2: The PDA relating to the provided domain.
    let domain_pda_account = next_account_info(accounts_iter)?;

    let domain_data =
        DomainDataAccount::fetch_data(&mut &domain_pda_account.data.borrow_mut()[..])?;

    println!("domain_data {:?} domain_pda_account {:?}", domain_data, domain_pda_account);

    let bump_seed = match domain_data {
        Some(domain_data) => {
            // The PDA account exists already, we need to confirm the key of the domain_pda_account
            // is the PDA with the stored bump seed.
            let domain_pda_key = Pubkey::create_program_address(
                domain_data_pda_seeds!(config.domain, domain_data.bump_seed),
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
        }
        None => {
            // Create the domain PDA account if it doesn't exist.

            // This is the initial size - because reallocations are allowed
            // in the `store` call further below, it's possible that the
            // size will be increased.
            let domain_pda_size: usize = 1024;

            // First find the key and bump seed for the domain PDA, and ensure
            // it matches the provided account.
            let (domain_pda_key, domain_pda_bump) = Pubkey::find_program_address(
                domain_data_pda_seeds!(config.domain),
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
                &[owner_account.clone(), domain_pda_account.clone()],
                &[domain_data_pda_seeds!(
                    config.domain,
                    domain_pda_bump
                )],
            )?;

            domain_pda_bump
        }
    };

    // Now store the new domain data according to the config:
    DomainDataAccount::from(DomainData {
        bump_seed,
        validators_and_threshold: config.data,
    })
    .store(domain_pda_account, true)?;

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    use solana_program::stake_history::Epoch;
    use hyperlane_core::H160;

    use std::borrow::BorrowMut;


    #[test]
    fn set_validators_and_threshold_already_initialized() {
        let program_id = id();

        let domain = 1234u32;

        let (domain_pda_key, domain_pda_bump_seed) = Pubkey::find_program_address(
            domain_data_pda_seeds!(domain),
            &program_id,
        );

        let mut domain_account_lamports = 0;
        let mut domain_account_data = vec![0_u8; 2048];
        let domain_pda_account = AccountInfo::new(
            // Public key of the account
            &domain_pda_key,
            // Was the transaction signed by this account's public key?
            false,
            // Is the account writable?
            true,
            // The lamports in the account. Modifiable by programs.
            &mut domain_account_lamports,
            // The data held in this account. Modifiable by programs.
            &mut domain_account_data,
            // Program that owns this account.
            &program_id,
            // This account's data contains a loaded program (and is now read-only).
            false,
            // The epoch at which this account will next owe rent.
            Epoch::default(),
        );
        {
            let init_data = DomainData {
                bump_seed: domain_pda_bump_seed,
                validators_and_threshold: ValidatorsAndThreshold {
                    validators: vec![H160::random()],
                    threshold: 1,
                },
            };
            DomainDataAccount::from(init_data)
                .store(&domain_pda_account, false)
                .unwrap();
        }

        println!("yooo {:?} {:?}", domain_pda_account, domain_pda_account.data);

        let owner_key = Pubkey::new_unique();
        let mut owner_account_lamports = 0;
        let mut owner_account_data = vec![];
        let system_program_id = solana_program::system_program::id();
        let owner_account = AccountInfo::new(
            // Public key of the account
            &owner_key,
            // Was the transaction signed by this account's public key?
            true,
            // Is the account writable?
            false,
            // The lamports in the account. Modifiable by programs.
            &mut owner_account_lamports,
            // The data held in this account. Modifiable by programs.
            &mut owner_account_data,
            // Program that owns this account.
            &system_program_id,
            // This account's data contains a loaded program (and is now read-only).
            false,
            // The epoch at which this account will next owe rent.
            Epoch::default(),
        );

        let mut program_lamports = 0;
        let mut program_data = vec![];
        let program_account = AccountInfo::new(
            // Public key of the account
            &program_id,
            // Was the transaction signed by this account's public key?
            false,
            // Is the account writable?
            false,
            // The lamports in the account. Modifiable by programs.
            &mut program_lamports,
            // The data held in this account. Modifiable by programs.
            &mut program_data,
            // Owner of this account.
            &owner_key,
            // This account's data contains a loaded program (and is now read-only).
            true,
            // The epoch at which this account will next owe rent.
            Epoch::default(),
        );

        println!("domain_account_data before {:?}", domain_pda_account.data.borrow());

        let config = Domained {
            domain,
            data: ValidatorsAndThreshold {
                validators: vec![H160::random(), H160::random()],
                threshold: 2,
            },
        };

        let accounts = vec![owner_account, program_account, domain_pda_account];

        // set_validators_and_threshold(&program_id, &[owner_account, program_account, domain_pda_account.clone()], config.clone())
        //     .unwrap();
        set_validators_and_threshold(&program_id, &accounts, config.clone())
            .unwrap();

        // println!("domain_account_data after {:?}", domain_account_data);
        println!("domain_pda_account.data after {:?}", accounts[2].data.borrow());
// &mut &accounts[0].data.borrow_mut()[..]
        let domain_data = DomainDataAccount::fetch_data(&mut &accounts[2].data.borrow_mut()[..]).unwrap().unwrap();
        assert_eq!(domain_data, Box::new(DomainData {
            bump_seed: domain_pda_bump_seed,
            validators_and_threshold: config.data,
        }));
    }
}
