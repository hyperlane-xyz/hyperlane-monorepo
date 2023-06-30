//! Processor logic shared by all Hyperlane Sealevel Token programs.

use access_control::AccessControl;
use account_utils::create_pda_account;
use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, Encode};
use hyperlane_sealevel_connection_client::{
    router::{
        HyperlaneRouterAccessControl, HyperlaneRouterDispatch, HyperlaneRouterMessageRecipient,
        RemoteRouterConfig,
    },
    HyperlaneConnectionClient, HyperlaneConnectionClientSetterAccessControl,
};
use hyperlane_sealevel_mailbox::{
    mailbox_message_dispatch_authority_pda_seeds, mailbox_process_authority_pda_seeds,
};
use hyperlane_sealevel_message_recipient_interface::HandleInstruction;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    msg,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use std::collections::HashMap;

use crate::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    error::Error,
    instruction::{Init, TransferRemote},
    message::TokenMessage,
};

/// Seeds relating to the PDA account with information about this warp route.
/// For convenience in getting the account metas required for handling messages,
/// this is the same as the `HANDLE_ACCOUNT_METAS_PDA_SEEDS` in the message
/// recipient interface.
#[macro_export]
macro_rules! hyperlane_token_pda_seeds {
    () => {{
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
        ]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_message_recipient",
            b"-",
            b"handle",
            b"-",
            b"account_metas",
            &[$bump_seed],
        ]
    }};
}

/// A plugin that handles token transfers for a Hyperlane Sealevel Token program.
pub trait HyperlaneSealevelTokenPlugin
where
    Self:
        BorshSerialize + BorshDeserialize + std::cmp::PartialEq + std::fmt::Debug + Default + Sized,
{
    /// Initializes the plugin.
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError>;

    /// Transfers tokens into the program.
    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError>;

    /// Transfers tokens out of the program.
    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError>;

    /// Gets the AccountMetas required by the `transfer_out` function.
    /// Returns (AccountMetas, whether recipient wallet must be writeable)
    fn transfer_out_account_metas(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        token_message: &TokenMessage,
    ) -> Result<(Vec<SerializableAccountMeta>, bool), ProgramError>;
}

/// Core functionality of a Hyperlane Sealevel Token program that uses
/// a plugin to handle token transfers.
pub struct HyperlaneSealevelToken<
    T: HyperlaneSealevelTokenPlugin
        + BorshDeserialize
        + BorshSerialize
        + std::cmp::PartialEq
        + std::fmt::Debug,
> {
    _plugin: std::marker::PhantomData<T>,
}

