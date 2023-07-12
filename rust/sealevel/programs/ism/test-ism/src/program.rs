//! Interchain Security Module used for testing.

use account_utils::{create_pda_account, AccountData, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
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
    system_program,
    sysvar::Sysvar,
};

use hyperlane_core::ModuleType;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

const ISM_TYPE: ModuleType = ModuleType::Unused;

/// Custom errors for the program.
pub enum TestIsmError {
    /// The verify instruction was not accepted.
    VerifyNotAccepted = 69420,
}

/// The PDA seeds relating to storage
#[macro_export]
macro_rules! test_ism_storage_pda_seeds {
    () => {{
        &[b"test_ism", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"test_ism", b"-", b"storage", &[$bump_seed]]
    }};
}

/// The storage account.
pub type TestIsmStorageAccount = AccountData<TestIsmStorage>;

/// The storage account's data.
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug, Default)]
pub struct TestIsmStorage {
    /// Whether messages should be accepted / verified.
    pub accept: bool,
}

impl SizedData for TestIsmStorage {
    fn size(&self) -> usize {
        // 1 byte bool
        1
    }
}

/// Instructions for the program.
#[derive(BorshSerialize, BorshDeserialize, PartialEq, Debug)]
pub enum TestIsmInstruction {
    /// Initializes the program.
    Init,
    /// Sets whether messages should be accepted / verified.
    SetAccept(bool),
}

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if let Ok(ism_instruction) = InterchainSecurityModuleInstruction::decode(instruction_data) {
        return match ism_instruction {
            InterchainSecurityModuleInstruction::Verify(_) => verify(program_id, accounts),
            InterchainSecurityModuleInstruction::VerifyAccountMetas(_) => {
                verify_account_metas(program_id, accounts)
            }
            InterchainSecurityModuleInstruction::Type => {
                set_return_data(
                    &SimulationReturnData::new(ISM_TYPE as u32)
                        .try_to_vec()
                        .map_err(|err| ProgramError::BorshIoError(err.to_string()))?[..],
                );
                Ok(())
            }
        };
    }

    let instruction = TestIsmInstruction::try_from_slice(instruction_data)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    match instruction {
        TestIsmInstruction::Init => init(program_id, accounts),
        TestIsmInstruction::SetAccept(accept) => set_accept(program_id, accounts, accept),
    }
}

/// Creates the storage PDA.
///
/// Accounts:
/// 0. [executable] System program.
/// 1. [signer] Payer.
/// 2. [writeable] Storage PDA.
fn init(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 2: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let (storage_pda_key, storage_pda_bump_seed) =
        Pubkey::find_program_address(test_ism_storage_pda_seeds!(), program_id);
    if storage_info.key != &storage_pda_key {
        return Err(ProgramError::InvalidArgument);
    }

    let storage_account = TestIsmStorageAccount::from(TestIsmStorage { accept: true });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        storage_account.size(),
        program_id,
        system_program_info,
        storage_info,
        test_ism_storage_pda_seeds!(storage_pda_bump_seed),
    )?;
    // Store it
    storage_account.store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. [writeable] Storage PDA.
fn set_accept(_program_id: &Pubkey, accounts: &[AccountInfo], accept: bool) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA.
    // Not bothering to check for validity because this is a test program
    let storage_info = next_account_info(accounts_iter)?;
    let mut storage =
        TestIsmStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();
    storage.accept = accept;
    TestIsmStorageAccount::from(storage).store(storage_info, false)?;

    Ok(())
}

/// Accounts:
/// 0. [] Storage PDA.
fn verify(_program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Storage PDA.
    let storage_info = next_account_info(accounts_iter)?;
    let storage = TestIsmStorageAccount::fetch(&mut &storage_info.data.borrow()[..])?.into_inner();

    if !storage.accept {
        return Err(ProgramError::Custom(TestIsmError::VerifyNotAccepted as u32));
    }

    Ok(())
}

fn verify_account_metas(program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    let (storage_pda_key, _storage_pda_bump) =
        Pubkey::find_program_address(test_ism_storage_pda_seeds!(), program_id);

    let account_metas: Vec<SerializableAccountMeta> =
        vec![AccountMeta::new_readonly(storage_pda_key, false).into()];

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
