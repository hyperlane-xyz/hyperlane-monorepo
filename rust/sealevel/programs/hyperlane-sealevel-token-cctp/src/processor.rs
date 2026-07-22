//! Program processor.

use access_control::AccessControl;
use account_utils::{create_pda_account, DiscriminatorDecode};
use hyperlane_sealevel_message_recipient_interface::{
    HandleInstruction, MessageRecipientInstruction,
};
use hyperlane_sealevel_token_lib::{
    accounts::HyperlaneTokenAccount,
    instruction::{Init, Instruction as TokenIxn, TransferRemoteWithMemo},
    processor::HyperlaneSealevelToken,
};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    msg,
    program::{invoke, invoke_signed, set_return_data},
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};
use spl_associated_token_account::instruction::create_associated_token_account_idempotent;
use spl_token_2022::instruction::transfer_checked;

use crate::{
    accounts::{
        derive_ata_payer_pda, derive_remote_config_pda, CctpPlugin, RemoteConfig,
        RemoteConfigAccount,
    },
    cctp_remote_config_pda_seeds,
    circle::{self, deposit_for_burn_instruction, DepositForBurnParams},
    hyperlane_token_cctp_ata_payer_pda_seeds,
    instruction::{CctpInstruction, SetRemoteConfig},
    ism::{process_ism_instruction, stage_verify_metadata},
};

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Marker type for PackageVersioned trait implementation.
pub struct HyperlaneCctpTokenProgram;
impl package_versioned::PackageVersioned for HyperlaneCctpTokenProgram {}

