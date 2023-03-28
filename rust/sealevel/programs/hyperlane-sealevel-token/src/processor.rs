//! TODO

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
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
    instruction::create_associated_token_account_idempotent
};
use spl_token_2022::{
    instruction::{burn_checked, initialize_mint2, mint_to_checked},
    state::Mint,
};

use crate::{
    accounts::{HyperlaneErc20, HyperlaneErc20Account},
    error::Error,
    instruction::{
        Init, Instruction as TokenIxn, TransferFromRemote, TransferFromSender, TransferRemote,
        TransferTo,
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

pub const DECIMALS: u8 = 0; // FIXME this should be an input?
const MINT_ACCOUNT_SIZE: usize = spl_token_2022::state::Mint::LEN;

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    match TokenIxn::from_instruction_data(instruction_data)? {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
        TokenIxn::TransferRemote(xfer) => transfer_remote(program_id, accounts, xfer),
        TokenIxn::TransferFromRemote(xfer) => transfer_from_remote(program_id, accounts, xfer),

        TokenIxn::TransferFromSender(xfer) => transfer_from_sender(program_id, accounts, xfer),
        TokenIxn::TransferTo(xfer) => transfer_to(program_id, accounts, xfer),
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

// FIXME assert mailbox is signer?
// Accounts:
// 1. system_program
// 2. spl_token_2022
// 3. payer
// 4. hyperlane_token_erc20
// 5. hyperlane_token_mint
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    // On chain create appears to use realloc which is limited to 1024 byte increments.
    let erc20_account_size = 2048;

    let total_supply = init
        .total_supply
        .try_into()
        .map_err(|_| Error::TODO)?;
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
        &[hyperlane_token_erc20_pda_seeds!(init.name, init.symbol, erc20_bump)],
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
        &[hyperlane_token_mint_pda_seeds!(init.name, init.symbol, mint_bump)],
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
        &[hyperlane_token_erc20_pda_seeds!(init.name, init.symbol, mint_bump)],
    )?;

    let erc20 = HyperlaneErc20 {
        erc20_bump,
        mint_bump,
        mailbox: init.mailbox,
        interchain_gas_paymaster: init.interchain_gas_paymaster,
        total_supply,
        name: init.name,
        symbol: init.symbol,
    };
    // FIXME what if we fail to store here after the CPI...?
    HyperlaneErc20Account::from(erc20).store(erc20_account, true)?;

    Ok(())
/*
    // transfers ownership to `msg.sender`
    __HyperlaneConnectionClient_initialize(
        _mailbox,
        _interchainGasPaymaster
    );

    // Initialize ERC20 metadata
    __ERC20_init(_name, _symbol);
    _mint(msg.sender, _totalSupply);
*/
}

fn transfer_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferRemote
) -> ProgramResult {
    todo!() // FIXME

/*
/// @dev Emitted on `_handle` when a transfer message is processed.
/// @param origin The identifier of the origin chain.
/// @param recipient The address of the recipient on the destination chain.
/// @param amount The amount of tokens minted on the destination chain.
event ReceivedTransferRemote(
    uint32 indexed origin,
    bytes32 indexed recipient,
    uint256 amount
);

/// @notice Transfers `_amountOrId` token to `_recipient` on `_destination` domain.
/// @dev Delegates transfer logic to `_transferFromSender` implementation.
/// @dev Emits `SentTransferRemote` event on the origin chain.
/// @param _destination The identifier of the destination chain.
/// @param _recipient The address of the recipient on the destination chain.
/// @param _amountOrId The amount or identifier of tokens to be sent to the remote recipient.
/// @return messageId The identifier of the dispatched message.
function transferRemote(
    uint32 _destination,
    bytes32 _recipient,
    uint256 _amountOrId
) public payable virtual returns (bytes32 messageId) {
    bytes memory metadata = _transferFromSender(_amountOrId);
    messageId = _dispatchWithGas(
        _destination,
        Message.format(_recipient, _amountOrId, metadata),
        msg.value, // interchain gas payment
        msg.sender // refund address
    );
    emit SentTransferRemote(_destination, _recipient, _amountOrId);
}
*/
}

fn transfer_from_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferFromRemote
) -> ProgramResult {
    todo!() // FIXME

/*
/// @dev Emitted on `transferRemote` when a transfer message is dispatched.
/// @param destination The identifier of the destination chain.
/// @param recipient The address of the recipient on the destination chain.
/// @param amount The amount of tokens burnt on the origin chain.
event SentTransferRemote(
    uint32 indexed destination,
    bytes32 indexed recipient,
    uint256 amount
);

/// @dev Should transfer `_amountOrId` of tokens from `msg.sender` to this token router.
/// @dev Called by `transferRemote` before message dispatch.
/// @dev Optionally returns `metadata` associated with the transfer to be passed in message.
function _transferFromSender(uint256 _amountOrId)
    internal
    virtual
    returns (bytes memory metadata);

/// @dev Mints tokens to recipient when router receives transfer message.
/// @dev Emits `ReceivedTransferRemote` event on the destination chain.
/// @param _origin The identifier of the origin chain.
/// @param _message The encoded remote transfer message containing the recipient address and amount.
function _handle(
    uint32 _origin,
    bytes32,
    bytes calldata _message
) internal override {
    bytes32 recipient = _message.recipient();
    uint256 amount = _message.amount();
    bytes calldata metadata = _message.metadata();
    _transferTo(recipient.bytes32ToAddress(), amount, metadata);
    emit ReceivedTransferRemote(_origin, recipient, amount);
}
*/
}

