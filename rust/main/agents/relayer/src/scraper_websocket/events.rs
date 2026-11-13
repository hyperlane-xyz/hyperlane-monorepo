//! Decode and validate the three live event types against local RPC history.
use super::{Kind, ScraperSource};
use eyre::{bail, ensure, Context, ContextCompat, Result};
use futures_util::FutureExt;
use hyperlane_base::{broadcast::IndexingNotification, cursors::Indexable};
use hyperlane_base::{
    db::{HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{parse_address, EventMessage, MerkleEventData, StringOrNumber},
};
use hyperlane_core::{
    bytes_to_h512, HyperlaneMessage, Indexed, InterchainGasPayment, LogMeta, MerkleTreeInsertion,
    H256, H512, U256,
};
use serde::Deserialize;
use tracing::debug;

#[derive(Clone, Debug, PartialEq)]
pub(super) enum LiveEvent {
    Dispatch(HyperlaneMessage, u64, H512),
    Merkle(MerkleTreeInsertion, u64),
    Gas(Indexed<InterchainGasPayment>, LogMeta),
}
impl LiveEvent {
    pub(super) fn sequence(&self) -> Option<(Kind, u32)> {
        match self {
            Self::Dispatch(m, ..) => Some((Kind::Dispatch, m.nonce)),
            Self::Merkle(m, ..) => Some((Kind::Merkle, m.index())),
            Self::Gas(..) => None,
        }
    }
    pub(super) fn body_bytes(&self) -> usize {
        match self {
            Self::Dispatch(m, ..) => m.body.len(),
            _ => 0,
        }
    }
    pub(super) fn decode(
        event: EventMessage<serde_json::Value>,
        source: &ScraperSource,
    ) -> Result<Option<Self>> {
        ensure!(
            event.domain == source.domain,
            "Unexpected live stream domain"
        );
        match event.event_type.as_str() {
            "dispatch" => {
                let data: DispatchData = serde_json::from_value(event.data)?;
                if parse_address(&data.origin_mailbox)? != source.mailbox {
                    return Ok(None);
                }
                ensure!(
                    data.origin_domain == source.domain,
                    "Dispatch origin mismatch"
                );
                let message = HyperlaneMessage {
                    version: 3,
                    nonce: data.nonce.as_u32("dispatch nonce")?,
                    origin: data.origin_domain,
                    sender: parse_address(&data.sender)?,
                    recipient: parse_address(&data.recipient)?,
                    destination: data.destination_domain,
                    body: parse_hex(
                        data.msg_body
                            .as_deref()
                            .context("Dispatch body unavailable; use RPC")?,
                    )?,
                };
                ensure!(
                    message.id() == parse_address(&data.msg_id)?,
                    "Dispatch payload does not match its message ID"
                );
                ensure!(
                    event
                        .sequence
                        .context("Missing dispatch sequence")?
                        .parse::<u32>()?
                        == message.nonce,
                    "Dispatch sequence mismatch"
                );
                Ok(Some(Self::Dispatch(
                    message,
                    data.origin_block_height.as_u64("dispatch height")?,
                    parse_tx(&data.origin_tx_hash)?,
                )))
            }
            "merkle_tree_insertion" => {
                let data: MerkleEventData = serde_json::from_value(event.data)?;
                if parse_address(&data.merkle_tree_hook)? != source.merkle_tree_hook {
                    return Ok(None);
                }
                let sequence = event.sequence.context("Missing Merkle sequence")?.parse()?;
                let (insertion, block) =
                    data.decode(source.domain, source.merkle_tree_hook, sequence)?;
                Ok(Some(Self::Merkle(insertion, block)))
            }
            "gas_payment" => {
                ensure!(source.gas_indexing, "Unexpected gas payment stream");
                let data: GasData = serde_json::from_value(event.data)?;
                if parse_address(&data.interchain_gas_paymaster)? != source.interchain_gas_paymaster
                {
                    return Ok(None);
                }
                ensure!(
                    data.origin == source.domain && data.domain == source.domain,
                    "Gas payment origin mismatch"
                );
                let (payment, meta) = data.decode(source.interchain_gas_paymaster)?;
                Ok(Some(Self::Gas(payment, meta)))
            }
            other => bail!("Unexpected scraper event type {other}"),
        }
    }
    /// Missing data keeps RPC active; conflicting data must never be overwritten.
    pub(super) fn matches(&self, db: &HyperlaneRocksDB) -> Result<bool> {
        match self {
            Self::Dispatch(message, block, tx) => {
                let stored = db.retrieve_message_by_nonce(message.nonce)?;
                let stored_block = db.retrieve_dispatched_block_number_by_nonce(&message.nonce)?;
                let stored_tx = db.retrieve_dispatched_tx_hash_by_message_id(&message.id())?;
                ensure!(
                    stored.as_ref().is_none_or(|m| m == message)
                        && stored_block.is_none_or(|b| b == *block),
                    "Conflicting dispatch history"
                );
                ensure!(
                    *tx == H512::zero() || stored_tx.is_none_or(|t| t == H512::zero() || t == *tx),
                    "Conflicting dispatch transaction"
                );
                Ok(stored.is_some() && stored_block.is_some())
            }
            Self::Merkle(insertion, block) => {
                let stored = db.retrieve_merkle_tree_insertion_by_leaf_index(&insertion.index())?;
                let stored_block = db.retrieve_merkle_tree_insertion_block_number_by_leaf_index(
                    &insertion.index(),
                )?;
                ensure!(
                    stored.as_ref().is_none_or(|i| i == insertion)
                        && stored_block.is_none_or(|b| b == *block),
                    "Conflicting Merkle history"
                );
                Ok(stored.is_some() && stored_block.is_some())
            }
            Self::Gas(payment, meta) => {
                if let Some(sequence) = payment.sequence {
                    let stored = db.retrieve_gas_payment_by_sequence(&sequence)?;
                    let block = db.retrieve_gas_payment_block_by_sequence(&sequence)?;
                    ensure!(
                        stored.as_ref().is_none_or(|p| p == payment.inner())
                            && block.is_none_or(|b| b == meta.block_number),
                        "Conflicting gas payment history"
                    );
                }
                Ok(db
                    .retrieve_processed_by_gas_payment_meta(&meta.into())?
                    .unwrap_or(false))
            }
        }
    }
}

#[derive(Deserialize)]
struct DispatchData {
    origin_mailbox: String,
    origin_domain: u32,
    nonce: StringOrNumber,
    sender: String,
    recipient: String,
    destination_domain: u32,
    msg_body: Option<String>,
    msg_id: String,
    origin_block_height: StringOrNumber,
    origin_tx_hash: String,
}

#[derive(Deserialize)]
struct GasData {
    destination: u32,
    domain: u32,
    gas_amount: String,
    interchain_gas_paymaster: String,
    log_index: String,
    msg_id: String,
    origin: u32,
    origin_block_hash: Option<String>,
    origin_block_height: Option<String>,
    origin_tx_hash: Option<String>,
    payment: String,
    sequence: Option<String>,
}
impl GasData {
    fn decode(self, paymaster: H256) -> Result<(Indexed<InterchainGasPayment>, LogMeta)> {
        let payment = InterchainGasPayment {
            message_id: parse_address(&self.msg_id)?,
            destination: self.destination,
            payment: U256::from_dec_str(&self.payment)?,
            gas_amount: U256::from_dec_str(&self.gas_amount)?,
        };
        let mut payment = Indexed::new(payment);
        payment.sequence = self.sequence.map(|s| s.parse::<u32>()).transpose()?;
        let meta = LogMeta {
            address: paymaster,
            block_number: self
                .origin_block_height
                .context("Gas payment needs RPC block metadata")?
                .parse()?,
            block_hash: parse_address(
                &self
                    .origin_block_hash
                    .context("Gas payment needs RPC block hash")?,
            )?,
            transaction_id: parse_tx(
                &self
                    .origin_tx_hash
                    .context("Gas payment needs RPC transaction hash")?,
            )?,
            transaction_index: 0,
            log_index: U256::from_dec_str(&self.log_index)?,
        };
        Ok((payment, meta))
    }
}
fn parse_hex(value: &str) -> Result<Vec<u8>> {
    hex::decode(
        value
            .strip_prefix("0x")
            .or_else(|| value.strip_prefix("\\x"))
            .unwrap_or(value),
    )
    .context("Invalid scraper hex")
}
fn parse_tx(value: &str) -> Result<H512> {
    let bytes = parse_hex(value)?;
    ensure!(
        matches!(bytes.len(), 32 | 64),
        "Invalid transaction hash length"
    );
    Ok(bytes_to_h512(&bytes))
}

impl ScraperSource {
    pub(super) fn store(&self, event: &LiveEvent) -> Result<()> {
        // Check any RPC overlap before writing; never overwrite conflicting history.
        event.matches(&self.database)?;
        match event {
            LiveEvent::Dispatch(message, block, tx) => {
                let inserted = self.database.store_message(message, *block)?;
                self.database
                    .extend_sequence_coverage::<HyperlaneMessage>(message.nonce)?;
                if *tx != H512::zero() {
                    self.database
                        .store_dispatched_tx_hash_by_message_id(&message.id(), tx)?;
                    if let Some(sender) = self.broadcaster.as_ref().filter(|_| inserted) {
                        // DB discovery is authoritative; a slow hint subscriber must not block the socket.
                        if !matches!(
                            sender
                                .send(IndexingNotification {
                                    tx_id: *tx,
                                    sequences: vec![Some(message.nonce)]
                                })
                                .now_or_never(),
                            Some(Ok(()))
                        ) {
                            debug!(
                                chain = self.chain,
                                "Indexed dispatch notification deferred to DB discovery"
                            );
                        }
                    }
                }
            }
            LiveEvent::Merkle(insertion, block) => {
                self.database.process_tree_insertion(insertion, *block)?;
                self.database
                    .extend_sequence_coverage::<MerkleTreeInsertion>(insertion.index())?;
            }
            LiveEvent::Gas(payment, meta) => {
                self.database.process_indexed_gas_payment(*payment, meta)?;
                // Replay the observed block and its predecessor after reconnect.
                let height = u32::try_from(meta.block_number).context("Gas height exceeds u32")?;
                self.database
                    .advance_observed_gas_height(height.saturating_sub(1))?;
                if let Some(sequence) = payment.sequence {
                    self.database
                        .extend_sequence_coverage::<InterchainGasPayment>(sequence)?;
                }
            }
        }
        if let Some((kind, sequence)) = event.sequence() {
            let event_type = match kind {
                Kind::Dispatch => HyperlaneMessage::name(),
                Kind::Merkle => MerkleTreeInsertion::name(),
                Kind::Gas => unreachable!(),
            };
            let metrics = &self.sync_metrics.cursor_metrics;
            for gauge in [
                metrics
                    .cursor_max_sequence
                    .with_label_values(&[event_type, &self.chain]),
                metrics.cursor_current_sequence.with_label_values(&[
                    event_type,
                    &self.chain,
                    "forward_sequenced",
                ]),
            ] {
                gauge.set(gauge.get().max(i64::from(sequence)));
            }
        }
        Ok(())
    }
}
