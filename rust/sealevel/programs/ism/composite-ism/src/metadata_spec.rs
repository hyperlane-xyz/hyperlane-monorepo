use borsh::BorshDeserialize;
use hyperlane_core::{Encode, HyperlaneMessage, ModuleType};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpecResult, VerifyMetadataSpecInstruction,
    VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use multisig_ism::{domain_data_pda, ValidatorsAndThreshold};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{get_return_data, invoke},
    pubkey::Pubkey,
};

pub use hyperlane_sealevel_interchain_security_module_interface::MetadataSpec;

use crate::{
    accounts::{
        derive_domain_pda, load_and_validate_domain_ism_storage, DomainIsmStorage, IsmNode,
    },
    error::Error,
    metadata::parse_routing_amount,
};

/// If `loaded` contains a per-domain ISM override, resolves its spec and
/// returns `Some(result)`. Returns `Ok(None)` if no override is configured.
fn spec_for_domain_override<'a, 'info>(
    loaded: &Option<Box<DomainIsmStorage>>,
    domain_pda_key: Pubkey,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&'a AccountInfo<'info>],
) -> Result<Option<MetadataSpecResult>, Error> {
    let Some(ref storage) = loaded else {
        return Ok(None);
    };
    let Some(ref ism) = storage.ism else {
        return Ok(None);
    };
    let result = spec_and_accounts_for_node(ism, message, program_id, extra_accounts)?;
    // Domain ISMs cannot be Routing/FallbackRouting (enforced at config time),
    // so spec is always Some here — no node in a domain ISM returns spec: None.
    debug_assert!(result.spec.is_some());
    Ok(Some(result))
}

