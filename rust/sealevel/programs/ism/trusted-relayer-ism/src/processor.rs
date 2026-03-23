use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use hyperlane_core::ModuleType;
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
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
use solana_system_interface::program as system_program;

use crate::{
    accounts::{StorageAccount, StorageData},
    error::Error,
    instruction::Instruction,
};

const ISM_TYPE: ModuleType = ModuleType::Null;

/// PDA seeds for the storage account.
#[macro_export]
macro_rules! storage_pda_seeds {
    () => {{
        &[b"trusted_relayer_ism", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"trusted_relayer_ism", b"-", b"storage", &[$bump_seed]]
    }};
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(ism_instruction) = InterchainSecurityModuleInstruction::decode(instruction_data) {
        return match ism_instruction {
            InterchainSecurityModuleInstruction::Type => {
                set_return_data(
                    &borsh::to_vec(&SimulationReturnData::new(ISM_TYPE as u32))
                        .map_err(|_| ProgramError::BorshIoError)?[..],
                );
                Ok(())
            }
            InterchainSecurityModuleInstruction::Verify(_verify_data) => {
                verify(program_id, accounts)
            }
            InterchainSecurityModuleInstruction::VerifyAccountMetas(_verify_data) => {
                let account_metas = verify_account_metas(program_id, accounts)?;
                let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                    .map_err(|_| ProgramError::BorshIoError)?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    match Instruction::decode(instruction_data)? {
        Instruction::Initialize(relayer) => initialize(program_id, accounts, relayer),
        Instruction::SetRelayer(relayer) => set_relayer(program_id, accounts, relayer),
        Instruction::GetOwner => get_owner(program_id, accounts),
        Instruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Verifies the message was submitted by the trusted relayer.
///
/// Note: metadata is ignored (ModuleType::Null).
///
/// Accounts:
/// 0. `[]` The storage PDA account.
/// 1. `[]` The relayer account (must be signer).
fn verify(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    // Account 1: The relayer that must be a signer.
    let relayer_info = next_account_info(accounts_iter)?;

    if relayer_info.key != &storage.relayer {
        return Err(Error::InvalidRelayer.into());
    }
    if !relayer_info.is_signer {
        return Err(Error::RelayerNotSigner.into());
    }

    Ok(())
}

/// Returns the accounts required by `Verify`.
///
/// Accounts:
/// 0. `[]` The VERIFY_ACCOUNT_METAS_PDA (convention, unused).
/// 1. `[]` The storage PDA account (read to get relayer pubkey).
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // Account 0: VERIFY_ACCOUNT_METAS_PDA (convention, unused).
    let _vam_pda = next_account_info(accounts_iter)?;

    // Account 1: Storage PDA - read to get relayer pubkey.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);

    Ok(vec![
        AccountMeta::new_readonly(storage_pda_key, false).into(),
        // The relayer must be a signer in the actual verify transaction.
        AccountMeta {
            pubkey: storage.relayer,
            is_signer: true,
            is_writable: false,
        }
        .into(),
    ])
}

/// Initializes the program, creating the storage PDA.
///
/// Accounts:
/// 0. `[signer]` The new owner and payer of the storage PDA.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], relayer: Pubkey) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Owner/payer.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: Storage PDA.
    let storage_pda_account = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump) =
        Pubkey::find_program_address(storage_pda_seeds!(), program_id);
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    if let Ok(Some(_)) = StorageAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..]) {
        return Err(Error::AlreadyInitialized.into());
    }

    // Account 2: System program.
    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    let storage = StorageAccount::from(StorageData {
        bump_seed: storage_pda_bump,
        owner: Some(*owner_account.key),
        relayer,
    });
    let storage_size = storage.size();
    create_pda_account(
        owner_account,
        &Rent::get()?,
        storage_size,
        program_id,
        system_program_account,
        storage_pda_account,
        storage_pda_seeds!(storage_pda_bump),
    )?;
    storage.store(storage_pda_account, false)?;

    Ok(())
}

/// Sets the trusted relayer. Owner only.
///
/// Accounts:
/// 0. `[signer]` The access control owner.
/// 1. `[writable]` The storage PDA account.
fn set_relayer(program_id: &Pubkey, accounts: &[AccountInfo], relayer: Pubkey) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;
    storage.relayer = relayer;

    StorageAccount::from(*storage).store(storage_pda_account, false)?;

    Ok(())
}

/// Gets the owner from the storage account, returning it as return data.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn get_owner(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let storage_pda_account = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_pda_account)?;

    let bytes = borsh::to_vec(&SimulationReturnData::new(storage.owner))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);
    Ok(())
}

/// Transfers ownership.
///
/// Accounts:
/// 0. `[signer]` The current owner.
/// 1. `[writable]` The storage PDA account.
fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.transfer_ownership(owner_account, new_owner)?;
    StorageAccount::from(*storage).store(storage_pda_account, false)?;

    Ok(())
}

/// Loads and validates the storage PDA account.
fn load_storage(
    program_id: &Pubkey,
    storage_pda_account: &AccountInfo,
) -> Result<Box<StorageData>, ProgramError> {
    if storage_pda_account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }
    let storage = StorageAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..])?
        .ok_or(Error::AccountNotInitialized)?;

    let storage_pda_key =
        Pubkey::create_program_address(storage_pda_seeds!(storage.bump_seed), program_id)?;
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(storage)
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction,
    };

    #[test]
    fn test_verify_trusted_relayer() {
        let program_id = Pubkey::new_unique();
        let relayer_key = Pubkey::new_unique();
        let system_program_id = solana_system_interface::program::ID;

        let (storage_key, storage_bump) =
            Pubkey::find_program_address(storage_pda_seeds!(), &program_id);
        let mut lamps = 1_000_000u64;
        let mut data = vec![0u8; 256];
        let storage_info = AccountInfo::new(
            &storage_key,
            false,
            true,
            &mut lamps,
            &mut data,
            &program_id,
            false,
        );
        StorageAccount::from(StorageData {
            bump_seed: storage_bump,
            owner: Some(Pubkey::new_unique()),
            relayer: relayer_key,
        })
        .store(&storage_info, false)
        .unwrap();

        let mut relayer_lamports = 0u64;
        let mut relayer_data = vec![];

        // Test: relayer is signer → should succeed.
        let relayer_info = AccountInfo::new(
            &relayer_key,
            true, // is_signer
            false,
            &mut relayer_lamports,
            &mut relayer_data,
            &system_program_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[storage_info.clone(), relayer_info.clone()],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert!(result.is_ok(), "Expected Ok, got {:?}", result);

        // Test: relayer is NOT signer → should fail.
        let mut relayer_data2 = vec![];
        let mut relayer_lamports2 = 0u64;
        let relayer_info_no_sig = AccountInfo::new(
            &relayer_key,
            false, // not a signer
            false,
            &mut relayer_lamports2,
            &mut relayer_data2,
            &system_program_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[storage_info.clone(), relayer_info_no_sig],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert_eq!(result.unwrap_err(), Error::RelayerNotSigner.into());

        // Test: wrong relayer → should fail.
        let wrong_key = Pubkey::new_unique();
        let mut wrong_data = vec![];
        let mut wrong_lamports = 0u64;
        let wrong_info = AccountInfo::new(
            &wrong_key,
            true,
            false,
            &mut wrong_lamports,
            &mut wrong_data,
            &system_program_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[storage_info.clone(), wrong_info],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert_eq!(result.unwrap_err(), Error::InvalidRelayer.into());
    }
}
