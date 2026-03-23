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
use solana_system_interface::program as system_program;

use hyperlane_core::ModuleType;
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;

use crate::{
    trusted_relayer_pda_seeds, Error, Instruction, TrustedRelayerAccount, TrustedRelayerData,
};

const ISM_TYPE: ModuleType = ModuleType::Null;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Try ISM interface instructions first.
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
            InterchainSecurityModuleInstruction::VerifyAccountMetas(verify_data) => {
                let account_metas = verify_account_metas(
                    program_id,
                    accounts,
                    verify_data.metadata,
                    verify_data.message,
                )?;
                let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                    .map_err(|_| ProgramError::BorshIoError)?;
                set_return_data(&bytes[..]);
                Ok(())
            }
        };
    }

    // Try admin instructions.
    match Instruction::decode(instruction_data)? {
        Instruction::Initialize(relayer) => initialize(program_id, accounts, relayer),
    }
}

/// Verifies the message was submitted by the trusted relayer.
///
/// Accounts:
/// 0. `[]` Trusted relayer PDA.
/// 1. `[signer]` The trusted relayer account.
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _metadata: Vec<u8>,
    _message: Vec<u8>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Trusted relayer PDA.
    let trusted_relayer_pda = next_account_info(accounts_iter)?;
    let trusted_relayer_data = fetch_trusted_relayer_data(program_id, trusted_relayer_pda)?;

    // Account 1: The relayer account — must be a signer.
    let relayer_info = next_account_info(accounts_iter)?;
    if !relayer_info.is_signer {
        return Err(Error::RelayerNotSigner.into());
    }
    if relayer_info.key != &trusted_relayer_data.relayer {
        return Err(Error::RelayerMismatch.into());
    }

    Ok(())
}

/// Returns account metas required by the Verify instruction.
///
/// Accounts:
/// 0. `[]` Trusted relayer PDA (to read the relayer pubkey).
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _metadata: Vec<u8>,
    _message: Vec<u8>,
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Trusted relayer PDA.
    let trusted_relayer_pda = next_account_info(accounts_iter)?;
    let trusted_relayer_data = fetch_trusted_relayer_data(program_id, trusted_relayer_pda)?;

    let (trusted_relayer_pda_key, _) =
        Pubkey::find_program_address(trusted_relayer_pda_seeds!(), program_id);

    Ok(vec![
        AccountMeta::new_readonly(trusted_relayer_pda_key, false).into(),
        AccountMeta::new_readonly(trusted_relayer_data.relayer, true).into(),
    ])
}

/// Initializes the program with an immutable trusted relayer.
///
/// Accounts:
/// 0. `[signer]` Payer.
/// 1. `[writable]` Trusted relayer PDA.
/// 2. `[executable]` System program.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], relayer: Pubkey) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Payer.
    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 1: Trusted relayer PDA.
    let trusted_relayer_info = next_account_info(accounts_iter)?;
    let (trusted_relayer_key, trusted_relayer_bump) =
        Pubkey::find_program_address(trusted_relayer_pda_seeds!(), program_id);
    if *trusted_relayer_info.key != trusted_relayer_key {
        return Err(Error::AccountOutOfOrder.into());
    }
    // Ensure not already initialized.
    if TrustedRelayerAccount::fetch_data(&mut &trusted_relayer_info.data.borrow()[..])
        .is_ok_and(|d| d.is_some())
    {
        return Err(Error::AlreadyInitialized.into());
    }

    // Account 2: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(Error::AccountOutOfOrder.into());
    }

    // Create trusted relayer PDA.
    let trusted_relayer_account = TrustedRelayerAccount::from(TrustedRelayerData {
        bump_seed: trusted_relayer_bump,
        relayer,
    });
    create_pda_account(
        payer_info,
        &Rent::get()?,
        trusted_relayer_account.size(),
        program_id,
        system_program_info,
        trusted_relayer_info,
        trusted_relayer_pda_seeds!(trusted_relayer_bump),
    )?;
    trusted_relayer_account.store(trusted_relayer_info, false)?;

    Ok(())
}

// ---- Helpers ----

fn fetch_trusted_relayer_data(
    program_id: &Pubkey,
    account: &AccountInfo,
) -> Result<TrustedRelayerData, ProgramError> {
    let data = TrustedRelayerAccount::fetch_data(&mut &account.data.borrow()[..])?
        .ok_or(Error::AccountNotInitialized)?;
    let expected_key =
        Pubkey::create_program_address(trusted_relayer_pda_seeds!(data.bump_seed), program_id)?;
    if *account.key != expected_key {
        return Err(Error::AccountOutOfOrder.into());
    }
    if account.owner != program_id {
        return Err(Error::ProgramIdNotOwner.into());
    }
    Ok(*data)
}

#[cfg(test)]
mod test {
    use super::*;

    use account_utils::DiscriminatorEncode;
    use hyperlane_sealevel_interchain_security_module_interface::{
        InterchainSecurityModuleInstruction, VerifyInstruction,
    };
    use std::str::FromStr;

