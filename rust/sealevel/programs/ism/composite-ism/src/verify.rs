use hyperlane_core::{Checkpoint, CheckpointWithMessageId, HyperlaneMessage};
use multisig_ism::multisig::MultisigIsm;
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    sysvar::Sysvar,
};

use crate::{
    accounts::IsmNode,
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
/// `accounts_iter` is advanced only for nodes that require signer accounts
/// (currently only `TrustedRelayer`). All other state is read from the VAM PDA
/// already loaded by the caller.
pub(crate) fn verify_node<'a, 'b, I>(
    node: &mut IsmNode,
    metadata: &[u8],
    message: &HyperlaneMessage,
    accounts_iter: &mut I,
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

        IsmNode::MultisigMessageId { domain_configs } => {
            let config = domain_configs
                .iter()
                .find(|c| c.origin == message.origin)
                .ok_or(Error::NoDomainConfig)?;

            let meta = MultisigIsmMessageIdMetadata::try_from(metadata.to_vec())
                .map_err(|_| Error::InvalidMetadata)?;

            let multisig_ism = MultisigIsm::new(
                CheckpointWithMessageId {
                    checkpoint: Checkpoint {
                        merkle_tree_hook_address: meta.origin_merkle_tree_hook,
                        mailbox_domain: message.origin,
                        root: meta.merkle_root,
                        index: meta.merkle_index,
                    },
                    message_id: message.id(),
                },
                meta.validator_signatures,
                config.validators.clone(),
                config.threshold,
            );

            multisig_ism
                .verify()
                .map_err(|e| Into::<Error>::into(e).into())
        }

        IsmNode::Aggregation {
            threshold,
            sub_isms,
        } => {
            let ranges = parse_aggregation_ranges(metadata, sub_isms.len())?;

            // Count sub-ISMs that have metadata provided.
            let provided = ranges.iter().filter(|r| r.has_metadata()).count() as u8;
            if provided < *threshold {
                return Err(Error::ThresholdNotMet.into());
            }

            // Verify each sub-ISM that has metadata. All must pass.
            for (i, sub_ism) in sub_isms.iter_mut().enumerate() {
                if !ranges[i].has_metadata() {
                    continue;
                }
                let sub_meta = sub_metadata(metadata, ranges[i]);
                verify_node(sub_ism, sub_meta, message, accounts_iter)?;
            }

            Ok(())
        }

        IsmNode::Routing {
            routes,
            default_ism,
        } => {
            let sub_ism: &mut IsmNode = if let Some((_, ism)) = routes
                .iter_mut()
                .find(|(domain, _)| *domain == message.origin)
            {
                ism
            } else if let Some(d) = default_ism {
                d.as_mut()
            } else {
                return Err(Error::NoRouteForDomain.into());
            };

            // Routing is transparent: pass metadata through unchanged.
            verify_node(sub_ism, metadata, message, accounts_iter)
        }

        IsmNode::AmountRouting {
            threshold,
            lower,
            upper,
        } => {
            // TokenMessage body layout: [recipient (32b) | amount (32b BE) | ...]
            const AMOUNT_OFFSET: usize = 32;
            const AMOUNT_END: usize = 64;
            if message.body.len() < AMOUNT_END {
                return Err(Error::InvalidMessageBody.into());
            }
            let amount: [u8; 32] = message.body[AMOUNT_OFFSET..AMOUNT_END]
                .try_into()
                .map_err(|_| Error::InvalidMessageBody)?;

            let sub_ism: &mut IsmNode = if amount >= *threshold { upper } else { lower };
            verify_node(sub_ism, metadata, message, accounts_iter)
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
            // 1. Recipient guard.
            if let Some(r) = recipient {
                if message.recipient != *r {
                    return Err(Error::RecipientMismatch.into());
                }
            }

            // 2. Parse amount from body[56..64] (last 8 bytes of 32-byte BE u256).
            //    TokenMessage layout: [recipient (32b) | amount (32b BE) | ...]
            //    Amounts exceeding u64::MAX (non-zero bytes at [32..56]) are rejected.
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

            // 3. Compute adjusted level via token bucket refill.
            let now = Clock::get()?.unix_timestamp;
            let adjusted =
                calculate_current_level(*filled_level, *last_updated, now, *max_capacity);

            // 4. Check capacity.
            if amount > adjusted {
                return Err(Error::RateLimitExceeded.into());
            }

            // 5. Update state in place; processor writes the PDA back.
            *filled_level = adjusted - amount;
            *last_updated = now;
            Ok(())
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::accounts::DomainConfig;
    use ecdsa_signature::EcdsaSignature;
    use hyperlane_core::{Encode, H256};
    use multisig_ism::test_data::{get_multisig_ism_test_data, MultisigIsmTestData};

    const ORIGIN_DOMAIN: u32 = 1234u32;

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

    // ── Test ISM node ──────────────────────────────────────────────────────

    #[test]
    fn test_node_accept() {
        let mut node = IsmNode::Test { accept: true };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_node_reject() {
        let mut node = IsmNode::Test { accept: false };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    // ── Pausable ISM node ──────────────────────────────────────────────────

    #[test]
    fn test_pausable_unpaused() {
        let mut node = IsmNode::Pausable { paused: false };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_pausable_paused() {
        let mut node = IsmNode::Pausable { paused: true };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    // ── Routing ISM node ───────────────────────────────────────────────────

    #[test]
    fn test_routing_to_accept() {
        let mut node = IsmNode::Routing {
            routes: vec![(ORIGIN_DOMAIN, IsmNode::Test { accept: true })],
            default_ism: None,
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_routing_to_reject() {
        let mut node = IsmNode::Routing {
            routes: vec![(ORIGIN_DOMAIN, IsmNode::Test { accept: false })],
            default_ism: None,
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_err());
    }

    #[test]
    fn test_routing_default() {
        let mut node = IsmNode::Routing {
            routes: vec![],
            default_ism: Some(Box::new(IsmNode::Test { accept: true })),
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_routing_no_route() {
        let mut node = IsmNode::Routing {
            routes: vec![],
            default_ism: None,
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter).unwrap_err(),
            Error::NoRouteForDomain.into()
        );
    }

    // ── Aggregation ISM node ───────────────────────────────────────────────

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
    fn test_aggregation_threshold_met() {
        // threshold=1, 2 sub-ISMs, only sub-ISM 0 has metadata
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
        assert!(verify_node(&mut node, &metadata, &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_aggregation_threshold_not_met() {
        // threshold=2 but only 1 sub-ISM has metadata
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
            verify_node(&mut node, &metadata, &msg, &mut iter).unwrap_err(),
            Error::ThresholdNotMet.into()
        );
    }

    #[test]
    fn test_aggregation_sub_ism_fails() {
        // Both sub-ISMs have metadata but sub-ISM 0 rejects
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
        assert!(verify_node(&mut node, &metadata, &msg, &mut iter).is_err());
    }

    // ── MultisigMessageId node ─────────────────────────────────────────────

    #[test]
    fn test_multisig_message_id_verify() {
        let MultisigIsmTestData {
            message,
            checkpoint,
            validators,
            signatures,
        } = get_multisig_ism_test_data();

        let mut node = IsmNode::MultisigMessageId {
            domain_configs: vec![DomainConfig {
                origin: message.origin,
                validators,
                threshold: 2,
            }],
        };

        let meta = crate::multisig_metadata::MultisigIsmMessageIdMetadata {
            origin_merkle_tree_hook: checkpoint.merkle_tree_hook_address,
            merkle_root: checkpoint.root,
            merkle_index: checkpoint.index,
            validator_signatures: vec![
                EcdsaSignature::from_bytes(&signatures[0]).unwrap(),
                EcdsaSignature::from_bytes(&signatures[1]).unwrap(),
            ],
        };
        let meta_bytes = meta.to_vec();

        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &meta_bytes, &message, &mut iter).is_ok());
    }

    #[test]
    fn test_multisig_no_domain_config() {
        let mut node = IsmNode::MultisigMessageId {
            domain_configs: vec![],
        };
        let msg = dummy_message(ORIGIN_DOMAIN);
        // metadata must be long enough to parse (at least 68 + 65 bytes)
        let dummy_meta = vec![0u8; 68 + 65];
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &dummy_meta, &msg, &mut iter).unwrap_err(),
            Error::NoDomainConfig.into()
        );
    }

    // ── AmountRouting ISM node ─────────────────────────────────────────────

    fn token_message_body(amount_bytes: [u8; 32]) -> Vec<u8> {
        let mut body = vec![0u8; 64]; // recipient (32b) + amount (32b)
        body[32..64].copy_from_slice(&amount_bytes);
        body
    }

    fn amount_routing_node(threshold_value: u64) -> IsmNode {
        let mut threshold = [0u8; 32];
        threshold[24..32].copy_from_slice(&threshold_value.to_be_bytes());
        IsmNode::AmountRouting {
            threshold,
            lower: Box::new(IsmNode::Test { accept: true }),
            upper: Box::new(IsmNode::Test { accept: false }), // upper rejects, lower accepts
        }
    }

    #[test]
    fn test_amount_routing_below_threshold_routes_lower() {
        let mut node = amount_routing_node(1000);
        // amount = 500 < 1000 → lower (accept=true)
        let mut amount = [0u8; 32];
        amount[24..32].copy_from_slice(&500u64.to_be_bytes());
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = token_message_body(amount);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_ok());
    }

    #[test]
    fn test_amount_routing_at_threshold_routes_upper() {
        let mut node = amount_routing_node(1000);
        // amount = 1000 >= 1000 → upper (accept=false)
        let mut amount = [0u8; 32];
        amount[24..32].copy_from_slice(&1000u64.to_be_bytes());
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = token_message_body(amount);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter).unwrap_err(),
            Error::VerifyRejected.into()
        );
    }

    #[test]
    fn test_amount_routing_above_threshold_routes_upper() {
        let mut node = amount_routing_node(1000);
        // amount = 5000 >= 1000 → upper (accept=false)
        let mut amount = [0u8; 32];
        amount[24..32].copy_from_slice(&5000u64.to_be_bytes());
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = token_message_body(amount);
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert!(verify_node(&mut node, &[], &msg, &mut iter).is_err());
    }

    #[test]
    fn test_amount_routing_body_too_short() {
        let mut node = amount_routing_node(1000);
        let mut msg = dummy_message(ORIGIN_DOMAIN);
        msg.body = vec![0u8; 10]; // too short
        let mut iter = std::iter::empty::<&AccountInfo>();
        assert_eq!(
            verify_node(&mut node, &[], &msg, &mut iter).unwrap_err(),
            Error::InvalidMessageBody.into()
        );
    }
}
