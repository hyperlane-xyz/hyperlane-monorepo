use ethers::utils::keccak256;
use eyre::Result;
use sea_orm::{prelude::*, ActiveValue::*, QueryOrder, QuerySelect};
use tracing::instrument;

use hyperlane_core::{
    address_to_bytes, h256_to_bytes, HyperlaneMessage, LogMeta, SameChainCcrSwap, H256,
};

use crate::db::ScraperDb;
use crate::db::{StorableDelivery, StorableMessage};

use super::generated::message;

/// Compute the synthetic message ID for a same-chain CCR swap.
///
/// Format: `0x00000000 || keccak256("SameChainCCR" || txHash32 || logIndex8)[0..28]`
///
/// The 4-byte zero prefix makes synthetic IDs immediately distinguishable from
/// real Hyperlane message IDs (keccak256 outputs are uniformly distributed).
/// Uniqueness comes from `txHash || logIndex` in the hash.
fn synthetic_ccr_msg_id(meta: &LogMeta) -> H256 {
    // The H512 transaction_id stores the 32-byte tx hash right-aligned (bytes 32..64).
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
    /// Returns the next nonce to use for a synthetic CCR swap from `source_router`
    /// on `domain`. Reads the current maximum nonce for that (origin, origin_mailbox)
    /// pair and returns max + 1, or 0 if no rows exist yet.
    ///
    /// Safe because the scraper processes one block range at a time per domain —
    /// no concurrent writers can race to claim the same nonce.
    async fn ccr_next_nonce(&self, domain: u32, source_router: &H256) -> Result<u32> {
        let mailbox_bytes = address_to_bytes(source_router);
        let max: Option<i32> = message::Entity::find()
            .filter(message::Column::Origin.eq(domain as i32))
            .filter(message::Column::OriginMailbox.eq(mailbox_bytes))
            .select_only()
            .column(message::Column::Nonce)
            .order_by_desc(message::Column::Nonce)
            .limit(1)
            .into_tuple::<i32>()
            .one(&self.0)
            .await?;
        Ok(max.map_or(0, |n| (n as u32).wrapping_add(1)))
    }

    /// Returns true if a message with this `msg_id` is already stored.
    /// Used to skip re-insertion when re-indexing a block range.
    async fn ccr_msg_already_stored(&self, msg_id: H256) -> Result<bool> {
        let count = message::Entity::find()
            .filter(message::Column::MsgId.eq(h256_to_bytes(&msg_id)))
            .count(&self.0)
            .await?;
        Ok(count > 0)
    }

    /// Store same-chain CCR swaps as synthetic Hyperlane messages so the
    /// explorer can display them without any Hasura or explorer code changes.
    /// origin == destination (same domain), source_router = origin_mailbox,
    /// destination_router = destination_mailbox.
    ///
    /// The message ID has a 4-byte zero prefix for immediate recognition:
    /// `0x00000000 || keccak256("SameChainCCR" || txHash || logIndex)[0..28]`
    ///
    /// Nonce is a sequential counter per (domain, source_router) pair, derived
    /// by querying the current max nonce and incrementing. This avoids birthday
    /// collisions entirely. Idempotency is handled by a pre-check on msg_id.
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

            // Skip if already indexed — sequential nonce is not deterministic
            // across re-index runs so we guard on msg_id instead of relying on
            // ON CONFLICT.
            if self.ccr_msg_already_stored(msg_id).await? {
                continue;
            }

            let nonce = self.ccr_next_nonce(domain, &swap.source_router).await?;

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
