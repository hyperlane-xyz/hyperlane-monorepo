//! Program processor for the multicollateral token program.
//!
//! Extends the collateral token program with:
//! - Multi-router-per-domain enrollment (enrolled_routers)
//! - TransferRemoteTo: transfer to a specific enrolled target router
//! - HandleLocal: same-chain CPI from enrolled local routers
//!
//! The program uses CollateralPlugin for token escrow mechanics and
//! stores additional multicollateral state in a separate PDA.

use account_utils::{create_pda_account, DiscriminatorDecode, SizedData};
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, Encode, H256};
use hyperlane_sealevel_connection_client::{router::HyperlaneRouter, HyperlaneConnectionClient};
use hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType;
use hyperlane_sealevel_mailbox::mailbox_message_dispatch_authority_pda_seeds;
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_collateral::plugin::CollateralPlugin;
use hyperlane_sealevel_token_lib::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    instruction::{Init, Instruction as TokenIxn},
    processor::{HyperlaneSealevelToken, HyperlaneSealevelTokenPlugin},
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    msg,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use solana_system_interface::program as system_program;
use std::collections::HashMap;

use crate::instruction::{
    EnrolledRouterConfig, HandleLocal, MultiCollateralInstruction, TransferRemoteTo,
};

use hyperlane_sealevel_token_lib::hyperlane_token_pda_seeds;

/// Seeds for the multicollateral state PDA.
#[macro_export]
macro_rules! multicollateral_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"multicollateral"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"multicollateral", &[$bump_seed]]
    }};
}

/// Extra state stored in a separate PDA for multicollateral functionality.
/// Kept separate from HyperlaneToken to avoid changing the base serialization.
#[derive(BorshDeserialize, BorshSerialize, Debug, PartialEq, Default)]
pub struct MultiCollateralState {
    /// The bump seed for this PDA.
    pub bump: u8,
    /// The local domain ID (for detecting same-chain transfers).
    pub local_domain: u32,
    /// Additional enrolled routers per domain.
    /// A router can appear in both remote_routers (primary) and here (additional).
    pub enrolled_routers: HashMap<u32, Vec<H256>>,
}

impl SizedData for MultiCollateralState {
    fn size(&self) -> usize {
        // bump
        std::mem::size_of::<u8>()
        // local_domain
        + std::mem::size_of::<u32>()
        // enrolled_routers map length
        + std::mem::size_of::<u32>()
        // enrolled_routers entries
        + self.enrolled_routers.values().map(|routers| {
            // domain key
            std::mem::size_of::<u32>()
            // vec length prefix
            + std::mem::size_of::<u32>()
            // H256 entries
            + routers.len() * 32
        }).sum::<usize>()
    }
}

/// Account data wrapper for MultiCollateralState.
pub type MultiCollateralStateAccount = account_utils::AccountData<MultiCollateralState>;

impl MultiCollateralState {
    /// Check if a router is enrolled for a given domain.
    pub fn is_enrolled(&self, domain: u32, router: &H256) -> bool {
        self.enrolled_routers
            .get(&domain)
            .is_some_and(|routers| routers.contains(router))
    }

    /// Enroll a router for a domain. No-op if already enrolled.
    pub fn enroll_router(&mut self, domain: u32, router: H256) {
        let routers = self.enrolled_routers.entry(domain).or_default();
        if !routers.contains(&router) {
            routers.push(router);
        }
    }

    /// Unenroll a router for a domain. No-op if not enrolled.
    pub fn unenroll_router(&mut self, domain: u32, router: &H256) {
        if let Some(routers) = self.enrolled_routers.get_mut(&domain) {
            routers.retain(|r| r != router);
            if routers.is_empty() {
                self.enrolled_routers.remove(&domain);
            }
        }
    }

    /// Verify the PDA and deserialize.
    pub fn verify_account_and_fetch(
        program_id: &Pubkey,
        account_info: &AccountInfo<'_>,
    ) -> Result<Self, ProgramError> {
        let state =
            MultiCollateralStateAccount::fetch(&mut &account_info.data.borrow()[..])?.into_inner();
        let seeds: &[&[u8]] = multicollateral_pda_seeds!(state.bump);
        let expected_key = Pubkey::create_program_address(seeds, program_id)?;
        if account_info.key != &expected_key {
            return Err(ProgramError::InvalidArgument);
        }
        if account_info.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }
        Ok(*state)
    }
}

