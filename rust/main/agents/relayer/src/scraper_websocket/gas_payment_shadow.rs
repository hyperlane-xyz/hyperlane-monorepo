//! Bounded, read-only receipt checks for accepted scraper gas events.
//!
//! These observations never gate credits, cursors, or indexing authority. A match
//! means agreement at the time of the configured RPC reads, not a finality proof.

use super::{GasPaymentInput, ScraperSource};
use std::{collections::HashMap, sync::Arc, time::Duration};

use hyperlane_base::CoreMetrics;
use hyperlane_core::{
    BlockInfo, HyperlaneProvider, Indexed, Indexer, InterchainGasPayment, LogMeta, H256, H512,
};
use hyperlane_metric::rpc_operation::{with_rpc_operation, RpcOperation};
use parking_lot::Mutex;
use prometheus::IntCounterVec;
use tokio::sync::{mpsc, OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout, Instant};

// Bound events, including top-ups waiting on the same receipt and in-flight work.
const CAPACITY: usize = 256;
const RPC_TIMEOUT: Duration = Duration::from_secs(10);
const DIAGNOSTIC_INTERVAL: Duration = Duration::from_secs(60);
type ReceiptKey = (u32, H512);
type PaymentLogs = Vec<(Indexed<InterchainGasPayment>, LogMeta)>;
type Pending = HashMap<ReceiptKey, Vec<(GasPaymentInput, OwnedSemaphorePermit)>>;

#[derive(Clone)]
pub(super) struct ReceiptVerifier {
    pub(super) indexer: Arc<dyn Indexer<InterchainGasPayment>>,
    pub(super) provider: Arc<dyn HyperlaneProvider>,
    pub(super) paymaster: H256,
}

struct Receipt {
    logs: PaymentLogs,
    block: BlockInfo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Outcome {
    Accepted,
    Queued,
    Saturated,
    Verified,
    Mismatch,
    Ineligible,
    MissingLog,
    RpcError,
    Timeout,
    Cancelled,
}

impl Outcome {
    const fn label(self) -> &'static str {
        match self {
            Self::Accepted => "accepted",
            Self::Queued => "queued",
            Self::Saturated => "saturated",
            Self::Verified => "verified",
            Self::Mismatch => "mismatch",
            Self::Ineligible => "ineligible",
            Self::MissingLog => "missing_log",
            Self::RpcError => "rpc_error",
            Self::Timeout => "timeout",
            Self::Cancelled => "cancelled",
        }
    }
}

impl ReceiptVerifier {
    async fn fetch(&self, tx: H512) -> Result<Receipt, Outcome> {
        let tip = self
            .indexer
            .get_finalized_block_number()
            .await
            .map_err(|_| Outcome::RpcError)?;
        // The EVM indexer filters the configured IGP and decodes its complete
        // GasPayment event. It retries absent receipts; the outer deadline bounds
        // those retries along with tip and canonical-header reads.
        let logs = self
            .indexer
            .fetch_logs_by_tx_hash(tx)
            .await
            .map_err(|_| Outcome::RpcError)?;
        let (_, meta) = logs.first().ok_or(Outcome::MissingLog)?;
        if meta.block_number > u64::from(tip) {
            return Err(Outcome::Ineligible);
        }
        // A receipt can survive a reorg on a provider. Read the canonical block
        // independently by height; never accept the receipt's hash alone.
        let block = self
            .provider
            .get_block_by_height(meta.block_number)
            .await
            .map_err(|_| Outcome::RpcError)?;
        Ok(Receipt { logs, block })
    }

    fn compare(&self, receipt: &Receipt, input: &GasPaymentInput) -> Outcome {
        let Some((payment, meta)) = receipt.logs.iter().find(|(_, meta)| {
            meta.transaction_id == input.meta.transaction_id
                && meta.log_index == input.meta.log_index
        }) else {
            return Outcome::MissingLog;
        };
        // The proxy does not supply transaction_index; it is deliberately not
        // compared. Native EVM gas events have no sequence, unlike stream cursors.
        if payment.inner() == input.payment.inner()
            && meta.address == self.paymaster
            && input.meta.address == self.paymaster
            && meta.block_number == input.meta.block_number
            && meta.block_hash == input.meta.block_hash
            && receipt.block.number == meta.block_number
            && receipt.block.hash == meta.block_hash
        {
            Outcome::Verified
        } else {
            Outcome::Mismatch
        }
    }
}

