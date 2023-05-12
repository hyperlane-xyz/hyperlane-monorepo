//! Interchain Security Module that unconditionally approves.
//! **NOT INTENDED FOR USE IN PRODUCTION**

// #![deny(warnings)] // FIXME
// #![deny(missing_docs)] // FIXME
#![deny(unsafe_code)]

mod accounts;
mod error;
mod instruction;

use hyperlane_core::{H160, H256, Signable, Hasher, Checkpoint, HyperlaneMessage, Decode};

// use hyperlane_sealevel_mailbox::instruction::IsmInstruction;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    // msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    keccak,
    system_instruction,
    program::{invoke_signed, set_return_data},
    secp256k1_recover::{secp256k1_recover, Secp256k1RecoverError},
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
        Instruction::SetValidatorsAndThreshold(config) => set_validators_and_threshold(program_id, accounts, config),
        Instruction::GetValidatorsAndThreshold(domain) => get_validators_and_threshold(program_id, accounts, domain),
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

struct EcdsaSignature {
    serialized_rs: [u8; 64],
    recovery_id: u8,
}

impl EcdsaSignature {
    fn from_bytes(bytes: &[u8]) -> Result<Self, ProgramError> {
        if bytes.len() != 65 {
            return Err(ProgramError::InvalidArgument);
        }

        let mut serialized_rs = [0u8; 64];
        serialized_rs.copy_from_slice(&bytes[..64]);

        let mut recovery_id = bytes[64];
        if recovery_id == 27 || recovery_id == 28 {
            recovery_id -= 27;
        }

        // Recovery ID must be 0 or 1
        if recovery_id > 1 {
            return Err(Error::InvalidSignatureRecoveryId.into());
        }

        Ok(Self {
            serialized_rs,
            recovery_id,
        })
    }
}

fn secp256k1_recover_ethereum_address(
    hash: &[u8],
    recovery_id: u8,
    signature: &[u8],
) -> Result<H160, Secp256k1RecoverError> {
    let public_key = secp256k1_recover(hash, recovery_id, signature)?;

    let public_key_hash = {
        let mut hasher = keccak::Hasher::default();
        hasher.hash(&public_key.to_bytes()[..]);
        &hasher.result().to_bytes()[12..]
    };

    Ok(H160::from_slice(public_key_hash))
}

struct MultisigIsm<T: Signable<KeccakHasher>> {
    signed_data: T,
    signatures: Vec<EcdsaSignature>,
    validators: Vec<H160>,
    threshold: u8,
}

enum MultisigIsmError {
    InvalidSignature,
    ThresholdNotMet,
}

impl Into<Error> for MultisigIsmError {
    fn into(self) -> Error {
        match self {
            MultisigIsmError::InvalidSignature => Error::InvalidSignature,
            MultisigIsmError::ThresholdNotMet => Error::ThresholdNotMet,
        }
    }
}

impl<T: Signable<KeccakHasher>> MultisigIsm<T> {
    fn new(
        signed_data: T,
        signatures: Vec<EcdsaSignature>,
        validators: Vec<H160>,
        threshold: u8,
    ) -> Self {
        Self {
            signed_data,
            signatures,
            validators,
            threshold,
        }
    }

    fn verify(&self) -> Result<(), MultisigIsmError> {
        let signed_digest = self.signed_data.eth_signed_message_hash();
        let signed_digest_bytes = signed_digest.as_bytes();

        let validator_count = self.validators.len();
        let mut validator_index = 0;

        // Assumes that signatures are ordered by validator
        for i in 0..self.threshold {
            let signature = &self.signatures[i as usize];
            let signer = secp256k1_recover_ethereum_address(
                signed_digest_bytes,
                signature.recovery_id,
                signature.serialized_rs.as_slice(),
            ).map_err(|_| MultisigIsmError::InvalidSignature)?;

            while validator_index < validator_count && signer != self.validators[validator_index] {
                validator_index += 1;
            }

            if validator_index >= validator_count {
                return Err(MultisigIsmError::ThresholdNotMet);
            }

            validator_index += 1;
        }

        Ok(())
    }
}

#[derive(Default)]
struct KeccakHasher(keccak::Hasher);

impl Hasher for KeccakHasher {
    fn hash(mut self, payload: &[u8]) -> [u8; 32] {
        self.0.hash(payload);
        self.0.result().to_bytes()
    }
}

struct MultisigIsmMessageIdMetadata {
    origin_mailbox: H256,
    merkle_root: H256,
    validator_signatures: Vec<EcdsaSignature>,
}

const ORIGIN_MAILBOX_OFFSET: usize = 0;
const MERKLE_ROOT_OFFSET: usize = 32;
const SIGNATURES_OFFSET: usize = 64;
const SIGNATURE_LENGTH: usize = 65;

impl TryFrom<Vec<u8>> for MultisigIsmMessageIdMetadata {
    type Error = ProgramError;

    fn try_from(bytes: Vec<u8>) -> Result<Self, Self::Error> {
        let bytes_len = bytes.len();
        // Require the bytes to be at least big enough to include a single signature.
        if bytes_len < SIGNATURES_OFFSET + SIGNATURE_LENGTH {
            return Err(ProgramError::InvalidArgument);
        }

        let origin_mailbox = H256::from_slice(&bytes[ORIGIN_MAILBOX_OFFSET..MERKLE_ROOT_OFFSET]);
        let merkle_root = H256::from_slice(&bytes[MERKLE_ROOT_OFFSET..SIGNATURES_OFFSET]);

        let signature_bytes_len = bytes_len - SIGNATURES_OFFSET;
        // Require the signature bytes to be a multiple of the signature length.
        // We don't need to check if signature_bytes_len is 0 because this is checked
        // above.
        if signature_bytes_len % SIGNATURE_LENGTH != 0 {
            return Err(ProgramError::InvalidArgument);
        }
        let signature_count = signature_bytes_len / SIGNATURE_LENGTH;
        let mut validator_signatures = Vec::with_capacity(signature_count);
        for i in 0..signature_count {
            let signature_offset = SIGNATURES_OFFSET + (i * SIGNATURE_LENGTH);
            let signature = EcdsaSignature::from_bytes(&bytes[signature_offset..signature_offset + SIGNATURE_LENGTH])?;
            validator_signatures.push(signature);
        }

        Ok(Self {
            origin_mailbox,
            merkle_root,
            validator_signatures,
        })
    }
}
