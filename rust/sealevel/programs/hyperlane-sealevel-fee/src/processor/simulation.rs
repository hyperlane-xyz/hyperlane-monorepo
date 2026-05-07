//! Simulation-only handlers that emit account-meta layouts for QuoteFee and SubmitQuote.

use account_utils::ensure_no_extraneous_accounts;
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::set_return_data,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use solana_system_interface::program as system_program;

use crate::{
    accounts::{FeeAccountData, FeeData, DEFAULT_ROUTER, WILDCARD_DOMAIN},
    cc_route_pda_seeds, fee_standing_quote_pda_seeds,
    instruction::{GetQuoteAccountMetas, GetSubmitQuoteAccountMetas},
    route_domain_pda_seeds, transient_quote_pda_seeds,
};

/// Simulation-only: returns the required account metas for a QuoteFee call.
/// Derives PDA addresses based on the fee account's FeeData type.
///
/// Accounts:
/// 0. `[]` Fee account.
pub(super) fn process_get_quote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: GetQuoteAccountMetas,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    ensure_no_extraneous_accounts(accounts_iter)?;

    let mut metas: Vec<SerializableAccountMeta> = Vec::new();

    // Fixed prefix accounts.
    metas.push(SerializableAccountMeta {
        pubkey: *fee_account_info.key,
        is_signer: false,
        is_writable: false,
    });
    // Payer placeholder — actual payer key is not known at simulation time.
    // SDK must replace this with the real payer pubkey.
    metas.push(SerializableAccountMeta {
        pubkey: Pubkey::default(),
        is_signer: true,
        is_writable: true,
    });

    // Transient PDA (if scoped_salt provided).
    if let Some(scoped_salt) = data.scoped_salt {
        let (transient_key, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: transient_key,
            is_signer: false,
            is_writable: true,
        });
    }

    // Standing quote PDAs (domain + wildcard).
    // For CC: include target_router in PDA seeds. For Leaf/Routing: H256::zero() sentinel via macro default.
    let domain_le = data.destination_domain.to_le_bytes();
    let standing_target_router = match &fee_account.fee_data {
        FeeData::CrossCollateralRouting(_) => data.target_router,
        _ => hyperlane_core::H256::zero(),
    };
    let (domain_quotes_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
        program_id,
    );
    metas.push(SerializableAccountMeta {
        pubkey: domain_quotes_key,
        is_signer: false,
        is_writable: false,
    });

    let wildcard_le = WILDCARD_DOMAIN.to_le_bytes();
    let (wildcard_quotes_key, _) = Pubkey::find_program_address(
        fee_standing_quote_pda_seeds!(fee_account_info.key, &wildcard_le, standing_target_router),
        program_id,
    );
    metas.push(SerializableAccountMeta {
        pubkey: wildcard_quotes_key,
        is_signer: false,
        is_writable: false,
    });

    // Route-specific PDAs.
    match &fee_account.fee_data {
        FeeData::Leaf(_) => {}
        FeeData::Routing(_) => {
            let (route_key, _) = Pubkey::find_program_address(
                route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: route_key,
                is_signer: false,
                is_writable: false,
            });
        }
        FeeData::CrossCollateralRouting(_) => {
            let dest_le = data.destination_domain.to_le_bytes();
            let (cc_specific_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &dest_le, data.target_router),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: cc_specific_key,
                is_signer: false,
                is_writable: false,
            });

            let (cc_default_key, _) = Pubkey::find_program_address(
                cc_route_pda_seeds!(fee_account_info.key, &dest_le, DEFAULT_ROUTER),
                program_id,
            );
            metas.push(SerializableAccountMeta {
                pubkey: cc_default_key,
                is_signer: false,
                is_writable: false,
            });
        }
    }

    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(metas))
            .map_err(|_| ProgramError::BorshIoError)?,
    );

    Ok(())
}

/// Simulation-only: returns required account metas for a SubmitQuote call.
/// Accounts vary by fee_data type (Leaf vs Routing vs CC) and quote kind (transient vs standing).
///
/// Accounts:
/// 0. `[]` Fee account.
pub(super) fn process_get_submit_quote_account_metas(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: GetSubmitQuoteAccountMetas,
) -> ProgramResult {
    let accounts_iter = &mut accounts.iter();

    // Account 0: Fee account.
    let fee_account_info = next_account_info(accounts_iter)?;
    if fee_account_info.owner != program_id {
        return Err(ProgramError::IncorrectProgramId);
    }
    let fee_account = FeeAccountData::fetch(&mut &fee_account_info.data.borrow()[..])?.into_inner();

    ensure_no_extraneous_accounts(accounts_iter)?;

    let mut metas: Vec<SerializableAccountMeta> = Vec::new();

    // Account 0: System program.
    metas.push(SerializableAccountMeta {
        pubkey: system_program::ID,
        is_signer: false,
        is_writable: false,
    });
    // Account 1: Payer placeholder.
    metas.push(SerializableAccountMeta {
        pubkey: Pubkey::default(),
        is_signer: true,
        is_writable: true,
    });
    // Account 2: Fee account (always read-only for SubmitQuote).
    metas.push(SerializableAccountMeta {
        pubkey: *fee_account_info.key,
        is_signer: false,
        is_writable: false,
    });

    // Route PDAs for signer lookup (Routing/CC exact domain only).
    // Wildcard domain quotes use fee_data.wildcard_signers — no route PDAs needed.
    let domain_le = data.destination_domain.to_le_bytes();
    let is_wildcard = data.destination_domain == WILDCARD_DOMAIN;
    match &fee_account.fee_data {
        FeeData::Leaf(_) => {}
        FeeData::Routing(_) => {
            if !is_wildcard {
                let (route_key, _) = Pubkey::find_program_address(
                    route_domain_pda_seeds!(fee_account_info.key, &domain_le),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: route_key,
                    is_signer: false,
                    is_writable: false,
                });
            }
        }
        FeeData::CrossCollateralRouting(_) => {
            if !is_wildcard {
                let (cc_specific_key, _) = Pubkey::find_program_address(
                    cc_route_pda_seeds!(fee_account_info.key, &domain_le, data.target_router),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: cc_specific_key,
                    is_signer: false,
                    is_writable: false,
                });
                let (cc_default_key, _) = Pubkey::find_program_address(
                    cc_route_pda_seeds!(fee_account_info.key, &domain_le, DEFAULT_ROUTER),
                    program_id,
                );
                metas.push(SerializableAccountMeta {
                    pubkey: cc_default_key,
                    is_signer: false,
                    is_writable: false,
                });
            }
        }
    }

    // Quote PDA (transient or standing).
    if let Some(scoped_salt) = data.scoped_salt {
        // Transient quote PDA.
        let (transient_key, _) = Pubkey::find_program_address(
            transient_quote_pda_seeds!(fee_account_info.key, scoped_salt),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: transient_key,
            is_signer: false,
            is_writable: true,
        });
    } else {
        // Standing quote PDA.
        let standing_target_router = match &fee_account.fee_data {
            FeeData::CrossCollateralRouting(_) => data.target_router,
            _ => hyperlane_core::H256::zero(),
        };
        let (standing_key, _) = Pubkey::find_program_address(
            fee_standing_quote_pda_seeds!(fee_account_info.key, &domain_le, standing_target_router),
            program_id,
        );
        metas.push(SerializableAccountMeta {
            pubkey: standing_key,
            is_signer: false,
            is_writable: true,
        });
    }

    set_return_data(
        &borsh::to_vec(&SimulationReturnData::new(metas))
            .map_err(|_| ProgramError::BorshIoError)?,
    );

    Ok(())
}
