use hyperlane_core::{Encode, HyperlaneMessage};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpecResult, VerifyMetadataSpecInstruction,
    VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{get_return_data, invoke},
    pubkey::Pubkey,
};

pub use hyperlane_sealevel_interchain_security_module_interface::MetadataSpec;

use crate::{
    accounts::{derive_domain_pda, load_and_validate_domain_ism_storage, IsmNode},
    error::Error,
    metadata::parse_routing_amount,
};

/// Resolves the [`MetadataSpec`] for an ISM node via a cursor-based fixpoint.
///
/// `extra_accounts` is the slice of accounts passed after the composite ISM's
/// VAM PDA.  `cursor` tracks how many have been consumed by nodes processed
/// before this call (shared across siblings in an Aggregation).
///
/// **Return semantics**
/// - `spec: Some(s), accounts: []` — fully resolved.
/// - `spec: None, accounts: [a, b, …]` — accounts are needed starting at the
///   node's own starting-cursor position (relative, NOT global).  The node
///   restores `cursor` to its value on entry before returning `spec: None`, so
///   the parent can safely prepend the already-consumed accounts.
///
/// Aggregation prepends accounts consumed by earlier sub-ISMs so that the
/// top-level result is always the complete desired `extra_accounts` slice for
/// the next simulation (still relative to extra_accounts[0], not including
/// the composite VAM PDA which the caller prepends).
pub(crate) fn spec_and_accounts_for_node<'a, 'info>(
    node: &IsmNode,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&'a AccountInfo<'info>],
    cursor: &mut usize,
) -> Result<MetadataSpecResult, Error> {
    match node {
        IsmNode::MultisigMessageId {
            validators,
            threshold,
        } => Ok(MetadataSpecResult {
            spec: Some(MetadataSpec::MultisigMessageId {
                validators: validators.clone(),
                threshold: *threshold,
            }),
            accounts: vec![],
        }),

        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            let agg_start = *cursor;
            let mut sub_specs = Vec::with_capacity(sub_isms.len());
            for sub in sub_isms {
                let sub_start = *cursor;
                let result =
                    spec_and_accounts_for_node(sub, message, program_id, extra_accounts, cursor)?;
                match result.spec {
                    Some(spec) => sub_specs.push(spec),
                    None => {
                        // sub restored cursor to sub_start on failure.
                        // Prepend accounts consumed by earlier sub-ISMs (positions
                        // agg_start..sub_start) so the returned list is complete.
                        let mut accounts: Vec<Pubkey> = extra_accounts[agg_start..sub_start]
                            .iter()
                            .map(|a| *a.key)
                            .collect();
                        accounts.extend(result.accounts);
                        return Ok(MetadataSpecResult {
                            spec: None,
                            accounts,
                        });
                    }
                }
            }
            Ok(MetadataSpecResult {
                spec: Some(MetadataSpec::Aggregation {
                    threshold: *threshold,
                    sub_specs,
                }),
                accounts: vec![],
            })
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            let amount = parse_routing_amount(&message.body).ok_or(Error::InvalidMessageBody)?;
            let sub_ism = if amount >= *threshold { upper } else { lower };
            spec_and_accounts_for_node(sub_ism, message, program_id, extra_accounts, cursor)
        }

        IsmNode::Routing => {
            let cursor_before = *cursor;
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            let domain_present =
                *cursor < extra_accounts.len() && *extra_accounts[*cursor].key == domain_pda_key;
            if !domain_present {
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key],
                });
            }

            let domain_pda_info = extra_accounts[*cursor];
            *cursor += 1;

            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(ref storage) = loaded {
                if let Some(ref ism) = storage.ism {
                    let result = spec_and_accounts_for_node(
                        ism,
                        message,
                        program_id,
                        extra_accounts,
                        cursor,
                    )?;
                    if result.spec.is_some() {
                        return Ok(result);
                    }
                    *cursor = cursor_before;
                    let mut accounts = vec![domain_pda_key];
                    accounts.extend(result.accounts);
                    return Ok(MetadataSpecResult {
                        spec: None,
                        accounts,
                    });
                }
            }

            Err(Error::NoRouteForDomain)
        }

        IsmNode::FallbackRouting { fallback_ism } => {
            let cursor_before = *cursor;
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            // Pass 1: domain PDA not yet provided.
            let domain_present =
                *cursor < extra_accounts.len() && *extra_accounts[*cursor].key == domain_pda_key;
            if !domain_present {
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key],
                });
            }

            let domain_pda_info = extra_accounts[*cursor];
            *cursor += 1;

            // Fast path: check for a per-domain ISM override.
            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(ref storage) = loaded {
                if let Some(ref ism) = storage.ism {
                    let result = spec_and_accounts_for_node(
                        ism,
                        message,
                        program_id,
                        extra_accounts,
                        cursor,
                    )?;
                    if result.spec.is_some() {
                        return Ok(result);
                    }
                    *cursor = cursor_before;
                    let mut accounts = vec![domain_pda_key];
                    accounts.extend(result.accounts);
                    return Ok(MetadataSpecResult {
                        spec: None,
                        accounts,
                    });
                }
            }

            // Fallback path: CPI to the fallback ISM's VerifyMetadataSpec.
            // The fallback ISM's VAM PDA (derived from VERIFY_ACCOUNT_METAS_PDA_SEEDS) must
            // be the next account so the CPI can pass accounts[0] correctly.
            let (fallback_vam_pda, _) =
                Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, fallback_ism);

            // Pass 2: fallback VAM PDA not yet provided.
            let fallback_present =
                *cursor < extra_accounts.len() && *extra_accounts[*cursor].key == fallback_vam_pda;
            if !fallback_present {
                *cursor = cursor_before;
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key, fallback_vam_pda, *fallback_ism],
                });
            }

            // Pass 3+: perform the CPI.
            // extra_accounts[cursor..] starts with the fallback ISM's VAM PDA.
            let cpi_accounts: Vec<AccountInfo> = extra_accounts[*cursor..]
                .iter()
                .map(|a| (*a).clone())
                .collect();
            let cpi_metas: Vec<AccountMeta> = cpi_accounts
                .iter()
                .map(crate::account_info_to_meta)
                .collect();
            let ixn_data = InterchainSecurityModuleInstruction::VerifyMetadataSpec(
                VerifyMetadataSpecInstruction::new(message.to_vec()),
            )
            .encode()
            .map_err(|_| Error::InvalidConfig)?;
            let ixn = SolanaInstruction {
                program_id: *fallback_ism,
                accounts: cpi_metas,
                data: ixn_data,
            };
            invoke(&ixn, &cpi_accounts).map_err(|_| Error::FallbackIsmCallFailed)?;

            let Some((_, cpi_bytes)) = get_return_data() else {
                *cursor = cursor_before;
                return Err(Error::FallbackIsmCallFailed);
            };
            let cpi_result =
                borsh::from_slice::<SimulationReturnData<MetadataSpecResult>>(&cpi_bytes)
                    .map(|s| s.return_data)
                    .map_err(|_| Error::FallbackIsmCallFailed)?;

            match cpi_result.spec {
                Some(spec) => {
                    *cursor = extra_accounts.len();
                    Ok(MetadataSpecResult {
                        spec: Some(spec),
                        accounts: vec![],
                    })
                }
                None => {
                    // cpi_result.accounts = full desired accounts for the fallback ISM
                    // (including its VAM PDA as accounts[0]).
                    // Construct our relative result: [domain_pda_key] + cpi accounts + [fallback_ism].
                    *cursor = cursor_before;
                    let mut accounts = vec![domain_pda_key];
                    accounts.extend(cpi_result.accounts);
                    accounts.push(*fallback_ism);
                    Ok(MetadataSpecResult {
                        spec: None,
                        accounts,
                    })
                }
            }
        }

        IsmNode::TrustedRelayer { .. }
        | IsmNode::Test { .. }
        | IsmNode::Pausable { .. }
        | IsmNode::RateLimited { .. } => Ok(MetadataSpecResult {
            spec: Some(MetadataSpec::Null),
            accounts: vec![],
        }),
    }
}
