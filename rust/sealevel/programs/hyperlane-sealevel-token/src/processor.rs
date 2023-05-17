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
    program::invoke_signed,
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
use spl_token_2022::{
    instruction::{burn_checked, initialize_mint2, mint_to_checked},
    state::Mint,
};

use crate::{
    accounts::{HyperlaneErc20, HyperlaneErc20Account, HyperlaneToken, HyperlaneTokenAccount},
    error::Error,
    instruction::{
        Event, EventReceivedTransferRemote, EventSentTransferRemote, Init, InitErc20,
        Instruction as TokenIxn, TokenMessage, TransferFromRemote, TransferRemote,
    },
};

#[cfg(not(feature = "no-entrypoint"))]
entrypoint!(process_instruction);

#[macro_export]
macro_rules! hyperlane_token_erc20_pda_seeds {
    ($token_name:expr, $token_symbol:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            $token_name.as_bytes(),
            b"-",
            $token_symbol.as_bytes(),
            b"-",
            b"erc20",
        ]
    }};

    ($token_name:expr, $token_symbol:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            $token_name.as_bytes(),
            b"-",
            $token_symbol.as_bytes(),
            b"-",
            b"erc20",
            &[$bump_seed],
        ]
    }};
}

// FIXME should erc20 account address be a seed here instead?
#[macro_export]
macro_rules! hyperlane_token_mint_pda_seeds {
    ($token_name:expr, $token_symbol:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            $token_name.as_bytes(),
            b"-",
            $token_symbol.as_bytes(),
            b"-",
            b"mint",
        ]
    }};

    ($token_name:expr, $token_symbol:expr, $bump_seed:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            $token_name.as_bytes(),
            b"-",
            $token_symbol.as_bytes(),
            b"-",
            b"mint",
            &[$bump_seed],
        ]
    }};
}

// FIXME doesn't need to be a macro if static?
#[macro_export]
macro_rules! hyperlane_token_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"storage"]
    }};

    ($bump_seed:expr) => {{
        &[b"hyperlane_token", b"-", b"storage", &[$bump_seed]]
    }};
}

// FIXME doesn't need to be a macro if static?
#[macro_export]
macro_rules! hyperlane_token_native_collateral_pda_seeds {
    () => {{
        &[b"hyperlane_token", b"-", b"native_token_collateral"]
    }};

    ($bump_seed:expr) => {{
        &[
            b"hyperlane_token",
            b"-",
            b"native_token_collateral",
            &[$bump_seed],
        ]
    }};
}

pub const DECIMALS: u8 = 0; // FIXME this should be an input
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
                // sender: recipient_ixn.sender,
                message: recipient_ixn.message,
            },
        ),
        MailboxRecipientInstruction::Custom(token_ixn) => match token_ixn {
            TokenIxn::Init(init) => initialize(program_id, accounts, init),
            TokenIxn::InitErc20(init) => initialize_erc20(program_id, accounts, init),
            TokenIxn::TransferRemote(xfer) => transfer_remote(program_id, accounts, xfer),
            TokenIxn::TransferFromRemote(xfer) => transfer_from_remote(program_id, accounts, xfer),
        },
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

fn token_name_is_valid(name: &str) -> bool {
    !(name.contains("-") || name.is_empty())
}

fn token_symbol_is_valid(symbol: &str) -> bool {
    !symbol.is_empty()
}

