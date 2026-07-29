//! Fee program state processor.
//!
//! `process_instruction` dispatches into per-instruction modules. Helper
//! functions live in their owner module unless used cross-file, in which case
//! they live in `common`.

mod admin;
mod common;
mod init;
mod quote;
mod routes;
mod signers;
mod simulation;
mod submit;

use solana_program::{account_info::AccountInfo, entrypoint::ProgramResult, pubkey::Pubkey};

use crate::instruction::Instruction;

#[cfg(not(feature = "no-entrypoint"))]
solana_program::entrypoint!(process_instruction);

/// Entrypoint for the fee program.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    // Universal version query — discriminator-based, independent of instruction enum.
    if package_versioned::is_get_program_version(instruction_data) {
        return package_versioned::process_get_program_version::<FeeProgram>();
    }

    match Instruction::from_instruction_data(instruction_data)? {
        Instruction::InitFee(data) => init::process_init_fee(program_id, accounts, data),
        Instruction::QuoteFee(data) => quote::process_quote_fee(program_id, accounts, data),
        Instruction::SetRemoteFeeRoute(data) => {
            routes::process_set_remote_fee_route(program_id, accounts, data)
        }
        Instruction::RemoveRemoteFeeRoute(data) => {
            routes::process_remove_remote_fee_route(program_id, accounts, data)
        }
        Instruction::UpdateFeeParams(params) => {
            admin::process_update_fee_params(program_id, accounts, params)
        }
        Instruction::SetBeneficiary(beneficiary) => {
            admin::process_set_beneficiary(program_id, accounts, beneficiary)
        }
        Instruction::TransferOwnership(new_owner) => {
            admin::process_transfer_ownership(program_id, accounts, new_owner)
        }
        Instruction::SetQuoteSigner { operation, route } => {
            signers::process_set_quote_signer(program_id, accounts, operation, route)
        }
        Instruction::SetMinIssuedAt { min_issued_at } => {
            admin::process_set_min_issued_at(program_id, accounts, min_issued_at)
        }
        Instruction::SetWildcardQuoteSigners { signers } => {
            admin::process_set_wildcard_quote_signers(program_id, accounts, signers)
        }
        Instruction::SubmitQuote(quote) => {
            submit::process_submit_quote(program_id, accounts, quote)
        }
        Instruction::CloseTransientQuote => {
            submit::process_close_transient_quote(program_id, accounts)
        }
        Instruction::PruneExpiredQuotes {
            domain,
            target_router,
        } => submit::process_prune_expired_quotes(program_id, accounts, domain, target_router),
        Instruction::GetQuoteAccountMetas(data) => {
            simulation::process_get_quote_account_metas(program_id, accounts, data)
        }
        Instruction::GetSubmitQuoteAccountMetas(data) => {
            simulation::process_get_submit_quote_account_metas(program_id, accounts, data)
        }
    }
}

/// Marker type for PackageVersioned trait implementation.
pub struct FeeProgram;

impl package_versioned::PackageVersioned for FeeProgram {}