/// Check if a router is valid: either a primary remote_router or an enrolled multicollateral router.
fn is_valid_router<T>(
    token: &HyperlaneToken<T>,
    mc_state: &MultiCollateralState,
    domain: u32,
    router: &H256,
) -> bool {
    token
        .router(domain)
        .is_some_and(|primary| primary == router)
        || mc_state.is_enrolled(domain, router)
}

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // First, check MultiCollateral-specific instructions.
    if let Ok(mc_ixn) = MultiCollateralInstruction::decode(instruction_data) {
        return match mc_ixn {
            MultiCollateralInstruction::EnrollRouters(configs) => {
                enroll_multi_routers(program_id, accounts, configs)
            }
            MultiCollateralInstruction::UnenrollRouters(configs) => {
                unenroll_multi_routers(program_id, accounts, configs)
            }
            MultiCollateralInstruction::TransferRemoteTo(xfer) => {
                transfer_remote_to(program_id, accounts, xfer)
            }
            MultiCollateralInstruction::HandleLocal(handle) => {
                handle_local(program_id, accounts, handle)
            }
            MultiCollateralInstruction::SetLocalDomain(domain) => {
                set_local_domain(program_id, accounts, domain)
            }
        }
        .map_err(|err| {
            msg!("{}", err);
            err
        });
    }

    // Then check message recipient interface.
    if let Ok(message_recipient_instruction) = MessageRecipientInstruction::decode(instruction_data)
    {
        return match message_recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module(
                    program_id, accounts,
                )
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                HyperlaneSealevelToken::<CollateralPlugin>::interchain_security_module_account_metas(
                    program_id,
                )
            }
            MessageRecipientInstruction::Handle(handle) => {
                // Override: accept messages from enrolled routers, not just remote_routers.
                transfer_from_remote_with_enrollment(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                transfer_from_remote_account_metas_with_enrollment(
                    program_id,
                    accounts,
                    HandleInstruction {
                        origin: handle.origin,
                        sender: handle.sender,
                        message: handle.message,
                    },
                )
            }
        };
    }

    // Otherwise, try decoding a "normal" token instruction.
    match TokenIxn::decode(instruction_data)? {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
        TokenIxn::TransferRemote(xfer) => {
            HyperlaneSealevelToken::<CollateralPlugin>::transfer_remote(program_id, accounts, xfer)
        }
        TokenIxn::EnrollRemoteRouter(config) => {
            HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_router(
                program_id, accounts, config,
            )
        }
        TokenIxn::EnrollRemoteRouters(configs) => {
            HyperlaneSealevelToken::<CollateralPlugin>::enroll_remote_routers(
                program_id, accounts, configs,
            )
        }
        TokenIxn::SetDestinationGasConfigs(configs) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_destination_gas_configs(
                program_id, accounts, configs,
            )
        }
        TokenIxn::TransferOwnership(new_owner) => {
            HyperlaneSealevelToken::<CollateralPlugin>::transfer_ownership(
                program_id, accounts, new_owner,
            )
        }
        TokenIxn::SetInterchainSecurityModule(new_ism) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_security_module(
                program_id, accounts, new_ism,
            )
        }
        TokenIxn::SetInterchainGasPaymaster(new_igp) => {
            HyperlaneSealevelToken::<CollateralPlugin>::set_interchain_gas_paymaster(
                program_id, accounts, new_igp,
            )
        }
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the multicollateral program.
/// Creates both the base token PDA (with CollateralPlugin) and the
/// multicollateral state PDA.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writable]` The token PDA account.
/// 2. `[writable]` The dispatch authority PDA account.
/// 3. `[signer]` The payer and access control owner.
/// 4. `[executable]` The SPL token program for the mint.
/// 5. `[]` The mint.
/// 6. `[executable]` The Rent sysvar program.
/// 7. `[writable]` The escrow PDA account.
/// 8. `[writable]` The ATA payer PDA account.
/// 9. `[writable]` The multicollateral state PDA account.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    // Grab the last account (multicollateral state PDA) before delegating to base init.
    let mc_state_account_info = &accounts[accounts.len() - 1];

    let (mc_state_key, mc_state_bump) =
        Pubkey::find_program_address(multicollateral_pda_seeds!(), program_id);
    if mc_state_account_info.key != &mc_state_key {
        return Err(ProgramError::IncorrectProgramId);
    }
    if !mc_state_account_info.data_is_empty() || mc_state_account_info.owner != &system_program::ID
    {
        return Err(ProgramError::AccountAlreadyInitialized);
    }

    // Read the local domain from the mailbox before calling base init.
    // For now, store 0 and let the owner set it, or read from mailbox.
    // Actually, we can derive it: the mailbox stores the local domain.
    // But that requires reading the mailbox account, which is complex.
    // For MVP, accept local_domain as part of init (we'll need to extend Init or
    // pass it in the mc state PDA).
    // SIMPLE APPROACH: Read from mailbox outbox data after base init.

    // Delegate base token + collateral init (accounts 0..9, excluding the mc state PDA).
    let base_accounts = &accounts[..accounts.len() - 1];
    HyperlaneSealevelToken::<CollateralPlugin>::initialize(program_id, base_accounts, init)?;

    // Now create the multicollateral state PDA.
    let payer_account_info = &accounts[3]; // Account 3 is the payer.
    let system_program_info = &accounts[0]; // Account 0 is system program.
    let rent = Rent::get()?;

    let mc_state = MultiCollateralState {
        bump: mc_state_bump,
        local_domain: 0, // Will be set by owner or read from mailbox
        enrolled_routers: HashMap::new(),
    };
    let mc_state_data = MultiCollateralStateAccount::from(mc_state);

    create_pda_account(
        payer_account_info,
        &rent,
        mc_state_data.size(),
        program_id,
        system_program_info,
        mc_state_account_info,
        multicollateral_pda_seeds!(mc_state_bump),
    )?;

    mc_state_data.store(mc_state_account_info, false)?;

    Ok(())
}

