use hyperlane_core::HyperlaneMessage;
use serializable_account_meta::SerializableAccountMeta;
use solana_program::{instruction::AccountMeta, pubkey::Pubkey};

use crate::{
    accounts::IsmNode,
    metadata::{parse_aggregation_ranges, sub_metadata},
};

/// Returns the additional account metas required by `Verify` for this ISM node,
/// beyond account 0 (the VAM PDA) which is always included by the caller.
///
/// For `VerifyAccountMetas` simulation the metadata is parsed to determine which
/// aggregation sub-ISMs have metadata provided, so only their accounts are returned.
/// If metadata parsing fails (e.g. during a dry-run), an empty list is returned for
/// that sub-tree — the actual `Verify` call will fail with a proper error.
pub fn required_accounts_for_node(
    node: &IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
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
                let sub_accounts = required_accounts_for_node(sub_ism, sub_meta, message);
                for account in sub_accounts {
                    if !accounts
                        .iter()
                        .any(|a: &SerializableAccountMeta| a.pubkey == account.pubkey)
                    {
                        accounts.push(account);
                    }
                }
            }
            accounts
        }

        IsmNode::Routing {
            routes,
            default_ism,
        } => {
            let sub_ism = routes
                .iter()
                .find(|(domain, _)| *domain == message.origin)
                .map(|(_, ism)| ism)
                .or(default_ism.as_deref());

            match sub_ism {
                Some(ism) => required_accounts_for_node(ism, metadata, message),
                None => vec![],
            }
        }

        // No extra accounts for these leaf ISMs.
        IsmNode::Test { .. } | IsmNode::Pausable { .. } => vec![],
    }
}

/// Returns the full account metas list for `VerifyAccountMetas`:
/// always starts with the VAM PDA, then any node-specific accounts.
pub fn all_verify_account_metas(
    vam_pda_key: &Pubkey,
    root: &IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
) -> Vec<SerializableAccountMeta> {
    let mut accounts = vec![AccountMeta::new_readonly(*vam_pda_key, false).into()];
    accounts.extend(required_accounts_for_node(root, metadata, message));
    accounts
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::accounts::DomainConfig;
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

    #[test]
    fn test_trusted_relayer_returns_signer() {
        let relayer = Pubkey::new_unique();
        let node = IsmNode::TrustedRelayer { relayer };
        let msg = dummy_message(ORIGIN);
        let accounts = required_accounts_for_node(&node, &[], &msg);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer);
        assert!(accounts[0].is_signer);
    }

    #[test]
    fn test_multisig_no_extra_accounts() {
        let node = IsmNode::MultisigMessageId {
            domain_configs: vec![DomainConfig {
                origin: ORIGIN,
                validators: vec![],
                threshold: 1,
            }],
        };
        let msg = dummy_message(ORIGIN);
        let accounts = required_accounts_for_node(&node, &[], &msg);
        assert!(accounts.is_empty());
    }

    #[test]
    fn test_aggregation_only_active_sub_isms() {
        let relayer = Pubkey::new_unique();
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
        let accounts = required_accounts_for_node(&node, &metadata, &msg);
        // Only sub-ISM 0's relayer should be included
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer);
    }

    #[test]
    fn test_routing_selects_correct_branch() {
        let relayer_a = Pubkey::new_unique();
        let relayer_b = Pubkey::new_unique();
        let node = IsmNode::Routing {
            routes: vec![
                (ORIGIN, IsmNode::TrustedRelayer { relayer: relayer_a }),
                (9999, IsmNode::TrustedRelayer { relayer: relayer_b }),
            ],
            default_ism: None,
        };
        let msg = dummy_message(ORIGIN);
        let accounts = required_accounts_for_node(&node, &[], &msg);
        assert_eq!(accounts.len(), 1);
        assert_eq!(accounts[0].pubkey, relayer_a);
    }

    #[test]
    fn test_deduplication() {
        let relayer = Pubkey::new_unique();
        // Both sub-ISMs use the same relayer
        let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);
        let node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::TrustedRelayer { relayer },
                IsmNode::TrustedRelayer { relayer },
            ],
        };
        let msg = dummy_message(ORIGIN);
        let accounts = required_accounts_for_node(&node, &metadata, &msg);
        // Deduplication: only one entry for the shared relayer
        assert_eq!(accounts.len(), 1);
    }
}