/// Resolves the [`MetadataSpec`] for an ISM node.
///
/// `extra_accounts` is the slice of accounts passed after the composite ISM's
/// VAM PDA.
///
/// Config validation guarantees at most one `Routing` or `FallbackRouting` node
/// in the tree, so that node is always the sole consumer of `extra_accounts` and
/// always reads from fixed positions (starting at index 0).  No cursor is needed.
///
/// **Return semantics**
/// - `spec: Some(s), accounts: []` — fully resolved.
/// - `spec: None, accounts: [a, b, …]` — the complete desired `extra_accounts`
///   slice for the next simulation pass.
pub(crate) fn spec_and_accounts_for_node<'a, 'info>(
    node: &IsmNode,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&'a AccountInfo<'info>],
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
            let mut sub_specs = Vec::with_capacity(sub_isms.len());
            for sub in sub_isms {
                let result = spec_and_accounts_for_node(sub, message, program_id, extra_accounts)?;
                match result.spec {
                    Some(spec) => sub_specs.push(spec),
                    None => {
                        // At most one sub-ISM consumes accounts (Routing/FallbackRouting),
                        // so no earlier sibling accounts need to be prepended.
                        return Ok(MetadataSpecResult {
                            spec: None,
                            accounts: result.accounts,
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
            spec_and_accounts_for_node(sub_ism, message, program_id, extra_accounts)
        }

        IsmNode::Routing => {
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            let domain_present =
                !extra_accounts.is_empty() && *extra_accounts[0].key == domain_pda_key;
            if !domain_present {
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key],
                });
            }

            let domain_pda_info = extra_accounts[0];
            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(result) = spec_for_domain_override(
                &loaded,
                domain_pda_key,
                message,
                program_id,
                extra_accounts,
            )? {
                return Ok(result);
            }

            Err(Error::NoRouteForDomain)
        }

        IsmNode::FallbackRouting { fallback_ism } => {
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            // Pass 1: domain PDA not yet provided.
            let domain_present =
                !extra_accounts.is_empty() && *extra_accounts[0].key == domain_pda_key;
            if !domain_present {
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key],
                });
            }

            let domain_pda_info = extra_accounts[0];

            // Fast path: check for a per-domain ISM override.
            let loaded =
                load_and_validate_domain_ism_storage(program_id, message.origin, domain_pda_info)
                    .map_err(|_| Error::InvalidConfig)?;

            if let Some(result) = spec_for_domain_override(
                &loaded,
                domain_pda_key,
                message,
                program_id,
                extra_accounts,
            )? {
                return Ok(result);
            }

            // Fallback path: CPI to the fallback ISM's VerifyMetadataSpec.
            // The fallback ISM's VAM PDA must be at position 1 (after domain PDA).
            let (fallback_vam_pda, _) =
                Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, fallback_ism);

            // Pass 2: fallback VAM PDA not yet provided.
            let fallback_present =
                extra_accounts.len() > 1 && *extra_accounts[1].key == fallback_vam_pda;
            if !fallback_present {
                return Ok(MetadataSpecResult {
                    spec: None,
                    accounts: vec![domain_pda_key, fallback_vam_pda, *fallback_ism],
                });
            }

            // Pass 3+: determine type before invoking VerifyMetadataSpec so we
            // remain compatible with old deployed multisig ISMs that only support
            // Type / ValidatorsAndThresholdAccountMetas / ValidatorsAndThreshold.
            //
            // Pass the fallback ISM's VAM/storage PDA as accounts[0] so that
            // composite ISMs (which call next_account_info in their Type handler)
            // don't fail with NotEnoughAccountKeys.  Legacy multisig ISMs ignore
            // extra accounts, so this is backwards-compatible.
            let fallback_storage_info = (*extra_accounts[1]).clone();
            let fallback_storage_meta =
                AccountMeta::new_readonly(*fallback_storage_info.key, false);
            invoke(
                &SolanaInstruction {
                    program_id: *fallback_ism,
                    accounts: vec![fallback_storage_meta],
                    data: InterchainSecurityModuleInstruction::Type
                        .encode()
                        .map_err(|_| Error::InvalidConfig)?,
                },
                &[fallback_storage_info],
            )
            .map_err(|_| Error::FallbackIsmCallFailed)?;
            let Some((_, type_bytes)) = get_return_data() else {
                return Err(Error::FallbackIsmCallFailed);
            };
            let fallback_type = borsh::from_slice::<SimulationReturnData<u32>>(&type_bytes)
                .map(|s| s.return_data)
                .map_err(|_| Error::FallbackIsmCallFailed)?;

            if fallback_type == ModuleType::MessageIdMultisig as u32 {
                // Backwards-compatible path: old deployed multisig ISMs lack
                // VerifyMetadataSpec. Use the well-known domain data PDA seeds from
                // multisig-ism-message-id and read validators/threshold directly.
                let (multisig_domain_pda, _) = domain_data_pda(fallback_ism, message.origin);

                // multisig_domain_pda is at position 2 (after domain_pda, fallback_vam_pda).
                let domain_pda_present =
                    extra_accounts.len() > 2 && *extra_accounts[2].key == multisig_domain_pda;

                if !domain_pda_present {
                    return Ok(MetadataSpecResult {
                        spec: None,
                        accounts: vec![
                            domain_pda_key,
                            fallback_vam_pda,
                            multisig_domain_pda,
                            *fallback_ism,
                        ],
                    });
                }

                // Read validators/threshold directly from the domain PDA account.
                // AccountData<DomainData> layout: [bool (initialized)] + [u8 (bump_seed)]
                // + borsh(ValidatorsAndThreshold). No discriminator prefix.
                let multisig_domain_pda_info = extra_accounts[2];
                if *multisig_domain_pda_info.owner != *fallback_ism {
                    return Err(Error::FallbackIsmCallFailed);
                }
                let data = multisig_domain_pda_info.data.borrow();
                let buf = &mut &data[..];
                let initialized =
                    bool::deserialize(buf).map_err(|_| Error::FallbackIsmCallFailed)?;
                if !initialized {
                    return Err(Error::FallbackIsmCallFailed);
                }
                u8::deserialize(buf).map_err(|_| Error::FallbackIsmCallFailed)?; // bump_seed
                let vat = ValidatorsAndThreshold::deserialize(buf)
                    .map_err(|_| Error::FallbackIsmCallFailed)?;
                Ok(MetadataSpecResult {
                    spec: Some(MetadataSpec::MultisigMessageId {
                        validators: vat.validators,
                        threshold: vat.threshold,
                    }),
                    accounts: vec![],
                })
            } else if fallback_type == ModuleType::Unused as u32 {
                // Old test ISM (ModuleType::Unused) lacks VerifyMetadataSpec but
                // never requires metadata, so Null is always correct.
                Ok(MetadataSpecResult {
                    spec: Some(MetadataSpec::Null),
                    accounts: vec![],
                })
            } else {
                // New ISM that implements VerifyMetadataSpec.
                // extra_accounts[1..] starts with the fallback ISM's VAM PDA.
                let cpi_accounts: Vec<AccountInfo> =
                    extra_accounts[1..].iter().map(|a| (*a).clone()).collect();
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
                    return Err(Error::FallbackIsmCallFailed);
                };
                let cpi_result =
                    borsh::from_slice::<SimulationReturnData<MetadataSpecResult>>(&cpi_bytes)
                        .map(|s| s.return_data)
                        .map_err(|_| Error::FallbackIsmCallFailed)?;

                match cpi_result.spec {
                    Some(spec) => Ok(MetadataSpecResult {
                        spec: Some(spec),
                        accounts: vec![],
                    }),
                    None => {
                        // cpi_result.accounts = full desired accounts for the fallback ISM
                        // (including its VAM PDA as accounts[0]).
                        // Construct our relative result: [domain_pda_key] + cpi accounts + [fallback_ism].
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
