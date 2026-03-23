use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SPL_NOOP_PROGRAM_ID};
use borsh::BorshDeserialize;
use hyperlane_core::ModuleType;
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{StorageAccount, StorageData},
    error::Error,
    instruction::{InitConfig, Instruction as AggInstruction, SetConfigData},
};

const ISM_TYPE: ModuleType = ModuleType::Aggregation;

/// Initial PDA size; grows via realloc as needed.
const STORAGE_PDA_INITIAL_SIZE: usize = 1024;

/// PDA seeds for the storage account.
#[macro_export]
macro_rules! storage_pda_seeds {
    () => {{
        &[b"aggregation_ism", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"aggregation_ism", b"-", b"storage", &[$bump_seed]]
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
            InterchainSecurityModuleInstruction::Verify(verify_data) => verify(
                program_id,
                accounts,
                verify_data.metadata,
                verify_data.message,
            ),
            InterchainSecurityModuleInstruction::VerifyAccountMetas(_verify_data) => {
                let account_metas = verify_account_metas(program_id, accounts)?;
                let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                    .map_err(|_| ProgramError::BorshIoError)?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    match AggInstruction::decode(instruction_data)? {
        AggInstruction::Initialize(config) => initialize(program_id, accounts, config),
        AggInstruction::SetConfig(config) => set_config(program_id, accounts, config),
        AggInstruction::GetOwner => get_owner(program_id, accounts),
        AggInstruction::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
    }
}

/// Verifies a message against the configured sub-ISMs.
///
/// Metadata format: borsh-encoded `Vec<Option<Vec<u8>>>` with one entry per
/// configured module. `None` = skip that module. `Some(bytes)` = verify with
/// those bytes. At least `threshold` entries must be `Some`, and ALL `Some`
/// entries must successfully verify.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
/// Then, for each non-None sub-ISM in order:
///   [SPL_NOOP] separator
///   [sub_ism program]
///   [sub_ism verify accounts...]
/// [SPL_NOOP] final end marker
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata_bytes: Vec<u8>,
    message_bytes: Vec<u8>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter().peekable();

    // Account 0: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = load_storage(program_id, storage_info)?;

    // Decode metadata as Vec<Option<Vec<u8>>>.
    let sub_metas: Vec<Option<Vec<u8>>> =
        Vec::<Option<Vec<u8>>>::deserialize(&mut &metadata_bytes[..])
            .map_err(|_| ProgramError::InvalidInstructionData)?;

    if sub_metas.len() != storage.modules.len() {
        return Err(Error::MetadataModulesMismatch.into());
    }

    // Count how many modules are being verified.
    let presented_count = sub_metas.iter().filter(|m| m.is_some()).count();
    if (presented_count as u8) < storage.threshold {
        return Err(Error::ThresholdNotMet.into());
    }

    // Verify each presented module.
    for (i, sub_meta) in sub_metas.iter().enumerate() {
        let sub_meta_bytes = match sub_meta {
            None => continue,
            Some(b) => b,
        };

        let expected_module = &storage.modules[i];

        // Expect SPL_NOOP separator.
        let sep = next_account_info(accounts_iter)?;
        if sep.key != &SPL_NOOP_PROGRAM_ID {
            return Err(Error::AccountOutOfOrder.into());
        }

        // Expect sub-ISM program account.
        let sub_ism_info = next_account_info(accounts_iter)?;
        if sub_ism_info.key != expected_module {
            return Err(Error::InvalidSubIsm.into());
        }

        // Collect sub-ISM verify accounts until next SPL_NOOP.
        let mut sub_verify_infos: Vec<AccountInfo> = vec![];
        let mut sub_verify_metas: Vec<AccountMeta> = vec![];
        loop {
            let peek = accounts_iter.peek().ok_or(ProgramError::InvalidArgument)?;
            if peek.key == &SPL_NOOP_PROGRAM_ID {
                break;
            }
            let acct = next_account_info(accounts_iter)?;
            sub_verify_metas.push(AccountMeta {
                pubkey: *acct.key,
                is_signer: acct.is_signer,
                is_writable: acct.is_writable,
            });
            sub_verify_infos.push(acct.clone());
        }

        // CPI into sub-ISM verify.
        let verify_ix = InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
            metadata: sub_meta_bytes.clone(),
            message: message_bytes.clone(),
        });
        let ix = Instruction::new_with_bytes(
            *expected_module,
            &verify_ix
                .encode()
                .map_err(|_| ProgramError::InvalidInstructionData)?,
            sub_verify_metas,
        );
        invoke(&ix, &sub_verify_infos)?;
    }

    // Consume final SPL_NOOP end marker.
    let end_marker = next_account_info(accounts_iter)?;
    if end_marker.key != &SPL_NOOP_PROGRAM_ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    Ok(())
}

