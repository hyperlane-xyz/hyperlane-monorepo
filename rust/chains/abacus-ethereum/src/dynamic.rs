//! Dynamic provider and rpc client types that can be used without needing to
//! construct a narrow chain for static creation of each thing that uses a
//! middleware and still allows for digging into specific errors if needed.

use std::error::Error;
use std::fmt::{Debug, Display, Formatter};
use std::sync::Arc;

use async_trait::async_trait;
use derive_more::From;
use ethers::middleware::signer::SignerMiddlewareError;
use ethers::prelude::nonce_manager::NonceManagerError;
use ethers::prelude::*;
use paste::paste;
use serde::de::DeserializeOwned;
use serde::Serialize;

use abacus_core::Signers;
use ethers::types::transaction::eip2718::TypedTransaction;
use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;
use ethers_prometheus::middleware::{PrometheusMiddleware, PrometheusMiddlewareError};
use reqwest::Url;

use crate::RetryingProvider;

macro_rules! make_dyn_json_rpc_client {
    {$($n:ident($t:ty)),*$(,)?} => {
        #[derive(Debug)]
        pub enum DynamicJsonRpcClient {
            $($n(Box<$t>),)*
        }

        $(paste! {
        pub type [<T $n>] = $t;
        pub type [<T $n Error>] = <$t as JsonRpcClient>::Error;
        })*

        #[async_trait]
        impl JsonRpcClient for DynamicJsonRpcClient {
            type Error = DynamicJsonRpcClientError;

            async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
            where
                T: Debug + Serialize + Send + Sync,
                R: DeserializeOwned,
            {
                match self {
                    $(Self::$n(p) => JsonRpcClient::request(p, method, params).await.map_err(DynamicJsonRpcClientError::from),)*
                }
            }
        }

        $(
        impl From<$t> for DynamicJsonRpcClient {
            fn from(p: $t) -> Self {
                Self::$n(Box::new(p))
            }
        }

        impl From<Box<$t>> for DynamicJsonRpcClient {
            fn from(p: Box<$t>) -> Self {
                Self::$n(p)
            }
        }
        )*
    };
}

macro_rules! make_dyn_json_rpc_client_error {
    {$($n:ident($t:ty)),*$(,)?} => {
        #[derive(Debug)]
        pub enum DynamicJsonRpcClientError {
            $($n(Box<$t>),)*
        }

        impl Display for DynamicJsonRpcClientError {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                match self {
                    $(Self::$n(p) => write!(f, "{p}"),)*
                }
            }
        }

        impl Error for DynamicJsonRpcClientError {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                match self {
                    $(Self::$n(e) => e.source(),)*
                }
            }
        }

        impl From<DynamicJsonRpcClientError> for ProviderError {
            fn from(err: DynamicJsonRpcClientError) -> Self {
                match err {
                    $(DynamicJsonRpcClientError::$n(e) => (*e).into(),)*
                }
            }
        }

        $(
        impl From<$t> for DynamicJsonRpcClientError {
            fn from(p: $t) -> Self {
                Self::$n(Box::new(p))
            }
        }

        impl From<Box<$t>> for DynamicJsonRpcClientError {
            fn from(p: Box<$t>) -> Self {
                Self::$n(p)
            }
        }
        )*
    };
}

make_dyn_json_rpc_client! {
    RetryingPrometheusHttp(RetryingProvider<PrometheusJsonRpcClient<Http>>),
    PrometheusWs(PrometheusJsonRpcClient<Ws>),
    Quorum(QuorumProvider<DynamicJsonRpcClient>),
}

make_dyn_json_rpc_client_error! {
    RetryingPrometheusHttp(TRetryingPrometheusHttpError),
    Ws(WsClientError),
    Provider(ProviderError)
}

