//! TODO

use hyperlane_core::{Decode, Encode as _, H256};
use hyperlane_sealevel_mailbox::{
    instruction::{
        Instruction as MailboxIxn, MailboxRecipientInstruction,
        OutboxDispatch as MailboxOutboxDispatch,
    },
    mailbox_outbox_pda_seeds,
};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    msg,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    program_pack::Pack as _,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};
use spl_token_2022::instruction::{burn_checked, mint_to_checked};

use crate::{
    accounts::{HyperlaneToken, HyperlaneTokenAccount},
    error::Error,
    instruction::{
        Event, EventReceivedTransferRemote, EventSentTransferRemote, Init, Instruction as TokenIxn,
        TransferFromRemote, TransferRemote,
    },
    message::TokenMessage,
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

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

/// Seeds relating to the PDA account that acts both as the mint
/// *and* the mint authority.
#[macro_export]
macro_rules! hyperlane_token_mint_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"mint"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"mint", &[$bump_seed]]
    }};
}

// TODO make these easily configurable?
pub const REMOTE_DECIMALS: u8 = 18;
pub const DECIMALS: u8 = 8;

/// The size of the mint account in bytes.
const MINT_ACCOUNT_SIZE: usize = spl_token_2022::state::Mint::LEN;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = MailboxRecipientInstruction::<TokenIxn>::from_instruction_data(
        instruction_data,
    )
    .map_err(|err| {
        msg!("{}", err);
        err
    })?;
    match instruction {
        MailboxRecipientInstruction::MailboxRecipientCpi(recipient_ixn) => transfer_from_remote(
            program_id,
            accounts,
            TransferFromRemote {
                origin: recipient_ixn.origin,
                sender: recipient_ixn.sender,
                message: recipient_ixn.message,
            },
        ),
        MailboxRecipientInstruction::Custom(token_ixn) => match token_ixn {
            TokenIxn::Init(init) => initialize(program_id, accounts, init),
            TokenIxn::TransferRemote(xfer) => transfer_remote(program_id, accounts, xfer),
        },
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the program.
///
/// Accounts:
/// 0. [executable] The system program.
/// 1. [writable] The token PDA account.
/// 2. [writable] The mint / mint authority PDA account.
/// 3. [signer] The payer.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
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

    // Account 2: Mint / mint authority
    let mint_account = next_account_info(accounts_iter)?;
    let (mint_key, mint_bump) =
        Pubkey::find_program_address(hyperlane_token_mint_pda_seeds!(), program_id);
    if &mint_key != mint_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 3: Payer
    let payer_account = next_account_info(accounts_iter)?;
    if !payer_account.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

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

    let token = HyperlaneToken {
        bump: token_bump,
        mailbox: init.mailbox,
        mailbox_local_domain: init.mailbox_local_domain,
        mint: mint_key,
        mint_bump: mint_bump,
    };
    HyperlaneTokenAccount::from(token).store(token_account, true)?;

    // Create mint / mint authority PDA.
    // Grant ownership to the SPL token program.
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            mint_account.key,
            Rent::default().minimum_balance(MINT_ACCOUNT_SIZE),
            MINT_ACCOUNT_SIZE.try_into().unwrap(),
            &spl_token_2022::id(),
        ),
        &[payer_account.clone(), mint_account.clone()],
        &[hyperlane_token_mint_pda_seeds!(mint_bump)],
    )?;

    Ok(())
}