// FIXME assert mailbox is signer?
// Accounts:
// 1. spl_token_2022
// 2. hyperlane_token_erc20
// 3. hyperlane_token_mint
// FIXME should we use a delegate / does it even matter if it is one?
// 4. sender wallet
// 4. sender associated token account
fn transfer_from_sender(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferFromSender,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let spl_token_2022 = next_account_info(accounts_iter)?;
    if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
        return Err(ProgramError::InvalidArgument);
    }

    let erc20_account = next_account_info(accounts_iter)?;
    let erc20 = HyperlaneErc20Account::fetch(&mut &erc20_account.data.borrow_mut()[..])?
        .into_inner();
    let expected_erc20_key = Pubkey::create_program_address(
        hyperlane_token_erc20_pda_seeds!(erc20.name, erc20.symbol, erc20.erc20_bump),
        program_id,
    )?;
    if erc20_account.key != &expected_erc20_key {
        return Err(ProgramError::InvalidArgument);
    }
    if erc20_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mint_account = next_account_info(accounts_iter)?;
    let expected_mint_key = Pubkey::create_program_address(
        hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump),
        program_id,
    )?;
    if mint_account.key != &expected_mint_key {
        return Err(ProgramError::InvalidArgument);
    }
    if mint_account.owner != &spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    let sender_wallet = next_account_info(accounts_iter)?;
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

    let amount: u64 = xfer
        .amount
        .try_into()
        .map_err(|_| Error::TODO)?;

    // Burns tokens by removing them from an account.  `BurnChecked` does not
    // support accounts associated with the native mint, use `CloseAccount`
    // instead.
    //
    // This instruction differs from Burn in that the decimals value is checked
    // by the caller. This may be useful when creating transactions offline or
    // within a hardware wallet.
    //
    // Accounts expected by this instruction:
    //
    //   * Single owner/delegate
    //   0. `[writable]` The account to burn from.
    //   1. `[writable]` The token mint.
    //   2. `[signer]` The account's owner/delegate.
    //
    //   * Multisignature owner/delegate
    //   0. `[writable]` The account to burn from.
    //   1. `[writable]` The token mint.
    //   2. `[]` The account's multisignature owner/delegate.
    //   3. ..3+M `[signer]` M signer accounts.
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
        &[hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump)],
    )?;

    Ok(())
/*
    _burn(msg.sender, _amount);
    return bytes(""); // no metadata
*/
}

// FIXME assert mailbox is signer?
// Accounts:
// 1. system_program
// 2. spl_token_2022
// 3. spl_associated_token_account
// 4. payer
// 5. hyperlane_token_erc20
// 6. hyperlane_token_mint
// 7. recipient wallet address
// 8. recipient associated token account
fn transfer_to(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    xfer: TransferTo,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let system_program = next_account_info(accounts_iter)?;
    if system_program.key != &solana_program::system_program::id() {
        return Err(ProgramError::InvalidArgument);
    }
    let spl_token_2022 = next_account_info(accounts_iter)?;
    if spl_token_2022.key != &spl_token_2022::id() || !spl_token_2022.executable {
        return Err(ProgramError::InvalidArgument);
    }
    let spl_ata = next_account_info(accounts_iter)?;
    if spl_ata.key != &spl_associated_token_account::id() || !spl_ata.executable {
        return Err(ProgramError::InvalidArgument);
    }
    let payer_account = next_account_info(accounts_iter)?;

    let erc20_account = next_account_info(accounts_iter)?;
    let erc20 = HyperlaneErc20Account::fetch(&mut &erc20_account.data.borrow_mut()[..])?
        .into_inner();
    let expected_erc20_key = Pubkey::create_program_address(
        hyperlane_token_erc20_pda_seeds!(erc20.name, erc20.symbol, erc20.erc20_bump),
        program_id,
    )?;
    if erc20_account.key != &expected_erc20_key {
        return Err(ProgramError::InvalidArgument);
    }
    if erc20_account.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }

    let mint_account = next_account_info(accounts_iter)?;
    let expected_mint_key = Pubkey::create_program_address(
        hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump),
        program_id,
    )?;
    if mint_account.key != &expected_mint_key {
        return Err(ProgramError::InvalidArgument);
    }
    if mint_account.owner != &spl_token_2022::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let mint = Mint::unpack_from_slice(&mint_account.data.borrow())?;

    let recipient_wallet = next_account_info(accounts_iter)?;
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
        &[hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump)],
    )?;

    let amount = xfer
        .amount
        .try_into()
        .map_err(|_| Error::TODO)?;
    let total = mint.supply
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
        &[mint_account.clone(), recipient_ata.clone(), mint_account.clone()],
        &[hyperlane_token_mint_pda_seeds!(erc20.name, erc20.symbol, erc20.mint_bump)],
    )?;

    Ok(())
/*
    _mint(_recipient, _amount);
*/
}