macro_rules! make_dyn_middleware {
    {$($n:ident($t:ty)),*$(,)?} => {
        $(paste! {
        pub type [<T $n>] = $t;
        pub type [<T $n Error>] = <$t as Middleware>::Error;
        })*

        #[derive(Debug, From)]
        pub enum DynamicMiddleware {
            $($n($t),)*
        }

        #[async_trait]
        impl Middleware for DynamicMiddleware {
            type Error = DynamicMiddlewareError;
            type Provider = Arc<DynamicJsonRpcClient>;
            type Inner = Self;

            fn inner(&self) -> &Self::Inner {
                // not possible to implement because we can't just reference inner in a static way
                unimplemented!("You cannot request the inner type of a dynamic middleware");
            }

            fn provider(&self) -> &Provider<Self::Provider> {
                match self {
                    $(Self::$n(m) => m.provider(),)*
                }
            }

            fn default_sender(&self) -> Option<Address> {
                match self {
                    $(Self::$n(m) => m.default_sender(),)*
                }
            }

            async fn client_version(&self) -> Result<String, Self::Error> {
                match self {
                    $(Self::$n(m) => m.client_version().await.map_err(Into::into),)*
                }
            }

            async fn fill_transaction(
                &self,
                tx: &mut TypedTransaction,
                block: Option<BlockId>,
            ) -> Result<(), Self::Error> {
                match self {
                    $(Self::$n(m) => m.fill_transaction(tx, block).await.map_err(Into::into),)*
                }
            }

            async fn get_block_number(&self) -> Result<U64, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_block_number().await.map_err(Into::into),)*
                }
            }

            async fn send_transaction<T: Into<TypedTransaction> + Send + Sync>(
                &self,
                tx: T,
                block: Option<BlockId>,
            ) -> Result<PendingTransaction<'_, Self::Provider>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.send_transaction(tx, block).await.map_err(Into::into),)*
                }
            }

            async fn send_escalating<'a>(
                &'a self,
                tx: &TypedTransaction,
                escalations: usize,
                policy: EscalationPolicy,
            ) -> Result<EscalatingPending<'a, Self::Provider>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.send_escalating(tx, escalations, policy).await.map_err(Into::into),)*
                }
            }

            async fn resolve_name(&self, ens_name: &str) -> Result<Address, Self::Error> {
                match self {
                    $(Self::$n(m) => m.resolve_name(ens_name).await.map_err(Into::into),)*
                }
            }

            async fn lookup_address(&self, address: Address) -> Result<String, Self::Error> {
                match self {
                    $(Self::$n(m) => m.lookup_address(address).await.map_err(Into::into),)*
                }
            }

            async fn resolve_avatar(&self, ens_name: &str) -> Result<Url, Self::Error> {
                match self {
                    $(Self::$n(m) => m.resolve_avatar(ens_name).await.map_err(Into::into),)*
                }
            }

            async fn resolve_nft(&self, token: erc::ERCNFT) -> Result<Url, Self::Error> {
                match self {
                    $(Self::$n(m) => m.resolve_nft(token).await.map_err(Into::into),)*
                }
            }

            async fn resolve_field(&self, ens_name: &str, field: &str) -> Result<String, Self::Error> {
                match self {
                    $(Self::$n(m) => m.resolve_field(ens_name, field).await.map_err(Into::into),)*
                }
            }

            async fn get_block<T: Into<BlockId> + Send + Sync>(
                &self,
                block_hash_or_number: T,
            ) -> Result<Option<Block<TxHash>>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_block(block_hash_or_number).await.map_err(Into::into),)*
                }
            }

            async fn get_block_with_txs<T: Into<BlockId> + Send + Sync>(
                &self,
                block_hash_or_number: T,
            ) -> Result<Option<Block<Transaction>>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_block_with_txs(block_hash_or_number).await.map_err(Into::into),)*
                }
            }

            async fn get_uncle_count<T: Into<BlockId> + Send + Sync>(
                &self,
                block_hash_or_number: T,
            ) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_uncle_count(block_hash_or_number).await.map_err(Into::into),)*
                }
            }

            async fn get_uncle<T: Into<BlockId> + Send + Sync>(
                &self,
                block_hash_or_number: T,
                idx: U64,
            ) -> Result<Option<Block<H256>>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_uncle(block_hash_or_number, idx).await.map_err(Into::into),)*
                }
            }

            async fn get_transaction_count<T: Into<NameOrAddress> + Send + Sync>(
                &self,
                from: T,
                block: Option<BlockId>,
            ) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_transaction_count(from, block).await.map_err(Into::into),)*
                }
            }

            async fn estimate_gas(
                &self,
                tx: &TypedTransaction,
                block: Option<BlockId>,
            ) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.estimate_gas(tx, block).await.map_err(Into::into),)*
                }
            }

            async fn call(
                &self,
                tx: &TypedTransaction,
                block: Option<BlockId>,
            ) -> Result<Bytes, Self::Error> {
                match self {
                    $(Self::$n(m) => m.call(tx, block).await.map_err(Into::into),)*
                }
            }

            async fn syncing(&self) -> Result<SyncingStatus, Self::Error> {
                match self {
                    $(Self::$n(m) => m.syncing().await.map_err(Into::into),)*
                }
            }

            async fn get_chainid(&self) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_chainid().await.map_err(Into::into),)*
                }
            }

            async fn get_net_version(&self) -> Result<String, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_net_version().await.map_err(Into::into),)*
                }
            }

            async fn get_balance<T: Into<NameOrAddress> + Send + Sync>(
                &self,
                from: T,
                block: Option<BlockId>,
            ) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_balance(from, block).await.map_err(Into::into),)*
                }
            }

            async fn get_transaction<T: Send + Sync + Into<TxHash>>(
                &self,
                transaction_hash: T,
            ) -> Result<Option<Transaction>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_transaction(transaction_hash).await.map_err(Into::into),)*
                }
            }

            async fn get_transaction_receipt<T: Send + Sync + Into<TxHash>>(
                &self,
                transaction_hash: T,
            ) -> Result<Option<TransactionReceipt>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_transaction_receipt(transaction_hash).await.map_err(Into::into),)*
                }
            }

            async fn get_block_receipts<T: Into<BlockNumber> + Send + Sync>(
                &self,
                block: T,
            ) -> Result<Vec<TransactionReceipt>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_block_receipts(block).await.map_err(Into::into),)*
                }
            }

            async fn get_gas_price(&self) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_gas_price().await.map_err(Into::into),)*
                }
            }

            async fn estimate_eip1559_fees(
                &self,
                estimator: Option<fn(U256, Vec<Vec<U256>>) -> (U256, U256)>,
            ) -> Result<(U256, U256), Self::Error> {
                match self {
                    $(Self::$n(m) => m.estimate_eip1559_fees(estimator).await.map_err(Into::into),)*
                }
            }

            async fn get_accounts(&self) -> Result<Vec<Address>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_accounts().await.map_err(Into::into),)*
                }
            }

            async fn send_raw_transaction<'a>(
                &'a self,
                tx: Bytes,
            ) -> Result<PendingTransaction<'a, Self::Provider>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.send_raw_transaction(tx).await.map_err(Into::into),)*
                }
            }

            async fn is_signer(&self) -> bool {
                match self {
                    $(Self::$n(m) => m.is_signer().await,)*
                }
            }

            async fn sign<T: Into<Bytes> + Send + Sync>(
                &self,
                data: T,
                from: &Address,
            ) -> Result<Signature, Self::Error> {
                match self {
                    $(Self::$n(m) => m.sign(data, from).await.map_err(Into::into),)*
                }
            }

            async fn sign_transaction(
                &self,
                tx: &TypedTransaction,
                from: Address,
            ) -> Result<Signature, Self::Error> {
                match self {
                    $(Self::$n(m) => m.sign_transaction(tx, from).await.map_err(Into::into),)*
                }
            }

            async fn get_logs(&self, filter: &Filter) -> Result<Vec<Log>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_logs(filter).await.map_err(Into::into),)*
                }
            }

            fn get_logs_paginated<'a>(
                &'a self,
                filter: &Filter,
                page_size: u64,
            ) -> LogQuery<'a, Self::Provider> {
                match self {
                    $(Self::$n(m) => m.get_logs_paginated(filter, page_size),)*
                }
            }

            async fn new_filter(&self, filter: FilterKind<'_>) -> Result<U256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.new_filter(filter).await.map_err(Into::into),)*
                }
            }

            async fn uninstall_filter<T: Into<U256> + Send + Sync>(
                &self,
                id: T,
            ) -> Result<bool, Self::Error> {
                match self {
                    $(Self::$n(m) => m.uninstall_filter(id).await.map_err(Into::into),)*
                }
            }

            async fn watch<'a>(
                &'a self,
                filter: &Filter,
            ) -> Result<FilterWatcher<'a, Self::Provider, Log>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.watch(filter).await.map_err(Into::into),)*
                }
            }

            async fn watch_pending_transactions(
                &self,
            ) -> Result<FilterWatcher<'_, Self::Provider, H256>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.watch_pending_transactions().await.map_err(Into::into),)*
                }
            }

            async fn get_filter_changes<T, R>(&self, id: T) -> Result<Vec<R>, Self::Error>
            where
                T: Into<U256> + Send + Sync,
                R: Serialize + DeserializeOwned + Send + Sync + Debug
            {
                match self {
                    $(Self::$n(m) => m.get_filter_changes(id).await.map_err(Into::into),)*
                }
            }

            async fn watch_blocks(&self) -> Result<FilterWatcher<'_, Self::Provider, H256>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.watch_blocks().await.map_err(Into::into),)*
                }
            }

            async fn get_code<T: Into<NameOrAddress> + Send + Sync>(
                &self,
                at: T,
                block: Option<BlockId>,
            ) -> Result<Bytes, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_code(at, block).await.map_err(Into::into),)*
                }
            }

            async fn get_storage_at<T: Into<NameOrAddress> + Send + Sync>(
                &self,
                from: T,
                location: H256,
                block: Option<BlockId>,
            ) -> Result<H256, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_storage_at(from, location, block).await.map_err(Into::into),)*
                }
            }

            async fn get_proof<T: Into<NameOrAddress> + Send + Sync>(
                &self,
                from: T,
                locations: Vec<H256>,
                block: Option<BlockId>,
            ) -> Result<EIP1186ProofResponse, Self::Error> {
                match self {
                    $(Self::$n(m) => m.get_proof(from, locations, block).await.map_err(Into::into),)*
                }
            }

            async fn txpool_content(&self) -> Result<TxpoolContent, Self::Error> {
                match self {
                    $(Self::$n(m) => m.txpool_content().await.map_err(Into::into),)*
                }
            }

            async fn txpool_inspect(&self) -> Result<TxpoolInspect, Self::Error> {
                match self {
                    $(Self::$n(m) => m.txpool_inspect().await.map_err(Into::into),)*
                }
            }

            async fn txpool_status(&self) -> Result<TxpoolStatus, Self::Error> {
                match self {
                    $(Self::$n(m) => m.txpool_status().await.map_err(Into::into),)*
                }
            }

            async fn debug_trace_transaction(
                &self,
                tx_hash: TxHash,
                trace_options: GethDebugTracingOptions,
            ) -> Result<GethTrace, ProviderError> {
                match self {
                    $(Self::$n(m) => m.debug_trace_transaction(tx_hash, trace_options).await.map_err(Into::into),)*
                }
            }

            async fn trace_call<T: Into<TypedTransaction> + Send + Sync>(
                &self,
                req: T,
                trace_type: Vec<TraceType>,
                block: Option<BlockNumber>,
            ) -> Result<BlockTrace, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_call(req, trace_type, block).await.map_err(Into::into),)*
                }
            }

            async fn trace_call_many<T: Into<TypedTransaction> + Send + Sync>(
                &self,
                req: Vec<(T, Vec<TraceType>)>,
                block: Option<BlockNumber>,
            ) -> Result<Vec<BlockTrace>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_call_many(req, block).await.map_err(Into::into),)*
                }
            }

            async fn trace_raw_transaction(
                &self,
                data: Bytes,
                trace_type: Vec<TraceType>,
            ) -> Result<BlockTrace, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_raw_transaction(data, trace_type).await.map_err(Into::into),)*
                }
            }

            async fn trace_replay_transaction(
                &self,
                hash: H256,
                trace_type: Vec<TraceType>,
            ) -> Result<BlockTrace, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_replay_transaction(hash, trace_type).await.map_err(Into::into),)*
                }
            }

            async fn trace_replay_block_transactions(
                &self,
                block: BlockNumber,
                trace_type: Vec<TraceType>,
            ) -> Result<Vec<BlockTrace>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_replay_block_transactions(block, trace_type).await.map_err(Into::into),)*
                }
            }

            async fn trace_block(&self, block: BlockNumber) -> Result<Vec<Trace>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_block(block).await.map_err(Into::into),)*
                }
            }

            async fn trace_filter(&self, filter: TraceFilter) -> Result<Vec<Trace>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_filter(filter).await.map_err(Into::into),)*
                }
            }

            async fn trace_get<T: Into<U64> + Send + Sync>(
                &self,
                hash: H256,
                index: Vec<T>,
            ) -> Result<Trace, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_get(hash, index).await.map_err(Into::into),)*
                }
            }

            async fn trace_transaction(&self, hash: H256) -> Result<Vec<Trace>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.trace_transaction(hash).await.map_err(Into::into),)*
                }
            }

            async fn parity_block_receipts<T: Into<BlockNumber> + Send + Sync>(
                &self,
                block: T,
            ) -> Result<Vec<TransactionReceipt>, Self::Error> {
                match self {
                    $(Self::$n(m) => m.parity_block_receipts(block).await.map_err(Into::into),)*
                }
            }

            // async fn subscribe<T, R>(
            //     &self,
            //     params: T,
            // ) -> Result<SubscriptionStream<'_, Self::Provider, R>, Self::Error>
            // where
            //     T: Debug + Serialize + Send + Sync,
            //     R: DeserializeOwned + Send + Sync,
            //     <Self as Middleware>::Provider: PubsubClient
            // {
            //     match self {
            //         $(Self::$n(m) => m.subscribe(params).await.map_err(Into::into),)*
            //     }
            // }

            // async fn unsubscribe<T>(&self, id: T) -> Result<bool, Self::Error>
            // where
            //     T: Into<U256> + Send + Sync,
            //     <Self as Middleware>::Provider: PubsubClient
            // {
            //     match self {
            //         $(Self::$n(m) => m.unsubscribe(id).await.map_err(Into::into),)*
            //     }
            // }

            //async fn subscribe_blocks(
            //     &self,
            // ) -> Result<SubscriptionStream<'_, Self::Provider, Block<TxHash>>, Self::Error>
            // where
            //     <Self as Middleware>::Provider: PubsubClient;
            //
            // async fn subscribe_pending_txs(
            //     &self,
            // ) -> Result<SubscriptionStream<'_, Self::Provider, TxHash>, Self::Error>
            // where
            //     <Self as Middleware>::Provider: PubsubClient;
            //
            // async fn subscribe_logs<'a>(
            //     &'a self,
            //     filter: &Filter,
            // ) -> Result<SubscriptionStream<'a, Self::Provider, Log>, Self::Error>
            // where
            //     <Self as Middleware>::Provider: PubsubClient;

            async fn fee_history<T: Into<U256> + serde::Serialize + Send + Sync>(
                &self,
                block_count: T,
                last_block: BlockNumber,
                reward_percentiles: &[f64],
            ) -> Result<FeeHistory, Self::Error> {
                match self {
                    $(Self::$n(m) => m.fee_history(block_count, last_block, reward_percentiles).await.map_err(Into::into),)*
                }
            }

            async fn create_access_list(
                &self,
                tx: &TypedTransaction,
                block: Option<BlockId>,
            ) -> Result<ethers::types::transaction::eip2930::AccessListWithGasUsed, Self::Error> {
                match self {
                    $(Self::$n(m) => m.create_access_list(tx, block).await.map_err(Into::into),)*
                }
            }
        }
    };
}