/// Transfers tokens to a remote.
/// Burns the tokens from the sender's associated token account and
/// then dispatches a message to the remote recipient.
///
/// Accounts:
/// 0. [executable] The spl_noop program.
/// 1. [] The token PDA account.
/// 2. [executable] The mailbox program.
/// 3. [writeable] The mailbox outbox account.
/// 4. [signer] The token sender.
/// 5. [executable] The spl_token_2022 program.
/// 6. [writeable] The mint / mint authority PDA account.
/// 7. [writeable] The token sender's associated token account, from which tokens will be burned.
fn transfer_remote(
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

    // 5. SPL token 2022 program
    let spl_token_2022 = next_account_info(accounts_iter)?;
    if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // 6. mint account
    let mint_account = next_account_info(accounts_iter)?;
    let mint_seeds: &[&[u8]] = hyperlane_token_mint_pda_seeds!(token.mint_bump);
    let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
    if mint_account.key != &expected_mint_key {
        return Err(ProgramError::InvalidArgument);
    }
    if *mint_account.key != token.mint {
        return Err(ProgramError::InvalidArgument);
    }
    if mint_account.owner != &spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    if mint_account.owner != &spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Hmmmmmm should this be enforced?

    // 7. sender associated token account
    let sender_ata = next_account_info(accounts_iter)?;
    let expected_sender_associated_token_account = get_associated_token_address_with_program_id(
        sender_wallet.key,
        mint_account.key,
        &spl_token_2022::id(),
    );
    if sender_ata.key != &expected_sender_associated_token_account {
        return Err(ProgramError::InvalidArgument);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    let burn_ixn = burn_checked(
        &spl_token_2022::id(),
        sender_ata.key,
        mint_account.key,
        sender_wallet.key,
        &[sender_wallet.key],
        amount,
        DECIMALS,
    )?;
    // Sender wallet is expected to have signed this transaction
    invoke(
        &burn_ixn,
        &[
            sender_ata.clone(),
            mint_account.clone(),
            sender_wallet.clone(),
        ],
    )?;

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

// Accounts:
// 0. [signer] mailbox authority
// 1. [executable] system_program
// 2. [executable] spl_noop
// 3. [] hyperlane_token storage
// 4. [] recipient wallet address
// 5. [signer] payer // <- TODO this should NOT be required as a signer
// 6. [executable] SPL token 2022 program
// 7. [executable] SPL associated token account
// 8. [writeable] Mint account
// 9. [writeable] Recipient associated token account

// For wrapped tokens:
//     7. spl_token_2022
//     8. spl_associated_token_account
//     9. hyperlane_token_erc20
//     10. hyperlane_token_mint
//     11. recipient associated token account
// For native token:
//     7. native_token_collateral wallet
fn transfer_from_remote(
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

    // Account 5: Payer
    // TODO does this need to be a signer? It shouldn't...
    let payer_account = next_account_info(accounts_iter)?;

    // Account 6: SPL token 2022 program
    let spl_token_2022 = next_account_info(accounts_iter)?;
    if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
        return Err(ProgramError::InvalidArgument);
    }
    // Account 7: SPL associated token account
    let spl_ata = next_account_info(accounts_iter)?;
    if spl_ata.key != &spl_associated_token_account::id() || !spl_ata.executable {
        return Err(ProgramError::InvalidArgument);
    }

    // Account 8: Mint account
    let mint_account = next_account_info(accounts_iter)?;
    let mint_seeds: &[&[u8]] = hyperlane_token_mint_pda_seeds!(token.mint_bump);
    let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
    if mint_account.key != &expected_mint_key {
        return Err(ProgramError::InvalidArgument);
    }
    if mint_account.owner != &spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    // Account 9: Recipient associated token account
    let recipient_ata = next_account_info(accounts_iter)?;
    let expected_recipient_associated_token_account = get_associated_token_address_with_program_id(
        recipient_wallet.key,
        mint_account.key,
        &spl_token_2022::id(),
    );
    if recipient_ata.key != &expected_recipient_associated_token_account {
        return Err(ProgramError::InvalidArgument);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    // Create and init (this does both) associated token account if necessary.
    invoke_signed(
        &create_associated_token_account_idempotent(
            payer_account.key,
            recipient_wallet.key,
            mint_account.key,
            &spl_token_2022::id(),
        ),
        &[
            payer_account.clone(),
            recipient_ata.clone(),
            recipient_wallet.clone(),
            mint_account.clone(),
            system_program.clone(),
            spl_token_2022.clone(),
        ],
        &[mint_seeds],
    )?;

    // Mints new tokens to an account.  The native mint does not support
    // minting.
    //
    // Accounts expected by this instruction:
    //
    //   * Single authority
    //   0. `[writable]` The mint.
    //   1. `[writable]` The account to mint tokens to.
    //   2. `[signer]` The mint's minting authority.
    //
    //   * Multisignature authority
    //   0. `[writable]` The mint.
    //   1. `[writable]` The account to mint tokens to.
    //   2. `[]` The mint's multisignature mint-tokens authority.
    //   3. ..3+M `[signer]` M signer accounts.
    let mint_ixn = mint_to_checked(
        &spl_token_2022::id(),
        mint_account.key,
        recipient_ata.key,
        mint_account.key,
        &[],
        amount,
        DECIMALS,
    )?;
    invoke_signed(
        &mint_ixn,
        &[
            mint_account.clone(),
            recipient_ata.clone(),
            mint_account.clone(),
        ],
        &[hyperlane_token_mint_pda_seeds!(token.mint_bump)],
    )?;

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