// Accounts:
// 1. system_program
// 2. token storage
// 3. native_collateral wallet
// 4. payer
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    // On chain create appears to use realloc which is limited to 1024 byte increments.
    let token_account_size = 2048;

    if !token_name_is_valid(&init.name) {
        return Err(ProgramError::InvalidArgument);
    }
    if !token_symbol_is_valid(&init.symbol) {
        return Err(ProgramError::InvalidArgument);
    }

    let accounts_iter = &mut accounts.iter();

    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }

    let (token_key, token_bump) =
        Pubkey::find_program_address(hyperlane_token_pda_seeds!(), program_id);
    let token_account = next_account_info(accounts_iter)?;
    if &token_key != token_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    let (native_collateral_key, native_collateral_bump) =
        Pubkey::find_program_address(hyperlane_token_native_collateral_pda_seeds!(), program_id);
    let native_collateral_account = next_account_info(accounts_iter)?;
    if &native_collateral_key != native_collateral_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    let payer_account = next_account_info(accounts_iter)?;

    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    // Create token prog info storage account.
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

    // Create native collateral wallet.
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            native_collateral_account.key,
            Rent::default().minimum_balance(0),
            0,
            program_id,
        ),
        &[payer_account.clone(), native_collateral_account.clone()],
        &[hyperlane_token_native_collateral_pda_seeds!(
            native_collateral_bump
        )],
    )?;

    let token = HyperlaneToken {
        mailbox: init.mailbox,
        mailbox_local_domain: init.mailbox_local_domain,
        bump: token_bump,
        native_collateral_bump,
        native_name: init.name,
        native_symbol: init.symbol,
    };
    HyperlaneTokenAccount::from(token).store(token_account, true)?;

    Ok(())
}

// Accounts:
// 1. system_program
// 2. spl_token_2022
// 3. payer
// 4. hyperlane_token storage
// 5. hyperlane_token_erc20
// 6. hyperlane_token_mint
fn initialize_erc20(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    init: InitErc20,
) -> ProgramResult {
    // On chain create appears to use realloc which is limited to 1024 byte increments.
    let erc20_account_size = 2048;

    let total_supply = init.total_supply.try_into().map_err(|_| Error::TODO)?;
    if !token_name_is_valid(&init.name) {
        return Err(ProgramError::InvalidArgument);
    }
    if !token_symbol_is_valid(&init.symbol) {
        return Err(ProgramError::InvalidArgument);
    }

    let accounts_iter = &mut accounts.iter();

    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }
    let spl_token_2022 = next_account_info(accounts_iter)?;
    if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
        return Err(ProgramError::InvalidArgument);
    }
    let payer_account = next_account_info(accounts_iter)?;

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

    let erc20_account = next_account_info(accounts_iter)?;
    let (erc20_key, erc20_bump) = Pubkey::find_program_address(
        hyperlane_token_erc20_pda_seeds!(init.name, init.symbol),
        program_id,
    );
    if &erc20_key != erc20_account.key {
        return Err(ProgramError::InvalidArgument);
    }

    let mint_account = next_account_info(accounts_iter)?;
    let (mint_key, mint_bump) = Pubkey::find_program_address(
        hyperlane_token_mint_pda_seeds!(init.name, init.symbol),
        program_id,
    );
    if &mint_key != mint_account.key {
        return Err(ProgramError::InvalidArgument);
    }
    if accounts_iter.next().is_some() {
        return Err(ProgramError::from(Error::ExtraneousAccount));
    }

    if init.name == token.native_name || init.symbol == token.native_symbol {
        return Err(ProgramError::InvalidArgument);
    }

    let freeze_authority: Option<&Pubkey> = None; // FIXME do we need this?

    // Create erc20 account.
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            erc20_account.key,
            Rent::default().minimum_balance(erc20_account_size),
            erc20_account_size.try_into().unwrap(),
            program_id,
        ),
        &[payer_account.clone(), erc20_account.clone()],
        &[hyperlane_token_erc20_pda_seeds!(
            init.name,
            init.symbol,
            erc20_bump
        )],
    )?;

    // Create mint account.
    invoke_signed(
        &system_instruction::create_account(
            payer_account.key,
            mint_account.key,
            Rent::default().minimum_balance(MINT_ACCOUNT_SIZE),
            MINT_ACCOUNT_SIZE.try_into().unwrap(),
            &spl_token_2022::id(),
        ),
        &[payer_account.clone(), mint_account.clone()],
        &[hyperlane_token_mint_pda_seeds!(
            init.name,
            init.symbol,
            mint_bump
        )],
    )?;

    // Initialize mint. It is it's own authority since it is a PDA.
    let init_mint_ixn = initialize_mint2(
        &spl_token_2022::id(),
        mint_account.key,
        mint_account.key,
        freeze_authority,
        DECIMALS,
    )?;
    invoke_signed(
        &init_mint_ixn,
        &[payer_account.clone(), mint_account.clone()],
        &[hyperlane_token_erc20_pda_seeds!(
            init.name,
            init.symbol,
            mint_bump
        )],
    )?;

    let erc20 = Box::new(HyperlaneErc20 {
        erc20_bump,
        mint_bump,
        total_supply,
        name: init.name,
        symbol: init.symbol,
    });
    HyperlaneErc20Account::from(erc20).store(erc20_account, true)?;

    Ok(())
}

