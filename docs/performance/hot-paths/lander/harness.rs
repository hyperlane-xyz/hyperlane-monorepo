//! Temporary unit-test module, compiled only by run.py. Baseline and proposed
//! production code are git-show snapshots, not benchmark reimplementations.
#![allow(dead_code, unused_imports)]

use std::{
    fmt::Debug,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use ethers::{
    abi::{AbiParser, Function},
    providers::{HttpClientError, JsonRpcClient, Provider},
    types::{Block, TransactionRequest, H160, H256 as EthersH256},
};
use futures_util::future::join_all;
use hyperlane_core::{identifiers::UniqueIdentifier, ChainResult, KnownHyperlaneDomain, H256};
use hyperlane_ethereum::{EthereumProvider, EvmProviderForLander, TransactionOverrides};
use hyperlane_sealevel::{
    PriorityFeeOracle, SealevelKeypair, SealevelProcessPayload, SealevelProviderForLander,
    SealevelTransactionFormat, SealevelTxCostEstimate, SealevelTxType, TransactionSubmitter,
};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    account::Account,
    instruction::Instruction,
    message::Message,
    pubkey::Pubkey,
    signature::{Signature, Signer},
    transaction::Transaction as SvmTransaction,
};

use crate::{
    adapter::{AdaptsChain, EthereumTxPrecursor},
    payload::{FullPayload, PayloadDetails},
    transaction::Transaction,
};

mod baseline_svm {
    include!(concat!(env!("LANDER_BENCH_SNAPSHOT"), "/baseline_svm.rs"));
}
mod proposed_svm {
    include!(concat!(env!("LANDER_BENCH_SNAPSHOT"), "/proposed_svm.rs"));
}
mod baseline_gas {
    include!(concat!(env!("LANDER_BENCH_SNAPSHOT"), "/baseline_gas.rs"));
}
mod proposed_gas {
    include!(concat!(env!("LANDER_BENCH_SNAPSHOT"), "/proposed_gas.rs"));
}
mod baseline_payload {
    include!(concat!(
        env!("LANDER_BENCH_SNAPSHOT"),
        "/baseline_payload.rs"
    ));
}
mod proposed_payload {
    include!(concat!(
        env!("LANDER_BENCH_SNAPSHOT"),
        "/proposed_payload.rs"
    ));
}

#[derive(Clone, Copy, Debug)]
enum Scenario {
    Uniform,
    Straggler,
    NoIo,
}

#[derive(Clone, Copy)]
enum Kind {
    SvmEstimate,
    SvmBuild,
    SvmSend,
    EvmGas,
    EvmBlock,
    EvmCall,
}

struct Activity {
    active: AtomicUsize,
    peak: AtomicUsize,
    requests: AtomicUsize,
    started: Mutex<Instant>,
    completions_ms: Mutex<Vec<f64>>,
    scenario: Scenario,
}

impl Activity {
    fn new(scenario: Scenario) -> Self {
        Self {
            active: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            requests: AtomicUsize::new(0),
            started: Mutex::new(Instant::now()),
            completions_ms: Mutex::new(Vec::new()),
            scenario,
        }
    }

    fn reset(&self, started: Instant) {
        assert_eq!(self.active.load(Ordering::Relaxed), 0);
        self.peak.store(0, Ordering::Relaxed);
        self.requests.store(0, Ordering::Relaxed);
        *self.started.lock().expect("batch start") = started;
        self.completions_ms
            .lock()
            .expect("completion samples")
            .clear();
    }

    fn begin(&self, kind: Kind) -> RequestGuard<'_> {
        self.requests.fetch_add(1, Ordering::Relaxed);
        let active = self
            .active
            .fetch_add(1, Ordering::Relaxed)
            .saturating_add(1);
        self.peak.fetch_max(active, Ordering::Relaxed);
        RequestGuard {
            activity: self,
            kind,
        }
    }

    async fn wait(&self, kind: Kind, operation: usize) {
        // Only cost/account reads carry injected I/O. Building and sending SVM
        // transactions succeed immediately, isolating estimation lock contention.
        if matches!(kind, Kind::SvmBuild | Kind::SvmSend) {
            return;
        }
        let delay = match self.scenario {
            Scenario::NoIo => return,
            Scenario::Uniform => 2,
            Scenario::Straggler if operation == 0 && !matches!(kind, Kind::EvmBlock) => 20,
            Scenario::Straggler => 2,
        };
        tokio::time::sleep(Duration::from_millis(delay)).await;
    }
}

struct RequestGuard<'a> {
    activity: &'a Activity,
    kind: Kind,
}

