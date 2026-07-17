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

use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction;
use hyperlane_warp_route::TokenMessage;
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;

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
        InterchainSecurityModuleInstruction::VerifyAccountMetas(_) => {
            // No generic account-discovery support (yet) — the account list
            // is large, fixed, and confirmed directly against Circle's
            // source; a relayer integration builds it explicitly rather than
            // via the fixpoint simulation loop composite-ism uses. See open
            // items in the accompanying plan notes.
            Err(ProgramError::InvalidInstructionData)
        }
        InterchainSecurityModuleInstruction::VerifyMetadataSpec(_) => {
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

fn ism_type() -> ProgramResult {
    use solana_program::program::set_return_data;
    // No CCTP-specific ModuleType exists upstream; Null is the closest
    // accurate signal ("no special relayer-side metadata construction is
    // generically supported") — same reasoning composite-ism's CctpV2 node
    // used for MetadataSpec::Null.
    let bytes = borsh::to_vec(&SimulationReturnData::new(
        hyperlane_core::ModuleType::Unused as u32,
    ))
    .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes);
    Ok(())
}

/// Accounts (every PDA we have a confirmed derivation for is independently
/// re-derived here and checked against the supplied account — never
/// trusted blindly just because the caller labeled it correctly):
/// 0.  `[]` This program's persistent `HyperlaneToken<CctpPlugin>` config
///     PDA (checked against `mint_info`, below).
/// 1.  `[signer, writable]` The payer (Circle's `receive_message` payer;
///     also funds idempotent recipient-ATA creation via the ata_payer PDA).
/// 2.  `[signer]` Circle's `caller` account (permissionless unless the
///     origin's `destination_caller` was set restrictively).
/// 3.  `[writable]` This program's ata_payer PDA (derived, checked).
/// 4.  `[]` The recipient wallet (checked against `BurnMessage.mint_recipient`).
/// 5.  `[writable]` The recipient's associated token account.
/// 6.  `[writable]` The USDC mint (checked against our own config, account 0).
/// 7.  `[executable]` The SPL token program (token or token-2022).
/// 8.  `[executable]` The SPL associated-token-account program (unused
///     directly — see inline note at its `next_account_info` call).
/// 9.  `[executable]` The system program.
/// 10. `[writable]` Circle's `message_transmitter` config PDA (derived, checked).
/// 11. `[writable]` Circle's `used_nonce` PDA (derived from the parsed
///     CCTP message's nonce, checked).
/// 12. `[]` Circle's `authority_pda` (derived, checked — `MessageTransmitterV2`'s
///     own signer for its internal CPI into `TokenMessengerMinterV2`, never
///     signed by us).
/// 13. `[]` Circle's `token_messenger` config. **Not independently derived —
///     its exact PDA seed wasn't confirmed in this research pass (unlike
///     `remote_token_messenger`/`local_token`/`token_pair`/`custody`, which
///     were); trusted as supplied for now. Flagged as an open item.**
/// 14. `[]` Circle's `remote_token_messenger` PDA for the burn's source
///     domain (derived, checked).
/// 15. `[]` Circle's `token_minter` config. **Same caveat as `token_messenger`
///     above — not independently derived.**
/// 16. `[writable]` Circle's `local_token` PDA for the USDC mint (derived,
///     checked).
/// 17. `[writable]` Circle's `token_pair` PDA for
///     `(source_domain, burn_token)` (derived, checked).
/// 18. `[writable]` Circle's fee-recipient token account. **Open item: this
///     address needs to be sourced from `TokenMinter`'s on-chain config —
///     not independently confirmed in this pass; trusted as supplied.**
/// 19. `[writable]` Circle's `custody_token_account` PDA for the USDC mint
///     (derived, checked).
/// 20. `[]` Circle's event-CPI `event_authority` PDA (derived, checked).
/// 21. `[executable]` `TokenMessengerMinterV2`'s own program account
///     (checked against the constant program ID — used both as the
///     `receive_message` `receiver` and as the event-CPI `program` account;
///     one `AccountInfo` covers both `AccountMeta` occurrences).
#[allow(clippy::too_many_arguments)]
fn verify(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> ProgramResult {
    let meta: CctpV2Metadata = borsh::BorshDeserialize::try_from_slice(metadata)
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
    let token_config_info = next_account_info(accounts_iter)?;
    let payer_info = next_account_info(accounts_iter)?;
    let caller_info = next_account_info(accounts_iter)?;
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

    let (ata_payer_key, ata_payer_bump) = crate::accounts::derive_ata_payer_pda(program_id);
    if *ata_payer_info.key != ata_payer_key {
        return Err(ProgramError::InvalidArgument);
    }
    if *token_messenger_minter_program_info.key != circle::token_messenger_minter::ID {
        return Err(ProgramError::IncorrectProgramId);
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
    let (expected_remote_token_messenger, _) =
        circle::derive_remote_token_messenger_pda(header.source_domain);
    if *remote_token_messenger_info.key != expected_remote_token_messenger {
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

    let ixn = receive_message_instruction(
        *payer_info.key,
        *caller_info.key,
        *authority_pda_info.key,
        *message_transmitter_info.key,
        *used_nonce_info.key,
        *system_program_info.key,
        meta.message,
        meta.attestation,
        &remaining_accounts,
    )?;

    let cpi_accounts = vec![
        payer_info.clone(),
        caller_info.clone(),
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
    ];

    invoke(&ixn, &cpi_accounts)?;

    Ok(())
}
