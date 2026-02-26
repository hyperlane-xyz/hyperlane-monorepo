use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{
        FeeAccount, FeeAccountData, FeeAccountHeader, FeeData, RouteDomain, RouteDomainData,
    },
    error::Error,
    fee::compute_fee,
    fee_pda_seeds, fee_route_pda_seeds,
    instruction::{FeeInstruction, InitFee, QuoteFee, SetRoute},
};

/// Process a fee program instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = <FeeInstruction as DiscriminatorDecode>::decode(instruction_data)?;

    match instruction {
        FeeInstruction::InitFee(init) => process_init_fee(program_id, accounts, init),
        FeeInstruction::SetRoute(route) => process_set_route(program_id, accounts, route),
        FeeInstruction::RemoveRoute(domain) => process_remove_route(program_id, accounts, domain),
        FeeInstruction::UpdateFeeData(fee_data) => {
            process_update_fee_data(program_id, accounts, fee_data)
        }
        FeeInstruction::SetBeneficiary(new_beneficiary) => {
            process_set_beneficiary(program_id, accounts, new_beneficiary)
        }
        FeeInstruction::TransferOwnership(new_owner) => {
            process_transfer_ownership(program_id, accounts, new_owner)
        }
        FeeInstruction::QuoteFee(quote) => process_quote_fee(program_id, accounts, quote),
    }
}

/// Verifies the fee account is owned by this program.
///
/// WARNING: This is a program-ownership check only, not a full PDA
/// re-derivation. We cannot re-derive the PDA without the original salt.
/// An attacker could create an account with arbitrary data and assign
/// ownership to this program — this check alone does NOT prevent that.
/// The security model relies on:
/// 1. The fee account address being stored in the warp route's FeeConfig
///    (set by the warp route owner), which pins the expected account.
/// 2. For QuoteFee via CPI, the warp route validates fee_account matches
///    FeeConfig before invoking, so a spoofed account can't be substituted.
/// 3. For admin operations (SetRoute, UpdateFeeData, TransferOwnership),
///    the owner signer check provides the authorization.
fn verify_fee_account(
    program_id: &Pubkey,
    fee_account_info: &AccountInfo,
    fee_account: &FeeAccount,
) -> Result<(), ProgramError> {
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    // Bump is stored in the account data; PDA derivation was verified at init time.
    let _ = fee_account.header.bump;
    Ok(())
}

// ---- Handlers ----

/// Initialize a new fee account.
///
/// Accounts:
/// 0. `[executable]` System program
/// 1. `[writable]` Fee account PDA
/// 2. `[signer]` Payer / owner
fn process_init_fee(program_id: &Pubkey, accounts: &[AccountInfo], init: InitFee) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let fee_account_info = next_account_info(accounts_iter)?;
    let (expected_key, bump) = Pubkey::find_program_address(fee_pda_seeds!(init.salt), program_id);
    if fee_account_info.key != &expected_key {
        return Err(Error::InvalidFeeAccountPda.into());
    }
    if !fee_account_info.data_is_empty() {
        return Err(Error::AlreadyInitialized.into());
    }

    let payer = next_account_info(accounts_iter)?;
    if !payer.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let fee_account = FeeAccount {
        header: FeeAccountHeader {
            bump,
            owner: Some(*payer.key),
            beneficiary: init.beneficiary,
        },
        fee_data: init.fee_data,
    };
    let fee_account_data = FeeAccountData::from(fee_account);

    let rent = Rent::get()?;
    create_pda_account(
        payer,
        &rent,
        fee_account_data.size(),
        program_id,
        system_program_account,
        fee_account_info,
        fee_pda_seeds!(init.salt, bump),
    )?;

    fee_account_data.store(fee_account_info, false)?;

    msg!("Fee account initialized: {}", fee_account_info.key);
    Ok(())
}

/// Set a per-domain route for a Routing fee account.
///
/// Accounts:
/// 0. `[executable]` System program
/// 1. `[]` Fee account PDA
/// 2. `[writable]` Route domain PDA
/// 3. `[signer]` Owner
fn process_set_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    route: SetRoute,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let fee_account_info = next_account_info(accounts_iter)?;
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    if fee_account.fee_data != FeeData::Routing {
        return Err(Error::NotRoutingFee.into());
    }

    let route_pda_info = next_account_info(accounts_iter)?;
    let (expected_route_key, route_bump) = Pubkey::find_program_address(
        fee_route_pda_seeds!(fee_account_info.key, route.domain),
        program_id,
    );
    if route_pda_info.key != &expected_route_key {
        return Err(Error::InvalidRouteDomainPda.into());
    }

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    // Nested routing (routing -> routing -> leaf) is not supported.
    // Each route domain must contain a leaf fee type (Linear, Regressive, Progressive).
    if route.fee_data == FeeData::Routing {
        return Err(Error::NestedRoutingNotSupported.into());
    }

    let route_domain = RouteDomain {
        bump: route_bump,
        fee_data: route.fee_data,
    };
    let route_domain_data = RouteDomainData::from(route_domain);

    let rent = Rent::get()?;

    if route_pda_info.data_is_empty() {
        // Create new route domain PDA
        create_pda_account(
            owner_info,
            &rent,
            route_domain_data.size(),
            program_id,
            system_program_account,
            route_pda_info,
            fee_route_pda_seeds!(fee_account_info.key, route.domain, route_bump),
        )?;
    }
    // Store (overwrite with realloc if size changed)
    route_domain_data.store_with_rent_exempt_realloc(
        route_pda_info,
        &rent,
        owner_info,
        system_program_account,
    )?;

    msg!("Route set for domain {}", route.domain);
    Ok(())
}