/// Processes an instruction.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if package_versioned::is_get_program_version(instruction_data) {
        return package_versioned::process_get_program_version::<HyperlaneCctpTokenProgram>();
    }

    // This program's own ISM (Verify() is where the mint happens).
    if let Ok(ism_instruction) =
        hyperlane_sealevel_interchain_security_module_interface::InterchainSecurityModuleInstruction::decode(
            instruction_data,
        )
    {
        return process_ism_instruction(program_id, accounts, ism_instruction);
    }

    // The shared message-recipient interface (ISM getter + Handle).
    if let Ok(message_recipient_instruction) = MessageRecipientInstruction::decode(instruction_data)
    {
        return match message_recipient_instruction {
            MessageRecipientInstruction::InterchainSecurityModule => {
                interchain_security_module(program_id, accounts)
            }
            MessageRecipientInstruction::InterchainSecurityModuleAccountMetas => {
                interchain_security_module_account_metas(program_id)
            }
            MessageRecipientInstruction::Handle(handle) => transfer_from_remote(
                program_id,
                accounts,
                HandleInstruction {
                    origin: handle.origin,
                    sender: handle.sender,
                    message: handle.message,
                },
            ),
            MessageRecipientInstruction::HandleAccountMetas(handle) => {
                transfer_from_remote_account_metas(
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

    // This program's own CCTP-specific config instruction.
    if let Ok(CctpInstruction::SetRemoteConfig(config)) = CctpInstruction::decode(instruction_data)
    {
        return set_remote_config(program_id, accounts, config).map_err(|err| {
            msg!("{}", err);
            err
        });
    }

    // Stages {message, attestation} ahead of `Verify()` — see module docs
    // on `StageVerifyMetadata`.
    if let Ok(CctpInstruction::StageVerifyMetadata(params)) =
        CctpInstruction::decode(instruction_data)
    {
        return stage_verify_metadata(program_id, accounts, params).map_err(|err| {
            msg!("{}", err);
            err
        });
    }

    // Fall back to the generic token instruction set.
    match TokenIxn::decode(instruction_data)? {
        TokenIxn::Init(init) => initialize(program_id, accounts, init),
        TokenIxn::TransferRemote(xfer) => transfer_remote_with_memo(
            program_id,
            accounts,
            TransferRemoteWithMemo {
                xfer,
                memo: Vec::with_capacity(0),
            },
        ),
        TokenIxn::TransferRemoteWithMemo(xfer) => {
            transfer_remote_with_memo(program_id, accounts, xfer)
        }
        TokenIxn::EnrollRemoteRouter(config) => enroll_remote_router(program_id, accounts, config),
        TokenIxn::EnrollRemoteRouters(configs) => {
            enroll_remote_routers(program_id, accounts, configs)
        }
        TokenIxn::SetDestinationGasConfigs(configs) => {
            set_destination_gas_configs(program_id, accounts, configs)
        }
        TokenIxn::TransferOwnership(new_owner) => {
            transfer_ownership(program_id, accounts, new_owner)
        }
        TokenIxn::SetInterchainSecurityModule(new_ism) => {
            set_interchain_security_module(program_id, accounts, new_ism)
        }
        TokenIxn::SetInterchainGasPaymaster(new_igp) => {
            set_interchain_gas_paymaster(program_id, accounts, new_igp)
        }
        TokenIxn::SetFeeConfig(fee_config) => set_fee_config(program_id, accounts, fee_config),
    }
    .map_err(|err| {
        msg!("{}", err);
        err
    })
}

/// Initializes the program. Whatever `init.interchain_security_module` is
/// set to is irrelevant — see `interchain_security_module()` below, which
/// hardcodes the answer to this program's own address regardless of any
/// stored config.
fn initialize(program_id: &Pubkey, accounts: &[AccountInfo], init: Init) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::initialize(program_id, accounts, init)
}

/// Escrows the sender's USDC into this program's `ata_payer` PDA's own
/// associated token account, then burns from there via a direct CPI into
/// Circle's real `TokenMessengerMinterV2.deposit_for_burn` — passing
/// `ata_payer` itself as Circle's `owner`, so Circle records `ata_payer` as
/// the burn's `messageSender`. This is what lets the EVM side recognize the
/// burn: `TokenBridgeCctpBase.cctpAuthorityOverrides` is configured with
/// this exact `ata_payer` PDA per Sealevel origin domain, since a Solana
/// program can never make its own literal address appear as a CPI signer —
/// only PDAs derived from it, which is why `owner` can't be this program's
/// `program_id` and must instead be a PDA it signs for via `invoke_signed`.
///
/// Finally delegates the remaining accounts to the generic library's
/// dispatch machinery (which calls `CctpPlugin::transfer_in` — a no-op,
/// since the burn already happened here).
///
/// Accounts, in order:
/// 0.  `[]` This program's `HyperlaneToken<CctpPlugin>` config PDA (to
///     confirm `burn_token_mint` matches the configured mint, and to read
///     `decimals` for the escrow transfer).
/// 1.  `[]` The remote-config PDA for `transfer.xfer.destination_domain`.
/// 2.  `[signer]` The sender wallet — authorizes the escrow transfer out of
///     their own USDC account. No longer passed to Circle as `owner`.
/// 3.  `[writable]` The sender's USDC token account (escrow transfer source).
/// 4.  `[signer, writable]` The event-rent payer for Circle's CPI.
/// 5.  `[writable]` This program's `ata_payer` PDA (derived, checked) — funds
///     idempotent escrow-ATA creation and signs, via `invoke_signed`, both
///     the escrow ATA creation and Circle's `owner` role below.
/// 6.  `[writable]` `ata_payer`'s own associated token account for the USDC
///     mint (escrow account — burned from).
/// 7.  `[]` `TokenMessengerMinterV2`'s `sender_authority` PDA (Circle signs
///     this internally via its own `invoke_signed` — we never sign it).
/// 8.  `[]` `ata_payer`'s `denylist_account` PDA.
/// 9.  `[writable]` Circle's `message_transmitter` global config PDA.
/// 10. `[]` Circle's `token_messenger` singleton config (trusted as
///     supplied — seeds not independently confirmed, same open item noted
///     in `ism.rs`).
/// 11. `[]` The `remote_token_messenger` PDA for the destination Circle
///     domain.
/// 12. `[]` Circle's `token_minter` singleton config (same caveat as 10).
/// 13. `[writable]` The `local_token` PDA for the USDC mint.
/// 14. `[writable]` The USDC mint.
/// 15. `[signer, writable]` A fresh, uninitialized account for Circle's
///     `message_sent_event_data`.
/// 16. `[]` `MessageTransmitterV2`'s own program account.
/// 17. `[]` `TokenMessengerMinterV2`'s own program account.
/// 18. `[executable]` The SPL token program.
/// 19. `[executable]` The system program.
/// 20. `[]` `TokenMessengerMinterV2`'s `event_authority` PDA.
/// 21. `[executable]` The SPL associated-token-account program (needed for
///     idempotent escrow-ATA creation).
///
/// Followed by whatever accounts `HyperlaneSealevelToken::transfer_remote_with_memo`
/// itself requires (see `hyperlane-sealevel-token-collateral`'s account list
/// for the shape; `CctpPlugin::transfer_in`/`transfer_out_account_metas`
/// need none of their own).
fn transfer_remote_with_memo(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemoteWithMemo,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let token_config_info = next_account_info(accounts_iter)?;
    let remote_config_info = next_account_info(accounts_iter)?;
    let owner_info = next_account_info(accounts_iter)?;
    let owner_token_account_info = next_account_info(accounts_iter)?;
    let event_rent_payer_info = next_account_info(accounts_iter)?;
    let ata_payer_info = next_account_info(accounts_iter)?;
    let ata_payer_ata_info = next_account_info(accounts_iter)?;
    let sender_authority_info = next_account_info(accounts_iter)?;
    let denylist_account_info = next_account_info(accounts_iter)?;
    let message_transmitter_info = next_account_info(accounts_iter)?;
    let token_messenger_info = next_account_info(accounts_iter)?;
    let remote_token_messenger_info = next_account_info(accounts_iter)?;
    let token_minter_info = next_account_info(accounts_iter)?;
    let local_token_info = next_account_info(accounts_iter)?;
    let burn_token_mint_info = next_account_info(accounts_iter)?;
    let message_sent_event_data_info = next_account_info(accounts_iter)?;
    let message_transmitter_program_info = next_account_info(accounts_iter)?;
    let token_messenger_minter_program_info = next_account_info(accounts_iter)?;
    let token_program_info = next_account_info(accounts_iter)?;
    let system_program_info = next_account_info(accounts_iter)?;
    let event_authority_info = next_account_info(accounts_iter)?;
    // Not referenced directly (same reasoning as `ism.rs`'s recipient-ATA
    // creation: invoke_signed() resolves the CPI target from the built
    // Instruction's own program_id, cross-checked against the current
    // instruction's full account set — this account just needs to be
    // present somewhere in that set, which consuming it here satisfies).
    let _ata_program_info = next_account_info(accounts_iter)?;

    let token_config =
        HyperlaneTokenAccount::<CctpPlugin>::fetch_data(&mut &token_config_info.data.borrow()[..])?
            .ok_or(ProgramError::UninitializedAccount)?;
    if token_config.plugin_data.mint != *burn_token_mint_info.key {
        return Err(ProgramError::InvalidArgument);
    }

    let (remote_config_key, _) =
        derive_remote_config_pda(program_id, transfer.xfer.destination_domain);
    if *remote_config_info.key != remote_config_key {
        return Err(ProgramError::InvalidArgument);
    }
    let remote_config =
        RemoteConfigAccount::fetch_data(&mut &remote_config_info.data.borrow()[..])?
            .ok_or(ProgramError::UninitializedAccount)?;

    let (ata_payer_key, ata_payer_bump) = derive_ata_payer_pda(program_id);
    if *ata_payer_info.key != ata_payer_key {
        return Err(ProgramError::InvalidArgument);
    }

    let (expected_sender_authority, _) = circle::derive_token_messenger_sender_authority_pda();
    if *sender_authority_info.key != expected_sender_authority {
        return Err(ProgramError::InvalidArgument);
    }
    // Circle's denylist is keyed by whatever `owner` we pass it below —
    // `ata_payer`, not the real sender — so this can only ever block the
    // whole route, never an individual end user.
    let (expected_denylist_account, _) = circle::derive_denylist_account_pda(&ata_payer_key);
    if *denylist_account_info.key != expected_denylist_account {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_message_transmitter, _) = circle::derive_message_transmitter_pda();
    if *message_transmitter_info.key != expected_message_transmitter {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_remote_token_messenger, _) =
        circle::derive_remote_token_messenger_pda(remote_config.circle_domain);
    if *remote_token_messenger_info.key != expected_remote_token_messenger {
        return Err(ProgramError::InvalidArgument);
    }
    let (expected_local_token, _) = circle::derive_local_token_pda(burn_token_mint_info.key);
    if *local_token_info.key != expected_local_token {
        return Err(ProgramError::InvalidArgument);
    }
    if *message_transmitter_program_info.key != circle::message_transmitter::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    if *token_messenger_minter_program_info.key != circle::token_messenger_minter::ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    let (expected_event_authority, _) =
        circle::derive_event_authority_pda(&circle::token_messenger_minter::ID);
    if *event_authority_info.key != expected_event_authority {
        return Err(ProgramError::InvalidArgument);
    }

    let amount: u64 = transfer
        .xfer
        .amount_or_id
        .try_into()
        .map_err(|_| ProgramError::InvalidInstructionData)?;

    // Ensure `ata_payer`'s own escrow ATA exists before transferring into it.
    invoke_signed(
        &create_associated_token_account_idempotent(
            ata_payer_info.key,
            ata_payer_info.key,
            burn_token_mint_info.key,
            token_program_info.key,
        ),
        &[
            ata_payer_info.clone(),
            ata_payer_ata_info.clone(),
            ata_payer_info.clone(),
            burn_token_mint_info.clone(),
            system_program_info.clone(),
            token_program_info.clone(),
        ],
        &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
    )?;
    account_utils::verify_rent_exempt(ata_payer_info, &Rent::get()?)?;

    // Move the sender's USDC into escrow — authorized by the sender
    // themselves, who is a normal signer of this transaction.
    invoke(
        &transfer_checked(
            token_program_info.key,
            owner_token_account_info.key,
            burn_token_mint_info.key,
            ata_payer_ata_info.key,
            owner_info.key,
            &[],
            amount,
            token_config.decimals,
        )?,
        &[
            owner_token_account_info.clone(),
            burn_token_mint_info.clone(),
            ata_payer_ata_info.clone(),
            owner_info.clone(),
        ],
    )?;

    let params = DepositForBurnParams {
        amount,
        destination_domain: remote_config.circle_domain,
        mint_recipient: Pubkey::new_from_array(transfer.xfer.recipient.into()),
        // Permissionless — Hyperlane relaying/delivery is permissionless by
        // design, so this hook never restricts who can deliver the attested
        // CCTP message downstream.
        destination_caller: Pubkey::new_from_array([0u8; 32]),
        max_fee: remote_config.max_fee,
        min_finality_threshold: remote_config.min_finality_threshold,
    };

    let ixn = deposit_for_burn_instruction(
        ata_payer_key,
        *event_rent_payer_info.key,
        *ata_payer_ata_info.key,
        *message_transmitter_info.key,
        *token_messenger_info.key,
        *token_minter_info.key,
        *burn_token_mint_info.key,
        *message_sent_event_data_info.key,
        *token_program_info.key,
        *system_program_info.key,
        params,
    )?;

    invoke_signed(
        &ixn,
        &[
            ata_payer_info.clone(),
            event_rent_payer_info.clone(),
            sender_authority_info.clone(),
            ata_payer_ata_info.clone(),
            denylist_account_info.clone(),
            message_transmitter_info.clone(),
            token_messenger_info.clone(),
            remote_token_messenger_info.clone(),
            token_minter_info.clone(),
            local_token_info.clone(),
            burn_token_mint_info.clone(),
            message_sent_event_data_info.clone(),
            message_transmitter_program_info.clone(),
            token_messenger_minter_program_info.clone(),
            token_program_info.clone(),
            system_program_info.clone(),
            event_authority_info.clone(),
        ],
        &[hyperlane_token_cctp_ata_payer_pda_seeds!(ata_payer_bump)],
    )?;

    let remaining: Vec<AccountInfo> = accounts_iter.cloned().collect();
    HyperlaneSealevelToken::<CctpPlugin>::transfer_remote_with_memo(
        program_id, &remaining, transfer,
    )
}

/// Delegates to the generic `Handle()` flow — `CctpPlugin::transfer_out` is
/// a no-op, since the mint already happened in this program's own
/// `Verify()`. See module docs in `lib.rs`.
fn transfer_from_remote(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_from_remote(program_id, accounts, transfer)
}

fn transfer_from_remote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: HandleInstruction,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_from_remote_account_metas(
        program_id, accounts, transfer,
    )
}

fn enroll_remote_router(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: hyperlane_sealevel_connection_client::router::RemoteRouterConfig,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::enroll_remote_router(program_id, accounts, config)
}

fn enroll_remote_routers(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<hyperlane_sealevel_connection_client::router::RemoteRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::enroll_remote_routers(program_id, accounts, configs)
}

fn set_destination_gas_configs(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    configs: Vec<hyperlane_sealevel_connection_client::gas_router::GasRouterConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_destination_gas_configs(program_id, accounts, configs)
}

fn transfer_ownership(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_owner: Option<Pubkey>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_ownership(program_id, accounts, new_owner)
}

/// Gets the interchain security module, returning it as a serialized
/// `Option<Pubkey>`. Hardcoded to this program's own address rather than
/// reading the generic (settable, defaults-to-`None`) config field — the
/// mint only ever happens inside this program's own `Verify()`, so nothing
/// else may ever be configured as the ISM. Matches EVM's
/// `TokenBridgeCctpV2.interchainSecurityModule() == address(this)`, which is
/// similarly hardcoded rather than storage-backed.
fn interchain_security_module(program_id: &Pubkey, _accounts: &[AccountInfo]) -> ProgramResult {
    let ism = Some(*program_id);
    set_return_data(&borsh::to_vec(&ism).map_err(|_| ProgramError::BorshIoError)?);
    Ok(())
}

/// No accounts needed — unlike the generic library's version, this doesn't
/// read the token config PDA at all (the answer is always `program_id`).
fn interchain_security_module_account_metas(_program_id: &Pubkey) -> ProgramResult {
    let bytes = borsh::to_vec(&SimulationReturnData::new(Vec::<
        serializable_account_meta::SerializableAccountMeta,
    >::new()))
    .map_err(|_| ProgramError::BorshIoError)?;
    set_return_data(&bytes);
    Ok(())
}

/// Rejected outright — the ISM is hardcoded to this program's own address
/// (see `interchain_security_module()` above) and can never be anything
/// else, so silently accepting a new value here would just store a config
/// field nothing ever reads. Fail closed rather than mask that.
fn set_interchain_security_module(
    _program_id: &Pubkey,
    _accounts: &[AccountInfo],
    _new_ism: Option<Pubkey>,
) -> ProgramResult {
    Err(ProgramError::InvalidInstructionData)
}

fn set_interchain_gas_paymaster(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    new_igp: Option<(
        Pubkey,
        hyperlane_sealevel_igp::accounts::InterchainGasPaymasterType,
    )>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_interchain_gas_paymaster(
        program_id, accounts, new_igp,
    )
}

fn set_fee_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    fee_config: Option<hyperlane_sealevel_token_lib::accounts::FeeConfig>,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::set_fee_config(program_id, accounts, fee_config)
}

