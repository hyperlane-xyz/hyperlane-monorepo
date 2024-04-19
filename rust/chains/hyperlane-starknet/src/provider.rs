use std::fmt::Debug;
use std::sync::Arc;

use hyperlane_core::HyperlaneDomain;
use starknet::accounts::{Account, AccountError, Declaration, Execution, SingleOwnerAccount};
use starknet::core::types::InvokeTransactionResult;
use starknet::providers::jsonrpc::{HttpTransport, JsonRpcClient};
use starknet::signers::LocalWallet;

use crate::ConnectionConf;

type RpcAccount<'a> = SingleOwnerAccount<&'a JsonRpcClient<HttpTransport>, LocalWallet>;
pub type TransactionExecution<'a> = Execution<'a, RpcAccount<'a>>;
type TransactionDeclaration<'a> = Declaration<'a, RpcAccount<'a>>;
type StarknetAccountError = AccountError<
    <SingleOwnerAccount<JsonRpcClient<HttpTransport>, LocalWallet> as Account>::SignError,
>;

pub enum Transaction<'a> {
    Execution(TransactionExecution<'a>),
}

#[derive(Debug)]
pub enum TransactionResult {
    Execution(InvokeTransactionResult),
}

#[derive(thiserror::Error, Debug)]
pub enum SendTransactionError {
    #[error(transparent)]
    AccountError(StarknetAccountError),
}

impl Transaction<'_> {
    pub async fn send(&self) -> Result<TransactionResult, SendTransactionError> {
        match self {
            Transaction::Execution(execution) => execution
                .send()
                .await
                .map(TransactionResult::Execution)
                .map_err(SendTransactionError::AccountError),
        }
    }
}

#[derive(Debug)]
/// A wrapper over the Starknet provider to provide a more ergonomic interface.
pub struct StarknetProvider {
    domain: HyperlaneDomain,
    rpc_client: Arc<JsonRpcClient<HttpTransport>>,
}

impl StarknetProvider {
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        let rpc_client = Arc::new(JsonRpcClient::new(HttpTransport::new(conf.url.clone())));
        Self { domain, rpc_client }
    }

    pub fn get_starknet_client(&self) -> Arc<JsonRpcClient<HttpTransport>> {
        self.rpc_client
    }

    pub async fn submit_txs(
        &mut self,
        transactions: Vec<Transaction<'_>>,
    ) -> Vec<Result<TransactionResult, SendTransactionError>> {
        let mut results = Vec::with_capacity(transactions.len());
        for tx in transactions {
            let result = tx.send().await;
            results.push(result);
        }
        results
    }
}
