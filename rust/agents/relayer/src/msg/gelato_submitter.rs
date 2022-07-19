use abacus_base::CoreMetrics;
use abacus_core::{CommittedMessage, MessageStatus};
use abacus_core::{Encode, Signers};
use abacus_ethereum::validator_manager::INBOXVALIDATORMANAGER_ABI as ivm_abi;
use ethers::abi::Token;
use ethers::types::{Address, U256};
use ethers_contract::BaseContract;
use ethers_signers::Signer;
use eyre::{bail, Result};
use futures::stream::FuturesUnordered;
use gelato::chains::Chain;
use gelato::fwd_req_call::{
    ForwardRequestArgs, ForwardRequestCall, PaymentType, NATIVE_FEE_TOKEN_ADDRESS,
};
use gelato::task_status_call::{TaskStatus, TaskStatusCall, TaskStatusCallArgs};
use prometheus::IntCounter;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tokio_stream::StreamExt;
use tracing::{debug, info, warn};
use tracing::{info_span, instrument::Instrumented, Instrument};

use super::gas_oracle::GasPaymentOracle;
use super::message_status::ProcessedStatusOracle;
use super::SubmitMessageArgs;

const DEFAULT_MAX_FEE: u32 = 1_000_000_000;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    pub(crate) messages: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// The Abacus domain of the source chain for messages to be submitted via this GelatoSubmitter.
    pub(crate) outbox_domain: u32,
    /// The Abacus domain of the destination chain for messages submitted with this GelatoSubmitter.
    pub(crate) inbox_domain: u32,
    /// The on-chain address of the inbox contract on the destination chain.
    pub(crate) inbox_address: Address,
    /// Address of the inbox validator manager contract that will be specified
    /// to Gelato in ForwardRequest submissions to process new messages.
    pub(crate) ivm_address: Address,
    /// The address of the 'sponsor' contract providing payment to Gelato.
    pub(crate) sponsor_address: Address,
    /// Interface providing access to information about gas payments. Used to decide when it is
    /// appropriate to forward a message.
    pub(crate) gas_oracle: GasPaymentOracle,
    /// Interface to learning the status of a message according to some authority, like a view
    /// call against the inbox contract.
    pub(crate) status_oracle: ProcessedStatusOracle,
    /// Signer to use for EIP-712 meta-transaction signatures.
    pub(crate) signer: Signers,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    /// Intended to be shared by reqwest library.
    pub(crate) http: reqwest::Client,
    /// Prometheus metrics.
    pub(crate) metrics: GelatoSubmitterMetrics,
}

impl GelatoSubmitter {
    pub fn spawn(mut self) -> Instrumented<JoinHandle<Result<()>>> {
        tokio::spawn(async move { self.work_loop().await })
            .instrument(info_span!("Gelato submitter work loop"))
    }

    async fn work_loop(&mut self) -> Result<()> {
        let mut in_flight_ops = FuturesUnordered::new();
        loop {
            let msg = tokio::select! {
                Some(msg) = self.messages.recv() => msg,
                _ = in_flight_ops.next() => continue,
                else => bail!("Unexpected select condition"),
            };
            let op = ForwardRequestOp {
                args: self.make_forward_request_args(&msg)?,
                opts: ForwardRequestOptions::default(),
                signer: self.signer.clone(),
                gas_oracle: self.gas_oracle.clone(),
                status_oracle: self.status_oracle.clone(),
                msg: msg.committed_message,
                http: self.http.clone(),
                metrics: ForwardRequestMetrics {
                    messages_processed_count: self.metrics.messages_processed_count.clone(),
                },
            };
            in_flight_ops.push(async move {
                op.run().await.unwrap();
            });
        }
    }

    fn make_forward_request_args(&self, msg: &SubmitMessageArgs) -> Result<ForwardRequestArgs> {
        let ivm_base_contract = BaseContract::from(ivm_abi.clone());
        let call_data = ivm_base_contract.encode(
            "process",
            [
                Token::Address(self.inbox_address),
                Token::FixedBytes(msg.checkpoint.checkpoint.root.to_fixed_bytes().into()),
                Token::Uint(msg.checkpoint.checkpoint.index.into()),
                Token::Array(
                    msg.checkpoint
                        .signatures
                        .iter()
                        .map(|s| Token::Bytes(s.to_vec()))
                        .collect(),
                ),
                Token::Bytes(msg.committed_message.message.to_vec()),
                Token::FixedArray(
                    (0..32)
                        .map(|i| Token::FixedBytes(msg.proof.path[i].to_vec()))
                        .collect(),
                ),
                Token::Uint(msg.leaf_index.into()),
            ],
        )?;
        Ok(ForwardRequestArgs {
            chain_id: abacus_domain_to_gelato_chain(self.inbox_domain)?,
            target: self.ivm_address,
            data: call_data,
            fee_token: NATIVE_FEE_TOKEN_ADDRESS,
            payment_type: PaymentType::AsyncGasTank,
            max_fee: DEFAULT_MAX_FEE.into(), // Maximum fee that sponsor is willing to pay.
            gas: DEFAULT_MAX_FEE.into(),     // Gas limit.
            sponsor_chain_id: abacus_domain_to_gelato_chain(self.outbox_domain)?,
            nonce: U256::zero(),
            enforce_sponsor_nonce: false,
            enforce_sponsor_nonce_ordering: false,
            sponsor: self.sponsor_address,
        })
    }
}