/// Sets the CCTP send config for a Hyperlane destination domain.
///
/// Accounts:
/// 0. `[]` The system program.
/// 1. `[]` The `HyperlaneToken<CctpPlugin>` config PDA (for owner check).
/// 2. `[signer]` The token owner.
/// 3. `[signer, writable]` The payer (funds the remote-config PDA if new).
/// 4. `[writable]` The remote-config PDA for `config.destination_domain`.
fn set_remote_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    config: SetRemoteConfig,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();
    let system_program_info = next_account_info(accounts_iter)?;
    if *system_program_info.key != solana_system_interface::program::ID {
        return Err(ProgramError::IncorrectProgramId);
    }

    let token_config_info = next_account_info(accounts_iter)?;
    let token_config =
        HyperlaneTokenAccount::<CctpPlugin>::fetch_data(&mut &token_config_info.data.borrow()[..])?
            .ok_or(ProgramError::UninitializedAccount)?;

    let owner_info = next_account_info(accounts_iter)?;
    token_config.ensure_owner_signer(owner_info)?;

    let payer_info = next_account_info(accounts_iter)?;
    if !payer_info.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }

    let remote_config_info = next_account_info(accounts_iter)?;
    let (remote_config_key, bump_seed) =
        derive_remote_config_pda(program_id, config.destination_domain);
    if *remote_config_info.key != remote_config_key {
        return Err(ProgramError::InvalidArgument);
    }

    let remote_config = RemoteConfigAccount::from(RemoteConfig {
        bump_seed,
        circle_domain: config.circle_domain,
        max_fee: config.max_fee,
        min_finality_threshold: config.min_finality_threshold,
    });

    if remote_config_info.data_is_empty() {
        let space = account_utils::SizedData::size(&remote_config);
        let rent = Rent::get()?;
        let domain_bytes = config.destination_domain.to_le_bytes();
        create_pda_account(
            payer_info,
            &rent,
            space,
            program_id,
            system_program_info,
            remote_config_info,
            cctp_remote_config_pda_seeds!(&domain_bytes, bump_seed),
        )?;
    }
    remote_config.store(remote_config_info, true)?;

    Ok(())
}
