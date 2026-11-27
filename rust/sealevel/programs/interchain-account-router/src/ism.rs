//! Message-selected verification with a live mailbox-default fallback.

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, HyperlaneMessage, ModuleType, H256};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction as IsmInstruction, MetadataSpecResult,
    VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_sealevel_mailbox::{accounts::Inbox, mailbox_inbox_pda_seeds};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{get_return_data, invoke, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    accounts::{config_address, RouterConfig},
    message::InterchainAccountMessage,
};

/// Accounts: config/VAM, mailbox Inbox, selected ISM program, selected ISM VAM,
/// then selected ISM accounts. Discovery retains the child's VAM even when its
/// Verify interface uses a different storage account (as legacy multisig ISMs do).
pub(crate) fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: IsmInstruction,
) -> ProgramResult {
    let message_bytes = match &instruction {
        // Composite exposes metadata discovery, which the Sealevel relayer uses
        // to build the selected ISM's metadata without an EVM-style route getter.
        IsmInstruction::Type => return return_data(ModuleType::Composite as u32),
        IsmInstruction::Verify(data) | IsmInstruction::VerifyAccountMetas(data) => &data.message,
        IsmInstruction::VerifyMetadataSpec(data) => &data.message,
    };
    let message = HyperlaneMessage::read_from(&mut message_bytes.as_slice())
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    if message.recipient != H256::from(program_id.to_bytes()) {
        return Err(ProgramError::InvalidInstructionData);
    }
    let body = InterchainAccountMessage::decode(&message.body)?;
    let config_info = accounts.first().ok_or(ProgramError::NotEnoughAccountKeys)?;
    let config = RouterConfig::load(program_id, config_info)?;
    let inbox_key = Pubkey::find_program_address(mailbox_inbox_pda_seeds!(), &config.mailbox).0;
    let mut prefix = vec![
        AccountMeta::new_readonly(config_address(program_id).0, false),
        AccountMeta::new_readonly(inbox_key, false),
    ];
    if !matches!(accounts.get(1), Some(info) if info.key == &inbox_key) {
        return request_accounts(&instruction, prefix);
    }
    // Read the authenticated account directly; a CPI back into Mailbox would
    // be indirect reentrancy. Mailbox passes this account read-only during Verify.
    let inbox = Inbox::verify_account_and_fetch_inner(&config.mailbox, &accounts[1])?;
    let ism = if body.ism == H256::zero() {
        inbox.default_ism
    } else {
        Pubkey::new_from_array(body.ism.0)
    };
    if ism == Pubkey::default() || ism == *program_id || ism == config.mailbox {
        return Err(ProgramError::InvalidArgument);
    }
    let vam = Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &ism).0;
    prefix.push(AccountMeta::new_readonly(ism, false));
    prefix.push(AccountMeta::new_readonly(vam, false));
    if accounts.len() < prefix.len()
        || !prefix
            .iter()
            .zip(accounts)
            .all(|(meta, info)| meta.pubkey == *info.key)
    {
        return request_accounts(&instruction, prefix);
    }
    if !accounts[2].executable {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mut child_accounts = &accounts[3..];
    if matches!(instruction, IsmInstruction::Verify(_)) && child_accounts[0].owner != &ism {
        // A discovery-only sentinel is not part of a legacy ISM's Verify accounts.
        child_accounts = &child_accounts[1..];
    }
    let metas = child_accounts.iter().map(account_meta).collect();
    invoke(
        &Instruction::new_with_bytes(ism, &instruction.encode()?, metas),
        accounts,
    )?;
    match instruction {
        IsmInstruction::Verify(_) => Ok(()),
        IsmInstruction::VerifyAccountMetas(_) => {
            let child: Vec<SerializableAccountMeta> = child_return_data(&ism)?;
            // Retain the VAM sentinel for subsequent discovery passes. Composite
            // ISMs also return it as storage; merge that first occurrence only.
            let mut child = child.into_iter();
            if let Some(first) = child.next() {
                if first.pubkey == vam {
                    prefix[3].is_writable |= first.is_writable;
                    prefix[3].is_signer |= first.is_signer;
                } else {
                    prefix.push(first.into());
                }
            }
            prefix.extend(child.map(Into::into));
            return_metas(prefix)
        }
        IsmInstruction::VerifyMetadataSpec(_) => {
            let mut result: MetadataSpecResult = child_return_data(&ism)?;
            if result.spec.is_none() {
                // Child results include their VAM as the first account.
                if result.accounts.first() != Some(&vam) {
                    return Err(ProgramError::InvalidAccountData);
                }
                let mut full: Vec<Pubkey> = prefix[..3].iter().map(|meta| meta.pubkey).collect();
                full.extend(result.accounts);
                result.accounts = full;
            }
            return_data(result)
        }
        IsmInstruction::Type => unreachable!(),
    }
}

fn account_meta(info: &AccountInfo) -> AccountMeta {
    AccountMeta {
        pubkey: *info.key,
        is_signer: info.is_signer,
        is_writable: info.is_writable,
    }
}

fn request_accounts(instruction: &IsmInstruction, accounts: Vec<AccountMeta>) -> ProgramResult {
    match instruction {
        IsmInstruction::VerifyAccountMetas(_) => return_metas(accounts),
        IsmInstruction::VerifyMetadataSpec(_) => return_data(MetadataSpecResult {
            spec: None,
            accounts: accounts.into_iter().map(|meta| meta.pubkey).collect(),
        }),
        _ => Err(ProgramError::InvalidArgument),
    }
}

fn return_metas(accounts: Vec<AccountMeta>) -> ProgramResult {
    let accounts: Vec<SerializableAccountMeta> = accounts.into_iter().map(Into::into).collect();
    return_data(accounts)
}

fn return_data<T: BorshSerialize + BorshDeserialize>(value: T) -> ProgramResult {
    set_return_data(&borsh::to_vec(&SimulationReturnData::new(value))?);
    Ok(())
}

fn child_return_data<T: BorshSerialize + BorshDeserialize>(
    ism: &Pubkey,
) -> Result<T, ProgramError> {
    let (program, data) = get_return_data().ok_or(ProgramError::InvalidAccountData)?;
    if program != *ism {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(SimulationReturnData::<T>::try_from_slice(&data)?.return_data)
}
