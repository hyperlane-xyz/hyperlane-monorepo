#![allow(clippy::unwrap_used)]
use crate::{
    dispatcher::{PayloadDb, TransactionDb},
    transaction::Transaction,
    FullPayload, PayloadStatus, PayloadUuid, TransactionUuid,
};
use async_trait::async_trait;
use hyperlane_base::db::{DbError, DbResult, HyperlaneRocksDB};
use std::sync::{Arc, Mutex};

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum WriteKind {
    Transaction,
    PayloadStatus,
    Association,
}

pub(crate) struct FailWrites {
    pub(crate) inner: Arc<HyperlaneRocksDB>,
    failure: Mutex<Option<WriteKind>>,
}
impl FailWrites {
    pub(crate) fn new(inner: Arc<HyperlaneRocksDB>, kind: WriteKind) -> Self {
        Self {
            inner,
            failure: Mutex::new(Some(kind)),
        }
    }
    fn check(&self, kind: WriteKind) -> DbResult<()> {
        let mut failure = self.failure.lock().unwrap();
        if *failure == Some(kind) {
            *failure = None;
            return Err(DbError::Other(format!("injected {kind:?} write failure")));
        }
        Ok(())
    }
}
#[async_trait]
impl PayloadDb for FailWrites {
    async fn retrieve_payload_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<FullPayload>> {
        self.inner.retrieve_payload_by_uuid(payload_uuid).await
    }

    async fn store_payload_by_uuid(&self, payload: &FullPayload) -> DbResult<()> {
        self.inner.store_payload_by_uuid(payload).await
    }

    async fn retrieve_payload_index_by_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<u32>> {
        self.inner
            .retrieve_payload_index_by_uuid(payload_uuid)
            .await
    }

    async fn store_payload_index_by_uuid(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.inner
            .store_payload_index_by_uuid(index, payload_uuid)
            .await
    }

    async fn retrieve_payload_uuid_by_index(&self, index: u32) -> DbResult<Option<PayloadUuid>> {
        self.inner.retrieve_payload_uuid_by_index(index).await
    }

    async fn store_payload_uuid_by_index(
        &self,
        index: u32,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<()> {
        self.inner
            .store_payload_uuid_by_index(index, payload_uuid)
            .await
    }

    async fn store_highest_payload_index(&self, index: u32) -> DbResult<()> {
        self.inner.store_highest_payload_index(index).await
    }

    async fn retrieve_highest_payload_index(&self) -> DbResult<u32> {
        self.inner.retrieve_highest_payload_index().await
    }

    async fn retrieve_pending_payloads(&self) -> DbResult<Vec<FullPayload>> {
        self.inner.retrieve_pending_payloads().await
    }

    async fn pending_payload_index_checkpoint(&self) -> DbResult<Option<u64>> {
        self.inner.pending_payload_index_checkpoint().await
    }

    async fn pending_payload_index_requires_reconciliation(
        &self,
        checkpoint: u64,
    ) -> DbResult<bool> {
        self.inner
            .pending_payload_index_requires_reconciliation(checkpoint)
            .await
    }

    async fn mark_pending_payload_index_reconciled(&self) -> DbResult<()> {
        self.inner.mark_pending_payload_index_reconciled().await
    }

    async fn begin_pending_payload_index_reconciliation(&self) -> DbResult<()> {
        self.inner
            .begin_pending_payload_index_reconciliation()
            .await
    }

    async fn reconcile_pending_payloads(
        &self,
        first_index: u32,
        last_index: u32,
    ) -> DbResult<Vec<FullPayload>> {
        self.inner
            .reconcile_pending_payloads(first_index, last_index)
            .await
    }

    async fn store_new_payload_status(
        &self,
        payload_uuid: &PayloadUuid,
        new_status: PayloadStatus,
    ) -> DbResult<()> {
        self.check(WriteKind::PayloadStatus)?;
        self.inner
            .store_new_payload_status(payload_uuid, new_status)
            .await
    }

    async fn store_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
        tx_uuid: &TransactionUuid,
    ) -> DbResult<()> {
        self.check(WriteKind::Association)?;
        self.inner
            .store_tx_uuid_by_payload_uuid(payload_uuid, tx_uuid)
            .await
    }

    async fn retrieve_tx_uuid_by_payload_uuid(
        &self,
        payload_uuid: &PayloadUuid,
    ) -> DbResult<Option<TransactionUuid>> {
        self.inner
            .retrieve_tx_uuid_by_payload_uuid(payload_uuid)
            .await
    }
}

#[async_trait]
impl TransactionDb for FailWrites {
    async fn retrieve_transaction_by_uuid(
        &self,
        id: &TransactionUuid,
    ) -> DbResult<Option<Transaction>> {
        self.inner.retrieve_transaction_by_uuid(id).await
    }
    async fn store_transaction_by_uuid(&self, tx: &Transaction) -> DbResult<()> {
        self.check(WriteKind::Transaction)?;
        self.inner.store_transaction_by_uuid(tx).await
    }
    async fn retrieve_transaction_index_by_uuid(
        &self,
        id: &TransactionUuid,
    ) -> DbResult<Option<u32>> {
        self.inner.retrieve_transaction_index_by_uuid(id).await
    }
    async fn store_transaction_index_by_uuid(
        &self,
        index: u32,
        id: &TransactionUuid,
    ) -> DbResult<()> {
        self.inner.store_transaction_index_by_uuid(index, id).await
    }
    async fn retrieve_transaction_uuid_by_index(
        &self,
        index: u32,
    ) -> DbResult<Option<TransactionUuid>> {
        self.inner.retrieve_transaction_uuid_by_index(index).await
    }
    async fn store_transaction_uuid_by_index(
        &self,
        index: u32,
        id: &TransactionUuid,
    ) -> DbResult<()> {
        self.inner.store_transaction_uuid_by_index(index, id).await
    }
    async fn store_highest_transaction_index(&self, index: u32) -> DbResult<()> {
        self.inner.store_highest_transaction_index(index).await
    }
    async fn retrieve_highest_transaction_index(&self) -> DbResult<u32> {
        self.inner.retrieve_highest_transaction_index().await
    }
}
