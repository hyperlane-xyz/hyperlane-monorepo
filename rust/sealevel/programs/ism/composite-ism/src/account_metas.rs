use hyperlane_core::{Encode, HyperlaneMessage};
use hyperlane_sealevel_interchain_security_module_interface::{
    InterchainSecurityModuleInstruction, VerifyInstruction, VERIFY_ACCOUNT_METAS_PDA_SEEDS,
};
use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
use solana_program::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction as SolanaInstruction},
    program::{get_return_data, invoke},
    program_error::ProgramError,
    pubkey::Pubkey,
};

use crate::{
    accounts::{derive_domain_pda, DomainIsmAccount, IsmNode},
    metadata::{parse_routing_amount, sub_metadata_at},
};

/// Returns `true` if the ISM tree contains any `RateLimited` node.
///
/// Used to decide whether the storage PDA must be marked writable in
/// `VerifyAccountMetas` and whether the processor must write it back after
/// `verify_node`.
pub(crate) fn contains_rate_limited(node: &IsmNode) -> bool {
    match node {
        IsmNode::RateLimited { .. } => true,
        IsmNode::Aggregation { sub_isms, .. } => sub_isms.iter().any(contains_rate_limited),
        IsmNode::AmountRouting { lower, upper, .. } => {
            contains_rate_limited(lower) || contains_rate_limited(upper)
        }
        // Routing/FallbackRouting: domain PDAs handle their own writable marking.
        // The fallback ISM's state is managed by the fallback program itself.
        IsmNode::Routing | IsmNode::FallbackRouting { .. } => false,
        _ => false,
    }
}