// Accounts:
// 1. spl_noop
// 2. hyperlane_token storage
// 3. mailbox program
// 4. mailbox outbox
// 5. sender wallet
// For wrapped tokens:
//     6. spl_token_2022
//     7. hyperlane_token_erc20
//     8. hyperlane_token_mint
//     9. sender associated token account TODO should we use a delegate / does it even matter if it is one?
// For native token:
//     7. system_instruction
//     8. native_token_collateral
fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferRemote,
) -> ProgramResult {
    let amount: u64 = xfer.amount_or_id.try_into().map_err(|_| Error::TODO)?;

    let accounts_iter = &mut accounts.iter();

    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
        return Err(ProgramError::InvalidArgument);
    }

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

    let mailbox_info = next_account_info(accounts_iter)?;
    if mailbox_info.key != &token.mailbox {
        return Err(ProgramError::IncorrectProgramId);
    }
    // TODO supposed to use create_program_address() but we would need to pass in bump seed...
    let mailbox_outbox_account = next_account_info(accounts_iter)?;
    let (mailbox_outbox, _mailbox_outbox_bump) = Pubkey::find_program_address(
        mailbox_outbox_pda_seeds!(token.mailbox_local_domain),
        &token.mailbox,
    );
    if mailbox_outbox_account.key != &mailbox_outbox {
        return Err(ProgramError::InvalidArgument);
    }

    let sender_wallet = next_account_info(accounts_iter)?;

    let next_account = next_account_info(accounts_iter)?;
    let xfer_is_native = next_account.key == &solana_program::system_program::id();

    if xfer_is_native {
        let system_program = next_account;
        if system_program.key != &solana_program::system_program::id() {
            return Err(ProgramError::InvalidArgument);
        }

        let native_collateral_seeds: &[&[u8]] =
            hyperlane_token_native_collateral_pda_seeds!(token.native_collateral_bump);
        let expected_native_collateral_key =
            Pubkey::create_program_address(native_collateral_seeds, program_id)?;
        let native_collateral_account = next_account_info(accounts_iter)?;
        if native_collateral_account.key != &expected_native_collateral_key {
            return Err(ProgramError::InvalidArgument);
        }
        if native_collateral_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        // Hold native tokens that are now "off chain" in custody account.
        invoke_signed(
            &system_instruction::transfer(sender_wallet.key, native_collateral_account.key, amount),
            &[sender_wallet.clone(), native_collateral_account.clone()],
            &[],
        )?;
    } else {
        let spl_token_2022 = next_account;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }

        let erc20_account = next_account_info(accounts_iter)?;
        let erc20 =
            HyperlaneErc20Account::fetch(&mut &erc20_account.data.borrow_mut()[..])?.into_inner();
        let erc20_seeds: &[&[u8]] =
            hyperlane_token_erc20_pda_seeds!(erc20.name, erc20.symbol, erc20.erc20_bump);
        let expected_erc20_key = Pubkey::create_program_address(erc20_seeds, program_id)?;
        if erc20_account.key != &expected_erc20_key {
            return Err(ProgramError::InvalidArgument);
        }
        if erc20_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        let mint_account = next_account_info(accounts_iter)?;
        let mint_seeds: &[&[u8]] =
            hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump);
        let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
        if mint_account.key != &expected_mint_key {
            return Err(ProgramError::InvalidArgument);
        }
        if mint_account.owner != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
        }

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
        invoke_signed(
            &burn_ixn,
            &[
                sender_ata.clone(),
                mint_account.clone(),
                sender_wallet.clone(),
            ],
            &[mint_seeds],
        )?;
    }

    let token_xfer_message =
        TokenMessage::new_erc20(xfer.recipient, xfer.amount_or_id, vec![]).to_vec();
    let mailbox_ixn = MailboxIxn::OutboxDispatch(MailboxOutboxDispatch {
        sender: *sender_wallet.key,
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
            AccountMeta::new_readonly(*sender_wallet.key, true),
            AccountMeta::new_readonly(spl_noop::id(), false),
        ],
    };
    // TODO implement interchain gas payment via paymaster? dispatch_with_gas()?
    invoke_signed(
        &mailbox_ixn,
        &[
            mailbox_outbox_account.clone(),
            sender_wallet.clone(),
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
// 1. mailbox_authority
// 2. system_program
// 3. spl_noop
// 4. hyperlane_token storage
// 5. recipient wallet address
// 6. payer
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
    let _mailbox_auth = next_account_info(accounts_iter)?;

    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }
    let spl_noop = next_account_info(accounts_iter)?;
    if spl_noop.key != &spl_noop::id() || !spl_noop.executable {
        return Err(ProgramError::InvalidArgument);
    }

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

    let recipient_wallet = next_account_info(accounts_iter)?;
    let payer_account = next_account_info(accounts_iter)?;

    let native_collateral_seeds: &[&[u8]] =
        hyperlane_token_native_collateral_pda_seeds!(token.native_collateral_bump);
    let expected_native_collateral_key =
        Pubkey::create_program_address(native_collateral_seeds, program_id)?;

    let next_account = next_account_info(accounts_iter)?;
    let xfer_is_native = next_account.key == &expected_native_collateral_key;

    if xfer_is_native {
        let native_collateral_account = next_account;
        if native_collateral_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        if accounts_iter.next().is_some() {
            return Err(ProgramError::from(Error::ExtraneousAccount));
        }

        // Note: the system program does not own the collateral PDA and thus cannot transfer
        // tokens. We must do it manually.
        **native_collateral_account.try_borrow_mut_lamports()? -= amount;
        **recipient_wallet.try_borrow_mut_lamports()? += amount;
    } else {
        let spl_token_2022 = next_account;
        if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
            return Err(ProgramError::InvalidArgument);
        }
        let spl_ata = next_account_info(accounts_iter)?;
        if spl_ata.key != &spl_associated_token_account::id() || !spl_ata.executable {
            return Err(ProgramError::InvalidArgument);
        }

        let erc20_account = next_account_info(accounts_iter)?;
        let erc20 =
            HyperlaneErc20Account::fetch(&mut &erc20_account.data.borrow_mut()[..])?.into_inner();
        let erc20_seeds: &[&[u8]] =
            hyperlane_token_erc20_pda_seeds!(erc20.name, erc20.symbol, erc20.erc20_bump);
        let expected_erc20_key = Pubkey::create_program_address(erc20_seeds, program_id)?;
        if erc20_account.key != &expected_erc20_key {
            return Err(ProgramError::InvalidArgument);
        }
        if erc20_account.owner != program_id {
            return Err(ProgramError::IncorrectProgramId);
        }

        let mint_account = next_account_info(accounts_iter)?;
        let mint_seeds: &[&[u8]] =
            hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump);
        let expected_mint_key = Pubkey::create_program_address(mint_seeds, program_id)?;
        if mint_account.key != &expected_mint_key {
            return Err(ProgramError::InvalidArgument);
        }
        if mint_account.owner != &spl_token_2022::id() {
            return Err(ProgramError::IncorrectProgramId);
        }
        let mint = Mint::unpack_from_slice(&mint_account.data.borrow())?;

        let recipient_ata = next_account_info(accounts_iter)?;
        let expected_recipient_associated_token_account =
            get_associated_token_address_with_program_id(
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

        let total = mint
            .supply
            .checked_add(amount)
            .ok_or_else(|| ProgramError::from(Error::TODO))?;
        if total > erc20.total_supply {
            return Err(Error::TODO.into());
        }

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
            &[hyperlane_token_mint_pda_seeds!(
                erc20.name,
                erc20.symbol,
                erc20.mint_bump
            )],
        )?;
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
