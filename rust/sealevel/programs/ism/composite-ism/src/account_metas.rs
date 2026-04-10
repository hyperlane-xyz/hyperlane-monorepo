use hyperlane_core::HyperlaneMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{account_info::AccountInfo, instruction::AccountMeta, pubkey::Pubkey};

use crate::{
    accounts::{derive_domain_pda, DomainIsmAccount, IsmNode},
    metadata::{parse_aggregation_ranges, sub_metadata},
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
        // For Routing, only the default_ism matters here — domain PDAs handle their own
        // writable marking (see the Routing arm in required_accounts_for_node).
        IsmNode::Routing { default_ism } => {
            default_ism.as_deref().is_some_and(contains_rate_limited)
        }
        _ => false,
    }
}

/// Returns the additional account metas required by `Verify` for this ISM node,
/// beyond account 0 (the VAM PDA) which is always included by the caller.
///
/// `program_id` is needed to derive domain PDA keys for `Routing` nodes.
///
/// `extra_accounts` is a slice of additional accounts passed to `VerifyAccountMetas`
/// beyond the VAM PDA (used in pass 2 for `Routing` to resolve sub-accounts like
/// `TrustedRelayer` inside a domain PDA). `cursor` tracks how many have been consumed.
pub fn required_accounts_for_node(
    node: &IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
    program_id: &Pubkey,
    extra_accounts: &[&AccountInfo],
    cursor: &mut usize,
) -> Vec<SerializableAccountMeta> {
    match node {
        IsmNode::TrustedRelayer { relayer } => {
            vec![AccountMeta {
                pubkey: *relayer,
                is_signer: true,
                is_writable: false,
            }
            .into()]
        }

        // All state is in the VAM PDA; no extra accounts needed.
        IsmNode::MultisigMessageId { .. } => vec![],

        IsmNode::Aggregation { sub_isms, .. } => {
            let ranges = match parse_aggregation_ranges(metadata, sub_isms.len()) {
                Ok(r) => r,
                Err(_) => return vec![],
            };

            let mut accounts: Vec<SerializableAccountMeta> = Vec::new();
            for (i, sub_ism) in sub_isms.iter().enumerate() {
                if !ranges[i].has_metadata() {
                    continue;
                }
                let sub_meta = sub_metadata(metadata, ranges[i]);
                let sub_accounts = required_accounts_for_node(
                    sub_ism,
                    sub_meta,
                    message,
                    program_id,
                    extra_accounts,
                    cursor,
                );
                for account in sub_accounts {
                    if let Some(existing) = accounts
                        .iter_mut()
                        .find(|a: &&mut SerializableAccountMeta| a.pubkey == account.pubkey)
                    {
                        existing.is_signer = existing.is_signer || account.is_signer;
                        existing.is_writable = existing.is_writable || account.is_writable;
                    } else {
                        accounts.push(account);
                    }
                }
            }
            accounts
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            const AMOUNT_OFFSET: usize = 32;
            const AMOUNT_END: usize = 64;
            if message.body.len() < AMOUNT_END {
                return vec![];
            }
            let Ok(amount): Result<[u8; 32], _> =
                message.body[AMOUNT_OFFSET..AMOUNT_END].try_into()
            else {
                return vec![];
            };
            let sub_ism = if amount >= *threshold { upper } else { lower };
            required_accounts_for_node(
                sub_ism,
                metadata,
                message,
                program_id,
                extra_accounts,
                cursor,
            )
        }

        IsmNode::Routing { .. } => {
            let (domain_pda_key, _) = derive_domain_pda(program_id, message.origin);

            // Pass 2: if the domain PDA was provided as an extra input account,
            // read it to discover sub-accounts and whether it needs to be writable
            // (e.g. a RateLimited node inside writes state back on Verify).
            let mut domain_pda_writable = false;
            let mut sub_accounts: Vec<SerializableAccountMeta> = vec![];

            if *cursor < extra_accounts.len() && *extra_accounts[*cursor].key == domain_pda_key {
                let domain_acc = extra_accounts[*cursor];
                *cursor += 1;

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
                                cursor,
                            );
                            for account in node_accounts {
                                if !sub_accounts
                                    .iter()
                                    .any(|a: &SerializableAccountMeta| a.pubkey == account.pubkey)
                                {
                                    sub_accounts.push(account);
                                }
                            }
                        }
                    }
                }
            }

            let domain_meta = if domain_pda_writable {
                AccountMeta::new(domain_pda_key, false) // writable, not signer
            } else {
                AccountMeta::new_readonly(domain_pda_key, false)
            };
            let mut result: Vec<SerializableAccountMeta> = vec![domain_meta.into()];
            result.extend(sub_accounts);
            result
        }

        // State lives in the VAM PDA; no extra accounts needed.
        IsmNode::RateLimited { .. } => vec![],

        // No extra accounts for these leaf ISMs.
        IsmNode::Test { .. } | IsmNode::Pausable { .. } => vec![],
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
) -> Vec<SerializableAccountMeta> {
    let storage_meta = if contains_rate_limited(root) {
        AccountMeta::new(*vam_pda_key, false) // writable, not signer
    } else {
        AccountMeta::new_readonly(*vam_pda_key, false)
    };
    let mut accounts = vec![storage_meta.into()];
    let mut cursor = 0usize;
    accounts.extend(required_accounts_for_node(
        root,
        metadata,
        message,
        program_id,
        extra_accounts,
        &mut cursor,
    ));
    accounts
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
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra(), &mut 0);
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
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra(), &mut 0);
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
            required_accounts_for_node(&node, &metadata, &msg, &program_id, &no_extra(), &mut 0);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer);
    }

    #[test]
    fn test_deduplication() {
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
            required_accounts_for_node(&node, &metadata, &msg, &program_id, &no_extra(), &mut 0);
        assert_eq!(accounts.len(), 1);
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
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra(), &mut 0);
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_routing_returns_domain_pda_key() {
        let program_id = Pubkey::new_unique();
        let node = IsmNode::Routing { default_ism: None };
        let msg = dummy_message(ORIGIN);
        let accounts =
            required_accounts_for_node(&node, &[], &msg, &program_id, &no_extra(), &mut 0);
        assert_eq!(accounts.len(), 1);
        let (expected_key, _) = derive_domain_pda(&program_id, ORIGIN);
        assert_eq!(accounts[0].pubkey, expected_key);
        assert!(!accounts[0].is_signer);
        assert!(!accounts[0].is_writable);
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
        let node = IsmNode::Routing { default_ism: None };
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
        let accounts = all_verify_account_metas(&vam_pda, &node, &[], &msg, &program_id, &[]);
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
        let accounts = all_verify_account_metas(&vam_pda, &node, &[], &msg, &program_id, &[]);
        assert_eq!(accounts.len(), 1);
        assert!(!accounts[0].is_writable);
    }
}
