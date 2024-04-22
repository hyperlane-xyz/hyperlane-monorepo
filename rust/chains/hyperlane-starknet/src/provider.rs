use std::fmt::Debug;
use std::sync::Arc;

use hyperlane_core::HyperlaneDomain;
use starknet::accounts::{Account, AccountError, Execution, ExecutionEncoding, SingleOwnerAccount};
use starknet::core::chain_id::{MAINNET, SEPOLIA};
use starknet::core::types::{FieldElement, InvokeTransactionResult};
use starknet::providers::jsonrpc::{HttpTransport, JsonRpcClient};
use starknet::providers::AnyProvider;
use starknet::signers::LocalWallet;

use crate::{ConnectionConf, Signer};

type RpcAccount<'a> = SingleOwnerAccount<&'a AnyProvider, LocalWallet>;
pub type TransactionExecution<'a> = Execution<'a, RpcAccount<'a>>;
type StarknetAccountError =
    AccountError<<SingleOwnerAccount<AnyProvider, LocalWallet> as Account>::SignError>;

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
    rpc_client: Arc<AnyProvider>,
    account: Option<Arc<SingleOwnerAccount<Arc<AnyProvider>, LocalWallet>>>,
}

impl StarknetProvider {
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf, signer: Option<Signer>) -> Self {
        let rpc_client = Arc::new(AnyProvider::JsonRpcHttp(JsonRpcClient::new(
            HttpTransport::new(conf.url.clone()),
        )));

        let chain_id = match domain.id() {
            23448594392895567 => SEPOLIA,
            23448594291968334 => MAINNET,
        };

        let account = if let Some(signer) = signer {
            Arc::new(SingleOwnerAccount::new(
                rpc_client,
                signer.local_wallet(),
                signer.address,
                chain_id,
                ExecutionEncoding::New, // Only supports Cairo 1 accounts
            ))
        } else {
            None
        };

        Self {
            domain,
            rpc_client,
            account,
        }
    }

    pub fn rpc_client(&self) -> Arc<AnyProvider> {
        self.rpc_client
    }

    pub fn domain(&self) -> &HyperlaneDomain {
        &self.domain
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