struct Shared {
    pending: Mutex<Pending>,
    permits: Arc<Semaphore>,
    sources: HashMap<u32, (String, ReceiptVerifier)>,
    outcomes: IntCounterVec,
    diagnostics: Mutex<HashMap<(u32, Outcome), Instant>>,
}

impl Shared {
    fn diagnostic(
        &self,
        domain: u32,
        outcome: Outcome,
        input: &GasPaymentInput,
        receipt: Option<&Receipt>,
    ) {
        if !self.take_diagnostic(domain, outcome) {
            return;
        }
        let rpc_log = receipt.and_then(|receipt| {
            receipt.logs.iter().find(|(_, meta)| {
                meta.transaction_id == input.meta.transaction_id
                    && meta.log_index == input.meta.log_index
            })
        });
        let canonical_block = receipt.map(|receipt| &receipt.block);
        tracing::info!(
            domain,
            result = outcome.label(),
            ?input,
            ?rpc_log,
            ?canonical_block,
            "Sampled canonical gas receipt shadow comparison"
        );
    }

    // Domain comes only from configured sources and outcome from this fixed enum.
    // Identities belong in sampled diagnostics, never in metric labels or keys.
    fn take_diagnostic(&self, domain: u32, outcome: Outcome) -> bool {
        let mut diagnostics = self.diagnostics.lock();
        let now = Instant::now();
        if diagnostics
            .get(&(domain, outcome))
            .is_some_and(|last| now.duration_since(*last) < DIAGNOSTIC_INTERVAL)
        {
            return false;
        }
        diagnostics.insert((domain, outcome), now);
        true
    }

    fn record(&self, domain: u32, outcome: Outcome) {
        if let Some((chain, _)) = self.sources.get(&domain) {
            self.outcomes
                .with_label_values(&[chain.as_str(), outcome.label()])
                .inc();
        }
    }
}

pub(super) struct GasPaymentShadow {
    shared: Arc<Shared>,
    sender: mpsc::Sender<ReceiptKey>,
    pub(super) worker: Option<Worker>,
}

impl GasPaymentShadow {
    pub(super) fn new(
        sources: &HashMap<u32, ScraperSource>,
        metrics: &CoreMetrics,
    ) -> eyre::Result<Self> {
        let outcomes = metrics.new_int_counter(
            "relayer_scraper_gas_receipt_shadow_events",
            "Accepted scraper gas event coverage and read-only canonical receipt check outcomes",
            &["chain", "result"],
        )?;
        let sources = sources
            .iter()
            .filter_map(|(domain, source)| {
                source
                    .gas_receipt_verifier
                    .clone()
                    .map(|verifier| (*domain, (source.chain.clone(), verifier)))
            })
            .collect();
        let shared = Arc::new(Shared {
            pending: Mutex::new(HashMap::new()),
            permits: Arc::new(Semaphore::new(CAPACITY)),
            sources,
            outcomes,
            diagnostics: Mutex::new(HashMap::new()),
        });
        let (sender, receiver) = mpsc::channel(CAPACITY);
        Ok(Self {
            sender,
            shared: shared.clone(),
            worker: Some(Worker { shared, receiver }),
        })
    }

    // No await, task spawn, or RPC on the socket-consumer path. At most CAPACITY
    // accepted inputs are retained, even when all belong to one busy receipt.
    pub(super) fn enqueue(&self, domain: u32, input: GasPaymentInput) {
        if !self.shared.sources.contains_key(&domain) {
            return;
        }
        self.shared.record(domain, Outcome::Accepted);
        let Ok(permit) = self.shared.permits.clone().try_acquire_owned() else {
            self.shared.record(domain, Outcome::Saturated);
            return;
        };
        let key = (domain, input.meta.transaction_id);
        let mut pending = self.shared.pending.lock();
        if let Some(inputs) = pending.get_mut(&key) {
            inputs.push((input, permit));
        } else {
            // Lock spans insertion and scheduling, so the worker cannot observe
            // a receipt key before its events, or remove an in-flight top-up.
            if self.sender.try_send(key).is_err() {
                self.shared.record(domain, Outcome::Saturated);
                return;
            }
            pending.insert(key, vec![(input, permit)]);
        }
        self.shared.record(domain, Outcome::Queued);
    }
}

