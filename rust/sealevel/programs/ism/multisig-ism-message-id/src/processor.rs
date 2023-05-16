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

use hyperlane_sealevel_mailbox::accounts::SizedData;

use crate::{
    accounts::{AccessControlAccount, AccessControlData, DomainData, DomainDataAccount},
    error::Error,
    instruction::{Domained, Instruction, ValidatorsAndThreshold},
    metadata::MultisigIsmMessageIdMetadata,
};

use multisig_ism::multisig::MultisigIsm;

use borsh::BorshSerialize;

const ISM_TYPE: IsmType = IsmType::MessageIdMultisig;

// FIXME Read these in at compile time? And don't use harcoded test keys.
// TODO this needs changing
solana_program::declare_id!("F6dVnLFioQ8hKszqPsmjWPwHn2dJfebgMfztWrzL548V");

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

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
                &(ISM_TYPE as u32)
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
        Instruction::GetOwner => get_owner(program_id, accounts),
        Instruction::SetOwner(new_owner) => set_owner(program_id, accounts, new_owner),
        Instruction::Initialize => initialize(program_id, accounts),
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
        AccessControlAccount::fetch_data(&mut &access_control_pda_account.data.borrow_mut()[..])
    {
        return Err(Error::AlreadyInitialized.into());
    }

    // Account 2: The system program account.
    let system_program_account = next_account_info(accounts_iter)?;
    if !solana_program::system_program::check_id(system_program_account.key) {
        return Err(Error::AccountOutOfOrder.into());
    }

    // Create the access control PDA account.
    let access_control_account_data_size = AccessControlAccount::size();
    invoke_signed(
        &system_instruction::create_account(
            owner_account.key,
            access_control_pda_account.key,
            Rent::default().minimum_balance(access_control_account_data_size),
            access_control_account_data_size as u64,
            program_id,
        ),
        &[owner_account.clone(), access_control_pda_account.clone()],
        &[access_control_pda_seeds!(access_control_pda_bump_seed)],
    )?;

    // Store the access control data.
    AccessControlAccount::from(AccessControlData {
        bump_seed: access_control_pda_bump_seed,
        owner: *owner_account.key,
    })
    .store(access_control_pda_account, false)?;

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

    let domain_data = DomainDataAccount::fetch_data(&mut &domain_pda_account.data.borrow_mut()[..]);

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
            if *domain_pda_account.owner != id() {
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
            invoke_signed(
                &system_instruction::create_account(
                    owner_account.key,
                    domain_pda_account.key,
                    Rent::default().minimum_balance(domain_pda_size),
                    domain_pda_size as u64,
                    program_id,
                ),
                &[owner_account.clone(), domain_pda_account.clone()],
                &[domain_data_pda_seeds!(config.domain, domain_pda_bump)],
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

    set_return_data(
        &access_control_data
            .owner
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?,
    );
    Ok(())
}

/// Gets the access control data of this program.
/// Returns an Err if the provided account isn't the access control PDA.
fn access_control_data(
    program_id: &Pubkey,
    access_control_pda_account: &AccountInfo,
) -> Result<AccessControlData, ProgramError> {
    let access_control_data =
        AccessControlAccount::fetch_data(&mut &access_control_pda_account.data.borrow_mut()[..])?
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
    if *access_control_pda_account.owner != id() {
        return Err(Error::ProgramIdNotOwner.into());
    }

    Ok(*access_control_data)
}

/// Sets a new access control owner.
///
/// Accounts:
/// 0. `[signer]` The current access control owner.
/// 1. `[]` The access control PDA account.
fn set_owner(program_id: &Pubkey, accounts: &[AccountInfo], new_owner: Pubkey) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: The current access control owner.
    // This is verified as correct further below.
    let owner_account = next_account_info(accounts_iter)?;

    // Account 1: The access control PDA account.
    let access_control_pda_account = next_account_info(accounts_iter)?;
    let access_control_data = access_control_data(program_id, access_control_pda_account)?;
    // Ensure the owner account is really the owner of this program.
    access_control_data.ensure_owner_signer(owner_account)?;

    // Store the new access control owner.
    AccessControlAccount::from(AccessControlData {
        bump_seed: access_control_data.bump_seed,
        owner: new_owner,
    })
    .store(access_control_pda_account, false)?;

    Ok(())
}