impl<T> HyperlaneSealevelToken<T>
where
    T: HyperlaneSealevelTokenPlugin
        + BorshSerialize
        + BorshDeserialize
        + std::cmp::PartialEq
        + std::fmt::Debug
        + Default,
{
    /// Initializes the program.
    ///
    /// Accounts:
    /// 0.   [executable] The system program.
    /// 1.   [writable] The token PDA account.
    /// 2.   [writable] The dispatch authority PDA account.
    /// 3.   [signer] The payer and access control owner.
    /// 4..N [??..??] Plugin-specific accounts.
    pub fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
        // On chain create appears to use realloc which is limited to 1024 byte increments.
        let token_account_size = 2048;

        let accounts_iter = &mut accounts.iter();

        // Account 0: System program
        let system_program_id = solana_program::system_program::id();
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &system_program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: Token storage account
        let token_account = next_account_info(accounts_iter)?;
        let (token_key, token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
        if &token_key != token_account.key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !token_account.data_is_empty() || token_account.owner != &system_program_id {
            return Err(ProgramError::AccountAlreadyInitialized);
        }

        // Account 2: Dispatch authority PDA.
        let dispatch_authority_account = next_account_info(accounts_iter)?;
        let (dispatch_authority_key, dispatch_authority_bump) = Pubkey::find_program_address(
            mailbox_message_dispatch_authority_pda_seeds!(),
            program_id,
        );
        if *dispatch_authority_account.key != dispatch_authority_key {
            return Err(ProgramError::IncorrectProgramId);
        }
        if !dispatch_authority_account.data_is_empty()
            || dispatch_authority_account.owner != &system_program_id
        {
            return Err(ProgramError::AccountAlreadyInitialized);
        }

        // Account 3: Payer
        let payer_account = next_account_info(accounts_iter)?;
        if !payer_account.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Get the Mailbox's process authority that is specific to this program
        // as a recipient.
        let (mailbox_process_authority, _mailbox_process_authority_bump) =
            Pubkey::find_program_address(
                mailbox_process_authority_pda_seeds!(program_id),
                &init.mailbox,
            );

        let plugin_data = T::initialize(
            program_id,
            system_program,
            token_account,
            payer_account,
            accounts_iter,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        let rent = Rent::get()?;

        // Create token account PDA
        create_pda_account(
            payer_account,
            &rent,
            token_account_size,
            program_id,
            system_program,
            token_account,
            hyperlane_token_pda_seeds!(token_bump),
        )?;

        // Create dispatch authority PDA
        create_pda_account(
            payer_account,
            &rent,
            0,
            program_id,
            system_program,
            dispatch_authority_account,
            mailbox_message_dispatch_authority_pda_seeds!(dispatch_authority_bump),
        )?;

        let token: HyperlaneToken<T> = HyperlaneToken {
            bump: token_bump,
            mailbox: init.mailbox,
            mailbox_process_authority,
            dispatch_authority_bump,
            owner: Some(*payer_account.key),
            interchain_security_module: init.interchain_security_module,
            decimals: init.decimals,
            remote_decimals: init.remote_decimals,
            remote_routers: HashMap::new(),
            plugin_data,
        };
        HyperlaneTokenAccount::<T>::from(token).store(token_account, true)?;

        Ok(())
    }

    /// Transfers tokens to a remote.
    /// Burns the tokens from the sender's associated token account and
    /// then dispatches a message to the remote recipient.
    ///
    /// Accounts:
    /// 0.   [executable] The system program.
    /// 1.   [executable] The spl_noop program.
    /// 2.   [] The token PDA account.
    /// 3.   [executable] The mailbox program.
    /// 4.   [writeable] The mailbox outbox account.
    /// 5.   [] Message dispatch authority.
    /// 6.   [signer] The token sender and mailbox payer.
    /// 7.   [signer] Unique message account.
    /// 8.   [writeable] Message storage PDA.
    /// 9..N [??..??] Plugin-specific accounts.
    pub fn transfer_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: TransferRemote,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: System program.
        let system_program_account = next_account_info(accounts_iter)?;
        if system_program_account.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 0: SPL Noop
        let spl_noop = next_account_info(accounts_iter)?;
        if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token storage account
        let token_account = next_account_info(accounts_iter)?;
        let token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow_mut()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 2: Mailbox program
        let mailbox_info = next_account_info(accounts_iter)?;
        if mailbox_info.key != &token.mailbox {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Mailbox Outbox data account.
        // No verification is performed here, the Mailbox will do that.
        let mailbox_outbox_account = next_account_info(accounts_iter)?;

        // Account 4: Message dispatch authority
        let dispatch_authority_account = next_account_info(accounts_iter)?;
        let dispatch_authority_seeds: &[&[u8]] =
            mailbox_message_dispatch_authority_pda_seeds!(token.dispatch_authority_bump);
        let dispatch_authority_key =
            Pubkey::create_program_address(dispatch_authority_seeds, program_id)?;
        if *dispatch_authority_account.key != dispatch_authority_key {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 5: Sender account / mailbox payer
        let sender_wallet = next_account_info(accounts_iter)?;
        if !sender_wallet.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        // Account 6: Unique message account
        // Defer to the checks in the Mailbox, no need to verify anything here.
        let unique_message_account = next_account_info(accounts_iter)?;

        // Account 7: Message storage PDA.
        // Similarly defer to the checks in the Mailbox to ensure account validity.
        let dispatched_message_pda = next_account_info(accounts_iter)?;

        // The amount denominated in the local decimals.
        let local_amount: u64 = xfer
            .amount_or_id
            .try_into()
            .map_err(|_| Error::IntegerOverflow)?;
        // Convert to the remote number of decimals, which is universally understood
        // by the remote routers as the number of decimals used by the message amount.
        let remote_amount = token.local_amount_to_remote_amount(local_amount)?;

        // Transfer `local_amount` of tokens in...
        T::transfer_in(
            program_id,
            &*token,
            sender_wallet,
            accounts_iter,
            local_amount,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        // The token message body, which specifies the remote_amount.
        let token_transfer_message =
            TokenMessage::new(xfer.recipient, remote_amount, vec![]).to_vec();

        // Dispatch the message.
        token.dispatch(
            program_id,
            dispatch_authority_seeds,
            xfer.destination_domain,
            token_transfer_message,
            vec![
                AccountMeta::new(*mailbox_outbox_account.key, false),
                AccountMeta::new_readonly(*dispatch_authority_account.key, true),
                AccountMeta::new_readonly(solana_program::system_program::id(), false),
                AccountMeta::new_readonly(spl_noop::id(), false),
                AccountMeta::new(*sender_wallet.key, true),
                AccountMeta::new_readonly(*unique_message_account.key, true),
                AccountMeta::new(*dispatched_message_pda.key, false),
            ],
            &[
                mailbox_outbox_account.clone(),
                dispatch_authority_account.clone(),
                system_program_account.clone(),
                spl_noop.clone(),
                sender_wallet.clone(),
                unique_message_account.clone(),
                dispatched_message_pda.clone(),
            ],
        )?;

        msg!(
            "Warp route transfer completed to destination: {}, recipient: {}, remote_amount: {}",
            xfer.destination_domain,
            xfer.recipient,
            remote_amount
        );

        Ok(())
    }

    /// Accounts:
    /// 0.   [signer] Mailbox processor authority specific to this program.
    /// 1.   [executable] system_program
    /// 2.   [] hyperlane_token storage
    /// 3.   [depends on plugin] recipient wallet address
    /// 4..N [??..??] Plugin-specific accounts.
    pub fn transfer_from_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: HandleInstruction,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        let mut message_reader = std::io::Cursor::new(xfer.message);
        let message = TokenMessage::read_from(&mut message_reader)
            .map_err(|_err| ProgramError::from(Error::TODO))?;

        // Account 0: Mailbox authority
        // This is verified further below.
        let process_authority_account = next_account_info(accounts_iter)?;

        // Account 1: System program
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 2: Token account
        let token_account = next_account_info(accounts_iter)?;
        let token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow_mut()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 3: Recipient wallet
        let recipient_wallet = next_account_info(accounts_iter)?;
        let expected_recipient = Pubkey::new_from_array(message.recipient().into());
        if recipient_wallet.key != &expected_recipient {
            return Err(ProgramError::InvalidArgument);
        }

        // Verify the authenticity of the message.
        // This ensures the `process_authority_account` is valid and a signer,
        // and that the sender is the remote router for the origin.
        token.ensure_valid_router_message(process_authority_account, xfer.origin, &xfer.sender)?;

        // The amount denominated in the remote decimals.
        let remote_amount = message.amount();
        // Convert to the local number of decimals.
        let local_amount: u64 = token.remote_amount_to_local_amount(remote_amount)?;

        // Transfer the `local_amount` of tokens out.
        T::transfer_out(
            program_id,
            &*token,
            system_program,
            recipient_wallet,
            accounts_iter,
            local_amount,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        msg!(
            "Warp route transfer completed from origin: {}, recipient: {}, remote_amount: {}",
            xfer.origin,
            recipient_wallet.key,
            remote_amount
        );

        Ok(())
    }

    /// Gets the account metas required by the `HandleInstruction` instruction,
    /// serializes them, and sets them as return data.
    ///
    /// Accounts:
    /// 0.   [] The token PDA, which is the PDA with the seeds `HANDLE_ACCOUNT_METAS_PDA_SEEDS`.
    pub fn transfer_from_remote_account_metas(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        transfer: HandleInstruction,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        let mut message_reader = std::io::Cursor::new(transfer.message);
        let message = TokenMessage::read_from(&mut message_reader)
            .map_err(|_err| ProgramError::from(Error::TODO))?;

        // Account 0: Token account.
        let token_account_info = next_account_info(accounts_iter)?;
        let token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account_info)?;

        let (transfer_out_account_metas, writeable_recipient) =
            T::transfer_out_account_metas(program_id, &token, &message)?;

        let mut accounts: Vec<SerializableAccountMeta> = vec![
            AccountMeta::new_readonly(solana_program::system_program::id(), false).into(),
            AccountMeta::new_readonly(*token_account_info.key, false).into(),
            AccountMeta {
                pubkey: Pubkey::new_from_array(message.recipient().into()),
                is_signer: false,
                is_writable: writeable_recipient,
            }
            .into(),
        ];
        accounts.extend(transfer_out_account_metas);

        // Wrap it in the SimulationReturnData because serialized account_metas
        // may end with zero byte(s), which are incorrectly truncated as
        // simulated transaction return data.
        // See `SimulationReturnData` for details.
        let bytes = SimulationReturnData::new(accounts)
            .try_to_vec()
            .map_err(|err| ProgramError::BorshIoError(err.to_string()))?;
        set_return_data(&bytes[..]);

        Ok(())
    }

    /// Enrolls a remote router.
    ///
    /// Accounts:
    /// 0. [writeable] The token PDA account.
    /// 1. [signer] The owner.
    pub fn enroll_remote_router(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        config: RemoteRouterConfig,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow_mut()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.enroll_remote_router_only_owner(owner_account, config)?;

        // Store the updated token account.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, true)?;

        Ok(())
    }

    /// Enrolls remote routers.
    ///
    /// Accounts:
    /// 0. [writeable] The token PDA account.
    /// 1. [signer] The owner.
    pub fn enroll_remote_routers(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        configs: Vec<RemoteRouterConfig>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token =
            HyperlaneTokenAccount::fetch(&mut &token_account.data.borrow_mut()[..])?.into_inner();
        let token_seeds: &[&[u8]] = hyperlane_token_pda_seeds!(token.bump);
        let expected_token_key = Pubkey::create_program_address(token_seeds, program_id)?;
        if token_account.key != &expected_token_key {
            return Err(ProgramError::InvalidArgument);
        }
        if token_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.enroll_remote_routers_only_owner(owner_account, configs)?;

        // Store the updated token account.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, true)?;

        Ok(())
    }

    /// Transfers ownership.
    ///
    /// Accounts:
    /// 0. [writeable] The token PDA account.
    /// 1. [signer] The current owner.
    pub fn transfer_ownership(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        new_owner: Option<Pubkey>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.transfer_ownership(owner_account, new_owner)?;

        // Store the updated token account.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, true)?;

        Ok(())
    }

    /// Gets the interchain security module.
    ///
    /// Accounts:
    /// 0. [] The token PDA account.
    pub fn interchain_security_module(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let token = HyperlaneToken::<T>::verify_account_and_fetch_inner(program_id, token_account)?;

        // Set the return data to the serialized Option<Pubkey> representing
        // the ISM.
        token.set_interchain_security_module_return_data();

        Ok(())
    }

    /// Gets the account metas required to get the ISM, serializes them,
    /// and sets them as return data.
    ///
    /// Accounts:
    ///   None
    pub fn interchain_security_module_account_metas(program_id: &Pubkey) -> ProgramResult {
        let (token_key, _token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);

        let account_metas: Vec<SerializableAccountMeta> =
            vec![AccountMeta::new_readonly(token_key, false).into()];

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

    /// Lets the owner set the interchain security module.
    ///
    /// Accounts:
    /// 0. [writeable] The token PDA account.
    /// 1. [signer] The access control owner.
    pub fn set_interchain_security_module(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        ism: Option<Pubkey>,
    ) -> ProgramResult {
        let accounts_iter = &mut accounts.iter();

        // Account 0: Token account
        let token_account = next_account_info(accounts_iter)?;
        let mut token = HyperlaneToken::verify_account_and_fetch_inner(program_id, token_account)?;

        // Account 1: Owner
        let owner_account = next_account_info(accounts_iter)?;

        // This errors if owner_account is not really the owner.
        token.set_interchain_security_module_only_owner(owner_account, ism)?;

        // Store the updated token account.
        HyperlaneTokenAccount::<T>::from(token).store(token_account, true)?;

        Ok(())
    }
}
