//! TODO

use borsh::{BorshDeserialize, BorshSerialize};
use hyperlane_core::{Decode, Encode as _, H256};
use hyperlane_sealevel_mailbox::{
    instruction::{Instruction as MailboxIxn, OutboxDispatch as MailboxOutboxDispatch},
    mailbox_outbox_pda_seeds,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    msg,
    rent::Rent,
    system_instruction,
};

use crate::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    error::Error,
    instruction::{
        Event, EventReceivedTransferRemote, EventSentTransferRemote, Init, TransferFromRemote,
        TransferRemote,
    },
    message::TokenMessage,
};

// TODO make these easily configurable?
pub const REMOTE_DECIMALS: u8 = 18;
pub const DECIMALS: u8 = 8;

/// Seeds relating to the PDA account with information about this warp route.
#[macro_export]
macro_rules! hyperlane_token_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"token"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"token", &[$bump_seed]]
    }};
}

pub trait HyperlaneSealevelTokenPlugin
where
    Self:
        BorshSerialize + BorshDeserialize + std::cmp::PartialEq + std::fmt::Debug + Default + Sized,
{
    fn initialize<'a, 'b>(
        program_id: &Pubkey,
        system_program: &'a AccountInfo<'b>,
        token_account: &'a AccountInfo<'b>,
        payer_account: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
    ) -> Result<Self, ProgramError>;

    fn transfer_in<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        sender_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError>;

    fn transfer_out<'a, 'b>(
        program_id: &Pubkey,
        token: &HyperlaneToken<Self>,
        system_program: &'a AccountInfo<'b>,
        recipient_wallet: &'a AccountInfo<'b>,
        accounts_iter: &mut std::slice::Iter<'a, AccountInfo<'b>>,
        amount: u64,
    ) -> Result<(), ProgramError>;
}

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
    /// 2.   [signer] The payer.
    /// 3..N [??..??] Plugin-specific accounts.
    pub fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
        // On chain create appears to use realloc which is limited to 1024 byte increments.
        let token_account_size = 2048;

        let accounts_iter = &mut accounts.iter();

        // Account 0: System program
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 1: Token storage account
        let token_account = next_account_info(accounts_iter)?;
        let (token_key, token_bump) =
            Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
        if &token_key != token_account.key {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 2: Payer
        let payer_account = next_account_info(accounts_iter)?;
        if !payer_account.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

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

        // Create token account PDA
        invoke_signed(
            &system_instruction::create_account(
                payer_account.key,
                token_account.key,
                Rent::default().minimum_balance(token_account_size),
                token_account_size.try_into().unwrap(),
                program_id,
            ),
            &[payer_account.clone(), token_account.clone()],
            &[hyperlane_token_pda_seeds!(token_bump)],
        )?;

        let token: HyperlaneToken<T> = HyperlaneToken {
            bump: token_bump,
            mailbox: init.mailbox,
            mailbox_local_domain: init.mailbox_local_domain,
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
    /// 0.   [executable] The spl_noop program.
    /// 1.   [] The token PDA account.
    /// 2.   [executable] The mailbox program.
    /// 3.   [writeable] The mailbox outbox account.
    /// 4.   [signer] The token sender.
    /// 5..N [??..??] Plugin-specific accounts.
    pub fn transfer_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: TransferRemote,
    ) -> ProgramResult {
        let amount: u64 = xfer.amount_or_id.try_into().map_err(|_| Error::TODO)?;

        let accounts_iter = &mut accounts.iter();

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
        // TODO supposed to use create_program_address() but we would need to pass in bump seed...

        // Account 3: Mailbox outbox data account
        // TODO should I be using find_program_address...?
        let mailbox_outbox_account = next_account_info(accounts_iter)?;
        let (mailbox_outbox, _mailbox_outbox_bump) = Pubkey::find_program_address(
            mailbox_outbox_pda_seeds!(token.mailbox_local_domain),
            &token.mailbox,
        );
        if mailbox_outbox_account.key != &mailbox_outbox {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 4: Sender account
        let sender_wallet = next_account_info(accounts_iter)?;
        if !sender_wallet.is_signer {
            return Err(ProgramError::MissingRequiredSignature);
        }

        T::transfer_in(program_id, &*token, sender_wallet, accounts_iter, amount)?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        let token_xfer_message =
            TokenMessage::new_erc20(xfer.recipient, xfer.amount_or_id, vec![]).to_vec();
        let mailbox_ixn = MailboxIxn::OutboxDispatch(MailboxOutboxDispatch {
            sender: *token_account.key,
            local_domain: token.mailbox_local_domain,
            destination_domain: xfer.destination_domain,
            recipient: xfer.destination_program_id,
            message_body: token_xfer_message,
        });
        let mailbox_ixn = Instruction {
            program_id: token.mailbox,
            data: mailbox_ixn.into_instruction_data().unwrap(),
            accounts: vec![
                AccountMeta::new(*mailbox_outbox_account.key, false),
                AccountMeta::new_readonly(*token_account.key, true),
                AccountMeta::new_readonly(spl_noop::id(), false),
            ],
        };
        // TODO implement interchain gas payment via paymaster? dispatch_with_gas()?
        invoke_signed(
            &mailbox_ixn,
            &[
                mailbox_outbox_account.clone(),
                token_account.clone(),
                spl_noop.clone(),
            ],
            &[token_seeds],
        )?;

        let event = Event::new(EventSentTransferRemote {
            destination: xfer.destination_domain,
            recipient: xfer.recipient,
            amount: xfer.amount_or_id,
        });
        let event_data = event.to_noop_cpi_ixn_data().map_err(|_| Error::TODO)?;
        let noop_cpi_log = Instruction {
            program_id: spl_noop::id(),
            accounts: vec![],
            data: event_data,
        };
        invoke_signed(&noop_cpi_log, &[], &[token_seeds])?;

        Ok(())
    }

    /// Accounts:
    /// 0.   [signer] mailbox authority
    /// 1.   [executable] system_program
    /// 2.   [executable] spl_noop
    /// 3.   [] hyperlane_token storage
    /// 4.   [] recipient wallet address
    /// 5..N [??..??] Plugin-specific accounts.
    pub fn transfer_from_remote(
        program_id: &Pubkey,
        accounts: &[AccountInfo],
        xfer: TransferFromRemote,
    ) -> ProgramResult {
        let mut message_reader = std::io::Cursor::new(xfer.message);
        let message = TokenMessage::read_from(&mut message_reader)
            .map_err(|_err| ProgramError::from(Error::TODO))?;
        // FIXME we must account for decimals of the mint not only the raw amount value during
        // transfer. Wormhole accounts for this with some extra care taken to round/truncate properly -
        // we should do the same.
        let amount = message.amount().try_into().map_err(|_| Error::TODO)?;
        // FIXME validate message fields?

        let accounts_iter = &mut accounts.iter();

        // FIXME validate mailbox auth pda and require that it's a signer
        // Account 0: Mailbox authority
        let _mailbox_auth = next_account_info(accounts_iter)?;

        // Account 1: System program
        let system_program = next_account_info(accounts_iter)?;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }
        // Account 2: SPL Noop program
        let spl_noop = next_account_info(accounts_iter)?;
        if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
            return Err(ProgramError::InvalidArgument);
        }

        // Account 3: Token account
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

        // Account 4: Recipient wallet
        let recipient_wallet = next_account_info(accounts_iter)?;

        T::transfer_out(
            program_id,
            &*token,
            system_program,
            recipient_wallet,
            accounts_iter,
            amount,
        )?;

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        let event = Event::new(EventReceivedTransferRemote {
            origin: xfer.origin,
            // Note: assuming recipient not recipient ata is the correct "recipient" to log.
            recipient: H256::from(recipient_wallet.key.to_bytes()),
            amount: message.amount(),
        });
        let event_data = event.to_noop_cpi_ixn_data().map_err(|_| Error::TODO)?;
        let noop_cpi_log = Instruction {
            program_id: spl_noop::id(),
            accounts: vec![],
            data: event_data,
        };
        invoke_signed(&noop_cpi_log, &[], &[token_seeds])?;

        Ok(())
    }
}