// TODO(webbhorn): Is there already somewhere actually canonical/authoritative to use instead
// of duplicating this here?  Perhaps we can expand `macro_rules! domain_and_chain`?
// Otherwise, try to keep this translation logic out of the gelato crate at least so that we
// don't start introducing any Abacus concepts (like domain) into it.
fn abacus_domain_to_gelato_chain(domain: u32) -> Result<Chain> {
    Ok(match domain {
        6648936 => Chain::Mainnet,
        1634872690 => Chain::Rinkeby,
        3000 => Chain::Kovan,
        1886350457 => Chain::Polygon,
        80001 => Chain::PolygonMumbai,
        1635148152 => Chain::Avalanche,
        43113 => Chain::AvalancheFuji,
        6386274 => Chain::Arbitrum,
        28528 => Chain::Optimism,
        1869622635 => Chain::OptimismKovan,
        6452067 => Chain::BinanceSmartChain,
        1651715444 => Chain::BinanceSmartChainTestnet,
        // TODO(webbhorn): Uncomment once Gelato supports Celo.
        // 1667591279 => Chain::Celo,
        // TODO(webbhorn): Need Alfajores support too.
        // TODO(webbhorn): What is the difference between ArbitrumRinkeby and ArbitrumTestnet?
        // 421611 => Chain::ArbitrumTestnet,
        // TODO(webbhorn): Abacus hasn't assigned a domain id for Alfajores yet.
        // 5 => Chain::Goerli,
        _ => bail!("Unknown domain {}", domain),
    })
}

#[derive(Debug, Clone)]
struct ForwardRequestOp {
    args: ForwardRequestArgs,
    opts: ForwardRequestOptions,
    signer: Signers,
    gas_oracle: GasPaymentOracle,
    status_oracle: ProcessedStatusOracle,
    msg: CommittedMessage,
    http: reqwest::Client,
    metrics: ForwardRequestMetrics,
}

impl ForwardRequestOp {
    async fn run(&self) -> Result<ForwardRequestOpResult> {
        info!(?self.msg);
        let sig = self.signer.sign_typed_data(&self.args).await?;
        loop {
            if self.already_processed().await? {
                debug!(%self.msg.leaf_index, "Message already processed");
                return Ok(ForwardRequestOpResult {});
            }
            // TODO(webbhorn): If message gets submitted by another relayer at a price below
            // opts.min, while we are waiting here, we will never terminate. Add a timeout.
            self.wait_for_gas().await?;

            let fwd_req_call = ForwardRequestCall {
                http: self.http.clone(),
                args: &self.args,
                sig,
            };
            let fwd_req_result = fwd_req_call.run().await?;
            let start = Instant::now();
            loop {
                let poll_call_args = TaskStatusCallArgs {
                    task_id: fwd_req_result.task_id.clone(),
                };
                let poll_call = TaskStatusCall {
                    http: self.http.clone(),
                    args: poll_call_args,
                };
                let result = poll_call.run().await?;
                if result.data.len() != 1 {
                    bail!("Unexpected TaskStatus result: {:?}", result);
                }
                if result.data[0].task_state == TaskStatus::ExecSuccess {
                    self.metrics.messages_processed_count.inc();
                    self.status_oracle.mark_processed(&self.msg)?;
                    return Ok(ForwardRequestOpResult {});
                }
                if start.elapsed() >= self.opts.retry_submit_interval {
                    warn!(
                        "Forward request expired after '{:?}', re-submitting (task: '{:?}')",
                        self.opts.retry_submit_interval, self.args,
                    );
                    break;
                }
                sleep(self.opts.poll_interval).await;
            }
        }
    }
    async fn already_processed(&self) -> Result<bool> {
        if self.status_oracle.message_status(&self.msg).await? == MessageStatus::Processed {
            return Ok(true);
        }
        Ok(false)
    }
    async fn wait_for_gas(&self) -> Result<()> {
        loop {
            let gas_paid = self.gas_oracle.get_total_payment(self.msg.leaf_index)?;
            if gas_paid >= self.opts.min_required_gas_payment {
                debug!(%gas_paid, %self.opts.min_required_gas_payment, %self.msg.leaf_index,
                    "Gas funded for message");
                return Ok(());
            }
            debug!(%gas_paid, %self.opts.min_required_gas_payment, %self.msg.leaf_index,
                "Insufficient gas to deliver, sleeping {:?}", self.opts.poll_interval);
            sleep(self.opts.poll_interval).await;
        }
    }
}

#[derive(Debug, Clone)]
struct ForwardRequestOpResult {}

#[derive(Debug, Clone)]
struct ForwardRequestOptions {
    poll_interval: Duration,
    retry_submit_interval: Duration,
    min_required_gas_payment: U256,
}

impl Default for ForwardRequestOptions {
    fn default() -> Self {
        Self {
            poll_interval: Duration::from_secs(60),
            retry_submit_interval: Duration::from_secs(20 * 60),
            min_required_gas_payment: U256::zero(),
        }
    }
}

#[derive(Clone, Debug)]
struct ForwardRequestMetrics {
    messages_processed_count: IntCounter,
}

#[derive(Debug)]
pub(crate) struct GelatoSubmitterMetrics {
    messages_processed_count: IntCounter,
}

impl GelatoSubmitterMetrics {
    pub fn new(metrics: &CoreMetrics, outbox_chain: &str, inbox_chain: &str) -> Self {
        Self {
            messages_processed_count: metrics
                .messages_processed_count()
                .with_label_values(&[outbox_chain, inbox_chain]),
        }
    }
}