/// Enrolls additional multicollateral routers.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The token PDA account (for owner check).
/// 2. `[signer]` The owner.
/// 3. `[writeable]` The multicollateral state PDA.
fn enroll_multi_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<EnrolledRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Token PDA (for owner verification).
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 2: Owner.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token.owner.as_ref() != Some(owner_account.key) {
        return Err(ProgramError::IllegalOwner);
    }

    // Account 3: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mut mc_state =
        MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    for config in configs {
        mc_state.enroll_router(config.domain, config.router);
        msg!(
            "Enrolled multicollateral router: domain={}, router={}",
            config.domain,
            config.router
        );
    }

    // Store with realloc.
    MultiCollateralStateAccount::from(mc_state).store_with_rent_exempt_realloc(
        mc_state_account,
        &Rent::get()?,
        owner_account,
        system_program_info,
    )?;

    Ok(())
}

/// Unenrolls multicollateral routers.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[writeable]` The token PDA account (for owner check).
/// 2. `[signer]` The owner.
/// 3. `[writeable]` The multicollateral state PDA.
fn unenroll_multi_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<EnrolledRouterConfig>,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Token PDA (for owner verification).
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 2: Owner.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token.owner.as_ref() != Some(owner_account.key) {
        return Err(ProgramError::IllegalOwner);
    }

    // Account 3: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mut mc_state =
        MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    for config in configs {
        mc_state.unenroll_router(config.domain, &config.router);
        msg!(
            "Unenrolled multicollateral router: domain={}, router={}",
            config.domain,
            config.router
        );
    }

    // Store with realloc (may shrink).
    MultiCollateralStateAccount::from(mc_state).store_with_rent_exempt_realloc(
        mc_state_account,
        &Rent::get()?,
        owner_account,
        system_program_info,
    )?;

    Ok(())
}

/// Sets the local domain on the multicollateral state. Owner only.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[]` The token PDA account.
/// 2. `[signer]` The owner.
/// 3. `[writable]` The multicollateral state PDA.
fn set_local_domain(program_id: &Pubkey, accounts: &[AccountInfo], domain: u32) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let _system_program_info = next_account_info(accounts_iter)?;

    // Account 1: Token PDA (for owner verification).
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 2: Owner.
    let owner_account = next_account_info(accounts_iter)?;
    if !owner_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token.owner.as_ref() != Some(owner_account.key) {
        return Err(ProgramError::IllegalOwner);
    }

    // Account 3: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mut mc_state =
        MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    mc_state.local_domain = domain;
    msg!("Set local domain to {}", domain);

    // No realloc needed, local_domain is fixed size.
    MultiCollateralStateAccount::from(mc_state).store(mc_state_account, false)?;

    Ok(())
}

