//! This program's own `InterchainSecurityModuleInstruction` implementation
//! — registered as its own ISM at `Init` time (`interchain_security_module =
//! Some(this_program_id)`), mirroring EVM's `TokenBridgeCctpV2` fusing
//! Router + ISM into one contract.
//!
//! `Verify()` is where the actual mint happens, as a side effect of a
//! successful CPI into Circle's real `MessageTransmitterV2.receive_message`
//! (receiver = `TokenMessengerMinterV2`, Circle's own program — not this
//! one, so no reentrancy concern). This mirrors
//! `TokenBridgeCctpBase.verify()` on EVM exactly: verification and value
//! movement are the same call.
//!
//! Unlike the composite-ism `CctpV2` GMP node, this ISM does **not** need to
//! check the CCTP message's `sender` field itself — Circle's own
//! `handle_receive_finalized_message` already checks it against the
//! `remote_token_messenger` registry (see `circle.rs` module docs). What
//! this ISM *does* need to check, that Circle's programs know nothing
//! about, is that the accompanying Hyperlane `TokenMessage` actually
//! describes the same transfer as the CCTP `BurnMessage` (amount, recipient)
//! — mirroring EVM's `_validateTokenMessage`.
//!
//! `Verify()`'s two CPI-signer roles (Circle's own `payer`/`caller` params
//! for `receive_message`) are **not** externally-supplied signer accounts —
//! the Sealevel relayer forces any signer an ISM's account-metas response
//! declares down to non-signer unless it matches a separately-configured
//! `identity` key, and hard-errors if the real transaction payer appears in
//! the list at all (`hyperlane-sealevel/src/utils.rs::sanitize_dynamic_accounts`).
//! So both roles are filled by this program's own `ata_payer` PDA, signed
//! for internally via `invoke_signed` — the same pattern already used here
//! for the idempotent recipient-ATA creation.