/// Returns the accounts required by `Verify`.
///
/// Returns only the storage PDA. The SDK is responsible for additionally
/// calling each sub-ISM's `VerifyAccountMetas` and assembling the full
/// account list with SPL_NOOP delimiters.
///
/// Accounts:
/// 0. `[]` The storage PDA account.
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let accounts_iter = &mut accounts.iter();
    let storage_info = next_account_info(accounts_iter)?;
    // Validate it's the correct PDA.
    let _ = load_storage(program_id, storage_info)?;

    let (storage_pda_key, _) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);
    Ok(vec![
        AccountMeta::new_readonly(storage_pda_key, false).into()
    ])
}

/// Initializes the program.
///
/// Accounts:
/// 0. `[signer]` The owner/payer.
/// 1. `[writable]` The storage PDA account.
/// 2. `[executable]` The system program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], config: InitConfig) -> ProgramResult {
    let set_config = SetConfigData {
        threshold: config.threshold,
        modules: config.modules,
    };
    set_config.validate().map_err(ProgramError::from)?;

    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let storage_pda_account = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump) =
        Pubkey::find_program_address(storage_pda_seeds!(), program_id);
    if *storage_pda_account.key != storage_pda_key {
        return Err(Error::AccountOutOfOrder.into());
    }

    if let Ok(Some(_)) = StorageAccount::fetch_data(&mut &storage_pda_account.data.borrow()[..]) {
        return Err(Error::AlreadyInitialized.into());
    }

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    create_pda_account(
        owner_account,
        &Rent::get()?,
        STORAGE_PDA_INITIAL_SIZE,
        program_id,
        system_program_account,
        storage_pda_account,
        storage_pda_seeds!(storage_pda_bump),
    )?;

    StorageAccount::from(StorageData {
        bump_seed: storage_pda_bump,
        owner: Some(*owner_account.key),
        threshold: set_config.threshold,
        modules: set_config.modules,
    })
    .store(storage_pda_account, true)?;

    Ok(())
}

/// Sets the modules and threshold. Owner only.
///
/// Accounts:
/// 0. `[signer]` The owner.
/// 1. `[writable]` The storage PDA account.
fn set_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: SetConfigData,
) -> ProgramResult {
    config.validate().map_err(ProgramError::from)?;

    let accounts_iter = &mut accounts.iter();

    let owner_account = next_account_info(accounts_iter)?;
    let storage_pda_account = next_account_info(accounts_iter)?;

    let mut storage = load_storage(program_id, storage_pda_account)?;
    storage.ensure_owner_signer(owner_account)?;

    storage.threshold = config.threshold;
    storage.modules = config.modules;

    StorageAccount::from(*storage).store(storage_pda_account, true)?;

    Ok(())
}

