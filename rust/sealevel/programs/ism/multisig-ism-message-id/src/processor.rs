use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Decode, HyperlaneMessage, ModuleType};

use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::{
    accounts::{AccessControlAccount, AccessControlData, DomainData, DomainDataAccount},
    error::Error,
    instruction::{Domained, Instruction, ValidatorsAndThreshold},
    metadata::MultisigIsmMessageIdMetadata,
};

use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use multisig_ism::{interface::MultisigIsmInstruction, multisig::MultisigIsm};

use borsh::BorshSerialize;

const ISM_TYPE: ModuleType = ModuleType::MessageIdMultisig;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// PDA seeds relating to the access control PDA account.
#[macro_export]
macro_rules! access_control_pda_seeds {
    () => {{
        &[b"multisig_ism_message_id", b"-", b"access_control"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"multisig_ism_message_id",
            b"-",
            b"access_control",
            &[$bump_seed],
        ]
    }};
}

/// PDA seeds relating to a domain data PDA account.
/// A distinct account exists for each domain.
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
    // First, try to decode the instruction as an interchain security module
    // interface supported function based off the discriminator.
    if let Ok(ism_instruction) = InterchainSecurityModuleInstruction::decode(instruction_data) {
        return match ism_instruction {
            InterchainSecurityModuleInstruction::Type => {
                set_return_data(
                    &SimulationReturnData::new(ISM_TYPE as u32)
                        .try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
                return Ok(());
            }
            InterchainSecurityModuleInstruction::Verify(verify_data) => verify(
                program_id,
                accounts,
                verify_data.metadata,
                verify_data.message,
            ),
            InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_data) => {
                let account_metas = verify_account_metas(
                    program_id,
                    accounts,
                    verify_data.metadata,
                    verify_data.message,
                )?;
                // Wrap it in the SimulationReturnData because serialized account_metas
                // may end with zero byte(s), which are incorrectly truncated as
                // simulated transaction return data.
                // See `SimulationReturnData` for details.
                let bytes = SimulationReturnData::new(account_metas)
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    // Next, try to decode the instruction as a multisig ISM instruction.
    if let Ok(multisig_ism_instruction) = MultisigIsmInstruction::decode(instruction_data) {
        return match multisig_ism_instruction {
            // Gets the validators and threshold to verify the provided message.
            //
            // Accounts passed into this must be those returned by the
            // ValidatorsAndThresholdAccountMetas instruction.
            MultisigIsmInstruction::ValidatorsAndThreshold(message_bytes) => {
                let message = HyperlaneMessage::read_from(&mut &message_bytes[..])
                    .map_err(|_| ProgramError::InvalidArgument)?;
                // No need to wrap in SimulationReturnData because the threshold
                // should always be the last serialized byte and non-zero.
                get_validators_and_threshold(program_id, accounts, message.origin)
            }
            MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message_bytes) => {
                let message = HyperlaneMessage::read_from(&mut &message_bytes[..])
                    .map_err(|_| ProgramError::InvalidArgument)?;
                let account_metas = get_validators_and_threshold_account_metas(
                    program_id,
                    accounts,
                    message.origin,
                )?;
                // Wrap it in the SimulationReturnData because serialized account_metas
                // may end with zero byte(s), which are incorrectly truncated as
                // simulated transaction return data.
                // See `SimulationReturnData` for details.
                let bytes = SimulationReturnData::new(account_metas)
                    .try_to_vec()
                    .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    match Instruction::decode(instruction_data)? {
        // Initializes the program.
        Instruction::Initialize => initialize(program_id, accounts),
        // Sets the validators and threshold for a given domain.
        Instruction::SetValidatorsAndThreshold(config) => {
            set_validators_and_threshold(program_id, accounts, config)
        }
        // Gets the owner of this program from the access control account.
        Instruction::GetOwner => get_owner(program_id, accounts),
        // Sets the owner of this program in the access control account.
        Instruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Initializes the program, creating the access control PDA account.
///
/// Accounts:
/// 0. `[signer]` The new owner and payer of the access control PDA.
/// 1. `[writable]` The access control PDA account.
/// 2. `[executable]` The system program account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The new owner of this program and payer of the access control PDA.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: The access control PDA account.
    let access_control_pda_account = next_account_info(accounts_iter)?;
    let (access_control_pda_key, access_control_pda_bump_seed) =
        Pubkey::find_program_address(access_control_pda_seeds!(), program_id);
    if *access_control_pda_account.key != access_control_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    // Ensure the access control PDA account isn't already initialized.
    if let Ok(Some(_)) =
        AccessControlAccount::fetch_data(&mut &access_control_pda_account.data.borrow()[..])
    {
        return Err(Error::AlreadyInitialized.into());
    }

    // Account 2: The system program account.
    let system_program_account = next_account_info(accounts_iter)?;
    if !solana_program::system_program::check_id(system_program_account.key) {
        return Err(Error::AccountOutOfOrder.into());
    }

    // Create the access control PDA account.
    let access_control_account = AccessControlAccount::from(AccessControlData {
        bump_seed: access_control_pda_bump_seed,
        owner: Some(*owner_account.key),
    });
    let access_control_account_data_size = access_control_account.size();
    create_pda_account(
        owner_account,
        &Rent::get()?,
        access_control_account_data_size,
        program_id,
        system_program_account,
        access_control_pda_account,
        access_control_pda_seeds!(access_control_pda_bump_seed),
    )?;

    // Store the access control data.
    access_control_account.store(access_control_pda_account, false)?;

    Ok(())
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
        CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: metadata.origin_merkle_tree_hook,
                mailbox_domain: message.origin,
                root: metadata.merkle_root,
                index: metadata.merkle_index,
                block_height: 0, // We can put 0 here since this field is not signed
            },
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

/// Gets the list of AccountMetas required by the `Verify` instruction.
///
/// Accounts:
/// 0. `[]` This program's PDA relating to the seeds VERIFY_ACCOUNT_METAS_PDA_SEEDS.
///         Note this is not actually used / required in this implementation.
fn verify_account_metas(
    program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let message = HyperlaneMessage::read_from(&mut &message_bytes[..])
        .map_err(|_| ProgramError::InvalidArgument)?;
    let (domain_pda_key, _) =
        Pubkey::find_program_address(domain_data_pda_seeds!(message.origin), program_id);

    Ok(vec![AccountMeta::new_readonly(domain_pda_key, false).into()])
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
    // Wrap it in the SimulationReturnData because serialized validators_and_threshold
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(validators_and_threshold)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Returns a list of account metas that are required for a call to `get_validators_and_threshold`,
/// which is called by the MultisigIsmInstruction::ValidatorsAndThreshold instruction.
///
/// Accounts:
/// 0. `[]` This program's PDA relating to the seeds VALIDATORS_AND_THRESHOLD_ACCOUNT_METAS_PDA_SEEDS.
///         Note this is not actually used / required in this implementation.
fn get_validators_and_threshold_account_metas(
    program_id: &Pubkey,
    _accounts: &[AccountInfo],
    domain: u32,
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let (domain_pda_key, _) =
        Pubkey::find_program_address(domain_data_pda_seeds!(domain), program_id);

    Ok(vec![AccountMeta::new_readonly(domain_pda_key, false).into()])
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
    if domain_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }

    let domain_data = DomainDataAccount::fetch_data(&mut &domain_pda_account.data.borrow()[..])?
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
/// 0. `[signer]` The access control owner and payer of the domain PDA.
/// 1. `[]` The access control PDA account.
/// 2. `[writable]` The PDA relating to the provided domain.
/// 3. `[executable]` OPTIONAL - The system program account. Required if creating the domain PDA.
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

    // Account 1: The access control PDA account.
    let access_control_pda_account = next_account_info(accounts_iter)?;
    let access_control_data = access_control_data(program_id, access_control_pda_account)?;
    // Ensure the owner account is the owner of this program.
    access_control_data.ensure_owner_signer(owner_account)?;

    // Account 2: The PDA relating to the provided domain.
    let domain_pda_account = next_account_info(accounts_iter)?;

    let domain_data = DomainDataAccount::fetch_data(&mut &domain_pda_account.data.borrow()[..]);

    let bump_seed = match domain_data {
        Ok(Some(domain_data)) => {
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
            if domain_pda_account.owner != program_id {
                return Err(Error::ProgramIdNotOwner.into());
            }

            domain_data.bump_seed
        }
        Ok(None) | Err(_) => {
            // Create the domain PDA account if it doesn't exist.

            // This is the initial size - because reallocations are allowed
            // in the `store` call further below, it's possible that the
            // size will be increased.
            let domain_pda_size: usize = 1024;

            // First find the key and bump seed for the domain PDA, and ensure
            // it matches the provided account.
            let (domain_pda_key, domain_pda_bump) =
                Pubkey::find_program_address(domain_data_pda_seeds!(config.domain), program_id);
            if *domain_pda_account.key != domain_pda_key {
                return Err(Error::AccountOutOfOrder.into());
            }

            // Account 3: The system program account.
            let system_program_account = next_account_info(accounts_iter)?;
            if !solana_program::system_program::check_id(system_program_account.key) {
                return Err(Error::AccountOutOfOrder.into());
            }

            // Create the domain PDA account.
            create_pda_account(
                owner_account,
                &Rent::get()?,
                domain_pda_size,
                program_id,
                system_program_account,
                domain_pda_account,
                domain_data_pda_seeds!(config.domain, domain_pda_bump),
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

/// Gets the owner of this program from the access control account, and returns it as return data.
/// Intended to be used by instructions querying the owner.
///
/// Accounts:
/// 0. `[]` The access control PDA account.
fn get_owner(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The access control PDA account.
    let access_control_pda_account = next_account_info(accounts_iter)?;

    let access_control_data = access_control_data(program_id, access_control_pda_account)?;

    // Wrap it in the SimulationReturnData because serialized `access_control_data.owner`
    // may end with zero byte(s), which are incorrectly truncated as
    // simulated transaction return data.
    // See `SimulationReturnData` for details.
    let bytes = SimulationReturnData::new(access_control_data.owner)
        .try_to_vec()
        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Gets the access control data of this program.
/// Returns an Err if the provided account isn't the access control PDA.
fn access_control_data(
    program_id: &Pubkey,
    access_control_pda_account: &AccountInfo,
) -> Result<AccessControlData, ProgramError> {
    let access_control_data =
        AccessControlAccount::fetch_data(&mut &access_control_pda_account.data.borrow()[..])?
            .ok_or(Error::AccountNotInitialized)?;
    // Confirm the key of the access_control_pda_account is the correct PDA
    // using the stored bump seed.
    let access_control_pda_key = Pubkey::create_program_address(
        access_control_pda_seeds!(access_control_data.bump_seed),
        program_id,
    )?;
    // This check validates that the provided access_control_pda_account is valid
    if *access_control_pda_account.key != access_control_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }
    // Extra sanity check that the owner of the PDA account is this program
    if access_control_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }

    Ok(*access_control_data)
}

/// Transfers ownership to a new access control owner.
///
/// Accounts:
/// 0. `[signer]` The current access control owner.
/// 1. `[writeable]` The access control PDA account.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The current access control owner.
    // This is verified as correct further below.
    let owner_account = next_account_info(accounts_iter)?;

    // Account 1: The access control PDA account.
    let access_control_pda_account = next_account_info(accounts_iter)?;
    let mut access_control_data = access_control_data(program_id, access_control_pda_account)?;

    // Transfer ownership. This errors if `owner_account` is not a signer or the owner.
    access_control_data.transfer_ownership(owner_account, new_owner)?;

    // Store the new access control owner.
    AccessControlAccount::from(access_control_data).store(access_control_pda_account, false)?;

    Ok(())
}

#[cfg(test)]
pub mod test {
    use super::*;

    use account_utils::DiscriminatorEncode;
    use ecdsa_signature::EcdsaSignature;
    use hyperlane_core::{Encode, HyperlaneMessage, H160};
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction,
    };
    use multisig_ism::test_data::{get_multisig_ism_test_data, MultisigIsmTestData};
    use solana_program::stake_history::Epoch;
    use std::str::FromStr;

    const ORIGIN_DOMAIN: u32 = 1234u32;

    fn id() -> Pubkey {
        Pubkey::from_str("2YjtZDiUoptoSsA5eVrDCcX6wxNK6YoEVW7y82x5Z2fw").unwrap()
    }

    #[test]
    fn test_verify() {
        let program_id = id();

        let (domain_pda_key, domain_pda_bump_seed) =
            Pubkey::find_program_address(domain_data_pda_seeds!(ORIGIN_DOMAIN), &program_id);

        let MultisigIsmTestData {
            message,
            checkpoint,
            validators,
            signatures,
        } = get_multisig_ism_test_data();

        let mut domain_account_lamports = 0;
        let mut domain_account_data = vec![0_u8; 2048];
        let domain_pda_account = AccountInfo::new(
            &domain_pda_key,
            false,
            true,
            &mut domain_account_lamports,
            &mut domain_account_data,
            &program_id,
            false,
            Epoch::default(),
        );
        let init_domain_data = DomainData {
            bump_seed: domain_pda_bump_seed,
            validators_and_threshold: ValidatorsAndThreshold {
                validators,
                threshold: 2,
            },
        };
        DomainDataAccount::from(init_domain_data)
            .store(&domain_pda_account, false)
            .unwrap();

        let message_bytes = message.to_vec();

        // A quorum of signatures in the correct order.
        // Expect no error.
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the InterchainSecurityModuleInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
                    merkle_root: checkpoint.root,
                    merkle_index: checkpoint.index,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                        EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
                    ],
                }
                .to_vec(),
                message: message_bytes.clone(),
            })
            .encode()
            .unwrap()
            .as_slice(),
        );
        assert!(result.is_ok());

        // A quorum of signatures NOT in the correct order.
        // Expect an error.
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the InterchainSecurityModuleInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
                    merkle_root: checkpoint.root,
                    merkle_index: checkpoint.index,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
                        EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                    ],
                }
                .to_vec(),
                message: message_bytes.clone(),
            })
            .encode()
            .unwrap()
            .as_slice(),
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::ThresholdNotMet.into());

        // A quorum valid signatures. Includes one invalid signature.
        // Expect no error.
        let result = process_instruction(
            &program_id,
            &[
                domain_pda_account.clone(),
            ],
            // Use the InterchainSecurityModuleInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
                    merkle_root: checkpoint.root,
                    merkle_index: checkpoint.index,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                        EcdsaSignature::from_bytes(&signatures[2]).unwrap(),
                        // Signature from a non-validator:
                        //   Address: 0xB92752D900573BC114D18e023D81312bBC32e266
                        //   Private Key: 0x2e09250a71f712e5f834285cc60f1d62578360c65a0f4836daa0a5caa27199cf
                        EcdsaSignature::from_bytes(&hex::decode("c75dca903d963f30f169ba99c2554572108474c097bd40c2a29fbcf4739fdb564e795fce8e0ae3b860dfd4e0b3f93420ccb6454e87fa3235c8754a5437a78f781b").unwrap()).unwrap(),
                    ],
                }.to_vec(),
                message: message_bytes,
            }).encode().unwrap().as_slice(),
        );
        assert!(result.is_ok());

        // A quorum of signatures, but the message has a different nonce & therefore ID
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the InterchainSecurityModuleInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
                    merkle_root: checkpoint.root,
                    merkle_index: checkpoint.index,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                        EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
                    ],
                }
                .to_vec(),
                message: HyperlaneMessage {
                    nonce: 420,
                    ..message
                }
                .to_vec(),
            })
            .encode()
            .unwrap()
            .as_slice(),
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::ThresholdNotMet.into());
    }

    #[test]
    fn test_transfer_ownership() {
        let program_id = id();

        let owner_key = Pubkey::new_unique();
        let mut owner_account_lamports = 0;
        let mut owner_account_data = vec![];
        let system_program_id = solana_program::system_program::id();
        let owner_account = AccountInfo::new(
            &owner_key,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let (access_control_pda_key, access_control_pda_bump_seed) =
            Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

        let mut access_control_account_lamports = 0;
        let mut access_control_account_data = vec![0u8; 1024];
        let access_control_pda_account = AccountInfo::new(
            &access_control_pda_key,
            false,
            true,
            &mut access_control_account_lamports,
            &mut access_control_account_data,
            &program_id,
            false,
            Epoch::default(),
        );
        let init_access_control_data = AccessControlData {
            bump_seed: access_control_pda_bump_seed,
            owner: Some(owner_key),
        };
        AccessControlAccount::from(init_access_control_data)
            .store(&access_control_pda_account, false)
            .unwrap();

        let new_owner_key = Pubkey::new_unique();

        let mut accounts = vec![owner_account, access_control_pda_account];

        // First, we test that the owner must sign.

        // Temporarily set the owner account as a non-signer
        accounts[0].is_signer = false;
        let result = process_instruction(
            &program_id,
            &accounts,
            Instruction::TransferOwnership(Some(new_owner_key))
                .encode()
                .unwrap()
                .as_slice(),
        );
        assert_eq!(result, Err(ProgramError::MissingRequiredSignature));
        // Set is_signer back to true
        accounts[0].is_signer = true;

        // Now successfully set ownership to new_owner_key
        process_instruction(
            &program_id,
            &accounts,
            Instruction::TransferOwnership(Some(new_owner_key))
                .encode()
                .unwrap()
                .as_slice(),
        )
        .unwrap();

        let access_control_data =
            AccessControlAccount::fetch_data(&mut &accounts[1].data.borrow()[..])
                .unwrap()
                .unwrap();
        assert_eq!(
            access_control_data,
            Box::new(AccessControlData {
                bump_seed: access_control_pda_bump_seed,
                owner: Some(new_owner_key),
            })
        );

        // And now let's try to set the owner again, but with the old owner signing.
        let result = process_instruction(
            &program_id,
            &accounts,
            Instruction::TransferOwnership(Some(new_owner_key))
                .encode()
                .unwrap()
                .as_slice(),
        );
        assert_eq!(result, Err(ProgramError::InvalidArgument));
    }

    // Only tests the case where a domain data PDA account has already been created.
    // For testing a case where it must be created, see the functional tests.
    #[test]
    fn test_set_validators_and_threshold() {
        let program_id = id();

        let domain = 1234u32;

        let (domain_pda_key, domain_pda_bump_seed) =
            Pubkey::find_program_address(domain_data_pda_seeds!(domain), &program_id);

        let mut domain_account_lamports = 0;
        let mut domain_account_data = vec![0_u8; 2048];
        let domain_pda_account = AccountInfo::new(
            &domain_pda_key,
            false,
            true,
            &mut domain_account_lamports,
            &mut domain_account_data,
            &program_id,
            false,
            Epoch::default(),
        );
        let init_domain_data = DomainData {
            bump_seed: domain_pda_bump_seed,
            validators_and_threshold: ValidatorsAndThreshold {
                validators: vec![H160::random()],
                threshold: 1,
            },
        };
        DomainDataAccount::from(init_domain_data)
            .store(&domain_pda_account, false)
            .unwrap();

        let owner_key = Pubkey::new_unique();
        let mut owner_account_lamports = 0;
        let mut owner_account_data = vec![];
        let system_program_id = solana_program::system_program::id();
        let owner_account = AccountInfo::new(
            &owner_key,
            true,
            false,
            &mut owner_account_lamports,
            &mut owner_account_data,
            &system_program_id,
            false,
            Epoch::default(),
        );

        let (access_control_pda_key, access_control_pda_bump_seed) =
            Pubkey::find_program_address(access_control_pda_seeds!(), &program_id);

        let mut access_control_account_lamports = 0;
        let mut access_control_account_data = vec![0u8; 1024];
        let access_control_pda_account = AccountInfo::new(
            &access_control_pda_key,
            false,
            true,
            &mut access_control_account_lamports,
            &mut access_control_account_data,
            &program_id,
            false,
            Epoch::default(),
        );
        let init_access_control_data = AccessControlData {
            bump_seed: access_control_pda_bump_seed,
            owner: Some(owner_key),
        };
        AccessControlAccount::from(init_access_control_data)
            .store(&access_control_pda_account, false)
            .unwrap();

        let config = Domained {
            domain,
            data: ValidatorsAndThreshold {
                validators: vec![H160::random(), H160::random()],
                threshold: 2,
            },
        };

        let accounts = vec![
            owner_account,
            access_control_pda_account,
            domain_pda_account,
        ];

        set_validators_and_threshold(&program_id, &accounts, config.clone()).unwrap();

        let domain_data =
            DomainDataAccount::fetch_data(&mut &accounts[2].try_borrow_data().unwrap()[..])
                .unwrap()
                .unwrap();
        assert_eq!(
            domain_data,
            Box::new(DomainData {
                bump_seed: domain_pda_bump_seed,
                validators_and_threshold: config.data,
            })
        );
    }
}