/// Returns the additional account metas required by `Verify` for this ISM node,
/// beyond account 0 (the VAM PDA) which is always included by the caller.
///
/// `program_id` is needed to derive domain PDA keys for `Routing` nodes.
///
/// `extra_accounts` is a slice of additional accounts passed to `VerifyAccountMetas`
/// beyond the VAM PDA (used in pass 2 for `Routing`/`FallbackRouting` to resolve
/// sub-accounts). Config validation ensures at most one `Routing` or `FallbackRouting`
/// exists in the tree, so that node always reads from fixed positions starting at
/// index 0 — no cursor is needed.
pub fn required_accounts_for_node(
    node: &IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&AccountInfo],
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    match node {
        IsmNode::TrustedRelayer { relayer } => Ok(vec![AccountMeta {
            pubkey: *relayer,
            is_signer: true,
            is_writable: false,
        }
        .into()]),

        // All state is in the VAM PDA; no extra accounts needed.
        IsmNode::MultisigMessageId { .. } => Ok(vec![]),

        IsmNode::Aggregation { sub_isms, .. } => {
            let mut accounts: Vec<SerializableAccountMeta> = Vec::new();
            for (i, sub_ism) in sub_isms.iter().enumerate() {
                let Some(sub_meta) = sub_metadata_at(metadata, i)? else {
                    continue;
                };
                let sub_accounts = required_accounts_for_node(
                    sub_ism,
                    sub_meta,
                    message,
                    program_id,
                    extra_accounts,
                )?;
                // No dedup: account_metas must mirror the positional consumption in
                // verify_node. Each active sub-ISM pops its own accounts via
                // next_account_info regardless of whether a sibling used the same key.
                accounts.extend(sub_accounts);
            }
            Ok(accounts)
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            let Some(amount) = parse_routing_amount(&message.body) else {
                return Ok(vec![]);
            };
            let sub_ism = if amount >= *threshold { upper } else { lower };
            required_accounts_for_node(sub_ism, metadata, message, program_id, extra_accounts)
        }

        IsmNode::Routing => {
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            // Pass 2: if the domain PDA was provided as an extra input account,
            // read it to discover sub-accounts and whether it needs to be writable
            // (e.g. a RateLimited node inside writes state back on Verify).
            let mut domain_pda_writable = false;
            let mut sub_accounts: Vec<SerializableAccountMeta> = vec![];

            if !extra_accounts.is_empty() && *extra_accounts[0].key == domain_pda_key {
                let domain_acc = extra_accounts[0];

                if domain_acc.owner == program_id {
                    if let Ok(Some(storage)) =
                        DomainIsmAccount::fetch_data(&mut &domain_acc.data.borrow()[..])
                    {
                        if let Some(ref ism) = storage.ism {
                            if contains_rate_limited(ism) {
                                domain_pda_writable = true;
                            }
                            let node_accounts = required_accounts_for_node(
                                ism,
                                metadata,
                                message,
                                program_id,
                                extra_accounts,
                            )?;
                            // No dedup: preserve positional ordering to match verify_node
                            // consumption (same rationale as the Aggregation arm above).
                            sub_accounts.extend(node_accounts);
                        }
                    }
                }
            }
            // If pass 1 — domain PDA not yet in extra_accounts — we return only the
            // domain_pda_key. The fixpoint loop will re-invoke with the domain PDA
            // present, at which point the branch above fires.

            let domain_meta = if domain_pda_writable {
                AccountMeta::new(domain_pda_key, false) // writable, not signer
            } else {
                AccountMeta::new_readonly(domain_pda_key, false)
            };
            let mut result: Vec<SerializableAccountMeta> = vec![domain_meta.into()];
            result.extend(sub_accounts);
            Ok(result)
        }

        IsmNode::FallbackRouting { fallback_ism } => {
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            // Pass 1: request the domain PDA (same as Routing).
            let domain_provided =
                !extra_accounts.is_empty() && *extra_accounts[0].key == domain_pda_key;
            if !domain_provided {
                return Ok(vec![AccountMeta::new_readonly(domain_pda_key, false).into()]);
            }

            let domain_acc = extra_accounts[0];

            // Check whether the domain PDA holds an ISM for this origin (fast path).
            let mut domain_pda_writable = false;
            let mut used_domain_ism = false;
            let mut domain_sub_accounts: Vec<SerializableAccountMeta> = vec![];

            if domain_acc.owner == program_id {
                if let Ok(Some(storage)) =
                    DomainIsmAccount::fetch_data(&mut &domain_acc.data.borrow()[..])
                {
                    if let Some(ref ism) = storage.ism {
                        if contains_rate_limited(ism) {
                            domain_pda_writable = true;
                        }
                        domain_sub_accounts = required_accounts_for_node(
                            ism,
                            metadata,
                            message,
                            program_id,
                            extra_accounts,
                        )?;
                        used_domain_ism = true;
                    }
                }
            }

            if used_domain_ism {
                let domain_meta = if domain_pda_writable {
                    AccountMeta::new(domain_pda_key, false)
                } else {
                    AccountMeta::new_readonly(domain_pda_key, false)
                };
                let mut result: Vec<SerializableAccountMeta> = vec![domain_meta.into()];
                result.extend(domain_sub_accounts);
                return Ok(result);
            }

            // No domain ISM — fallback path.
            // Derive the fallback ISM's storage PDA directly from the stored address.
            // No mailbox inbox PDA is needed, avoiding a borrow conflict with the
            // mailbox's own reentrancy guard during process.
            let (fallback_storage_key, _) =
                Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, fallback_ism);

            // Pass 2: request the fallback ISM's storage PDA and program account.
            // The program account must be in the outer instruction's accounts so
            // that the CPI to the fallback ISM can locate the callee program.
            // fallback_storage_key is at position 1 (after domain PDA at position 0).
            let fallback_provided =
                extra_accounts.len() > 1 && *extra_accounts[1].key == fallback_storage_key;
            if !fallback_provided {
                return Ok(vec![
                    AccountMeta::new_readonly(domain_pda_key, false).into(),
                    AccountMeta::new_readonly(fallback_storage_key, false).into(),
                    AccountMeta::new_readonly(*fallback_ism, false).into(),
                ]);
            }

            // Pass 3+: CPI to the fallback ISM's VerifyAccountMetas instruction.
            // extra_accounts[1..] starts with the fallback ISM's VAM PDA.
            // The fallback program can be any ISM that implements the interface.
            let cpi_accounts: Vec<AccountInfo> =
                extra_accounts[1..].iter().map(|a| (*a).clone()).collect();
            let cpi_metas: Vec<AccountMeta> = cpi_accounts
                .iter()
                .map(crate::account_info_to_meta)
                .collect();
            let ixn_data =
                InterchainSecurityModuleInstruction::VerifyAccountMetas(VerifyInstruction {
                    metadata: metadata.to_vec(),
                    message: message.to_vec(),
                })
                .encode()?;
            let ixn = SolanaInstruction {
                program_id: *fallback_ism,
                accounts: cpi_metas,
                data: ixn_data,
            };
            invoke(&ixn, &cpi_accounts)?;

            let (_, cpi_return_bytes) =
                get_return_data().ok_or(crate::error::Error::InvalidFallbackIsmAccount)?;
            let cpi_result =
                borsh::from_slice::<SimulationReturnData<Vec<SerializableAccountMeta>>>(
                    &cpi_return_bytes,
                )
                .map_err(|_| ProgramError::BorshIoError)?;

            // Keep fallback_storage_key in the result so that the next fixpoint
            // iteration finds it at position 1 and re-enters Pass 3+ (stable point).
            // verify_node skips this sentinel before the CPI to Verify.
            let mut result: Vec<SerializableAccountMeta> = vec![
                AccountMeta::new_readonly(domain_pda_key, false).into(),
                AccountMeta::new_readonly(fallback_storage_key, false).into(),
            ];
            result.extend(cpi_result.return_data);
            // Re-append the program account so that subsequent Verify calls (and the
            // fixpoint loop) also include it and can perform the CPI.
            result.push(AccountMeta::new_readonly(*fallback_ism, false).into());
            Ok(result)
        }

        // State lives in the VAM PDA; no extra accounts needed.
        IsmNode::RateLimited { .. } => Ok(vec![]),

        // No extra accounts for these leaf ISMs.
        IsmNode::Test { .. } | IsmNode::Pausable { .. } => Ok(vec![]),
    }
}