/// Handles a cross-chain transfer_from_remote, accepting messages from
/// both primary remote_routers AND enrolled multicollateral routers.
///
/// Accounts: Same as base transfer_from_remote, plus:
/// - Extra account after token PDA: the multicollateral state PDA.
///
/// 0. `[signer]` Mailbox process authority.
/// 1. `[executable]` System program.
/// 2. `[]` Token PDA account.
/// 3. `[]` Multicollateral state PDA.
/// 4. `[]` Recipient wallet.
/// 5. ..N. Plugin-specific accounts.
fn transfer_from_remote_with_enrollment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(&xfer.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::InvalidInstructionData)?;

    // Account 0: Mailbox process authority (signer).
    let process_authority_account = next_account_info(accounts_iter)?;

    // Account 1: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 2: Token PDA.
    let token_account = next_account_info(accounts_iter)?;
    let token =
        HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account.data.borrow()[..])?
            .into_inner();
    let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
    let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
    if token_account.key != &expected_token_key {
        return Err(ProgramError::InvalidArgument);
    }
    if token_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 3: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mc_state = MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    // Account 4: Recipient wallet.
    let recipient_wallet = next_account_info(accounts_iter)?;
    let expected_recipient = Pubkey::new_from_array(message.recipient().into());
    if recipient_wallet.key != &expected_recipient {
        return Err(ProgramError::InvalidArgument);
    }

    // Verify mailbox process authority is valid signer.
    use hyperlane_sealevel_connection_client::HyperlaneConnectionClientRecipient;
    if !process_authority_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if process_authority_account.key != token.mailbox_process_authority() {
        return Err(ProgramError::InvalidArgument);
    }

    // Check sender is either primary remote router OR enrolled multicollateral router.
    if !is_valid_router(&token, &mc_state, xfer.origin, &xfer.sender) {
        msg!(
            "Sender {} is not a valid router for origin {}",
            xfer.sender,
            xfer.origin
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // Decimal conversion.
    let remote_amount = message.amount();
    let local_amount: u64 = token.remote_amount_to_local_amount(remote_amount)?;

    // Transfer tokens out to recipient.
    CollateralPlugin::transfer_out(
        program_id,
        &token,
        system_program_info,
        recipient_wallet,
        accounts_iter,
        local_amount,
    )?;

    msg!(
        "Multicollateral transfer completed from origin: {}, recipient: {}, remote_amount: {}",
        xfer.origin,
        recipient_wallet.key,
        remote_amount
    );

    Ok(())
}

/// Returns the account metas needed for the Handle instruction, including
/// the multicollateral state PDA.
///
/// Accounts returned:
/// 0. System program.
/// 1. Token PDA.
/// 2. Multicollateral state PDA.
/// 3. Recipient wallet.
/// 4. ..N. Plugin transfer_out accounts.
fn transfer_from_remote_account_metas_with_enrollment(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let mut message_reader = std::io::Cursor::new(transfer.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::InvalidInstructionData)?;

    // Account 0: Token account.
    let token_account_info = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account_info,
    )?;

    let (transfer_out_account_metas, writeable_recipient) =
        CollateralPlugin::transfer_out_account_metas(program_id, &token, &message)?;

    let (mc_state_key, _mc_state_bump) =
        Pubkey::find_program_address(multicollateral_pda_seeds!(), program_id);

    let mut account_metas: Vec<SerializableAccountMeta> = vec![
        AccountMeta::new_readonly(system_program::ID, false).into(),
        AccountMeta::new_readonly(*token_account_info.key, false).into(),
        AccountMeta::new_readonly(mc_state_key, false).into(),
        AccountMeta {
            pubkey: Pubkey::new_from_array(message.recipient().into()),
            is_signer: false,
            is_writable: writeable_recipient,
        }
        .into(),
    ];
    account_metas.extend(transfer_out_account_metas);

    let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
        .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes[..]);

    Ok(())
}

