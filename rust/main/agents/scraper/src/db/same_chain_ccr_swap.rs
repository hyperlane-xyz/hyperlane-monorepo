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
    /// The nonce is `keccak256(tx_id || log_index) % 2^31` — collision-resistant
    /// within PostgreSQL's signed INT4 range.
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

            // Deterministic nonce: keccak256(tx_id_bytes || log_index_be)
            // % 2^31 keeps the nonce in PostgreSQL's signed integer range.
            let mut nonce_input = [0u8; 72];
            nonce_input[..64].copy_from_slice(storable.meta.transaction_id.as_bytes());
            nonce_input[64..].copy_from_slice(&storable.meta.log_index.as_u64().to_be_bytes());
            let nonce_hash = keccak256(nonce_input);
            let nonce =
                u32::from_be_bytes([nonce_hash[0], nonce_hash[1], nonce_hash[2], nonce_hash[3]])
                    % 2_147_483_648;

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