impl Drop for RequestGuard<'_> {
    fn drop(&mut self) {
        self.activity.active.fetch_sub(1, Ordering::Relaxed);
        if matches!(self.kind, Kind::EvmCall) {
            let elapsed = self
                .activity
                .started
                .lock()
                .expect("batch start")
                .elapsed()
                .as_secs_f64()
                * 1000.0;
            self.activity
                .completions_ms
                .lock()
                .expect("completion samples")
                .push(elapsed);
        }
    }
}

fn operation_index(data: &[u8]) -> usize {
    let mut bytes = [0; 8];
    if data.len() >= bytes.len() {
        bytes.copy_from_slice(&data[..8]);
    }
    usize::try_from(u64::from_le_bytes(bytes)).expect("operation fits usize")
}

struct SvmProvider(Arc<Activity>);

#[async_trait]
impl SealevelProviderForLander for SvmProvider {
    async fn get_estimated_costs_for_instruction(
        &self,
        instruction: Instruction,
        _: &SealevelKeypair,
        _: Arc<dyn TransactionSubmitter>,
        _: Arc<dyn PriorityFeeOracle>,
        _: &SealevelTransactionFormat,
    ) -> ChainResult<SealevelTxCostEstimate> {
        let _request = self.0.begin(Kind::SvmEstimate);
        self.0
            .wait(Kind::SvmEstimate, operation_index(&instruction.data))
            .await;
        Ok(SealevelTxCostEstimate {
            compute_units: 42,
            compute_unit_price_micro_lamports: 0,
        })
    }

    async fn create_transaction_for_instruction<'a>(
        &self,
        _: u32,
        _: u64,
        instruction: Instruction,
        payer: &'a SealevelKeypair,
        _: Arc<dyn TransactionSubmitter>,
        _: bool,
        _: &SealevelTransactionFormat,
        _: &'a [&'a SealevelKeypair],
    ) -> ChainResult<SealevelTxType> {
        let _request = self.0.begin(Kind::SvmBuild);
        Ok(SealevelTxType::Legacy(SvmTransaction::new_unsigned(
            Message::new(&[instruction], Some(&payer.pubkey())),
        )))
    }

    async fn wait_for_transaction_confirmation(&self, _: &SealevelTxType) -> ChainResult<()> {
        Ok(())
    }
    async fn confirm_transaction(&self, _: Signature, _: CommitmentConfig) -> ChainResult<bool> {
        Ok(true)
    }
    async fn get_account(&self, _: Pubkey) -> ChainResult<Option<Account>> {
        Ok(None)
    }
}

struct Submitter(Arc<Activity>);

#[async_trait]
impl TransactionSubmitter for Submitter {
    fn get_priority_fee_instruction(&self, price: u64, _: u64, _: &Pubkey) -> Instruction {
        solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_price(price)
    }
    async fn send_transaction(&self, _: &SealevelTxType, _: bool) -> ChainResult<Signature> {
        let _request = self.0.begin(Kind::SvmSend);
        Ok(Signature::default())
    }
    async fn wait_for_transaction_confirmation(&self, _: &SealevelTxType) -> ChainResult<()> {
        Ok(())
    }
    async fn confirm_transaction(&self, _: Signature, _: CommitmentConfig) -> ChainResult<bool> {
        Ok(true)
    }
}

#[derive(Clone)]
struct RpcClient {
    activity: Arc<Activity>,
    block: Value,
}

impl Debug for RpcClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("ControlledRpcClient")
    }
}

fn rpc_operation(params: &Value) -> usize {
    let data = params[0]
        .get("data")
        .or_else(|| params[0].get("input"))
        .and_then(Value::as_str)
        .unwrap_or("0x");
    let mut bytes = Vec::new();
    for pair in data.trim_start_matches("0x").as_bytes().chunks_exact(2) {
        let word = std::str::from_utf8(pair).expect("hex input");
        bytes.push(u8::from_str_radix(word, 16).expect("hex byte"));
    }
    operation_index(&bytes)
}

#[async_trait]
impl JsonRpcClient for RpcClient {
    type Error = HttpClientError;
    async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
    where
        T: Debug + Serialize + Send + Sync,
        R: DeserializeOwned,
    {
        let params = serde_json::to_value(params).expect("request params");
        let (kind, response) = match method {
            "eth_estimateGas" => (Kind::EvmGas, json!("0x5208")),
            "eth_getBlockByNumber" => (Kind::EvmBlock, self.block.clone()),
            "eth_call" => (Kind::EvmCall, json!(format!("0x{}", "00".repeat(32)))),
            _ => panic!("unexpected RPC {method}"),
        };
        let _request = self.activity.begin(kind);
        self.activity.wait(kind, rpc_operation(&params)).await;
        serde_json::from_value(response.clone()).map_err(|err| HttpClientError::SerdeJson {
            err,
            text: response.to_string(),
        })
    }
}