/// Remove a per-domain route.
///
/// Accounts:
/// 0. `[]` Fee account PDA
/// 1. `[writable]` Route domain PDA
/// 2. `[signer]` Owner
/// 3. `[writable]` Rent recipient
fn process_remove_route(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    domain: u32,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    if fee_account.fee_data != FeeData::Routing {
        return Err(Error::NotRoutingFee.into());
    }

    let route_pda_info = next_account_info(accounts_iter)?;
    let (expected_route_key, _) = Pubkey::find_program_address(
        fee_route_pda_seeds!(fee_account_info.key, domain),
        program_id,
    );
    if route_pda_info.key != &expected_route_key {
        return Err(Error::InvalidRouteDomainPda.into());
    }

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    let rent_recipient = next_account_info(accounts_iter)?;

    // Transfer lamports back and zero the account data.
    let lamports = route_pda_info.lamports();
    **route_pda_info.try_borrow_mut_lamports()? = 0;
    **rent_recipient.try_borrow_mut_lamports()? = rent_recipient
        .lamports()
        .checked_add(lamports)
        .ok_or(ProgramError::ArithmeticOverflow)?;

    // Zero account data to mark as uninitialized.
    route_pda_info.try_borrow_mut_data()?.fill(0);
    // Note: data_len remains >0 until the runtime garbage-collects this
    // 0-lamport account at end of transaction. set_route handles this
    // because it overwrites in place when the PDA already has data.
    // Same-tx remove+recreate is not supported (use set_route to overwrite).
    route_pda_info.assign(&system_program::ID);

    msg!(
        "Route removed for domain {}, account {}",
        domain,
        route_pda_info.key,
    );
    Ok(())
}

/// Update fee data on an existing fee account.
///
/// Note: when switching from Routing to a non-Routing type, existing route
/// domain PDAs are not cleaned up. The owner should call RemoveRoute for
/// each domain before (or after) switching away from Routing.
///
/// Accounts:
/// 0. `[executable]` System program
/// 1. `[writable]` Fee account PDA
/// 2. `[signer]` Owner
fn process_update_fee_data(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_data: FeeData,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let fee_account_info = next_account_info(accounts_iter)?;
    let mut fee_account =
        FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    fee_account.fee_data = fee_data;
    let fee_account_data = FeeAccountData::from(fee_account);

    fee_account_data.store_with_rent_exempt_realloc(
        fee_account_info,
        &Rent::get()?,
        owner_info,
        system_program_account,
    )?;

    msg!("Fee data updated for account {}", fee_account_info.key);
    Ok(())
}

/// Update the beneficiary on an existing fee account.
///
/// Accounts:
/// 0. `[writable]` Fee account PDA
/// 1. `[signer]` Owner
fn process_set_beneficiary(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_beneficiary: Pubkey,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    let mut fee_account =
        FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.ensure_owner_signer(owner_info)?;

    fee_account.header.beneficiary = new_beneficiary;

    FeeAccountData::from(fee_account).store(fee_account_info, false)?;

    msg!(
        "Beneficiary of {} set to {}",
        fee_account_info.key,
        new_beneficiary,
    );
    Ok(())
}

/// Transfer ownership of a fee account.
///
/// Accounts:
/// 0. `[writable]` Fee account PDA
/// 1. `[signer]` Current owner
fn process_transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    let mut fee_account =
        FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    let owner_info = next_account_info(accounts_iter)?;
    fee_account.transfer_ownership(owner_info, new_owner)?;

    FeeAccountData::from(fee_account).store(fee_account_info, false)?;

    msg!(
        "Ownership of {} transferred to {:?}",
        fee_account_info.key,
        new_owner,
    );
    Ok(())
}

/// Quote a fee. Called by warp routes via CPI.
/// Returns fee amount as u64 le bytes via set_return_data.
///
/// Accounts:
/// 0. `[]` Fee account
/// For Routing type, additional accounts:
/// 1. `[]` Route domain PDA
fn process_quote_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    quote: QuoteFee,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();
    verify_fee_account(program_id, fee_account_info, &fee_account)?;

    let fee_amount = match &fee_account.fee_data {
        FeeData::Routing => {
            // Read route domain PDA
            let route_pda_info = next_account_info(accounts_iter)?;
            let (expected_route_key, _) = Pubkey::find_program_address(
                fee_route_pda_seeds!(fee_account_info.key, quote.destination_domain),
                program_id,
            );

            if route_pda_info.key != &expected_route_key {
                return Err(Error::InvalidRouteDomainPda.into());
            }

            // If route PDA is uninitialized (no route set), fee is 0
            if route_pda_info.data_is_empty() || route_pda_info.owner == &system_program::ID {
                0u64
            } else {
                let route_domain =
                    RouteDomainData::fetch(&mut &route_pda_info.data.borrow()[..])?.into_inner();
                // route_domain.fee_data is guaranteed to be a leaf type (not Routing),
                // enforced by process_set_route.
                compute_fee(&route_domain.fee_data, quote.amount)?
            }
        }
        fee_data => compute_fee(fee_data, quote.amount)?,
    };

    set_return_data(&fee_amount.to_le_bytes());

    Ok(())
}

impl AccessControl for FeeAccount {
    fn owner(&self) -> Option<&Pubkey> {
        self.header.owner.as_ref()
    }

    fn set_owner(&mut self, new_owner: Option<Pubkey>) -> Result<(), ProgramError> {
        self.header.owner = new_owner;
        Ok(())
    }
}
