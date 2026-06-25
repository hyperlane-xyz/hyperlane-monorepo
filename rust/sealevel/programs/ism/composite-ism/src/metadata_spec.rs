use hyperlane_core::{Encode, HyperlaneMessage, ModuleType};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, MetadataSpecResult, VerifyMetadataSpecInstruction,
    VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use multisig_ism::{domain_data_pda, interface::MultisigIsmInstruction, ValidatorsAndThreshold};
use serializable_account_meta::SimulationReturnData;
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{get_return_data, invoke},
    pubkey::Pubkey,
    sysvar::Sysvar,
};

pub use hyperlane_sealevel_interchain_security_module_interface::MetadataSpec;

use crate::{
    accounts::{
        derive_domain_pda, load_and_validate_domain_ism_storage, DomainIsmStorage, IsmNode,
    },
    error::Error,
    metadata::parse_routing_amount,
    rate_limit::calculate_current_level,
};

/// If `loaded` contains a per-domain ISM override, resolves its spec and
/// returns `Some(result)`. Returns `Ok(None)` if no override is configured.
fn spec_for_domain_override(
    loaded: &Option<Box<DomainIsmStorage>>,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&AccountInfo<'_>],
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
pub(crate) fn spec_and_accounts_for_node(
    node: &IsmNode,
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&AccountInfo<'_>],
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
                match spec_and_accounts_for_node(sub, message, program_id, extra_accounts) {
                    Ok(result) => match result.spec {
                        Some(spec) => sub_specs.push(spec),
                        None => {
                            // At most one sub-ISM consumes accounts (Routing/FallbackRouting),
                            // so no earlier sibling accounts need to be prepended.
                            return Ok(MetadataSpecResult {
                                spec: None,
                                accounts: result.accounts,
                            });
                        }
                    },
                    Err(Error::NoRouteForDomain) => sub_specs.push(MetadataSpec::CannotVerify),
                    Err(e) => return Err(e),
                }
            }
            let viable = sub_specs
                .iter()
                .filter(|s| !matches!(s, MetadataSpec::CannotVerify))
                .count();
            if viable < *threshold as usize {
                return Err(Error::ThresholdNotMet);
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

            if let Some(result) =
                spec_for_domain_override(&loaded, message, program_id, extra_accounts)?
            {
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

            if let Some(result) =
                spec_for_domain_override(&loaded, message, program_id, extra_accounts)?
            {
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

                // CPI to MultisigIsmInstruction::ValidatorsAndThreshold — the stable
                // public interface. Decouples composite from the internal PDA layout
                // of multisig-ism-message-id (no discriminator assumptions, no field
                // ordering assumptions).
                let multisig_domain_pda_info = (*extra_accounts[2]).clone();
                invoke(
                    &SolanaInstruction {
                        program_id: *fallback_ism,
                        accounts: vec![AccountMeta::new_readonly(multisig_domain_pda, false)],
                        data: MultisigIsmInstruction::ValidatorsAndThreshold(message.to_vec())
                            .encode()
                            .map_err(|_| Error::FallbackIsmCallFailed)?,
                    },
                    &[multisig_domain_pda_info],
                )
                .map_err(|_| Error::FallbackIsmCallFailed)?;
                let Some((_, vat_bytes)) = get_return_data() else {
                    return Err(Error::FallbackIsmCallFailed);
                };
                let vat =
                    borsh::from_slice::<SimulationReturnData<ValidatorsAndThreshold>>(&vat_bytes)
                        .map(|s| s.return_data)
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

        IsmNode::TrustedRelayer { relayer } => Ok(MetadataSpecResult {
            spec: Some(MetadataSpec::TrustedRelayer { relayer: *relayer }),
            accounts: vec![],
        }),

        IsmNode::Test { accept } => Ok(MetadataSpecResult {
            spec: Some(if *accept {
                MetadataSpec::Null
            } else {
                MetadataSpec::CannotVerify
            }),
            accounts: vec![],
        }),

        IsmNode::Pausable { paused } => Ok(MetadataSpecResult {
            spec: Some(if !*paused {
                MetadataSpec::Null
            } else {
                MetadataSpec::CannotVerify
            }),
            accounts: vec![],
        }),

        IsmNode::RateLimited {
            max_capacity,
            recipient,
            filled_level,
            last_updated,
            mailbox: _,
        } => {
            let spec = rate_limited_spec(
                message,
                *max_capacity,
                *recipient,
                *filled_level,
                *last_updated,
            );
            Ok(MetadataSpecResult {
                spec: Some(spec),
                accounts: vec![],
            })
        }
    }
}

/// Returns `Null` if the current transfer would pass the rate-limit check,
/// or `CannotVerify` if it would be rejected.
///
/// Mirrors the logic in `verify.rs` for `IsmNode::RateLimited`, without the
/// state mutation.  Uses `Clock::get()` for the current timestamp; returns
/// `CannotVerify` on clock failure so the relayer skips the slot conservatively.
fn rate_limited_spec(
    message: &HyperlaneMessage,
    max_capacity: u64,
    recipient: Option<hyperlane_core::H256>,
    filled_level: u64,
    last_updated: i64,
) -> MetadataSpec {
    if let Some(r) = recipient {
        if message.recipient != r {
            return MetadataSpec::CannotVerify;
        }
    }

    if message.body.len() < 64 {
        return MetadataSpec::CannotVerify;
    }
    // High 24 bytes of the 32-byte BE U256 must be zero; otherwise the amount
    // overflows u64 and certainly exceeds any realistic capacity.
    if message.body[32..56].iter().any(|&b| b != 0) {
        return MetadataSpec::CannotVerify;
    }
    let amount = u64::from_be_bytes(match message.body[56..64].try_into() {
        Ok(b) => b,
        Err(_) => return MetadataSpec::CannotVerify,
    });

    let now = match Clock::get() {
        Ok(clock) => clock.unix_timestamp,
        Err(_) => return MetadataSpec::CannotVerify,
    };

    let adjusted = calculate_current_level(filled_level, last_updated, now, max_capacity);

    if amount > adjusted {
        MetadataSpec::CannotVerify
    } else {
        MetadataSpec::Null
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::H256;
    use solana_program::pubkey::Pubkey;

    fn test_message(origin: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin,
            sender: H256::zero(),
            destination: 1,
            recipient: H256::zero(),
            body: vec![],
        }
    }

    // Resolves a node with no extra accounts (sufficient for nodes that don't
    // need accounts).
    fn resolve(node: &IsmNode, message: &HyperlaneMessage) -> Result<MetadataSpecResult, Error> {
        spec_and_accounts_for_node(node, message, &Pubkey::new_unique(), &[])
    }

    // --- Aggregation threshold-aware spec tests ---

    #[test]
    fn test_aggregation_all_viable_returns_full_spec() {
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        };
        let result = resolve(&node, &test_message(1)).unwrap();
        let Some(MetadataSpec::Aggregation {
            threshold,
            sub_specs,
        }) = result.spec
        else {
            panic!("expected Aggregation spec");
        };
        assert_eq!(threshold, 2);
        assert_eq!(sub_specs.len(), 2);
        assert!(sub_specs.iter().all(|s| matches!(s, MetadataSpec::Null)));
    }

    #[test]
    fn test_aggregation_cannot_verify_child_skipped_when_threshold_met() {
        // 1-of-2: one Test(accept=true), one Test(accept=false). Threshold met by
        // the first child; the second produces CannotVerify but that is fine.
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: false },
            ],
        };
        let result = resolve(&node, &test_message(1)).unwrap();
        let Some(MetadataSpec::Aggregation {
            threshold,
            sub_specs,
        }) = result.spec
        else {
            panic!("expected Aggregation spec");
        };
        assert_eq!(threshold, 1);
        assert_eq!(sub_specs.len(), 2);
        assert!(matches!(sub_specs[0], MetadataSpec::Null));
        assert!(matches!(sub_specs[1], MetadataSpec::CannotVerify));
    }

    #[test]
    fn test_aggregation_threshold_not_met_returns_error() {
        // 2-of-2 but both children are Test(accept=false) — threshold cannot be met.
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Test { accept: false },
                IsmNode::Test { accept: false },
            ],
        };
        assert_eq!(
            resolve(&node, &test_message(1)).unwrap_err(),
            Error::ThresholdNotMet
        );
    }

    #[test]
    fn test_aggregation_no_route_child_skipped_when_threshold_met() {
        // 1-of-2: Test(accept=true) + Routing(no domain configured).
        // Without the fix, Routing triggers an account-discovery pass that
        // eventually returns NoRouteForDomain, which would propagate as an error.
        // With the fix, NoRouteForDomain is caught and treated as CannotVerify.
        //
        // We use a Routing node whose domain PDA key will not be in extra_accounts,
        // so the first call returns spec:None (account request). We test the
        // CannotVerify path by using Test(accept=false) as a proxy for a child
        // that definitively cannot verify, to keep the test self-contained without
        // real PDA accounts.
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: false },
            ],
        };
        let result = resolve(&node, &test_message(1)).unwrap();
        let Some(MetadataSpec::Aggregation { sub_specs, .. }) = result.spec else {
            panic!("expected Aggregation spec");
        };
        // Threshold (1) is satisfied by the first child; second is CannotVerify.
        assert_eq!(sub_specs.len(), 2);
        assert!(matches!(sub_specs[0], MetadataSpec::Null));
        assert!(matches!(sub_specs[1], MetadataSpec::CannotVerify));
    }
}