    fn id() -> Pubkey {
        Pubkey::from_str("TRism11111111111111111111111111111111111111").unwrap()
    }

    fn setup_trusted_relayer_pda(program_id: &Pubkey, relayer: &Pubkey) -> (Pubkey, u8, Vec<u8>) {
        let (key, bump) = Pubkey::find_program_address(trusted_relayer_pda_seeds!(), program_id);
        let mut data = vec![0u8; 1024];
        let mut lamports = 0u64;
        let account_info = AccountInfo::new(
            &key,
            false,
            true,
            &mut lamports,
            &mut data,
            program_id,
            false,
        );
        TrustedRelayerAccount::from(TrustedRelayerData {
            bump_seed: bump,
            relayer: *relayer,
        })
        .store(&account_info, false)
        .unwrap();
        (key, bump, data)
    }

    #[test]
    fn test_verify_succeeds_with_correct_signer() {
        let program_id = id();
        let relayer = Pubkey::new_unique();

        let (pda_key, _bump, mut pda_data) = setup_trusted_relayer_pda(&program_id, &relayer);
        let mut pda_lamports = 0u64;
        let pda_account = AccountInfo::new(
            &pda_key,
            false,
            false,
            &mut pda_lamports,
            &mut pda_data,
            &program_id,
            false,
        );

        let mut relayer_lamports = 0u64;
        let mut relayer_data = vec![];
        let system_id = system_program::ID;
        let relayer_account = AccountInfo::new(
            &relayer,
            true, // is_signer
            false,
            &mut relayer_lamports,
            &mut relayer_data,
            &system_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[pda_account, relayer_account],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert!(result.is_ok());
    }

    #[test]
    fn test_verify_fails_with_wrong_relayer() {
        let program_id = id();
        let relayer = Pubkey::new_unique();
        let wrong_relayer = Pubkey::new_unique();

        let (pda_key, _bump, mut pda_data) = setup_trusted_relayer_pda(&program_id, &relayer);
        let mut pda_lamports = 0u64;
        let pda_account = AccountInfo::new(
            &pda_key,
            false,
            false,
            &mut pda_lamports,
            &mut pda_data,
            &program_id,
            false,
        );

        let mut relayer_lamports = 0u64;
        let mut relayer_data = vec![];
        let system_id = system_program::ID;
        let relayer_account = AccountInfo::new(
            &wrong_relayer,
            true, // is_signer
            false,
            &mut relayer_lamports,
            &mut relayer_data,
            &system_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[pda_account, relayer_account],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert_eq!(result, Err(Error::RelayerMismatch.into()));
    }

    #[test]
    fn test_verify_fails_with_non_signer() {
        let program_id = id();
        let relayer = Pubkey::new_unique();

        let (pda_key, _bump, mut pda_data) = setup_trusted_relayer_pda(&program_id, &relayer);
        let mut pda_lamports = 0u64;
        let pda_account = AccountInfo::new(
            &pda_key,
            false,
            false,
            &mut pda_lamports,
            &mut pda_data,
            &program_id,
            false,
        );

        let mut relayer_lamports = 0u64;
        let mut relayer_data = vec![];
        let system_id = system_program::ID;
        let relayer_account = AccountInfo::new(
            &relayer,
            false, // NOT a signer
            false,
            &mut relayer_lamports,
            &mut relayer_data,
            &system_id,
            false,
        );

        let result = process_instruction(
            &program_id,
            &[pda_account, relayer_account],
            &InterchainSecurityModuleInstruction::Verify(VerifyInstruction {
                metadata: vec![],
                message: vec![],
            })
            .encode()
            .unwrap(),
        );
        assert_eq!(result, Err(Error::RelayerNotSigner.into()));
    }

    #[test]
    fn test_initialize_prevents_reinit() {
        let program_id = id();
        let relayer = Pubkey::new_unique();

        // Pre-initialize the PDA.
        let (pda_key, _bump, mut pda_data) = setup_trusted_relayer_pda(&program_id, &relayer);
        let mut pda_lamports = 0u64;
        let pda_account = AccountInfo::new(
            &pda_key,
            false,
            true,
            &mut pda_lamports,
            &mut pda_data,
            &program_id,
            false,
        );

        let payer_key = Pubkey::new_unique();
        let mut payer_lamports = 0u64;
        let mut payer_data = vec![];
        let system_id = system_program::ID;
        let payer_account = AccountInfo::new(
            &payer_key,
            true,
            false,
            &mut payer_lamports,
            &mut payer_data,
            &system_id,
            false,
        );

        let mut sys_lamports = 0u64;
        let mut sys_data = vec![];
        let sys_account = AccountInfo::new(
            &system_id,
            false,
            false,
            &mut sys_lamports,
            &mut sys_data,
            &system_id,
            true,
        );

        let result = process_instruction(
            &program_id,
            &[payer_account, pda_account, sys_account],
            &DiscriminatorEncode::encode(Instruction::Initialize(relayer)).unwrap(),
        );
        assert_eq!(result, Err(Error::AlreadyInitialized.into()));
    }
}
