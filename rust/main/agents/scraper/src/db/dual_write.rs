//! Dual-write database wrapper for the Explorer API migration.
//!
//! This module provides a wrapper around ScraperDb that supports writing to both
//! a primary and secondary database. This enables a gradual migration to Cloud SQL
//! while maintaining the existing Hasura Cloud database as the source of truth.
//!
//! Key design principles:
//! - Primary database failures propagate as errors (existing behavior)
//! - Secondary database failures are logged but don't affect the primary pipeline
//! - All write operations are independent (no distributed transactions)

use eyre::Result;
use tracing::{error, info, instrument};

use hyperlane_core::{Delivery, HyperlaneMessage, InterchainGasPayment, H256};

use super::{
    ScraperDb, StorableDelivery, StorableMessage, StorablePayment, StorableRawMessageDispatch,
};

/// A wrapper around ScraperDb that optionally writes to a secondary database.
///
/// When dual-write is enabled, all write operations are performed on both databases.
/// Failures on the secondary database are logged but don't affect the primary pipeline.
#[derive(Debug, Clone)]
pub struct DualWriteDb {
    /// Primary database (existing Hasura Cloud DB)
    primary: ScraperDb,
    /// Secondary database (new Cloud SQL DB) - optional
    secondary: Option<ScraperDb>,
    /// Whether dual-write is enabled
    dual_write_enabled: bool,
}

impl DualWriteDb {
    /// Create a new DualWriteDb with only a primary database (no dual-write)
    pub fn new(primary: ScraperDb) -> Self {
        Self {
            primary,
            secondary: None,
            dual_write_enabled: false,
        }
    }

    /// Create a new DualWriteDb with dual-write enabled
    pub fn with_dual_write(
        primary: ScraperDb,
        secondary: ScraperDb,
        enabled: bool,
    ) -> Self {
        if enabled {
            info!("Dual-write mode enabled for scraper database");
        }
        Self {
            primary,
            secondary: Some(secondary),
            dual_write_enabled: enabled,
        }
    }

    /// Check if dual-write is currently enabled
    pub fn is_dual_write_enabled(&self) -> bool {
        self.dual_write_enabled && self.secondary.is_some()
    }

    /// Get a reference to the primary database
    pub fn primary(&self) -> &ScraperDb {
        &self.primary
    }

