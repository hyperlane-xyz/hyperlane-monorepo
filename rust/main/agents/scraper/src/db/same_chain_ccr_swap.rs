use ethers::utils::keccak256;
use eyre::Result;
use tracing::instrument;

use hyperlane_core::{HyperlaneMessage, LogMeta, SameChainCcrSwap};

use crate::db::ScraperDb;
use crate::db::{StorableDelivery, StorableMessage};

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
    /// destination_router = destination_mailbox. The nonce is derived from
    /// keccak256(tx_id ++ log_index) to be deterministic and collision-resistant.
    #[instrument(skip_all)]
    pub async fn store_ccr_swaps_as_messages(
        &self,
        domain: u32,
        swaps: &[StorableCcrSwap<'_>],
    ) -> Result<u64> {
        let mut count = 0u64;
        for storable in swaps {
            let swap = storable.swap;

            // Deterministic nonce: keccak256(tx_id_bytes || log_index_be)
            let mut nonce_input = [0u8; 72];
            nonce_input[..64].copy_from_slice(storable.meta.transaction_id.as_bytes());
            nonce_input[64..].copy_from_slice(&storable.meta.log_index.as_u64().to_be_bytes());
            let nonce_hash = keccak256(nonce_input);
            // % 2^31 keeps the nonce in PostgreSQL's signed integer range (equivalent to & 0x7FFF_FFFF).
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
            let msg_id = msg.id();

            self.store_dispatched_messages(
                domain,
                &swap.source_router,
                std::iter::once(StorableMessage {
                    msg,
                    meta: storable.meta,
                    txn_id: storable.txn_id,
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