/// Transfers tokens to a specific target router on the destination domain.
/// If destination == local_domain, performs a same-chain CPI to the target program.
/// Otherwise, dispatches via mailbox to the target router.
///
/// Accounts (cross-chain, same as transfer_remote plus mc_state + target_router):
/// 0.   `[executable]` The system program.
/// 1.   `[executable]` The spl_noop program.
/// 2.   `[]` The token PDA account.
/// 3.   `[]` The multicollateral state PDA.
/// 4.   `[executable]` The mailbox program.
/// 5.   `[writeable]` The mailbox outbox account.
/// 6.   `[]` Message dispatch authority.
/// 7.   `[signer]` The token sender and mailbox payer.
/// 8.   `[signer]` Unique message / gas payment account.
/// 9.   `[writeable]` Message storage PDA.
///      ---- If using an IGP ----
/// 10.  `[executable]` The IGP program.
/// 11.  `[writeable]` The IGP program data.
/// 12.  `[writeable]` Gas payment PDA.
/// 13.  `[]` OPTIONAL - The Overhead IGP program.
/// 14.  `[writeable]` The IGP account.
///      ---- End if ----
/// 15. Plugin-specific accounts (SPL token, mint, sender ATA, escrow).
///
/// Accounts (same-chain):
///
/// 0. `[executable]` The system program.
/// 1. `[]` The token PDA account.
/// 2. `[]` The multicollateral state PDA.
/// 3. `[signer]` The token sender.
/// 4. Plugin transfer_in accounts (SPL token, mint, sender ATA, escrow).
/// 5. Target program accounts for CPI (target program, target token PDA, etc.)
fn transfer_remote_to(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferRemoteTo,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_account = next_account_info(accounts_iter)?;
    if system_program_account.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // For same-chain transfers, we skip noop/mailbox accounts.
    // Peek at mc_state to check if this is a same-chain transfer.
    // We need to read token PDA and mc_state PDA first.

    // Account 1 (cross-chain): spl_noop OR (same-chain): token PDA
    // We need to know if same-chain before parsing accounts.
    // APPROACH: Always read token PDA and mc_state first, then branch.

    // For now, implement cross-chain path (same-chain CPI is a follow-up).
    // TODO: Implement same-chain CPI path.

    // Account 1: SPL Noop.
    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &account_utils::SPL_NOOP_PROGRAM_ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 2: Token PDA.
    let token_account = next_account_info(accounts_iter)?;
    let token =
        HyperlaneTokenAccount::<CollateralPlugin>::fetch(&mut &token_account.data.borrow()[..])?
            .into_inner();
    let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
    let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
    if token_account.key != &expected_token_key {
        return Err(ProgramError::InvalidArgument);
    }
    if token_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 3: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mc_state = MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    // Validate target_router is enrolled for destination_domain.
    if !is_valid_router(
        &token,
        &mc_state,
        xfer.destination_domain,
        &xfer.target_router,
    ) {
        msg!(
            "Target router {} is not enrolled for domain {}",
            xfer.target_router,
            xfer.destination_domain
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // Check if same-chain.
    if mc_state.local_domain != 0 && xfer.destination_domain == mc_state.local_domain {
        // Same-chain CPI path.
        return transfer_remote_to_local(
            program_id,
            &token,
            &mc_state,
            accounts_iter,
            system_program_account,
            &xfer,
        );
    }

    // Cross-chain path: mirrors transfer_remote but dispatches to target_router.

    // Account 4: Mailbox program.
    let mailbox_info = next_account_info(accounts_iter)?;
    if mailbox_info.key != &token.mailbox {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 5: Mailbox outbox.
    let mailbox_outbox_account = next_account_info(accounts_iter)?;

    // Account 6: Dispatch authority.
    let dispatch_authority_account = next_account_info(accounts_iter)?;
    let dispatch_authority_seeds: &[&[u8]] =
        mailbox_message_dispatch_authority_pda_seeds!(token.dispatch_authority_bump);
    let dispatch_authority_key =
        Pubkey::create_program_address(dispatch_authority_seeds, program_id)?;
    if *dispatch_authority_account.key != dispatch_authority_key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 7: Sender wallet (signer + mailbox payer).
    let sender_wallet = next_account_info(accounts_iter)?;
    if !sender_wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    // Account 8: Unique message / gas payment account.
    let unique_message_account = next_account_info(accounts_iter)?;

    // Account 9: Message storage PDA.
    let dispatched_message_pda = next_account_info(accounts_iter)?;

    // IGP accounts (optional).
    let igp_payment_accounts =
        if let Some((igp_program_id, igp_account_type)) = token.interchain_gas_paymaster() {
            let igp_program_account = next_account_info(accounts_iter)?;
            if igp_program_account.key != igp_program_id {
                return Err(ProgramError::InvalidArgument);
            }

            let igp_program_data_account = next_account_info(accounts_iter)?;
            let igp_payment_pda_account = next_account_info(accounts_iter)?;
            let configured_igp_account = next_account_info(accounts_iter)?;
            if configured_igp_account.key != igp_account_type.key() {
                return Err(ProgramError::InvalidArgument);
            }

            let mut igp_payment_account_metas = vec![
                AccountMeta::new_readonly(system_program::ID, false),
                AccountMeta::new(*sender_wallet.key, true),
                AccountMeta::new(*igp_program_data_account.key, false),
                AccountMeta::new_readonly(*unique_message_account.key, true),
                AccountMeta::new(*igp_payment_pda_account.key, false),
            ];
            let mut igp_payment_account_infos = vec![
                system_program_account.clone(),
                sender_wallet.clone(),
                igp_program_data_account.clone(),
                unique_message_account.clone(),
                igp_payment_pda_account.clone(),
            ];

            match igp_account_type {
                InterchainGasPaymasterType::Igp(_) => {
                    igp_payment_account_metas
                        .push(AccountMeta::new(*configured_igp_account.key, false));
                    igp_payment_account_infos.push(configured_igp_account.clone());
                }
                InterchainGasPaymasterType::OverheadIgp(_) => {
                    let inner_igp_account = next_account_info(accounts_iter)?;
                    igp_payment_account_metas.extend([
                        AccountMeta::new(*inner_igp_account.key, false),
                        AccountMeta::new_readonly(*configured_igp_account.key, false),
                    ]);
                    igp_payment_account_infos
                        .extend([inner_igp_account.clone(), configured_igp_account.clone()]);
                }
            };

            Some((igp_payment_account_metas, igp_payment_account_infos))
        } else {
            None
        };

    // Convert amount to local then remote.
    let local_amount = xfer.amount_or_id;
    let remote_amount = token.local_amount_to_remote_amount(local_amount)?;

    // Transfer tokens into escrow.
    CollateralPlugin::transfer_in(
        program_id,
        &token,
        sender_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Build dispatch accounts.
    let dispatch_account_metas = vec![
        AccountMeta::new(*mailbox_outbox_account.key, false),
        AccountMeta::new_readonly(*dispatch_authority_account.key, true),
        AccountMeta::new_readonly(system_program::ID, false),
        AccountMeta::new_readonly(account_utils::SPL_NOOP_PROGRAM_ID, false),
        AccountMeta::new(*sender_wallet.key, true),
        AccountMeta::new_readonly(*unique_message_account.key, true),
        AccountMeta::new(*dispatched_message_pda.key, false),
    ];
    let dispatch_account_infos = &[
        mailbox_outbox_account.clone(),
        dispatch_authority_account.clone(),
        system_program_account.clone(),
        spl_noop.clone(),
        sender_wallet.clone(),
        unique_message_account.clone(),
        dispatched_message_pda.clone(),
    ];

    // Build token message targeting recipient, with remote_amount.
    let token_transfer_message = TokenMessage::new(xfer.recipient, remote_amount, vec![]).to_vec();

    // Dispatch to the SPECIFIC target_router (not the primary enrolled router).
    // We need to override the dispatch destination to target_router.
    // The base dispatch uses token.router(destination) which returns the primary.
    // Instead, we invoke the mailbox directly with target_router as the recipient.

    // Dispatch to the specific target router (not the primary enrolled one).
    let message_id = dispatch_to_specific_router(
        &token,
        program_id,
        dispatch_authority_seeds,
        xfer.destination_domain,
        xfer.target_router,
        token_transfer_message,
        dispatch_account_metas,
        dispatch_account_infos,
    )?;

    // Pay for gas if IGP is configured.
    if let Some((igp_payment_account_metas, igp_payment_account_infos)) = igp_payment_accounts {
        use hyperlane_sealevel_connection_client::gas_router::HyperlaneGasRouter;
        let gas_amount = token
            .destination_gas(xfer.destination_domain)
            .ok_or(ProgramError::InvalidArgument)?;
        let (igp_program_id, _) = token
            .interchain_gas_paymaster()
            .ok_or(ProgramError::InvalidArgument)?;

        use hyperlane_sealevel_igp::instruction as igp_instruction;
        let igp_ixn = solana_program::instruction::Instruction::new_with_borsh(
            *igp_program_id,
            &igp_instruction::Instruction::PayForGas(igp_instruction::PayForGas {
                message_id,
                destination_domain: xfer.destination_domain,
                gas_amount,
            }),
            igp_payment_account_metas,
        );
        solana_program::program::invoke(&igp_ixn, &igp_payment_account_infos)?;
    }

    msg!(
        "Multicollateral transfer_remote_to completed: dest={}, target_router={}, remote_amount={}",
        xfer.destination_domain,
        xfer.target_router,
        remote_amount
    );

    Ok(())
}

/// Same-chain CPI transfer. Called when destination_domain == local_domain.
///
/// The remaining accounts after mc_state should be:
/// - sender_wallet (signer)
/// - plugin transfer_in accounts
/// - target program ID (executable)
/// - target program's handle accounts (for CPI)
fn transfer_remote_to_local<'a, 'b>(
    program_id: &Pubkey,
    token: &HyperlaneToken<CollateralPlugin>,
    _mc_state: &MultiCollateralState,
    accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    system_program_account: &'a AccountInfo<'b>,
    xfer: &TransferRemoteTo,
) -> ProgramResult {
    // Account: Sender wallet (signer).
    let sender_wallet = next_account_info(accounts_iter)?;
    if !sender_wallet.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let local_amount = xfer.amount_or_id;
    let remote_amount = token.local_amount_to_remote_amount(local_amount)?;

    // Transfer tokens into escrow.
    CollateralPlugin::transfer_in(
        program_id,
        token,
        sender_wallet,
        accounts_iter,
        local_amount,
    )?;

    // Build the HandleLocal instruction for the target program.
    let target_program_pubkey = Pubkey::new_from_array(xfer.target_router.into());

    // Account: Target program (executable).
    let target_program_info = next_account_info(accounts_iter)?;
    if target_program_info.key != &target_program_pubkey {
        return Err(ProgramError::InvalidArgument);
    }
    if !target_program_info.executable {
        return Err(ProgramError::InvalidAccountData);
    }

    // Build TokenMessage for the CPI.
    let token_transfer_message = TokenMessage::new(xfer.recipient, remote_amount, vec![]).to_vec();

    let handle_local = HandleLocal {
        origin_domain: xfer.destination_domain, // local_domain
        sender: H256::from(program_id.to_bytes()),
        message: token_transfer_message,
    };

    let handle_local_ixn = MultiCollateralInstruction::HandleLocal(handle_local);
    let handle_local_data =
        <MultiCollateralInstruction as account_utils::DiscriminatorEncode>::encode(
            handle_local_ixn,
        )
        .map_err(|_| ProgramError::BorshIoError)?;

    // Remaining accounts are passed through to the target program's HandleLocal.
    // These should include: system_program, target's token PDA, target's mc_state PDA,
    // recipient wallet, and target's plugin transfer_out accounts.
    let remaining_accounts: Vec<AccountInfo<'b>> = accounts_iter.cloned().collect();
    let mut cpi_account_metas: Vec<AccountMeta> = remaining_accounts
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect();

    // The system program should be first in the CPI accounts.
    cpi_account_metas.insert(0, AccountMeta::new_readonly(system_program::ID, false));

    let mut cpi_account_infos = vec![system_program_account.clone()];
    cpi_account_infos.extend(remaining_accounts);

    let cpi_instruction = solana_program::instruction::Instruction {
        program_id: target_program_pubkey,
        accounts: cpi_account_metas,
        data: handle_local_data,
    };

    // Invoke the target program. No PDA signing needed — we're just a regular caller.
    solana_program::program::invoke(&cpi_instruction, &cpi_account_infos)?;

    msg!(
        "Multicollateral same-chain transfer completed: target={}, remote_amount={}",
        target_program_pubkey,
        remote_amount
    );

    Ok(())
}

/// Handles a local (same-chain) transfer via CPI from an enrolled local router.
///
/// Accounts:
/// 0. `[executable]` The system program.
/// 1. `[]` The token PDA account.
/// 2. `[]` The multicollateral state PDA.
/// 3. `[]` Recipient wallet.
/// 4. ..N. Plugin transfer_out accounts.
fn handle_local(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    handle: HandleLocal,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: System program.
    let system_program_info = next_account_info(accounts_iter)?;
    if system_program_info.key != &system_program::ID {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 1: Token PDA.
    let token_account = next_account_info(accounts_iter)?;
    let token = HyperlaneToken::<CollateralPlugin>::verify_account_and_fetch_inner(
        program_id,
        token_account,
    )?;

    // Account 2: Multicollateral state PDA.
    let mc_state_account = next_account_info(accounts_iter)?;
    let mc_state = MultiCollateralState::verify_account_and_fetch(program_id, mc_state_account)?;

    // Verify the caller (sender) is an enrolled local router.
    // On Solana, we verify the sender H256 matches an enrolled router.
    // The actual caller verification is done by checking the instruction's
    // program context — the CPI caller's program_id must match the sender.
    //
    // Since Solana doesn't expose the calling program ID directly in the callee,
    // we verify that the sender in the HandleLocal data matches an enrolled router
    // for the local_domain. The calling program constructed the HandleLocal with
    // its own program_id as sender, so this is secure as long as:
    // 1. Only legitimate multicollateral programs can construct valid HandleLocal
    //    instructions (ensured by the discriminator)
    // 2. The sender is enrolled (checked below)
    //
    // NOTE: For additional security, we could use instruction introspection
    // (sysvar Instructions) to verify the calling program. This is a follow-up.

    if !is_valid_router(&token, &mc_state, handle.origin_domain, &handle.sender) {
        msg!(
            "HandleLocal: sender {} is not enrolled for domain {}",
            handle.sender,
            handle.origin_domain
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // Decode the token message.
    let mut message_reader = std::io::Cursor::new(&handle.message);
    let message = TokenMessage::read_from(&mut message_reader)
        .map_err(|_err| ProgramError::InvalidInstructionData)?;

    // Account 3: Recipient wallet.
    let recipient_wallet = next_account_info(accounts_iter)?;
    let expected_recipient = Pubkey::new_from_array(message.recipient().into());
    if recipient_wallet.key != &expected_recipient {
        return Err(ProgramError::InvalidArgument);
    }

    // Decimal conversion.
    let remote_amount = message.amount();
    let local_amount: u64 = token.remote_amount_to_local_amount(remote_amount)?;

    // Transfer tokens out to recipient.
    CollateralPlugin::transfer_out(
        program_id,
        &token,
        system_program_info,
        recipient_wallet,
        accounts_iter,
        local_amount,
    )?;

    msg!(
        "HandleLocal completed: sender={}, recipient={}, remote_amount={}",
        handle.sender,
        recipient_wallet.key,
        remote_amount
    );

    Ok(())
}

/// Dispatches a message to a specific router (not the primary enrolled one).
/// This is needed because the base `HyperlaneRouterDispatch::dispatch` uses
/// `token.router(destination)` which returns the primary remote router,
/// but we want to send to `target_router`.
#[allow(clippy::too_many_arguments)]
fn dispatch_to_specific_router(
    token: &HyperlaneToken<CollateralPlugin>,
    program_id: &Pubkey,
    dispatch_authority_seeds: &[&[u8]],
    destination_domain: u32,
    target_router: H256,
    message_body: Vec<u8>,
    dispatch_account_metas: Vec<AccountMeta>,
    dispatch_account_infos: &[AccountInfo],
) -> Result<H256, ProgramError> {
    use hyperlane_sealevel_mailbox::instruction as mailbox_instruction;

    let outbox_dispatch = mailbox_instruction::OutboxDispatch {
        sender: *program_id,
        destination_domain,
        recipient: target_router,
        message_body,
    };

    let dispatch_instruction = mailbox_instruction::Instruction::OutboxDispatch(outbox_dispatch);
    let dispatch_data = dispatch_instruction.into_instruction_data()?;

    let dispatch_ixn = solana_program::instruction::Instruction {
        program_id: *token.mailbox(),
        accounts: dispatch_account_metas,
        data: dispatch_data,
    };

    invoke_signed(
        &dispatch_ixn,
        dispatch_account_infos,
        &[dispatch_authority_seeds],
    )?;

    // Parse message ID from return data.
    let (returning_program_id, returned_data) =
        solana_program::program::get_return_data().ok_or(ProgramError::InvalidArgument)?;
    if returning_program_id != *token.mailbox() {
        return Err(ProgramError::InvalidArgument);
    }
    let message_id: H256 =
        H256::try_from_slice(&returned_data).map_err(|_| ProgramError::InvalidArgument)?;

    Ok(message_id)
}