    /// Store dispatched messages to both databases
    #[instrument(skip_all, fields(domain = domain))]
    pub async fn store_dispatched_messages(
        &self,
        domain: u32,
        origin_mailbox: &H256,
        messages: impl Iterator<Item = StorableMessage<'_>> + Clone,
    ) -> Result<u64> {
        // Write to primary database first
        let result = self
            .primary
            .store_dispatched_messages(domain, origin_mailbox, messages.clone())
            .await?;

        // Write to secondary database if dual-write is enabled
        if self.is_dual_write_enabled() {
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary
                    .store_dispatched_messages(domain, origin_mailbox, messages)
                    .await
                {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        domain = domain,
                        "Failed to write dispatched messages to secondary database"
                    );
                }
            }
        }

        Ok(result)
    }

    /// Store raw message dispatches to both databases
    #[instrument(skip_all, fields(domain = domain))]
    pub async fn store_raw_message_dispatches(
        &self,
        domain: u32,
        mailbox_address: &H256,
        messages: impl Iterator<Item = StorableRawMessageDispatch<'_>> + Clone,
    ) -> Result<u64> {
        // Write to primary database first
        let result = self
            .primary
            .store_raw_message_dispatches(domain, mailbox_address, messages.clone())
            .await?;

        // Write to secondary database if dual-write is enabled
        if self.is_dual_write_enabled() {
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary
                    .store_raw_message_dispatches(domain, mailbox_address, messages)
                    .await
                {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        domain = domain,
                        "Failed to write raw message dispatches to secondary database"
                    );
                }
            }
        }

        Ok(result)
    }

    /// Store deliveries to both databases
    #[instrument(skip_all, fields(domain = domain))]
    pub async fn store_deliveries(
        &self,
        domain: u32,
        destination_mailbox: H256,
        deliveries: impl Iterator<Item = StorableDelivery<'_>> + Clone,
    ) -> Result<u64> {
        // Write to primary database first
        let result = self
            .primary
            .store_deliveries(domain, destination_mailbox, deliveries.clone())
            .await?;

        // Write to secondary database if dual-write is enabled
        if self.is_dual_write_enabled() {
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary
                    .store_deliveries(domain, destination_mailbox, deliveries)
                    .await
                {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        domain = domain,
                        "Failed to write deliveries to secondary database"
                    );
                }
            }
        }

        Ok(result)
    }

    /// Store gas payments to both databases
    #[instrument(skip_all, fields(domain = domain))]
    pub async fn store_payments(
        &self,
        domain: u32,
        interchain_gas_paymaster: &H256,
        payments: &[StorablePayment<'_>],
    ) -> Result<u64> {
        // Write to primary database first
        let result = self
            .primary
            .store_payments(domain, interchain_gas_paymaster, payments)
            .await?;

        // Write to secondary database if dual-write is enabled
        if self.is_dual_write_enabled() {
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary
                    .store_payments(domain, interchain_gas_paymaster, payments)
                    .await
                {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        domain = domain,
                        "Failed to write payments to secondary database"
                    );
                }
            }
        }

        Ok(result)
    }

    /// Store blocks to both databases
    #[instrument(skip_all, fields(domain = domain))]
    pub async fn store_blocks(
        &self,
        domain: u32,
        blocks: impl Iterator<Item = hyperlane_core::BlockInfo> + Clone,
    ) -> Result<()> {
        // Write to primary database first
        self.primary.store_blocks(domain, blocks.clone()).await?;

        // Write to secondary database if dual-write is enabled
        if self.is_dual_write_enabled() {
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary.store_blocks(domain, blocks).await {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        domain = domain,
                        "Failed to write blocks to secondary database"
                    );
                }
            }
        }

        Ok(())
    }

    /// Store transactions to both databases
    #[instrument(skip_all)]
    pub async fn store_txns(
        &self,
        txns: impl Iterator<Item = super::StorableTxn>,
    ) -> Result<()> {
        // If dual-write is enabled, collect to Vec so we can iterate twice
        if self.is_dual_write_enabled() && self.secondary.is_some() {
            let txns_vec: Vec<_> = txns.collect();
            
            // Write to primary database first
            self.primary.store_txns(txns_vec.iter().cloned()).await?;
            
            // Write to secondary database
            if let Some(secondary) = &self.secondary {
                if let Err(e) = secondary.store_txns(txns_vec.into_iter()).await {
                    // Log error but don't fail the primary pipeline
                    error!(
                        error = ?e,
                        "Failed to write transactions to secondary database"
                    );
                }
            }
        } else {
            // No dual-write, just write to primary
            self.primary.store_txns(txns).await?;
        }

        Ok(())
    }

    // Read operations only use the primary database
    // These are delegated directly to the primary ScraperDb

    /// Retrieve a dispatched message by nonce (from primary database)
    pub async fn retrieve_dispatched_message_by_nonce(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
        nonce: u32,
    ) -> Result<Option<HyperlaneMessage>> {
        self.primary
            .retrieve_dispatched_message_by_nonce(origin_domain, origin_mailbox, nonce)
            .await
    }

    /// Retrieve dispatched tx ID (from primary database)
    pub async fn retrieve_dispatched_tx_id(
        &self,
        origin_domain: u32,
        origin_mailbox: &H256,
        nonce: u32,
    ) -> Result<Option<i64>> {
        self.primary
            .retrieve_dispatched_tx_id(origin_domain, origin_mailbox, nonce)
            .await
    }

    /// Retrieve delivery by sequence (from primary database)
    pub async fn retrieve_delivery_by_sequence(
        &self,
        destination_domain: u32,
        destination_mailbox: &H256,
        sequence: u32,
    ) -> Result<Option<Delivery>> {
        self.primary
            .retrieve_delivery_by_sequence(destination_domain, destination_mailbox, sequence)
            .await
    }

    /// Retrieve delivered message tx ID (from primary database)
    pub async fn retrieve_delivered_message_tx_id(
        &self,
        destination_domain: u32,
        destination_mailbox: &H256,
        sequence: u32,
    ) -> Result<Option<i64>> {
        self.primary
            .retrieve_delivered_message_tx_id(destination_domain, destination_mailbox, sequence)
            .await
    }

    /// Retrieve payment by sequence (from primary database)
    pub async fn retrieve_payment_by_sequence(
        &self,
        domain: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<InterchainGasPayment>> {
        self.primary
            .retrieve_payment_by_sequence(domain, interchain_gas_paymaster, sequence)
            .await
    }

    /// Retrieve payment tx ID (from primary database)
    pub async fn retrieve_payment_tx_id(
        &self,
        domain: u32,
        interchain_gas_paymaster: &H256,
        sequence: u32,
    ) -> Result<Option<i64>> {
        self.primary
            .retrieve_payment_tx_id(domain, interchain_gas_paymaster, sequence)
            .await
    }

    /// Retrieve block ID (from primary database)
    pub async fn retrieve_block_id(&self, tx_id: i64) -> Result<Option<i64>> {
        self.primary.retrieve_block_id(tx_id).await
    }

    /// Retrieve block number (from primary database)
    pub async fn retrieve_block_number(&self, block_id: i64) -> Result<Option<u64>> {
        self.primary.retrieve_block_number(block_id).await
    }

    /// Get transaction IDs (from primary database)
    pub async fn get_txn_ids<'a>(
        &self,
        hashes: impl Iterator<Item = &'a hyperlane_core::H512>,
    ) -> Result<std::collections::HashMap<hyperlane_core::H512, i64>> {
        self.primary.get_txn_ids(hashes).await
    }

    /// Get basic block info (from primary database)
    pub async fn get_block_basic<'a>(
        &self,
        hashes: impl Iterator<Item = &'a H256>,
    ) -> Result<Vec<super::BasicBlock>> {
        self.primary.get_block_basic(hashes).await
    }

    /// Create a block cursor (from primary database)
    pub async fn block_cursor(&self, domain: u32, from: u64) -> Result<super::BlockCursor> {
        self.primary.block_cursor(domain, from).await
    }
}
