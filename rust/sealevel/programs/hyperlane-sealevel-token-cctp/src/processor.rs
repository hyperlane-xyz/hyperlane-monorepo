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
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    sysvar::Sysvar,
};

use crate::{
    accounts::{derive_remote_config_pda, CctpPlugin, RemoteConfig, RemoteConfigAccount},
    cctp_remote_config_pda_seeds,
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

/// Delegates straight to the generic dispatch machinery, which calls
/// `CctpPlugin::transfer_in` at the appropriate point to perform the actual
/// escrow + Circle burn. See `plugin.rs` module docs for why the burn lives
/// there now instead of in a custom pre-processing step here.
fn transfer_remote_with_memo(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    transfer: TransferRemoteWithMemo,
) -> ProgramResult {
    HyperlaneSealevelToken::<CctpPlugin>::transfer_remote_with_memo(program_id, accounts, transfer)
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
