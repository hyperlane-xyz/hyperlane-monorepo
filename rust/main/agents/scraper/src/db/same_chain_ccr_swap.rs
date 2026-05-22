use ethers::utils::keccak256;
use eyre::Result;
use tracing::instrument;

use hyperlane_core::{HyperlaneMessage, LogMeta, SameChainCcrSwap, H256};

use crate::db::ScraperDb;
use crate::db::{StorableDelivery, StorableMessage};

/// Compute the synthetic message ID for a same-chain CCR swap.
///
/// Format: `0x00000000 || keccak256("SameChainCCR" || txHash32 || logIndex8)[0..28]`
///
/// The 4-byte zero prefix makes synthetic IDs immediately distinguishable from
/// real Hyperlane message IDs (keccak256 outputs are uniformly distributed).
/// Uniqueness comes from `txHash || logIndex` in the hash.
fn synthetic_ccr_msg_id(meta: &LogMeta) -> H256 {
    // The H512 transaction_id stores the 32-byte tx hash right-aligned (bytes 32..64).
    debug_assert_eq!(
        &meta.transaction_id.as_bytes()[..32],
        &[0u8; 32],
        "expected right-aligned 32-byte tx hash in transaction_id"
    );
    let tx_hash = &meta.transaction_id.as_bytes()[32..];
    let log_index = meta.log_index.as_u64().to_be_bytes();

    let mut input = Vec::with_capacity(12 + 32 + 8);
    input.extend_from_slice(b"SameChainCCR");
    input.extend_from_slice(tx_hash);
    input.extend_from_slice(&log_index);
    let hash = keccak256(&input);

    let mut id = [0u8; 32];
    id[4..].copy_from_slice(&hash[..28]);
    H256::from(id)
}

#[derive(Debug)]
pub struct StorableCcrSwap<'a> {
    pub swap: &'a SameChainCcrSwap,
    pub meta: &'a LogMeta,
    /// The database id of the transaction the swap was made in
    pub txn_id: i64,
}

