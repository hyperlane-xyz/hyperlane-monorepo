use abacus_base::CoreMetrics;
use abacus_core::{Encode, MessageStatus, Signers};
use abacus_ethereum::validator_manager::INBOXVALIDATORMANAGER_ABI as ivm_abi;
use ethers::abi::Token;
use ethers::types::{Address, U256};
use ethers_contract::BaseContract;
use eyre::{bail, Result};
use futures::stream::FuturesUnordered;
use gelato::chains::Chain;
use gelato::fwd_req_call::{ForwardRequestArgs, PaymentType, NATIVE_FEE_TOKEN_ADDRESS};
use prometheus::IntCounter;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep;
use tokio_stream::StreamExt;
use tracing::{info, warn};
use tracing::{info_span, instrument::Instrumented, Instrument};

use super::forward_request_op::{ForwardRequestOp, ForwardRequestOptions};
use super::gas_oracle::GasPaymentOracle;
use super::message_status::ProcessedStatusOracle;
use super::SubmitMessageArgs;

const DEFAULT_MAX_FEE: u32 = 1_000_000_000;

#[derive(Debug)]
pub(crate) struct GelatoSubmitter {
    /// Source of messages to submit.
    pub messages: mpsc::UnboundedReceiver<SubmitMessageArgs>,
    /// The Abacus domain of the source chain for messages to be submitted via this GelatoSubmitter.
    pub outbox_domain: u32,
    /// The Abacus domain of the destination chain for messages submitted with this GelatoSubmitter.
    pub inbox_domain: u32,
    /// The on-chain address of the inbox contract on the destination chain.
    pub inbox_address: Address,
    /// Address of the inbox validator manager contract that will be specified
    /// to Gelato in ForwardRequest submissions to process new messages.
    pub ivm_address: Address,
    /// The address of the 'sponsor' contract providing payment to Gelato.
    pub(crate) sponsor_address: Address,
    /// Interface providing access to information about gas payments. Used to decide when it is
    /// appropriate to forward a message.
    pub(crate) gas_oracle: GasPaymentOracle,
    /// Interface to learning the status of a message according to some authority, like a view
    /// call against the inbox contract.
    pub(crate) status_oracle: ProcessedStatusOracle,
    /// Signer to use for EIP-712 meta-transaction signatures.
    pub signer: Signers,
    /// Shared reqwest HTTP client to use for any ops to Gelato endpoints.
    /// Intended to be shared by reqwest library.
    pub http: reqwest::Client,
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
            };

            let submitter_metrics: &GelatoSubmitterMetrics = &self.metrics;
            let status_oracle: &ProcessedStatusOracle = &self.status_oracle;
            in_flight_ops.push(async move {
                loop {
                    match op.run().await {
                        Ok(result) => {
                            info!(?result.txn_status, "Gelato successfully processed message");
                            if result.responsible_for_processing {
                                submitter_metrics.messages_processed_count.inc();
                            }
                            assert!(result.message_status == MessageStatus::Processed);
                            status_oracle
                                .mark_processed(op.get_message())
                                .unwrap_or_else(|err| {
                                    warn!(?err, ?result, ?op, "Failed to mark msg processed in DB");
                                });
                            return;
                        }
                        Err(e) => {
                            warn!(err=?e, failed_op=?op,
                                "Error running forward request op, sleeping 60s");
                            sleep(Duration::from_secs(60)).await;
                            continue;
                        }
                    }
                }
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
                    msg.proof.path[0..32]
                        .iter()
                        .map(|e| Token::FixedBytes(e.to_vec()))
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
            max_fee: DEFAULT_MAX_FEE.into(),
            gas: DEFAULT_MAX_FEE.into(),
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
