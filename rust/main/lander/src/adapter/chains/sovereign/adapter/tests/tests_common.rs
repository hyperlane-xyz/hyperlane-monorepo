use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use ethers_prometheus::middleware::PrometheusMiddlewareConf;
use hyperlane_base::settings::{
    ChainConf, ChainConnectionConf, CoreContractAddresses, IndexSettings,
};
use hyperlane_core::{
    ChainResult, HyperlaneDomain, NativeToken, ReorgPeriod, SubmitterType, H256, H512,
};
use hyperlane_sovereign::{
    ConnectionConf, OpSubmissionConfig, SequencerTx, Signer, SimulateResult,
    SovereignProviderForLander, SubmitTxResponse, Tx, TxStatus,
};
use serde_json::{json, Value};
use url::Url;

use crate::adapter::AdaptsChain;
use crate::FullPayload;

use super::super::SovereignAdapter;

pub const TEST_PRIVATE_KEY: [u8; 32] = [1u8; 32];

mockall::mock! {
    pub SovereignProvider {}

    #[async_trait::async_trait]
    impl SovereignProviderForLander for SovereignProvider {
        async fn simulate(&self, call_message: &Value) -> ChainResult<SimulateResult>;
        async fn build_and_submit(&self, call_message: Value) -> ChainResult<(SubmitTxResponse, String)>;
        async fn get_tx_by_hash(&self, tx_hash: H256) -> ChainResult<Tx>;
        async fn get_tx_from_sequencer(&self, tx_hash: H256) -> ChainResult<SequencerTx>;
    }
}

pub fn adapter(provider: Arc<MockSovereignProvider>) -> SovereignAdapter {
    let domain = HyperlaneDomain::new_test_domain("test");

    let connection_conf = ConnectionConf {
        url: Url::parse("http://localhost:8080").unwrap(),
        op_submission_config: OpSubmissionConfig::default(),
        native_token: NativeToken::default(),
    };

    let conf = ChainConf {
        domain: domain.clone(),
        signer: None,
        submitter: SubmitterType::Lander,
        estimated_block_time: Duration::from_secs(1),
        reorg_period: ReorgPeriod::None,
        addresses: CoreContractAddresses::default(),
        connection: ChainConnectionConf::Sovereign(connection_conf.clone()),
        metrics_conf: PrometheusMiddlewareConf {
            contracts: HashMap::new(),
            chain: None,
        },
        index: IndexSettings::default(),
        ignore_reorg_reports: false,
    };

    let test_key = hyperlane_core::H256::from_slice(&TEST_PRIVATE_KEY);
    let signer = Signer::new(&test_key, "solana", None).expect("Failed to create test signer");

    SovereignAdapter {
        conf,
        connection_conf,
        provider,
        signer,
        estimated_block_time: Duration::from_secs(1),
    }
}

pub fn payload(data: Vec<u8>) -> FullPayload {
    FullPayload {
        data,
        ..Default::default()
    }
}

pub fn successful_submit_response(tx_hash: H256) -> SubmitTxResponse {
    SubmitTxResponse {
        id: tx_hash,
        status: TxStatus::Submitted,
        events: None,
    }
}

/// Convert H256 to H512 with leading zero padding (Sovereign tx hash format).
pub fn h256_to_h512(h: H256) -> H512 {
    let mut bytes = [0u8; 64];
    bytes[32..].copy_from_slice(h.as_bytes());
    H512::from_slice(&bytes)
}

/// Build a test transaction using the adapter.
pub async fn build_tx(adapter: &SovereignAdapter) -> crate::transaction::Transaction {
    let call_message = json!({"mailbox": {"process": {"metadata": [], "message": []}}});
    let test_payload = payload(serde_json::to_vec(&call_message).unwrap());
    adapter.build_transactions(&[test_payload]).await[0]
        .maybe_tx
        .clone()
        .unwrap()
}