make_dyn_middleware! {
    SignerNoncePrometheus(SignerMiddleware<NonceManagerMiddleware<Arc<PrometheusMiddleware<Provider<Arc<DynamicJsonRpcClient>>>>>, Signers>),
    Prometheus(Arc<PrometheusMiddleware<Provider<Arc<DynamicJsonRpcClient>>>>),
    SignerNonce(SignerMiddleware<NonceManagerMiddleware<Provider<Arc<DynamicJsonRpcClient>>>, Signers>),
    BaseProvider(Provider<Arc<DynamicJsonRpcClient>>),
}

#[derive(Debug, From)]
pub enum DynamicMiddlewareError {
    NoncePrometheus(
        NonceManagerError<Arc<PrometheusMiddleware<Provider<Arc<DynamicJsonRpcClient>>>>>,
    ),
    Nonce(NonceManagerError<Provider<Arc<DynamicJsonRpcClient>>>),
    SignerNoncePrometheus(
        SignerMiddlewareError<
            NonceManagerMiddleware<Arc<PrometheusMiddleware<Provider<Arc<DynamicJsonRpcClient>>>>>,
            Signers,
        >,
    ),
    Prometheus(PrometheusMiddlewareError<ProviderError>),
    SignerNonce(
        SignerMiddlewareError<NonceManagerMiddleware<Provider<Arc<DynamicJsonRpcClient>>>, Signers>,
    ),
    BaseProvider(ProviderError),
}

impl Display for DynamicMiddlewareError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

impl Error for DynamicMiddlewareError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        todo!()
    }
}

impl FromErr<DynamicMiddlewareError> for DynamicMiddlewareError {
    fn from(src: DynamicMiddlewareError) -> Self {
        src
    }
}