impl ScraperDb {
    /// Store same-chain CCR swaps as synthetic Hyperlane messages so the
    /// explorer can display them without any Hasura or explorer code changes.
    /// origin == destination (same domain), source_router = origin_mailbox,
    /// destination_router = destination_mailbox.
    ///
    /// The message ID has a 4-byte zero prefix for immediate recognition:
    /// `0x00000000 || keccak256("SameChainCCR" || txHash || logIndex)[0..28]`
    ///
    /// Nonce is derived deterministically from bytes 4..8 of the msg_id (the
    /// high word of the keccak hash), so it is stable across re-index runs and
    /// requires no DB reads.  Both inserts are idempotent via their existing
    /// ON CONFLICT clauses, so no pre-checks or new migrations are needed.
    #[instrument(skip_all)]
    pub async fn store_ccr_swaps_as_messages(
        &self,
        domain: u32,
        swaps: &[StorableCcrSwap<'_>],
    ) -> Result<u64> {
        let mut count = 0u64;
        for storable in swaps {
            let swap = storable.swap;
            let msg_id = synthetic_ccr_msg_id(storable.meta);

            // Derive nonce deterministically from msg_id bytes 4..8.
            // Bytes 0..4 are the zero prefix; bytes 4..8 are the high word of
            // the keccak hash — stable across re-index runs, no DB reads needed.
            // Birthday collision probability: p(n) ≈ n²/(2·2³²). At n=1 000
            // swaps per (chain, router) p≈0.01%; at n=65 536 p≈50%. If a
            // collision does occur, the ON CONFLICT DO UPDATE silently overwrites
            // one row. Acceptable without a migration; add a unique index on
            // msg_id to eliminate this if volumes grow.
            let nonce = u32::from_be_bytes(
                msg_id.as_bytes()[4..8]
                    .try_into()
                    .expect("slice has exactly 4 bytes"),
            );

            // TokenMessage body: recipient_bytes32 ++ amount_received_uint256
            // Uses amount_received (from ReceivedTransferRemote, post-fee) to match
            // what cross-chain CCR Hyperlane messages encode in the message body.
            let mut body = Vec::with_capacity(64);
            body.extend_from_slice(swap.recipient.as_bytes());
            let mut amount_bytes = [0u8; 32];
            swap.amount_received.to_big_endian(&mut amount_bytes);
            body.extend_from_slice(&amount_bytes);

            let msg = HyperlaneMessage {
                version: 3,
                nonce,
                origin: swap.domain,
                sender: swap.source_router,
                destination: swap.domain,
                recipient: swap.destination_router,
                body,
            };

            // ON CONFLICT (origin, origin_mailbox, nonce) → UPSERT.  With a
            // deterministic nonce, re-indexing the same swap produces identical
            // data, so the upsert is effectively a no-op.
            self.store_dispatched_messages(
                domain,
                &swap.source_router,
                std::iter::once(StorableMessage {
                    msg,
                    meta: storable.meta,
                    txn_id: storable.txn_id,
                    id_override: Some(msg_id),
                }),
            )
            .await?;

            // ON CONFLICT (msg_id) → UPSERT — idempotent on retry.
            self.store_deliveries(
                domain,
                swap.destination_router,
                std::iter::once(StorableDelivery {
                    message_id: msg_id,
                    sequence: None,
                    meta: storable.meta,
                    txn_id: storable.txn_id,
                }),
            )
            .await?;

            count = count.saturating_add(1);
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use hyperlane_core::{H256, H512, U256};

    use super::*;

    fn make_meta(tx_hash: H256, log_index: u64) -> LogMeta {
        let mut tx_id_bytes = [0u8; 64];
        tx_id_bytes[32..].copy_from_slice(tx_hash.as_bytes());
        LogMeta {
            address: H256::zero(),
            block_number: 0,
            block_hash: H256::zero(),
            transaction_id: H512::from(tx_id_bytes),
            transaction_index: 0,
            log_index: U256::from(log_index),
        }
    }

    /// Fixture shared with typescript/utils/src/messages.test.ts.
    /// Both sides must produce the identical hex string for the same inputs.
    #[test]
    fn synthetic_ccr_msg_id_matches_typescript_fixture() {
        let tx_hash: H256 = "0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890"
            .parse()
            .unwrap();
        let msg_id = synthetic_ccr_msg_id(&make_meta(tx_hash, 7));
        let expected: H256 = "0x000000001620870f00662d2235b9ddf02edd63c54ae359b191e04ffacff719e6"
            .parse()
            .unwrap();
        assert_eq!(msg_id, expected);
    }

    /// Same (txHash, logIndex) must always produce the same msg_id — deterministic.
    #[test]
    fn same_inputs_produce_same_msg_id() {
        let tx_hash: H256 = "0x1111111111111111111111111111111111111111111111111111111111111111"
            .parse()
            .unwrap();
        let id1 = synthetic_ccr_msg_id(&make_meta(tx_hash, 5));
        let id2 = synthetic_ccr_msg_id(&make_meta(tx_hash, 5));
        assert_eq!(id1, id2);
    }

    /// Different (txHash, logIndex) pairs must produce different msg_ids.
    #[test]
    fn different_inputs_produce_different_msg_ids() {
        let tx_a: H256 = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
            .parse()
            .unwrap();
        let tx_b: H256 = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
            .parse()
            .unwrap();
        assert_ne!(
            synthetic_ccr_msg_id(&make_meta(tx_a, 0)),
            synthetic_ccr_msg_id(&make_meta(tx_b, 0)),
        );
        assert_ne!(
            synthetic_ccr_msg_id(&make_meta(tx_a, 0)),
            synthetic_ccr_msg_id(&make_meta(tx_a, 1)),
        );
    }
}