#[cfg(test)]
mod test {
    use super::*;

    use hyperlane_core::{Checkpoint, Encode, HyperlaneMessage, Signable, H160, H256};
    use hyperlane_sealevel_mailbox::instruction::{IsmInstruction, IsmVerify};
    use multisig_ism::signature::EcdsaSignature;
    use solana_program::stake_history::Epoch;

    use std::str::FromStr;

    #[test]
    fn test_verify() {
        let program_id = id();

        let origin_domain = 1234u32;
        let destination_domain = 4321u32;

        let (domain_pda_key, domain_pda_bump_seed) =
            Pubkey::find_program_address(domain_data_pda_seeds!(origin_domain), &program_id);

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
                validators: vec![
                    H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
                    H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
                    H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
                ],
                threshold: 2,
            },
        };
        DomainDataAccount::from(init_domain_data)
            .store(&domain_pda_account, false)
            .unwrap();

        let message = HyperlaneMessage {
            version: 0,
            nonce: 69,
            origin: origin_domain,
            sender: H256::from_str(
                "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
            )
            .unwrap(),
            destination: destination_domain,
            recipient: H256::from_str(
                "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
            )
            .unwrap(),
            body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        };

        let checkpoint = Checkpoint {
            mailbox_address: H256::from_str(
                "0xabababababababababababababababababababababababababababababababab",
            )
            .unwrap(),
            mailbox_domain: origin_domain,
            root: H256::from_str(
                "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
            )
            .unwrap(),
            index: 69,
            message_id: message.id(),
        };

        // checkpoint.signing_hash() is equal to:
        // 0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e

        // Validator 0:
        // Address: 0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D
        // Private Key: 0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091
        //   > await (new ethers.Wallet('0x788aa7213bd92ff92017d767fde0d75601425818c8e4b21e87314c2a4dcd6091')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
        //   '0xba6ac92e3e1156c572ad2a9ba8bfc3a5e9492dfe9d0d00c6522682306614969a181962c07c64f8df863ded67ecc628fb19e4998e0521c4555b380a69b0afbf0c1b'
        let signature_0 = hex::decode("ba6ac92e3e1156c572ad2a9ba8bfc3a5e9492dfe9d0d00c6522682306614969a181962c07c64f8df863ded67ecc628fb19e4998e0521c4555b380a69b0afbf0c1b").unwrap();

        // Validator 1:
        // Address: 0xb25206874C24733F05CC0dD11924724A8E7175bd
        // Private Key: 0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e
        //   > await (new ethers.Wallet('0x4a599de3915f404d84a2ebe522bfe7032ebb1ca76a65b55d6eb212b129043a0e')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
        //   '0x9034ee44173817edf63c223b5761e3a7580adf34ed6239b25da3e4f9b5c5d6230d903672de6744827f128b89b74be3c3f3ea367a618162f239f1b6d4aae66eec1c'
        let signature_1 = hex::decode("9034ee44173817edf63c223b5761e3a7580adf34ed6239b25da3e4f9b5c5d6230d903672de6744827f128b89b74be3c3f3ea367a618162f239f1b6d4aae66eec1c").unwrap();

        // Validator 2:
        // Address: 0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3
        // Private Key: 0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515
        //   > await (new ethers.Wallet('0x2cc76d56db9924ddc3388164454dfea9edd2d5f5da81102fd3594fc7c5281515')).signMessage(ethers.utils.arrayify('0xb7f083667def5ba8a9b22af4faa336e2f5219bfa976a474034a67a9b5b71f13e'))
        //   '0x2b228823c04b9dd37577763043127fe3307074bb45968302c6111e8e334c3cd25292061618f392549c81351ae9e08d5c4a1e0b9947b79a30f8d693257e8818731c'
        let signature_2 = hex::decode("2b228823c04b9dd37577763043127fe3307074bb45968302c6111e8e334c3cd25292061618f392549c81351ae9e08d5c4a1e0b9947b79a30f8d693257e8818731c").unwrap();

        // let vec = checkpoint.signing_hash();
        // println!("vec {:x}", vec);
        let message_bytes = message.to_vec();

        // A quorum of signatures in the correct order.
        // Expect no error.
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the IsmInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            IsmInstruction::Verify(IsmVerify {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_mailbox: checkpoint.mailbox_address,
                    merkle_root: checkpoint.root,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signature_0).unwrap(),
                        EcdsaSignature::from_bytes(&signature_1).unwrap(),
                    ],
                }
                .to_vec(),
                message: message_bytes.clone(),
            })
            .try_to_vec()
            .unwrap()
            .as_slice(),
        );
        assert!(result.is_ok());

        // A quorum of signatures NOT in the correct order.
        // Expect an error.
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the IsmInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            IsmInstruction::Verify(IsmVerify {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_mailbox: checkpoint.mailbox_address,
                    merkle_root: checkpoint.root,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signature_1).unwrap(),
                        EcdsaSignature::from_bytes(&signature_0).unwrap(),
                    ],
                }
                .to_vec(),
                message: message_bytes.clone(),
            })
            .try_to_vec()
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
            // Use the IsmInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            IsmInstruction::Verify(IsmVerify {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_mailbox: checkpoint.mailbox_address,
                    merkle_root: checkpoint.root,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signature_0).unwrap(),
                        EcdsaSignature::from_bytes(&signature_2).unwrap(),
                        // Signature from a non-validator:
                        //   Address: 0xB92752D900573BC114D18e023D81312bBC32e266
                        //   Private Key: 0x2e09250a71f712e5f834285cc60f1d62578360c65a0f4836daa0a5caa27199cf
                        EcdsaSignature::from_bytes(&hex::decode("c75dca903d963f30f169ba99c2554572108474c097bd40c2a29fbcf4739fdb564e795fce8e0ae3b860dfd4e0b3f93420ccb6454e87fa3235c8754a5437a78f781b").unwrap()).unwrap(),
                    ],
                }.to_vec(),
                message: message_bytes.clone(),
            }).try_to_vec().unwrap().as_slice(),
        );
        assert!(result.is_ok());

        // A quorum of signatures, but the message has a different nonce & therefore ID
        let result = process_instruction(
            &program_id,
            &[domain_pda_account.clone()],
            // Use the IsmInstruction enum to ensure the instruction
            // is handled in compliance with what the Mailbox expects
            IsmInstruction::Verify(IsmVerify {
                metadata: MultisigIsmMessageIdMetadata {
                    origin_mailbox: checkpoint.mailbox_address,
                    merkle_root: checkpoint.root,
                    validator_signatures: vec![
                        EcdsaSignature::from_bytes(&signature_0).unwrap(),
                        EcdsaSignature::from_bytes(&signature_1).unwrap(),
                    ],
                }
                .to_vec(),
                message: HyperlaneMessage {
                    nonce: 420,
                    ..message
                }
                .to_vec(),
            })
            .try_to_vec()
            .unwrap()
            .as_slice(),
        );
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), Error::ThresholdNotMet.into());
    }

    #[test]
    fn test_set_owner() {
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
            owner: owner_key,
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
            Instruction::SetOwner(new_owner_key)
                .try_to_vec()
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
            Instruction::SetOwner(new_owner_key)
                .try_to_vec()
                .unwrap()
                .as_slice(),
        )
        .unwrap();

        let access_control_data =
            AccessControlAccount::fetch_data(&mut &accounts[1].data.borrow_mut()[..])
                .unwrap()
                .unwrap();
        assert_eq!(
            access_control_data,
            Box::new(AccessControlData {
                bump_seed: access_control_pda_bump_seed,
                owner: new_owner_key,
            })
        );

        // And now let's try to set the owner again, but with the old owner signing.
        let result = process_instruction(
            &program_id,
            &accounts,
            Instruction::SetOwner(new_owner_key)
                .try_to_vec()
                .unwrap()
                .as_slice(),
        );
        assert_eq!(result, Err(Error::AccountNotOwner.into()));
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
            owner: owner_key,
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