/// Returns the full account metas list for `VerifyAccountMetas`:
/// always starts with the VAM PDA, then any node-specific accounts.
///
/// The VAM PDA is marked **writable** when the ISM tree contains a `RateLimited`
/// node (which mutates `filled_level`/`last_updated` during `Verify`).
///
/// `extra_accounts` are additional accounts beyond the VAM PDA that were passed
/// to the `VerifyAccountMetas` instruction (used for two-pass `Routing` resolution).
pub fn all_verify_account_metas(
    vam_pda_key: &Pubkey,
    root: &IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&AccountInfo],
) -> Result<Vec<SerializableAccountMeta>, ProgramError> {
    let storage_meta = if contains_rate_limited(root) {
        AccountMeta::new(*vam_pda_key, false) // writable, not signer
    } else {
        AccountMeta::new_readonly(*vam_pda_key, false)
    };
    let mut accounts = vec![storage_meta.into()];
    accounts.extend(required_accounts_for_node(
        root,
        metadata,
        message,
        program_id,
        extra_accounts,
    )?);
    Ok(accounts)
}

#[cfg(test)]
mod test {
    use super::*;
    use hyperlane_core::H256;

    const ORIGIN: u32 = 1234;

    fn dummy_message(origin: u32) -> HyperlaneMessage {
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

    fn encode_aggregation_metadata(sub_metas: &[Option<&[u8]>]) -> Vec<u8> {
        let header_len = (sub_metas.len() * 8) as u32;
        let mut offsets: Vec<(u32, u32)> = Vec::new();
        let mut cursor = header_len;
        for opt in sub_metas {
            if let Some(m) = opt {
                let start = cursor;
                let end = start + m.len() as u32;
                offsets.push((start, end));
                cursor = end;
            } else {
                offsets.push((0, 0));
            }
        }
        let mut buf = Vec::new();
        for (start, end) in &offsets {
            buf.extend_from_slice(&start.to_be_bytes());
            buf.extend_from_slice(&end.to_be_bytes());
        }
        for opt in sub_metas {
            if let Some(m) = opt {
                buf.extend_from_slice(m);
            }
        }
        buf
    }

    fn no_extra<'a>() -> Vec<&'a AccountInfo<'a>> {
        vec![]
    }