pub(super) struct Worker {
    shared: Arc<Shared>,
    receiver: mpsc::Receiver<ReceiptKey>,
}

impl Drop for Worker {
    fn drop(&mut self) {
        for ((domain, _), inputs) in self.shared.pending.lock().drain() {
            for _input in inputs {
                self.shared.record(domain, Outcome::Cancelled);
            }
        }
    }
}

impl Worker {
    pub(super) async fn run(mut self) {
        while let Some(key) = self.receiver.recv().await {
            let Some((_, verifier)) = self.shared.sources.get(&key.0) else {
                continue;
            };
            let result = with_rpc_operation(RpcOperation::GasPaymentShadow, async {
                timeout(RPC_TIMEOUT, verifier.fetch(key.1))
                    .await
                    .unwrap_or(Err(Outcome::Timeout))
            })
            .await;
            // Include top-ups received while the RPC was in flight. Receipt
            // deduplication ends here; later replay is checked again, never served
            // from a cross-reorg receipt cache.
            let inputs = self.shared.pending.lock().remove(&key).unwrap_or_default();
            for (input, _permit) in inputs {
                let outcome = match &result {
                    Ok(receipt) => verifier.compare(receipt, &input),
                    Err(outcome) => *outcome,
                };
                self.shared.record(key.0, outcome);
                self.shared
                    .diagnostic(key.0, outcome, &input, result.as_ref().ok());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scraper_websocket::{DurableGasPaymentCursor, ScraperWebSocketMonitor};
    use async_trait::async_trait;
    use hyperlane_core::{ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain, TxnInfo, U256};
    use std::{
        ops::RangeInclusive,
        sync::atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::Notify;

    #[derive(Debug)]
    struct FakeRpc {
        domain: HyperlaneDomain,
        logs: PaymentLogs,
        block: BlockInfo,
        tip: u32,
        blocked: bool,
        fail: bool,
        release: Notify,
        calls: AtomicUsize,
        active: AtomicUsize,
        headers: AtomicUsize,
    }

    struct Active<'a>(&'a AtomicUsize);
    impl Drop for Active<'_> {
        fn drop(&mut self) {
            self.0.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl FakeRpc {
        fn new(inputs: &[GasPaymentInput]) -> Self {
            Self {
                domain: HyperlaneDomain::new_test_domain("test"),
                logs: inputs.iter().map(|i| (i.payment, i.meta.clone())).collect(),
                block: BlockInfo {
                    number: 100,
                    hash: H256::from_low_u64_be(8),
                    timestamp: 0,
                },
                tip: 100,
                blocked: false,
                fail: false,
                release: Notify::new(),
                calls: AtomicUsize::new(0),
                active: AtomicUsize::new(0),
                headers: AtomicUsize::new(0),
            }
        }
    }

    #[async_trait]
    impl Indexer<InterchainGasPayment> for FakeRpc {
        async fn fetch_logs_in_range(&self, _: RangeInclusive<u32>) -> ChainResult<PaymentLogs> {
            panic!("shadow must not poll ranges")
        }
        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            assert_eq!(
                hyperlane_metric::rpc_operation::current_rpc_operation(),
                RpcOperation::GasPaymentShadow
            );
            Ok(self.tip)
        }
        async fn fetch_logs_by_tx_hash(&self, _: H512) -> ChainResult<PaymentLogs> {
            assert_eq!(
                hyperlane_metric::rpc_operation::current_rpc_operation(),
                RpcOperation::GasPaymentShadow
            );
            self.calls.fetch_add(1, Ordering::SeqCst);
            self.active.fetch_add(1, Ordering::SeqCst);
            let _active = Active(&self.active);
            if self.blocked {
                self.release.notified().await;
            }
            if self.fail {
                return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                    "fixture RPC failure",
                ));
            }
            Ok(self.logs.clone())
        }
    }

    impl HyperlaneChain for FakeRpc {
        fn domain(&self) -> &HyperlaneDomain {
            &self.domain
        }
        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            panic!("already own configured provider")
        }
    }