/// Gets the owner. Returns as return data.
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
    StorageAccount::from(*storage).store(storage_pda_account, true)?;

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

    fn make_storage(
        program_id: &Pubkey,
        threshold: u8,
        modules: Vec<Pubkey>,
    ) -> (Pubkey, AccountInfo<'static>) {
        let (key, bump) = Pubkey::find_program_address(storage_pda_seeds!(), program_id);
        let key_ref = Box::leak(Box::new(key));
        let owner_ref = Box::leak(Box::new(*program_id));
        let data = Box::leak(Box::new(vec![0u8; 4096]));
        let lamports = Box::leak(Box::new(1_000_000u64));
        let info = AccountInfo::new(
            key_ref,
            false,
            true,
            lamports,
            data.as_mut_slice(),
            owner_ref,
            false,
        );
        StorageAccount::from(StorageData {
            bump_seed: bump,
            owner: Some(Pubkey::new_unique()),
            threshold,
            modules,
        })
        .store(&info, false)
        .unwrap();
        (key, info)
    }

    /// Builds a fake sub-ISM that always succeeds.
    fn make_passing_sub_ism_program_id() -> Pubkey {
        // In real tests we'd use solana_program_test; here we just verify the
        // account layout parsing. The CPI call itself is tested in integration tests.
        Pubkey::new_unique()
    }

    #[test]
    fn test_threshold_not_met() {
        let program_id = Pubkey::new_unique();
        let module0 = make_passing_sub_ism_program_id();
        let module1 = make_passing_sub_ism_program_id();
        let (_, storage_info) = make_storage(&program_id, 2, vec![module0, module1]);

        // Provide only 1 non-None entry but threshold is 2.
        let sub_metas: Vec<Option<Vec<u8>>> = vec![Some(vec![]), None];
        let metadata_bytes = borsh::to_vec(&sub_metas).unwrap();

        // We can't actually CPI in unit tests, but we can verify the threshold
        // check fires before any CPI is attempted if count < threshold.
        // With 1 presented vs threshold 2, the check fires immediately.
        // (The SPL_NOOP accounts are not provided, so it would also fail on account
        // parsing, but the threshold check should be first in the code path when
        // presented_count < threshold.)

        // Actually the threshold check happens after metadata parse, before CPI.
        // So the error should be ThresholdNotMet.
        // We need a dummy SPL_NOOP account to not trip the account parse first.
        // Since threshold check is before CPI loop in our impl, we just need
        // the storage account.
        let result = verify(&program_id, &[storage_info], metadata_bytes, vec![]);
        assert_eq!(result.unwrap_err(), Error::ThresholdNotMet.into());
    }

    #[test]
    fn test_metadata_modules_mismatch() {
        let program_id = Pubkey::new_unique();
        let module0 = make_passing_sub_ism_program_id();
        let (_, storage_info) = make_storage(&program_id, 1, vec![module0]);

        // Provide 2 entries for 1 module.
        let sub_metas: Vec<Option<Vec<u8>>> = vec![Some(vec![]), Some(vec![])];
        let metadata_bytes = borsh::to_vec(&sub_metas).unwrap();

        let result = verify(&program_id, &[storage_info], metadata_bytes, vec![]);
        assert_eq!(result.unwrap_err(), Error::MetadataModulesMismatch.into());
    }

    #[test]
    fn test_set_config_validates() {
        let config = SetConfigData {
            threshold: 0,
            modules: vec![Pubkey::new_unique()],
        };
        assert_eq!(config.validate().unwrap_err(), Error::InvalidThreshold);

        let config = SetConfigData {
            threshold: 2,
            modules: vec![Pubkey::new_unique()],
        };
        assert_eq!(config.validate().unwrap_err(), Error::InvalidThreshold);

        let config = SetConfigData {
            threshold: 1,
            modules: vec![],
        };
        assert_eq!(config.validate().unwrap_err(), Error::InvalidModules);

        let config = SetConfigData {
            threshold: 1,
            modules: vec![Pubkey::new_unique()],
        };
        assert!(config.validate().is_ok());
    }
}