    #[test]
    fn test_trusted_relayer_returns_signer() {
        let relayer = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let node = IsmNode::TrustedRelayer { relayer };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer);
        assert!(accounts[0].is_signer);
    }

    #[test]
    fn test_multisig_no_extra_accounts() {
        let program_id = Pubkey::new_unique();
        let node = IsmNode::MultisigMessageId {
            validators: vec![],
            threshold: 1,
        };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_aggregation_only_active_sub_isms() {
        let relayer = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        // sub-ISM 0 has metadata, sub-ISM 1 does not
        let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::TrustedRelayer { relayer },
                IsmNode::TrustedRelayer {
                    relayer: Pubkey::new_unique(),
                },
            ],
        };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &metadata, &msg, &program_id, &no_extra()).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer);
    }

    /// Regression test: duplicate TrustedRelayer keys in an Aggregation must produce
    /// two separate account meta entries (one per active sub-ISM) so that
    /// verify_node can positionally consume both via next_account_info.
    /// Previously, dedup collapsed them to 1, causing AccountNotFound at verify time.
    #[test]
    fn test_duplicate_trusted_relayer_returns_two_entries() {
        let relayer = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::TrustedRelayer { relayer },
                IsmNode::TrustedRelayer { relayer },
            ],
        };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &metadata, &msg, &program_id, &no_extra()).unwrap();
        // Both active sub-ISMs must each contribute their own entry.
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0].pubkey, relayer);
        assert_eq!(accounts[1].pubkey, relayer);
    }

    #[test]
    fn test_rate_limited_no_extra_accounts() {
        let program_id = Pubkey::new_unique();
        let node = IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 1_000,
            last_updated: 0,
        };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_routing_returns_domain_pda_key() {
        let program_id = Pubkey::new_unique();
        let node = IsmNode::Routing;
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert_eq!(accounts.len(), 1);
        let (expected_key, _) = derive_domain_pda(&program_id, ORIGIN);
        assert_eq!(accounts[0].pubkey, expected_key);
        assert!(!accounts[0].is_signer);
        assert!(!accounts[0].is_writable);
    }

    /// When the domain PDA is present but not owned by the program, Routing returns
    /// only the domain PDA key (no fallback accounts — Routing fails with
    /// NoRouteForDomain when no domain ISM is found).
    #[test]
    fn test_routing_unowned_domain_pda_returns_only_domain_key() {
        use solana_program::account_info::AccountInfo;

        let program_id = Pubkey::new_unique();
        let node = IsmNode::Routing;
        let msg = dummy_message(ORIGIN);

        let (domain_pda_key, _) = derive_domain_pda(&program_id, ORIGIN);

        let foreign_owner = Pubkey::default();
        let mut lamports = 0u64;
        let mut data: Vec<u8> = vec![];
        let domain_pda_info = AccountInfo::new(
            &domain_pda_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &foreign_owner,
            false,
        );

        // Pass 1: only the domain PDA key is returned.
        let pass1 = required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert_eq!(pass1.len(), 1);
        assert_eq!(pass1[0].pubkey, domain_pda_key);

        // Pass 2 (domain PDA present but unowned): still only the domain PDA — no fallback.
        let extra = vec![&domain_pda_info];
        let accounts = required_accounts_for_node(&node, &[], &msg, &program_id, &extra).unwrap();
        assert_eq!(accounts.len(), 1, "expected only domain_pda, no fallback");
        assert_eq!(accounts[0].pubkey, domain_pda_key);
    }

    // ── FallbackRouting tests ────────────────────────────────────────────────

    /// Pass 1: no extra accounts → returns only the domain PDA key.
    #[test]
    fn test_fallback_routing_pass1_returns_domain_pda_only() {
        let program_id = Pubkey::new_unique();
        let fallback_ism = Pubkey::new_unique();
        let node = IsmNode::FallbackRouting { fallback_ism };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra()).unwrap();
        assert_eq!(accounts.len(), 1);
        let (expected_domain_key, _) = derive_domain_pda(&program_id, ORIGIN);
        assert_eq!(accounts[0].pubkey, expected_domain_key);
        assert!(!accounts[0].is_writable);
    }

    /// Pass 2: domain PDA present but no domain ISM → requests fallback storage PDA and
    /// fallback ISM program account.  The program account is required so that pass 3's
    /// CPI to the fallback ISM can locate the callee in the outer instruction's accounts.
    #[test]
    fn test_fallback_routing_pass2_returns_fallback_storage_key() {
        use solana_program::account_info::AccountInfo;

        let program_id = Pubkey::new_unique();
        let fallback_ism = Pubkey::new_unique();
        let node = IsmNode::FallbackRouting { fallback_ism };
        let msg = dummy_message(ORIGIN);

        let (domain_pda_key, _) = derive_domain_pda(&program_id, ORIGIN);
        let (expected_fallback_storage, _) =
            Pubkey::find_program_address(VERIFY_ACCOUNT_METAS_PDA_SEEDS, &fallback_ism);

        // Domain PDA present but not owned by our program (no domain ISM).
        let foreign_owner = Pubkey::default();
        let mut lamports = 0u64;
        let mut data: Vec<u8> = vec![];
        let domain_pda_info = AccountInfo::new(
            &domain_pda_key,
            false,
            false,
            &mut lamports,
            &mut data,
            &foreign_owner,
            false,
        );

        let extra = vec![&domain_pda_info];
        let accounts = required_accounts_for_node(&node, &[], &msg, &program_id, &extra).unwrap();

        // [domain_pda, fallback_storage_key, fallback_ism_program_key]
        assert_eq!(accounts.len(), 3);
        assert_eq!(accounts[0].pubkey, domain_pda_key);
        assert_eq!(accounts[1].pubkey, expected_fallback_storage);
        assert_eq!(accounts[2].pubkey, fallback_ism);
    }

    #[test]
    fn test_contains_rate_limited_leaf() {
        let node = IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 1_000,
            last_updated: 0,
        };
        assert!(contains_rate_limited(&node));
    }

    #[test]
    fn test_contains_rate_limited_nested_in_aggregation() {
        let node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::RateLimited {
                    max_capacity: 1_000,
                    recipient: None,
                    filled_level: 1_000,
                    last_updated: 0,
                },
            ],
        };
        assert!(contains_rate_limited(&node));
    }

    #[test]
    fn test_contains_rate_limited_false_for_routing() {
        let node = IsmNode::Routing;
        assert!(!contains_rate_limited(&node));
    }

    #[test]
    fn test_all_verify_account_metas_writable_for_rate_limited() {
        let vam_pda = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let node = IsmNode::RateLimited {
            max_capacity: 1_000,
            recipient: None,
            filled_level: 1_000,
            last_updated: 0,
        };
        let msg = dummy_message(ORIGIN);
        let accounts =
            all_verify_account_metas(&vam_pda, &node, &[], &msg, &program_id, &[]).unwrap();
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, vam_pda);
        assert!(accounts[0].is_writable);
        assert!(!accounts[0].is_signer);
    }

    #[test]
    fn test_all_verify_account_metas_readonly_for_non_rate_limited() {
        let vam_pda = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let node = IsmNode::Test { accept: true };
        let msg = dummy_message(ORIGIN);
        let accounts =
            all_verify_account_metas(&vam_pda, &node, &[], &msg, &program_id, &[]).unwrap();
        assert_eq!(accounts.len(), 1);
        assert!(!accounts[0].is_writable);
    }
}