use borsh::BorshDeserialize;
use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    instruction::AccountMeta,
    program::{invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use spl_associated_token_account::{
    get_associated_token_address_with_program_id,
    instruction::create_associated_token_account_idempotent,
};

use crate::{
    circle::{
        self, handle_receive_message_remaining_accounts, receive_message_instruction, BurnMessage,
        CctpV2Header, CCTP_SOLANA_DOMAIN, CCTP_V2_MESSAGE_VERSION,
    },
    hyperlane_token_cctp_ata_payer_pda_seeds,
};

#[derive(borsh::BorshSerialize, borsh::BorshDeserialize, Debug, PartialEq)]
struct CctpV2Metadata {
    message: Vec<u8>,
    attestation: Vec<u8>,
}

/// Handles the ISM-namespace instructions this program also implements.
pub fn process_ism_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction: InterchainSecurityModuleInstruction,
) -> ProgramResult {
    match instruction {
        InterchainSecurityModuleInstruction::Type => ism_type(),
        InterchainSecurityModuleInstruction::Verify(data) => {
            let message = HyperlaneMessage::read_from(&mut &data.message[..])
                .map_err(|_| ProgramError::InvalidArgument)?;
            verify(program_id, accounts, &data.metadata, &message)
        }
        InterchainSecurityModuleInstruction::VerifyAccountMetas(data) => {
            let account_metas = verify_account_metas(program_id, accounts, &data.metadata)?;
            let bytes = borsh::to_vec(&SimulationReturnData::new(account_metas))
                .map_err(|_| ProgramError::BorshIoError)?;
            set_return_data(&bytes);
            Ok(())
        }
        InterchainSecurityModuleInstruction::VerifyMetadataSpec(_) => {
            // No generic MetadataSpec support (yet) — same reasoning
            // composite-ism's CctpV2 node used for MetadataSpec::Null; a
            // relayer integration builds CctpV2Metadata explicitly rather
            // than discovering its shape generically.
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

fn ism_type() -> ProgramResult {
    let bytes = borsh::to_vec(&SimulationReturnData::new(
        hyperlane_core::ModuleType::CctpV2 as u32,
    ))
    .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes);
    Ok(())
}

/// Accounts (every PDA we have a confirmed derivation for is independently
/// re-derived here and checked against the supplied account — never trusted
/// blindly just because the caller labeled it correctly):
/// 0.  `[]` The generic `VERIFY_ACCOUNT_METAS_PDA_SEEDS` PDA every ISM's
///     `VerifyAccountMetas` caller bootstraps with — unused by this ISM
///     (our persistent config lives at a different, token-lib-standard PDA,
///     account 1 below), consumed here only to keep this account list
///     positionally identical to whatever `VerifyAccountMetas` converges to.
/// 1.  `[]` This program's persistent `HyperlaneToken<CctpPlugin>` config
///     PDA (checked against `mint_info`, below).
/// 2.  `[writable]` This program's `ata_payer` PDA (derived, checked) —
///     funds idempotent recipient-ATA creation, and internally signs (via
///     `invoke_signed`) both of Circle's `payer`/`caller` roles for
///     `receive_message`.
/// 3.  `[]` The recipient wallet (checked against `BurnMessage.mint_recipient`).
/// 4.  `[writable]` The recipient's associated token account.
/// 5.  `[writable]` The USDC mint (checked against our own config, account 1).
/// 6.  `[executable]` The SPL token program (token or token-2022).
/// 7.  `[executable]` The SPL associated-token-account program (unused
///     directly — see inline note at its `next_account_info` call).
/// 8.  `[executable]` The system program.
/// 9.  `[writable]` Circle's `message_transmitter` config PDA (derived, checked).
/// 10. `[writable]` Circle's `used_nonce` PDA (derived from the parsed CCTP
///     message's nonce, checked).
/// 11. `[]` Circle's `authority_pda` (derived, checked — `MessageTransmitterV2`'s
///     own signer for its internal CPI into `TokenMessengerMinterV2`, never
///     signed by us).
/// 12. `[]` Circle's `token_messenger` singleton config (derived, checked).
/// 13. `[]` Circle's `remote_token_messenger` PDA for the burn's source
///     domain (derived, checked).
/// 14. `[]` Circle's `token_minter` singleton config (derived, checked).
/// 15. `[writable]` Circle's `local_token` PDA for the USDC mint (derived,
///     checked).
/// 16. `[writable]` Circle's `token_pair` PDA for `(source_domain,
///     burn_token)` (derived, checked).
/// 17. `[writable]` Circle's fee-recipient token account — the ATA of
///     `token_messenger`'s mutable `fee_recipient` field (read from account
///     12's data, then derived as a standard ATA; checked).
/// 18. `[writable]` Circle's `custody_token_account` PDA for the USDC mint
///     (derived, checked).
/// 19. `[]` Circle's event-CPI `event_authority` PDA (derived, checked) —
///     `TokenMessengerMinterV2`'s own, for its `handle_receive_finalized_message`
///     `#[event_cpi]`.
/// 20. `[executable]` `TokenMessengerMinterV2`'s own program account
///     (checked against the constant program ID — used both as the
///     `receive_message` `receiver` and as the event-CPI `program` account;
///     one `AccountInfo` covers both `AccountMeta` occurrences).
/// 21. `[executable]` `MessageTransmitterV2`'s own program account (derived,
///     checked) — required for `invoke_signed` to locate/call it as the
///     `receive_message` CPI target.
/// 22. `[]` `MessageTransmitterV2`'s own event-CPI `event_authority` PDA
///     (derived, checked) — its `receive_message` instruction is itself
///     `#[event_cpi]`-annotated for its own `emit_cpi!(MessageReceived)`,
///     distinct from account 19 above (different program, different PDA).
#[allow(clippy::too_many_arguments)]
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> ProgramResult {
    let meta: CctpV2Metadata = BorshDeserialize::try_from_slice(metadata)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let header = CctpV2Header::parse(&meta.message)?;

    if header.version != CCTP_V2_MESSAGE_VERSION {
        return Err(ProgramError::InvalidInstructionData);
    }
    // Sanity check only — Circle's own receive_message call (triggered
    // below) independently enforces this against its own local_domain.
    if header.destination_domain != CCTP_SOLANA_DOMAIN {
        return Err(ProgramError::InvalidInstructionData);
    }

    let burn_message = BurnMessage::parse(header.message_body)?;
    let remote_burn_token = burn_message.burn_token.to_bytes();

    // Cross-validate against the accompanying Hyperlane TokenMessage — this
    // is NOT something Circle's programs check; it's what ties the two
    // independently-dispatched artifacts (CCTP burn + Hyperlane message) to
    // the same real transfer. Mirrors EVM's `_validateTokenMessage`.
    let token_message = TokenMessage::read_from(&mut &message.body[..])
        .map_err(|_| ProgramError::InvalidArgument)?;
    if token_message.amount() != burn_message.amount.into() {
        return Err(ProgramError::InvalidInstructionData);
    }
    let expected_recipient = Pubkey::new_from_array(token_message.recipient().into());
    if expected_recipient != burn_message.mint_recipient {
        return Err(ProgramError::InvalidInstructionData);
    }

    let accounts_iter = &mut accounts.iter();
    let _vam_pda_info = next_account_info(accounts_iter)?;
    let token_config_info = next_account_info(accounts_iter)?;
    let ata_payer_info = next_account_info(accounts_iter)?;
    let recipient_wallet_info = next_account_info(accounts_iter)?;
    if *recipient_wallet_info.key != burn_message.mint_recipient {
        return Err(ProgramError::InvalidArgument);
    }
    let recipient_token_account_info = next_account_info(accounts_iter)?;
    let mint_info = next_account_info(accounts_iter)?;
    let token_program_info = next_account_info(accounts_iter)?;
    // Not referenced directly (see collateral plugin precedent: invoke()
    // resolves the CPI target from the built Instruction's own program_id,
    // cross-checked against the current instruction's full account set —
    // this account just needs to be present somewhere in that set, which
    // consuming it here from accounts_iter satisfies).
    let _ata_program_info = next_account_info(accounts_iter)?;
    let system_program_info = next_account_info(accounts_iter)?;
    let message_transmitter_info = next_account_info(accounts_iter)?;
    let used_nonce_info = next_account_info(accounts_iter)?;
    let authority_pda_info = next_account_info(accounts_iter)?;
    let token_messenger_info = next_account_info(accounts_iter)?;
    let remote_token_messenger_info = next_account_info(accounts_iter)?;
    let token_minter_info = next_account_info(accounts_iter)?;
    let local_token_info = next_account_info(accounts_iter)?;
    let token_pair_info = next_account_info(accounts_iter)?;
    let fee_recipient_token_account_info = next_account_info(accounts_iter)?;
    let custody_token_account_info = next_account_info(accounts_iter)?;
    let event_authority_info = next_account_info(accounts_iter)?;
    let token_messenger_minter_program_info = next_account_info(accounts_iter)?;
    let message_transmitter_program_info = next_account_info(accounts_iter)?;
    let message_transmitter_event_authority_info = next_account_info(accounts_iter)?;

    let (ata_payer_key, ata_payer_bump) = crate::accounts::derive_ata_payer_pda(program_id);
    if *ata_payer_info.key != ata_payer_key {
        return Err(ProgramError::InvalidArgument);
    }
    if *token_messenger_minter_program_info.key != circle::token_messenger_minter::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *message_transmitter_program_info.key != circle::message_transmitter::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (expected_message_transmitter_event_authority, _) =
        circle::derive_event_authority_pda(&circle::message_transmitter::ID);
    if *message_transmitter_event_authority_info.key != expected_message_transmitter_event_authority
    {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_message_transmitter, _) = circle::derive_message_transmitter_pda();
    if *message_transmitter_info.key != expected_message_transmitter {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_used_nonce, _) = circle::derive_used_nonce_pda(&header.nonce);
    if *used_nonce_info.key != expected_used_nonce {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_authority_pda, _) = circle::derive_message_transmitter_authority_pda();
    if *authority_pda_info.key != expected_authority_pda {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_token_messenger, _) = circle::derive_token_messenger_pda();
    if *token_messenger_info.key != expected_token_messenger {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_remote_token_messenger, _) =
        circle::derive_remote_token_messenger_pda(header.source_domain);
    if *remote_token_messenger_info.key != expected_remote_token_messenger {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_token_minter, _) = circle::derive_token_minter_pda();
    if *token_minter_info.key != expected_token_minter {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_local_token, _) = circle::derive_local_token_pda(mint_info.key);
    if *local_token_info.key != expected_local_token {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_token_pair, _) =
        circle::derive_token_pair_pda(header.source_domain, &remote_burn_token);
    if *token_pair_info.key != expected_token_pair {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_custody, _) = circle::derive_custody_token_account_pda(mint_info.key);
    if *custody_token_account_info.key != expected_custody {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_event_authority, _) =
        circle::derive_event_authority_pda(&circle::token_messenger_minter::ID);
    if *event_authority_info.key != expected_event_authority {
        return Err(ProgramError::InvalidArgument);
    }

    // Load our own persistent token config and confirm `mint_info` really is
    // this program's configured USDC mint — otherwise a caller could
    // substitute an arbitrary mint here (Circle's own `token_pair` PDA check
    // binds `burn_token` <-> `local_token`/mint on ITS side, but that alone
    // doesn't stop a caller from passing a *different*, unconfigured mint
    // account into this instruction).
    let token_config = hyperlane_sealevel_token_lib::accounts::HyperlaneTokenAccount::<
        crate::accounts::CctpPlugin,
    >::fetch_data(&mut &token_config_info.data.borrow()[..])?
    .ok_or(ProgramError::UninitializedAccount)?;
    if token_config.plugin_data.mint != *mint_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let expected_fee_recipient_token_account = {
        let fee_recipient =
            circle::parse_token_messenger_fee_recipient(&token_messenger_info.data.borrow())?;
        get_associated_token_address_with_program_id(
            &fee_recipient,
            mint_info.key,
            token_program_info.key,
        )
    };
    if *fee_recipient_token_account_info.key != expected_fee_recipient_token_account {
        return Err(ProgramError::InvalidArgument);
    }

    // Ensure the recipient's ATA exists before Circle's mint CPI writes to
    // it — Circle's program requires the token account to already exist.
    invoke_signed(
        &create_associated_token_account_idempotent(
            ata_payer_info.key,
            recipient_wallet_info.key,
            mint_info.key,
            token_program_info.key,
        ),
        &[
            ata_payer_info.clone(),
            recipient_token_account_info.clone(),
            recipient_wallet_info.clone(),
            mint_info.clone(),
            system_program_info.clone(),
            token_program_info.clone(),
        ],
        &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
    )?;
    account_utils::verify_rent_exempt(ata_payer_info, &Rent::get()?)?;

    let remaining_accounts = handle_receive_message_remaining_accounts(
        *token_messenger_info.key,
        header.source_domain,
        &remote_burn_token,
        *token_minter_info.key,
        *mint_info.key,
        *fee_recipient_token_account_info.key,
        *recipient_token_account_info.key,
        *token_program_info.key,
    );

    // `ata_payer` fills both of Circle's signer roles (`payer` and
    // `caller`) — see module docs for why these can't be externally-supplied
    // signer accounts on Sealevel.
    let ixn = receive_message_instruction(
        ata_payer_key,
        ata_payer_key,
        *authority_pda_info.key,
        *message_transmitter_info.key,
        *used_nonce_info.key,
        *system_program_info.key,
        meta.message,
        meta.attestation,
        &remaining_accounts,
    )?;

    let cpi_accounts = vec![
        ata_payer_info.clone(), // payer
        ata_payer_info.clone(), // caller
        authority_pda_info.clone(),
        message_transmitter_info.clone(),
        used_nonce_info.clone(),
        system_program_info.clone(),
        token_messenger_minter_program_info.clone(),
        token_messenger_info.clone(),
        remote_token_messenger_info.clone(),
        token_minter_info.clone(),
        local_token_info.clone(),
        token_pair_info.clone(),
        fee_recipient_token_account_info.clone(),
        recipient_token_account_info.clone(),
        custody_token_account_info.clone(),
        token_program_info.clone(),
        event_authority_info.clone(),
        mint_info.clone(),
        message_transmitter_program_info.clone(),
        message_transmitter_event_authority_info.clone(),
    ];

    invoke_signed(
        &ixn,
        &cpi_accounts,
        &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
    )?;

    Ok(())
}

/// Returns the account metas required for `Verify`, matching its exact
/// layout (see doc comment above `verify`) — including position, which
/// matters: this is consumed positionally via `next_account_info` there.
/// Resolved over the fixpoint loop `get_ism_verify_account_metas` runs
/// (`hyperlane-sealevel/src/provider.rs`): round 1 supplies only the generic
/// VAM PDA (account 0); once this function's own response is fed back as
/// the next round's input, our persistent token config (account 1) and,
/// a round later, Circle's `token_messenger` singleton (account 12, needed
/// to read its mutable `fee_recipient` field) become real, readable
/// accounts. Converges in a small, fixed number of rounds — see module
/// docs.
fn verify_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let meta: CctpV2Metadata = BorshDeserialize::try_from_slice(metadata)
        .map_err(|_| ProgramError::InvalidInstructionData)?;
    let header = CctpV2Header::parse(&meta.message)?;
    let burn_message = BurnMessage::parse(header.message_body)?;
    let remote_burn_token = burn_message.burn_token.to_bytes();

    let (vam_pda, _) = Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, program_id);
    let (token_config_pda, _) = Pubkey::find_program_address(
        hyperlane_sealevel_token_lib::hyperlane_token_pda_seeds!(),
        program_id,
    );

    let base: Vec<SerializableAccountMeta> = vec![
        AccountMeta::new_readonly(vam_pda, false).into(),
        AccountMeta::new_readonly(token_config_pda, false).into(),
    ];

    let token_config_info = match find_account(accounts, &token_config_pda) {
        Some(info) if !info.data_is_empty() => info,
        // Not readable yet on this round — ask for it next round.
        _ => return Ok(base),
    };

    let token_config = hyperlane_sealevel_token_lib::accounts::HyperlaneTokenAccount::<
        crate::accounts::CctpPlugin,
    >::fetch_data(&mut &token_config_info.data.borrow()[..])?
    .ok_or(ProgramError::UninitializedAccount)?;
    let mint = token_config.plugin_data.mint;
    let spl_token_program = token_config.plugin_data.spl_token_program;

    let (ata_payer_key, _) = crate::accounts::derive_ata_payer_pda(program_id);
    let (message_transmitter_key, _) = circle::derive_message_transmitter_pda();
    let (used_nonce_key, _) = circle::derive_used_nonce_pda(&header.nonce);
    let (authority_pda_key, _) = circle::derive_message_transmitter_authority_pda();
    let (token_messenger_key, _) = circle::derive_token_messenger_pda();
    let (remote_token_messenger_key, _) =
        circle::derive_remote_token_messenger_pda(header.source_domain);
    let (token_minter_key, _) = circle::derive_token_minter_pda();
    let (local_token_key, _) = circle::derive_local_token_pda(&mint);
    let (token_pair_key, _) =
        circle::derive_token_pair_pda(header.source_domain, &remote_burn_token);
    let (custody_key, _) = circle::derive_custody_token_account_pda(&mint);
    let (event_authority_key, _) =
        circle::derive_event_authority_pda(&circle::token_messenger_minter::ID);

    let recipient_wallet = burn_message.mint_recipient;
    let recipient_token_account =
        get_associated_token_address_with_program_id(&recipient_wallet, &mint, &spl_token_program);

    // Positions 0-16 exactly, matching `verify()`'s parse order. Everything
    // from `fee_recipient_token_account` (17) onward is appended below, in
    // order — NOT included here — since `fee_recipient_token_account`'s
    // value depends on `token_messenger`'s live data (fetched in a later
    // round), and it must land at position 17, not after the accounts that
    // don't depend on it (custody/event_authority/program accounts at
    // 18-22, which final `verify()` expects strictly after it).
    let mut result: Vec<SerializableAccountMeta> = vec![
        AccountMeta::new_readonly(vam_pda, false).into(),
        AccountMeta::new_readonly(token_config_pda, false).into(),
        AccountMeta::new(ata_payer_key, false).into(),
        AccountMeta::new_readonly(recipient_wallet, false).into(),
        AccountMeta::new(recipient_token_account, false).into(),
        AccountMeta::new(mint, false).into(),
        AccountMeta::new_readonly(spl_token_program, false).into(),
        AccountMeta::new_readonly(spl_associated_token_account::id(), false).into(),
        AccountMeta::new_readonly(solana_system_interface::program::ID, false).into(),
        AccountMeta::new(message_transmitter_key, false).into(),
        AccountMeta::new(used_nonce_key, false).into(),
        AccountMeta::new_readonly(authority_pda_key, false).into(),
        AccountMeta::new_readonly(token_messenger_key, false).into(),
        AccountMeta::new_readonly(remote_token_messenger_key, false).into(),
        AccountMeta::new_readonly(token_minter_key, false).into(),
        AccountMeta::new(local_token_key, false).into(),
        AccountMeta::new(token_pair_key, false).into(),
    ];

    let fee_recipient_token_account = match find_account(accounts, &token_messenger_key) {
        Some(info) if !info.data_is_empty() => {
            let fee_recipient = circle::parse_token_messenger_fee_recipient(&info.data.borrow())?;
            get_associated_token_address_with_program_id(&fee_recipient, &mint, &spl_token_program)
        }
        // token_messenger is now in `result` (added above) but not yet
        // readable this round — ask for it next round.
        _ => return Ok(result),
    };
    let (message_transmitter_event_authority_key, _) =
        circle::derive_event_authority_pda(&circle::message_transmitter::ID);
    result.push(AccountMeta::new(fee_recipient_token_account, false).into()); // 17
    result.push(AccountMeta::new(custody_key, false).into()); // 18
    result.push(AccountMeta::new_readonly(event_authority_key, false).into()); // 19
    result.push(AccountMeta::new_readonly(circle::token_messenger_minter::ID, false).into()); // 20
    result.push(AccountMeta::new_readonly(circle::message_transmitter::ID, false).into()); // 21
    result.push(AccountMeta::new_readonly(message_transmitter_event_authority_key, false).into()); // 22

    Ok(result)
}

fn find_account<'a, 'b>(
    accounts: &'a [AccountInfo<'b>],
    key: &Pubkey,
) -> Option<&'a AccountInfo<'b>> {
    accounts.iter().find(|info| info.key == key)
}