    #[async_trait]
    impl HyperlaneProvider for FakeRpc {
        async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
            assert_eq!(
                hyperlane_metric::rpc_operation::current_rpc_operation(),
                RpcOperation::GasPaymentShadow
            );
            assert_eq!(height, 100);
            self.headers.fetch_add(1, Ordering::SeqCst);
            Ok(self.block.clone())
        }
        async fn get_txn_by_hash(&self, _: &H512) -> ChainResult<TxnInfo> {
            panic!("unexpected RPC")
        }
        async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
            panic!("unexpected RPC")
        }
        async fn get_balance(&self, _: String) -> ChainResult<U256> {
            panic!("unexpected RPC")
        }
        async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
            panic!("unexpected RPC")
        }
    }

    fn input(log: u64) -> GasPaymentInput {
        GasPaymentInput {
            cursor: DurableGasPaymentCursor {
                fingerprint: None,
                legacy_max_stream_cursor: 0,
                stream_cursor: log + 1,
            },
            payment: Indexed::new(InterchainGasPayment {
                message_id: H256::from_low_u64_be(7),
                destination: 6,
                payment: U256::from(1000 + log),
                gas_amount: U256::from(50000),
            }),
            meta: LogMeta {
                address: H256::from_low_u64_be(3),
                block_number: 100,
                block_hash: H256::from_low_u64_be(8),
                transaction_id: H256::from_low_u64_be(9).into(),
                transaction_index: 0,
                log_index: U256::from(log),
            },
        }
    }

    fn setup(
        rpc: Arc<FakeRpc>,
    ) -> (
        GasPaymentShadow,
        tempfile::TempDir,
        ScraperSource,
        CoreMetrics,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let db = hyperlane_base::db::DB::from_path(dir.path()).unwrap();
        let db = hyperlane_base::db::HyperlaneRocksDB::new(&rpc.domain, db);
        let mut source = ScraperSource::new(
            "test".into(),
            5,
            H256::from_low_u64_be(1),
            H256::from_low_u64_be(3),
            H256::from_low_u64_be(2),
            db,
        );
        source.gas_receipt_verifier = Some(ReceiptVerifier {
            indexer: rpc.clone(),
            provider: rpc,
            paymaster: source.interchain_gas_paymaster,
        });
        let metrics = CoreMetrics::new("gas-shadow-test", 0, prometheus::Registry::new()).unwrap();
        let shadow =
            GasPaymentShadow::new(&HashMap::from([(5, source.clone())]), &metrics).unwrap();
        (shadow, dir, source, metrics)
    }

    fn count(shadow: &GasPaymentShadow, outcome: Outcome) -> u64 {
        shadow
            .shared
            .outcomes
            .with_label_values(&["test", outcome.label()])
            .get()
    }

    async fn wait_for(shadow: &GasPaymentShadow, outcome: Outcome, n: u64) {
        timeout(Duration::from_secs(1), async {
            while count(shadow, outcome) != n {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("expected terminal shadow outcome");
    }

    #[tokio::test]
    async fn binds_full_payment_paymaster_and_block_identity() {
        let canonical = input(0);
        let rpc = Arc::new(FakeRpc::new(&[canonical.clone()]));
        let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
        shadow.enqueue(5, canonical.clone());
        // Every independently meaningful field must bind to the receipt.
        for field in 0..9 {
            let mut changed = canonical.clone();
            let mut payment = *changed.payment.inner();
            match field {
                0 => payment.message_id = H256::zero(),
                1 => payment.destination += 1,
                2 => payment.payment += U256::one(),
                3 => payment.gas_amount += U256::one(),
                4 => changed.meta.address = H256::zero(),
                5 => changed.meta.block_hash = H256::zero(),
                6 => changed.meta.block_number += 1,
                7 => changed.meta.log_index += U256::one(),
                _ => changed.meta.transaction_id = H512::zero(),
            }
            changed.payment = Indexed::new(payment);
            shadow.enqueue(5, changed);
        }
        let worker = tokio::spawn(shadow.worker.take().unwrap().run());
        wait_for(&shadow, Outcome::Verified, 1).await;
        assert_eq!(count(&shadow, Outcome::Mismatch), 7);
        wait_for(&shadow, Outcome::MissingLog, 2).await;
        assert_eq!(rpc.calls.load(Ordering::SeqCst), 2);
        assert_eq!(rpc.headers.load(Ordering::SeqCst), 2);
        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test]
    async fn canonical_header_reorg_ineligible_missing_log_and_rpc_error() {
        for (case, outcome) in [
            (0, Outcome::Mismatch),
            (1, Outcome::Ineligible),
            (2, Outcome::MissingLog),
            (3, Outcome::RpcError),
        ] {
            let event = input(0);
            let mut rpc = FakeRpc::new(&[event.clone()]);
            match case {
                0 => rpc.block.hash = H256::zero(),
                1 => rpc.tip = 99,
                2 => rpc.logs.clear(),
                _ => rpc.fail = true,
            }
            let rpc = Arc::new(rpc);
            let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
            shadow.enqueue(5, event);
            let worker = tokio::spawn(shadow.worker.take().unwrap().run());
            wait_for(&shadow, outcome, 1).await;
            assert_eq!(count(&shadow, Outcome::Verified), 0);
            assert_eq!(rpc.headers.load(Ordering::SeqCst), usize::from(case == 0));
            worker.abort();
            let _ = worker.await;
        }
    }

    #[tokio::test]
    async fn coalesces_inflight_topups_and_rechecks_later_replay() {
        let mut rpc = FakeRpc::new(&[input(0), input(1)]);
        rpc.blocked = true;
        let rpc = Arc::new(rpc);
        let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
        shadow.enqueue(5, input(0));
        let worker = tokio::spawn(shadow.worker.take().unwrap().run());
        while rpc.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        shadow.enqueue(5, input(1));
        shadow.enqueue(5, input(0));
        rpc.release.notify_one();
        wait_for(&shadow, Outcome::Verified, 3).await;
        assert_eq!(rpc.calls.load(Ordering::SeqCst), 1);
        assert_eq!(shadow.shared.permits.available_permits(), CAPACITY);
        shadow.enqueue(5, input(0));
        rpc.release.notify_one();
        wait_for(&shadow, Outcome::Verified, 4).await;
        assert_eq!(rpc.calls.load(Ordering::SeqCst), 2);
        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test(start_paused = true)]
    async fn missing_receipt_retries_are_bounded_and_cancelled() {
        // Model the existing EVM indexer's missing-receipt retry future.
        let mut rpc = FakeRpc::new(&[]);
        rpc.blocked = true;
        let rpc = Arc::new(rpc);
        let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
        shadow.enqueue(5, input(0));
        let worker = tokio::spawn(shadow.worker.take().unwrap().run());
        while rpc.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        tokio::time::advance(RPC_TIMEOUT).await;
        wait_for(&shadow, Outcome::Timeout, 1).await;
        assert_eq!(rpc.active.load(Ordering::SeqCst), 0);
        assert_eq!(rpc.headers.load(Ordering::SeqCst), 0);
        assert_eq!(shadow.shared.permits.available_permits(), CAPACITY);
        worker.abort();
        let _ = worker.await;
    }

    #[tokio::test]
    async fn bounds_all_inputs_including_inflight_receipt_and_cancels_rpc() {
        let mut rpc = FakeRpc::new(&[input(0)]);
        rpc.blocked = true;
        let rpc = Arc::new(rpc);
        let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
        shadow.enqueue(5, input(0));
        let worker = tokio::spawn(shadow.worker.take().unwrap().run());
        while rpc.active.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        for _ in 0..CAPACITY {
            shadow.enqueue(5, input(0));
        }
        assert_eq!(count(&shadow, Outcome::Queued), CAPACITY as u64);
        assert_eq!(count(&shadow, Outcome::Saturated), 1);
        assert_eq!(shadow.shared.pending.lock().len(), 1);
        assert_eq!(rpc.calls.load(Ordering::SeqCst), 1);
        worker.abort();
        let _ = worker.await;
        assert_eq!(rpc.active.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    #[tracing_test::traced_test]
    async fn socket_credits_and_cursor_progress_while_rpc_is_slow_and_monitor_drop_cancels_worker()
    {
        use futures_util::{SinkExt, StreamExt};
        use serde_json::json;
        use tokio_tungstenite::tungstenite::Message;

        let mut rpc = FakeRpc::new(&[input(0), input(1)]);
        rpc.blocked = true;
        let rpc = Arc::new(rpc);
        let (shadow, _dir, source, metrics) = setup(rpc.clone());
        let shared = shadow.shared.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = url::Url::parse(&format!("ws://{}", listener.local_addr().unwrap())).unwrap();
        let mut monitor =
            ScraperWebSocketMonitor::new(url, vec![source.clone()], &metrics).unwrap();
        monitor.gas_payment_shadow = Some(shadow);
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            socket
                .send(Message::Text(
                    json!({"type": "ready", "streamCursorVersions": {"gas_payment": 3}})
                        .to_string(),
                ))
                .await
                .unwrap();
            let request = socket.next().await.unwrap().unwrap();
            let request: serde_json::Value =
                serde_json::from_str(request.to_text().unwrap()).unwrap();
            let mut streams = request["streams"].clone();
            for stream in streams.as_array_mut().unwrap() {
                for cursor in stream["cursors"].as_array_mut().unwrap() {
                    cursor.as_object_mut().unwrap().remove("allowReplay");
                }
            }
            socket
                .send(Message::Text(
                    json!({"type": "subscribed", "streams": streams}).to_string(),
                ))
                .await
                .unwrap();
            socket.send(Message::Text(json!({"type": "caught_up", "domain": 5, "eventType": "gas_payment", "address": crate::scraper_websocket::scraper_address(H256::from_low_u64_be(3)), "streamCursor": "0", "legacyMaxStreamCursor": "0"}).to_string())).await.unwrap();
            for log in 0..2 {
                let event = input(log);
                socket.send(Message::Text(json!({
                    "type": "event", "eventType": "gas_payment", "domain": 5,
                    "rowId": (log + 1).to_string(), "streamCursor": (log + 1).to_string(),
                    "legacyMaxStreamCursor": "0", "sequence": null,
                    "data": {
                        "domain": 5, "origin": 5, "destination": 6,
                        "time_created": "2026-09-09T00:00:00Z",
                        "interchain_gas_paymaster": format!("{:#x}", event.meta.address),
                        "msg_id": format!("{:#x}", event.payment.inner().message_id),
                        "payment": event.payment.inner().payment.to_string(), "gas_amount": "50000",
                        "log_index": log.to_string(), "id": (log + 1).to_string(), "sequence": null,
                        "origin_block_height": "100", "origin_block_hash": format!("{:#x}", event.meta.block_hash),
                        "origin_tx_hash": format!("{:#x}", H256::from_low_u64_be(9)), "tx_id": "42"
                    }
                }).to_string())).await.unwrap();
            }
            std::future::pending::<()>().await;
        });
        {
            let run = monitor.run();
            tokio::pin!(run);
            tokio::select! {
                _ = &mut run => panic!("monitor unexpectedly stopped"),
                result = timeout(Duration::from_secs(3), async {
                    loop {
                        if source.gas_payment_cursor().unwrap().is_some_and(|cursor| cursor.stream_cursor == 2)
                            && rpc.active.load(Ordering::SeqCst) == 1 {
                            break;
                        }
                        tokio::task::yield_now().await;
                    }
                }) => result.expect("socket cursor progresses without waiting on RPC"),
            }
            assert_eq!(
                shared
                    .outcomes
                    .with_label_values(&["test", "accepted"])
                    .get(),
                2
            );
            assert_eq!(
                shared
                    .outcomes
                    .with_label_values(&["test", "verified"])
                    .get(),
                0
            );
            let total = source
                .cursor_db
                .retrieve_gas_payment_by_gas_payment_key((*input(0).payment.inner()).into())
                .unwrap()
                .unwrap();
            assert_eq!(total.payment, U256::from(2001));
        }
        assert_eq!(rpc.active.load(Ordering::SeqCst), 0);
        assert_eq!(shared.permits.available_permits(), CAPACITY);
        assert_eq!(
            shared
                .outcomes
                .with_label_values(&["test", "cancelled"])
                .get(),
            2
        );
        server.abort();
        let _ = server.await;
    }

    #[tokio::test(start_paused = true)]
    async fn diagnostics_sample_each_outcome_without_identity_keys() {
        let (shadow, _dir, _source, _metrics) = setup(Arc::new(FakeRpc::new(&[])));
        assert!(shadow.shared.take_diagnostic(5, Outcome::Verified));
        assert!(!shadow.shared.take_diagnostic(5, Outcome::Verified));
        assert!(shadow.shared.take_diagnostic(5, Outcome::Mismatch));
        assert!(!shadow.shared.take_diagnostic(5, Outcome::Mismatch));
        tokio::time::advance(DIAGNOSTIC_INTERVAL).await;
        assert!(shadow.shared.take_diagnostic(5, Outcome::Verified));
        assert_eq!(shadow.shared.diagnostics.lock().len(), 2);
    }

    #[test]
    fn distinct_receipt_queue_and_cancellation_are_bounded() {
        let rpc = Arc::new(FakeRpc::new(&[input(0)]));
        let (mut shadow, _dir, _source, _metrics) = setup(rpc.clone());
        for tx in 0..=CAPACITY {
            let mut event = input(0);
            event.meta.transaction_id = H256::from_low_u64_be(tx as u64).into();
            shadow.enqueue(5, event);
        }
        assert_eq!(shadow.shared.pending.lock().len(), CAPACITY);
        assert_eq!(count(&shadow, Outcome::Queued), CAPACITY as u64);
        assert_eq!(count(&shadow, Outcome::Saturated), 1);
        assert_eq!(rpc.calls.load(Ordering::SeqCst), 0);
        drop(shadow.worker.take());
        assert_eq!(shadow.shared.permits.available_permits(), CAPACITY);
        assert_eq!(count(&shadow, Outcome::Cancelled), CAPACITY as u64);
    }

    #[test]
    fn outcomes_are_fixed_and_unselected_sources_create_no_series() {
        let (_shadow, _dir, source, _metrics) = setup(Arc::new(FakeRpc::new(&[])));
        let mut source = source;
        source.gas_receipt_verifier = None;
        // Use a fresh registry because each monitor owns one counter family.
        let metrics = CoreMetrics::new("unsupported", 0, prometheus::Registry::new()).unwrap();
        let shadow = GasPaymentShadow::new(&HashMap::from([(5, source)]), &metrics).unwrap();
        shadow.enqueue(5, input(0));
        assert!(shadow.shared.pending.lock().is_empty());
        assert!(shadow.shared.sources.is_empty());
        use prometheus::core::Collector;
        assert!(shadow
            .shared
            .outcomes
            .collect()
            .iter()
            .all(|family| family.get_metric().is_empty()));
        let labels = [
            Outcome::Accepted,
            Outcome::Queued,
            Outcome::Saturated,
            Outcome::Verified,
            Outcome::Mismatch,
            Outcome::Ineligible,
            Outcome::MissingLog,
            Outcome::RpcError,
            Outcome::Timeout,
            Outcome::Cancelled,
        ]
        .map(Outcome::label);
        assert_eq!(
            labels
                .into_iter()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            10
        );
        assert_eq!(
            RpcOperation::GasPaymentShadow.as_str(),
            "gas_payment_shadow"
        );
    }
}
