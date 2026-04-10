use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneMessage, Signable};
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

use crate::{
    account_metas::contains_rate_limited,
    accounts::{derive_domain_pda, load_domain_ism_storage, DomainIsmAccount, IsmNode},
    error::Error,
    metadata::{parse_aggregation_ranges, sub_metadata},
    multisig_metadata::MultisigIsmMessageIdMetadata,
    rate_limit::calculate_current_level,
};

/// Recursively verifies a message against an ISM node.
///
/// `node` is `&mut` so that `RateLimited` can update `filled_level` and
/// `last_updated` in place; the caller is responsible for persisting the
/// storage PDA back to the account after this returns.
///
/// `accounts_iter` is advanced for nodes that require on-chain accounts:
/// - `TrustedRelayer`: pops the relayer signer account.
/// - `Routing`: pops the domain PDA account, then may pop sub-accounts.
pub(crate) fn verify_node<'a, 'b, I>(
    node: &mut IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
    accounts_iter: &mut I,
    program_id: &Pubkey,
) -> ProgramResult
where
    I: Iterator<Item = &'a AccountInfo<'b>>,
    'b: 'a,
{
    match node {
        IsmNode::TrustedRelayer { relayer } => {
            let relayer_info = next_account_info(accounts_iter)?;
            if relayer_info.key != relayer {
                return Err(Error::InvalidRelayer.into());
            }
            if !relayer_info.is_signer {
                return Err(Error::RelayerNotSigner.into());
            }
            Ok(())
        }

        IsmNode::MultisigMessageId {
            validators,
            threshold,
        } => {
            let meta = MultisigIsmMessageIdMetadata::try_from(metadata.to_vec())
                .map_err(|_| Error::InvalidMetadata)?;

            let signed_digest = CheckpointWithMessageId {
                checkpoint: Checkpoint {
                    merkle_tree_hook_address: meta.origin_merkle_tree_hook,
                    mailbox_domain: message.origin,
                    root: meta.merkle_root,
                    index: meta.merkle_index,
                },
                message_id: message.id(),
            }
            .eth_signed_message_hash();
            let signed_digest_bytes = signed_digest.as_bytes();

            if meta.validator_signatures.len() < *threshold as usize {
                return Err(Error::ThresholdNotMet.into());
            }

            let validator_count = validators.len();
            let mut validator_index = 0;
            for i in 0..*threshold {
                let signer = meta.validator_signatures[i as usize]
                    .secp256k1_recover_ethereum_address(signed_digest_bytes)
                    .map_err(|_| Error::InvalidSignature)?;
                while validator_index < validator_count && signer != validators[validator_index] {
                    validator_index += 1;
                }
                if validator_index >= validator_count {
                    return Err(Error::ThresholdNotMet.into());
                }
                validator_index += 1;
            }
            Ok(())
        }

        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            let ranges = parse_aggregation_ranges(metadata, sub_isms.len())?;

            let provided = ranges.iter().filter(|r| r.has_metadata()).count();
            if provided < *threshold as usize {
                return Err(Error::ThresholdNotMet.into());
            }

            for (i, sub_ism) in sub_isms.iter_mut().enumerate() {
                if !ranges[i].has_metadata() {
                    continue;
                }
                let sub_meta = sub_metadata(metadata, ranges[i]);
                verify_node(sub_ism, sub_meta, message, accounts_iter, program_id)?;
            }

            Ok(())
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            const AMOUNT_OFFSET: usize = 32;
            const AMOUNT_END: usize = 64;
            if message.body.len() < AMOUNT_END {
                return Err(Error::InvalidMessageBody.into());
            }
            let amount: [u8; 32] = message.body[AMOUNT_OFFSET..AMOUNT_END]
                .try_into()
                .map_err(|_| Error::InvalidMessageBody)?;

            let sub_ism: &mut IsmNode = if amount >= *threshold { upper } else { lower };
            verify_node(sub_ism, metadata, message, accounts_iter, program_id)
        }

        IsmNode::Routing { default_ism } => {
            // Pop the domain PDA from the accounts iterator.
            let domain_pda_info = next_account_info(accounts_iter)?;

            // Verify the caller passed the correct domain PDA for this origin.
            let (expected_key, _) = derive_domain_pda(program_id, message.origin);
            if *domain_pda_info.key != expected_key {
                return Err(Error::AccountOutOfOrder.into());
            }

            // Load the full domain PDA storage (None if not owned by this program).
            let loaded_storage =
                load_domain_ism_storage(program_id, message.origin, domain_pda_info)?;

            if let Some(mut storage) = loaded_storage {
                if let Some(mut ism) = storage.ism.take() {
                    // RateLimited state must be persisted; require a writable domain PDA so a
                    // hand-crafted transaction cannot bypass the rate limit by passing it readonly.
                    if contains_rate_limited(&ism) && !domain_pda_info.is_writable {
                        return Err(Error::AccountOutOfOrder.into());
                    }
                    verify_node(&mut ism, metadata, message, accounts_iter, program_id)?;
                    // Write updated state back to the domain PDA (e.g. RateLimited counters).
                    if domain_pda_info.is_writable {
                        storage.ism = Some(ism);
                        DomainIsmAccount::from(storage).store(domain_pda_info, false)?;
                    }
                    return Ok(());
                }
                // ism is None — domain PDA exists but holds no ISM; fall through to default.
            }

            // No domain PDA (or empty) — fall back to default_ism.
            if let Some(d) = default_ism {
                return verify_node(d.as_mut(), metadata, message, accounts_iter, program_id);
            }

            Err(Error::NoRouteForDomain.into())
        }

        IsmNode::Test { accept } => {
            if *accept {
                Ok(())
            } else {
                Err(Error::VerifyRejected.into())
            }
        }

        IsmNode::Pausable { paused } => {
            if *paused {
                Err(Error::VerifyRejected.into())
            } else {
                Ok(())
            }
        }

        IsmNode::RateLimited {
            max_capacity,
            recipient,
            filled_level,
            last_updated,
        } => {
            if let Some(r) = recipient {
                if message.recipient != *r {
                    return Err(Error::RecipientMismatch.into());
                }
            }

            if message.body.len() < 64 {
                return Err(Error::InvalidMessageBody.into());
            }
            if message.body[32..56].iter().any(|&b| b != 0) {
                return Err(Error::InvalidMessageBody.into());
            }
            let amount = u64::from_be_bytes(
                message.body[56..64]
                    .try_into()
                    .map_err(|_| Error::InvalidMessageBody)?,
            );

            let now = Clock::get()?.unix_timestamp;
            let adjusted =
                calculate_current_level(*filled_level, *last_updated, now, *max_capacity);

            if amount > adjusted {
                return Err(Error::RateLimitExceeded.into());
            }

            *filled_level = adjusted - amount;
            *last_updated = now;
            Ok(())
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use ecdsa_signature::EcdsaSignature;
    use hyperlane_core::{Checkpoint, CheckpointWithMessageId, Encode, H160, H256};
    use std::str::FromStr;

    const ORIGIN_DOMAIN: u32 = 1234u32;

    // Test data matching the multisig-ism library's canonical fixtures.
    // checkpoint.signing_hash() == 0x3fd308215a20af20b137372f8a69fd336ebf93d57d4076a7c46e13f315255257
    fn test_message() -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce: 69,
            origin: ORIGIN_DOMAIN,
            sender: H256::from_str(
                "0xafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafafaf",
            )
            .unwrap(),
            destination: 4321,
            recipient: H256::from_str(
                "0xbebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebebe",
            )
            .unwrap(),
            body: vec![0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
        }
    }

    fn test_checkpoint(message: &HyperlaneMessage) -> CheckpointWithMessageId {
        CheckpointWithMessageId {
            checkpoint: Checkpoint {
                merkle_tree_hook_address: H256::from_str(
                    "0xabababababababababababababababababababababababababababababababab",
                )
                .unwrap(),
                mailbox_domain: ORIGIN_DOMAIN,
                root: H256::from_str(
                    "0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
                )
                .unwrap(),
                index: message.nonce + 1,
            },
            message_id: message.id(),
        }
    }

    fn test_validators() -> Vec<H160> {
        vec![
            H160::from_str("0xE3DCDBbc248cE191bDc271f3FCcd0d95911BFC5D").unwrap(),
            H160::from_str("0xb25206874C24733F05CC0dD11924724A8E7175bd").unwrap(),
            H160::from_str("0x28b8d0E2bBfeDe9071F8Ff3DaC9CcE3d3176DBd3").unwrap(),
        ]
    }

    fn test_signatures() -> Vec<Vec<u8>> {
        vec![
            hex::decode("081d398e1452ae12267f63f224d3037b4bb3f496cb55c14a2076c5e27ed944ad6d8e10d3164bc13b5820846a3f19e013e1c551b67a3c863882f7b951acdab96d1c").unwrap(),
            hex::decode("0c189e25dea6bb93292af16fd0516f3adc8a19556714c0b8d624016175bebcba7a5fe8218dad6fc86faeb8104fad8390ccdec989d992e852553ea6b61fbb2eda1b").unwrap(),
            hex::decode("5493449e8a09c1105195ecf913997de51bd50926a075ad98fe3e845e0a11126b5212a2cd1afdd35a44322146d31f8fa3d179d8a9822637d8db0e2fa8b3d292421b").unwrap(),
        ]
    }

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

    fn no_program_id() -> Pubkey {
        Pubkey::new_unique()
    }

    #[test]
    fn test_node_accept() {
        let mut node = IsmNode::Test { accept: true };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).is_ok());
    }

    #[test]
    fn test_node_reject() {
        let mut node = IsmNode::Test { accept: false };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    #[test]
    fn test_pausable_unpaused() {
        let mut node = IsmNode::Pausable { paused: false };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).is_ok());
    }

    #[test]
    fn test_pausable_paused() {
        let mut node = IsmNode::Pausable { paused: true };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    #[test]
    fn test_aggregation_threshold_met() {
        let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
        let mut node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &metadata, &msg, &mut iter, &no_program_id()).is_ok());
    }

    #[test]
    fn test_aggregation_threshold_not_met() {
        let metadata = encode_aggregation_metadata(&[Some(&[]), None]);
        let mut node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::Test { accept: true },
                IsmNode::Test { accept: true },
            ],
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &metadata, &msg, &mut iter, &no_program_id()).unwrap_err(),
            Error::ThresholdNotMet.into()
        );
    }

    #[test]
    fn test_aggregation_sub_ism_fails() {
        let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);
        let mut node = IsmNode::Aggregation {
            threshold: 1,
            sub_isms: vec![
                IsmNode::Test { accept: false },
                IsmNode::Test { accept: true },
            ],
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &metadata, &msg, &mut iter, &no_program_id()).is_err());
    }

    #[test]
    fn test_multisig_message_id_verify() {
        let message = test_message();
        let checkpoint = test_checkpoint(&message);
        let signatures = test_signatures();

        let mut node = IsmNode::MultisigMessageId {
            validators: test_validators(),
            threshold: 2,
        };

        let meta = crate::multisig_metadata::MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.checkpoint.root,
            merkle_index: checkpoint.checkpoint.index,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
            ],
        };
        let meta_bytes = meta.to_vec();

        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(
            &mut node,
            &meta_bytes,
            &message,
            &mut iter,
            &no_program_id()
        )
        .is_ok());
    }

    #[test]
    fn test_multisig_threshold_not_met_duplicate_sig() {
        let message = test_message();
        let checkpoint = test_checkpoint(&message);
        let signatures = test_signatures();

        let mut node = IsmNode::MultisigMessageId {
            validators: test_validators(),
            threshold: 2,
        };

        // Two copies of signature[0] — duplicate cannot satisfy a second slot.
        let meta = crate::multisig_metadata::MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.checkpoint.root,
            merkle_index: checkpoint.checkpoint.index,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
            ],
        };
        let meta_bytes = meta.to_vec();

        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(
                &mut node,
                &meta_bytes,
                &message,
                &mut iter,
                &no_program_id()
            )
            .unwrap_err(),
            Error::ThresholdNotMet.into()
        );
    }

    fn token_message_body(amount_bytes: [u8; 32]) -> Vec<u8> {
        let mut body = vec![0u8; 64];
        body[32..64].copy_from_slice(&amount_bytes);
        body
    }

    fn amount_routing_node(threshold_value: u64) -> IsmNode {
        let mut threshold = [0u8; 32];
        threshold[24..32].copy_from_slice(&threshold_value.to_be_bytes());
        IsmNode::AmountRouting {
            threshold,
            lower: Box::new(IsmNode::Test { accept: true }),
            upper: Box::new(IsmNode::Test { accept: false }),
        }
    }

    #[test]
    fn test_amount_routing_below_threshold_routes_lower() {
        let mut node = amount_routing_node(1000);
        let mut amount = [0u8; 32];
        amount[24..32].copy_from_slice(&500u64.to_be_bytes());
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = token_message_body(amount);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).is_ok());
    }

    #[test]
    fn test_amount_routing_at_threshold_routes_upper() {
        let mut node = amount_routing_node(1000);
        let mut amount = [0u8; 32];
        amount[24..32].copy_from_slice(&1000u64.to_be_bytes());
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = token_message_body(amount);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    #[test]
    fn test_amount_routing_body_too_short() {
        let mut node = amount_routing_node(1000);
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = vec![0u8; 10];
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter, &no_program_id()).unwrap_err(),
            Error::InvalidMessageBody.into()
        );
    }

    /// Regression test: Aggregation([TrustedRelayer(A), TrustedRelayer(A)]) with both
    /// sub-ISMs active must consume two account slots positionally, matching the two
    /// entries returned by required_accounts_for_node (no dedup).
    #[test]
    fn test_aggregation_duplicate_trusted_relayer_consumes_two_accounts() {
        use crate::account_metas::required_accounts_for_node;

        let relayer_key = Pubkey::new_unique();
        let program_id = Pubkey::new_unique();
        let metadata = encode_aggregation_metadata(&[Some(&[]), Some(&[])]);

        let mut node = IsmNode::Aggregation {
            threshold: 2,
            sub_isms: vec![
                IsmNode::TrustedRelayer {
                    relayer: relayer_key,
                },
                IsmNode::TrustedRelayer {
                    relayer: relayer_key,
                },
            ],
        };

        // Confirm account_metas returns 2 entries for this config.
        let metas = required_accounts_for_node(
            &node,
            &metadata,
            &dummy_message(ORIGIN_DOMAIN),
            &program_id,
            &[],
            &mut 0,
        );
        assert_eq!(
            metas.len(),
            2,
            "expected 2 account metas for Aggregation([TR(A), TR(A)])"
        );

        // Build two AccountInfo stubs for the same relayer key (is_signer = true).
        // SVM provides the same account twice when a key appears twice in the
        // instruction's accounts list.
        let mut lamports = 0u64;
        let mut data = vec![];
        let owner = Pubkey::default();
        let relayer_info_1 = AccountInfo::new(
            &relayer_key,
            /*is_signer=*/ true,
            false,
            &mut lamports,
            &mut data,
            &owner,
            false,
        );
        let mut lamports2 = 0u64;
        let mut data2 = vec![];
        let relayer_info_2 = AccountInfo::new(
            &relayer_key,
            /*is_signer=*/ true,
            false,
            &mut lamports2,
            &mut data2,
            &owner,
            false,
        );

        let accounts = vec![relayer_info_1, relayer_info_2];
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = accounts.iter();
        assert!(
            verify_node(&mut node, &metadata, &msg, &mut iter, &program_id).is_ok(),
            "verify_node must succeed when two account slots are provided for two TR(A) sub-ISMs"
        );
        // Both accounts were consumed.
        assert!(
            iter.next().is_none(),
            "both account slots should have been consumed"
        );
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
}