fn evm_provider(activity: Arc<Activity>) -> Arc<dyn EvmProviderForLander> {
    let block = serde_json::to_value(Block::<EthersH256> {
        gas_limit: 30_000_000.into(),
        base_fee_per_gas: Some(10.into()),
        ..Default::default()
    })
    .expect("block response");
    Arc::new(EthereumProvider::new(
        Arc::new(Provider::new(RpcClient { activity, block })),
        KnownHyperlaneDomain::Ethereum.into(),
    ))
}

fn call(operation: usize, returns_bool: bool) -> EthereumTxPrecursor {
    let function = AbiParser::default()
        .parse_function(if returns_bool {
            "function delivered(bytes32) view returns (bool)"
        } else {
            "function operation()"
        })
        .expect("fixture ABI");
    EthereumTxPrecursor::new(
        TransactionRequest::new()
            .to(H160::zero())
            .data(
                u64::try_from(operation)
                    .expect("operation")
                    .to_le_bytes()
                    .to_vec(),
            )
            .into(),
        function,
    )
}

fn svm_transactions(width: usize) -> Vec<Transaction> {
    (0..width)
        .map(|operation| {
            let instruction = Instruction::new_with_bytes(
                Pubkey::default(),
                &u64::try_from(operation).expect("operation").to_le_bytes(),
                vec![],
            );
            let payload = FullPayload {
                data: serde_json::to_vec(&SealevelProcessPayload {
                    instruction,
                    alt_addresses: SealevelTransactionFormat::Legacy,
                })
                .expect("SVM payload"),
                ..Default::default()
            };
            let precursor =
                crate::adapter::chains::sealevel::SealevelTxPrecursor::from_payload(&payload);
            crate::adapter::chains::sealevel::transaction::TransactionFactory::build(
                precursor, &payload,
            )
        })
        .collect()
}

fn payload_transaction(width: usize) -> Transaction {
    let details = (0..width)
        .map(|operation| {
            let precursor = call(operation, true);
            PayloadDetails::new(
                UniqueIdentifier::new(uuid::Uuid::from_u128(
                    u128::try_from(operation)
                        .expect("operation")
                        .saturating_add(1),
                )),
                "benchmark".to_owned(),
                Some(
                    serde_json::to_vec(&(precursor.tx, precursor.function))
                        .expect("success criteria"),
                ),
            )
        })
        .collect();
    Transaction::new(call(0, false), details)
}

#[derive(Serialize)]
struct Sample {
    elapsed_ms: f64,
    operation_latency_ms: Vec<f64>,
    peak_inflight: usize,
    provider_requests: usize,
    freshness_entries: Option<usize>,
}

enum SvmAdapter {
    Baseline(baseline_svm::SealevelAdapter),
    Proposed(proposed_svm::SealevelAdapter),
}

impl SvmAdapter {
    fn adapter(&self) -> &dyn AdaptsChain {
        match self {
            Self::Baseline(adapter) => adapter,
            Self::Proposed(adapter) => adapter,
        }
    }

    async fn freshness_entries(&self) -> usize {
        match self {
            Self::Baseline(adapter) => adapter.benchmark_freshness_entries().await,
            Self::Proposed(adapter) => adapter.benchmark_freshness_entries().await,
        }
    }
}

async fn measure(
    case: &str,
    version: &str,
    scenario: Scenario,
    batches: usize,
    width: usize,
) -> Vec<Sample> {
    let activity = Arc::new(Activity::new(scenario));
    let svm_provider: Arc<dyn SealevelProviderForLander> = Arc::new(SvmProvider(activity.clone()));
    let submitter: Arc<dyn TransactionSubmitter> = Arc::new(Submitter(activity.clone()));
    let svm_storage = if version == "baseline" {
        SvmAdapter::Baseline(baseline_svm::SealevelAdapter::benchmark_new(
            svm_provider,
            submitter,
        ))
    } else {
        SvmAdapter::Proposed(proposed_svm::SealevelAdapter::benchmark_new(
            svm_provider,
            submitter,
        ))
    };
    let svm = svm_storage.adapter();
    let provider = evm_provider(activity.clone());
    let baseline_payload = baseline_payload::PayloadAdapter {
        provider: provider.clone(),
        signer: H160::zero(),
    };
    let proposed_payload = proposed_payload::PayloadAdapter {
        provider: provider.clone(),
        signer: H160::zero(),
    };
    let warmups = if matches!(scenario, Scenario::NoIo) {
        50
    } else {
        3
    };
    let mut samples = Vec::with_capacity(batches);
    for batch in 0..batches.saturating_add(warmups) {
        // Fixture allocation/parsing stays outside the measured interval.
        let mut svm_txs = if case.starts_with("svm_") {
            svm_transactions(width)
        } else {
            vec![]
        };
        let mut gas_calls: Vec<_> = if case == "evm_gas" {
            (0..width).map(|index| call(index, false)).collect()
        } else {
            vec![]
        };
        let payload_tx = if case == "evm_payload" {
            Some(payload_transaction(width))
        } else {
            None
        };
        let started = Instant::now();
        activity.reset(started);
        let latencies = match case {
            "svm_submit" | "svm_prepare_submit" => {
                join_all(svm_txs.iter_mut().map(|tx| async move {
                    if case == "svm_prepare_submit" {
                        svm.estimate_tx(tx).await.expect("prepare fresh estimate");
                    }
                    svm.submit(tx).await.expect("submit");
                    started.elapsed().as_secs_f64() * 1000.0
                }))
                .await
            }
            "evm_gas" => {
                join_all(gas_calls.iter_mut().map(|precursor| {
                    let provider = provider.clone();
                    async move {
                        let result = if version == "baseline" {
                            baseline_gas::estimate_gas_limit(
                                provider,
                                precursor,
                                &TransactionOverrides::default(),
                                &KnownHyperlaneDomain::Ethereum.into(),
                                true,
                            )
                            .await
                        } else {
                            proposed_gas::estimate_gas_limit(
                                provider,
                                precursor,
                                &TransactionOverrides::default(),
                                &KnownHyperlaneDomain::Ethereum.into(),
                                true,
                            )
                            .await
                        };
                        result.expect("gas estimate");
                        assert_eq!(precursor.tx.gas().expect("estimated gas").as_u64(), 96_000);
                        started.elapsed().as_secs_f64() * 1000.0
                    }
                }))
                .await
            }
            "evm_payload" => {
                let tx = payload_tx.as_ref().expect("payload transaction");
                let reverted = if version == "baseline" {
                    baseline_payload.benchmark_check(tx).await
                } else {
                    proposed_payload.benchmark_check(tx).await
                }
                .expect("payload checks");
                assert_eq!(reverted, tx.payload_details);
                activity
                    .completions_ms
                    .lock()
                    .expect("criterion completions")
                    .clone()
            }
            _ => panic!("unknown case {case}"),
        };
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        assert_eq!(activity.active.load(Ordering::Relaxed), 0);
        assert_eq!(latencies.len(), width);
        let expected_requests = width.saturating_mul(match case {
            "svm_submit" | "svm_prepare_submit" => 3,
            "evm_gas" => 2,
            _ => 1,
        });
        assert_eq!(activity.requests.load(Ordering::Relaxed), expected_requests);
        if batch >= warmups {
            let freshness_entries = if case.starts_with("svm_") {
                Some(svm_storage.freshness_entries().await)
            } else {
                None
            };
            samples.push(Sample {
                elapsed_ms,
                operation_latency_ms: latencies,
                peak_inflight: activity.peak.load(Ordering::Relaxed),
                provider_requests: expected_requests,
                freshness_entries,
            });
        }
    }
    samples
}

#[test]
#[ignore = "opt-in benchmark; run docs/performance/hot-paths/lander/run.py"]
fn measure_actual_hot_paths() {
    let case = std::env::var("BENCH_CASE").expect("BENCH_CASE");
    let version = std::env::var("BENCH_VERSION").expect("BENCH_VERSION");
    assert!(matches!(version.as_str(), "baseline" | "proposed"));
    let scenario_name = std::env::var("BENCH_SCENARIO").expect("BENCH_SCENARIO");
    let scenario = match scenario_name.as_str() {
        "uniform" => Scenario::Uniform,
        "straggler" => Scenario::Straggler,
        "no_io" => Scenario::NoIo,
        _ => panic!("unknown scenario"),
    };
    let batches = std::env::var("BENCH_BATCHES")
        .expect("batches")
        .parse()
        .expect("batches number");
    let width = std::env::var("BENCH_WIDTH")
        .expect("width")
        .parse()
        .expect("width number");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("runtime");
    let samples = runtime.block_on(measure(&case, &version, scenario, batches, width));
    println!(
        "LANDER_BENCH_JSON={}",
        serde_json::to_string(
            &json!({ "case": case, "version": version, "scenario": scenario_name,
        "width": width, "samples": samples })
        )
        .expect("benchmark JSON")
    );
}
