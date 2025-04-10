use std::fmt::Debug;
use std::future::Future;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use cosmrs::{
    proto::{
        cosmos::{
            auth::v1beta1::{
                query_client::QueryClient as QueryAccountClient, BaseAccount, QueryAccountRequest,
            },
            bank::v1beta1::{query_client::QueryClient as QueryBalanceClient, QueryBalanceRequest},
            base::{
                abci::v1beta1::TxResponse,
                tendermint::v1beta1::{service_client::ServiceClient, GetLatestBlockRequest},
            },
            tx::v1beta1::{
                service_client::ServiceClient as TxServiceClient, BroadcastMode,
                BroadcastTxRequest, SimulateRequest, TxRaw,
            },
        },
        cosmwasm::wasm::v1::{
            query_client::QueryClient as WasmQueryClient, ContractInfo, MsgExecuteContract,
            QueryContractInfoRequest, QuerySmartContractStateRequest,
        },
        traits::Message,
    },
    tx::{self, Fee, MessageExt, SignDoc, SignerInfo},
    Any, Coin,
};
use derive_new::new;
use hyperlane_metric::prometheus_metric::{
    ChainInfo, ClientConnectionType, PrometheusClientMetrics, PrometheusConfig,
};
use ibc_proto::cosmos::{
    auth::v1beta1::QueryAccountResponse, bank::v1beta1::QueryBalanceResponse,
    base::tendermint::v1beta1::GetLatestBlockResponse,
};
use protobuf::Message as _;
use serde::Serialize;
use tonic::{
    transport::{Channel, Endpoint},
    GrpcMethod, IntoRequest,
};
use tracing::{debug, instrument};
use url::Url;

use hyperlane_core::{
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    ChainCommunicationError, ChainResult, ContractLocator, FixedPointNumber, HyperlaneDomain, U256,
};

use crate::{
    prometheus::metrics_channel::MetricsChannel, rpc_clients::CosmosFallbackProvider,
    HyperlaneCosmosError,
};
use crate::{signers::Signer, ConnectionConf};
use crate::{CosmosAddress, CosmosAmount};

/// A multiplier applied to a simulated transaction's gas usage to
/// calculate the estimated gas.
const GAS_ESTIMATE_MULTIPLIER: f64 = 1.25;
/// The number of blocks in the future in which a transaction will
/// be valid for.
const TIMEOUT_BLOCKS: u64 = 1000;
/// gRPC request timeout
const REQUEST_TIMEOUT: u64 = 30;

#[derive(Debug, Clone, new)]
struct CosmosChannel {
    channel: MetricsChannel<Channel>,
    /// The url that this channel is connected to.
    /// Not explicitly used, but useful for debugging.
    _url: Url,
}

impl CosmosChannel {
    async fn latest_block_height(&self) -> ChainResult<GetLatestBlockResponse> {
        let mut client = ServiceClient::new(self.channel.clone());
        let mut request = tonic::Request::new(GetLatestBlockRequest {});
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        let response = client
            .get_latest_block(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(response)
    }

    async fn estimate_gas(&self, payload: Vec<u8>) -> ChainResult<u64> {
        let tx_bytes = payload.to_vec();
        let mut client = TxServiceClient::new(self.channel.clone());
        #[allow(deprecated)]
        let mut sim_req = tonic::Request::new(SimulateRequest { tx: None, tx_bytes });
        sim_req.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        let response = client
            .simulate(sim_req)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner()
            .gas_info
            .ok_or_else(|| ChainCommunicationError::from_other_str("gas info not present"));
        Ok(response?.gas_used)
    }

    async fn account_query(&self, account: String) -> ChainResult<QueryAccountResponse> {
        let address = account.clone();
        let mut client = QueryAccountClient::new(self.channel.clone());
        let mut request = tonic::Request::new(QueryAccountRequest { address });
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        let response = client
            .account(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(response)
    }

    async fn account_query_injective(
        &self,
        account: String,
    ) -> ChainResult<injective_std::types::cosmos::auth::v1beta1::QueryAccountResponse> {
        let address = account.clone();
        let mut request = tonic::Request::new(
            injective_std::types::cosmos::auth::v1beta1::QueryAccountRequest { address },
        );
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));

        // Borrowed from the logic of `QueryAccountClient` in `cosmrs`, but using injective types.
        let mut grpc_client = tonic::client::Grpc::new(self.channel.clone());
        grpc_client
            .ready()
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        let codec = tonic::codec::ProstCodec::default();
        let path = http::uri::PathAndQuery::from_static("/cosmos.auth.v1beta1.Query/Account");
        let mut req: tonic::Request<
            injective_std::types::cosmos::auth::v1beta1::QueryAccountRequest,
        > = request.into_request();
        req.extensions_mut()
            .insert(GrpcMethod::new("cosmos.auth.v1beta1.Query", "Account"));

        let response: tonic::Response<
            injective_std::types::cosmos::auth::v1beta1::QueryAccountResponse,
        > = grpc_client
            .unary(req, path, codec)
            .await
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok(response.into_inner())
    }

    async fn get_balance(
        &self,
        address: String,
        denom: String,
    ) -> ChainResult<QueryBalanceResponse> {
        let address = address.clone();
        let denom = denom.clone();

        let mut client = QueryBalanceClient::new(self.channel.clone());
        let mut balance_request = tonic::Request::new(QueryBalanceRequest { address, denom });
        balance_request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        let response = client
            .balance(balance_request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        Ok(response)
    }

    async fn wasm_query(
        &self,
        contract_address: String,
        payload: Vec<u8>,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>> {
        let to = contract_address.clone();
        let mut client = WasmQueryClient::new(self.channel.clone());
        let mut request = tonic::Request::new(QuerySmartContractStateRequest {
            address: to,
            query_data: payload.clone(),
        });
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));
        if let Some(block_height) = block_height {
            request
                .metadata_mut()
                .insert("x-cosmos-block-height", block_height.into());
        }
        let response = client
            .smart_contract_state(request)
            .await
            .map_err(ChainCommunicationError::from_other);
        Ok(response?.into_inner().data)
    }

    async fn wasm_contract_info(&self, contract_address: String) -> ChainResult<ContractInfo> {
        let to = contract_address.clone();
        let mut client = WasmQueryClient::new(self.channel.clone());

        let mut request = tonic::Request::new(QueryContractInfoRequest { address: to });
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));

        let response = client
            .contract_info(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner()
            .contract_info
            .ok_or(ChainCommunicationError::from_other_str(
                "empty contract info",
            ))?;
        Ok(response)
    }

    async fn wasm_send(&self, payload: Vec<u8>) -> ChainResult<TxResponse> {
        let tx_bytes = payload.to_vec();
        let mut client = TxServiceClient::new(self.channel.clone());
        // We often use U256s to represent gas limits, but Cosmos expects u64s. Try to convert,
        // and if it fails, just fallback to None which will result in gas estimation.
        let tx_req = BroadcastTxRequest {
            tx_bytes,
            mode: BroadcastMode::Sync as i32,
        };
        let response = client
            .broadcast_tx(tx_req)
            .await
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?
            .into_inner()
            .tx_response
            .ok_or_else(|| ChainCommunicationError::from_other_str("Empty tx_response"))?;
        Ok(response)
    }
}

#[async_trait]
impl BlockNumberGetter for CosmosChannel {
    async fn get_block_number(&self) -> ChainResult<u64> {
        let mut client = ServiceClient::new(self.channel.clone());
        let mut request = tonic::Request::new(GetLatestBlockRequest {});
        request.set_timeout(Duration::from_secs(REQUEST_TIMEOUT));

        let response = client
            .get_latest_block(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();
        let height = response
            .block
            .ok_or_else(|| ChainCommunicationError::from_other_str("block not present"))?
            .header
            .ok_or_else(|| ChainCommunicationError::from_other_str("header not present"))?
            .height;

        Ok(height as u64)
    }
}

#[async_trait]
/// Cosmwasm GRPC Provider
pub trait WasmProvider: Send + Sync {
    /// Get latest block height.
    /// Note that in Tendermint, validators come to consensus on a block
    /// before they execute the transactions in that block. This means that
    /// we may not be able to make state queries against this block until
    /// the next one is committed!
    async fn latest_block_height(&self) -> ChainResult<u64>;

    /// Perform a wasm query against the stored contract address.
    async fn wasm_query<T: Serialize + Sync + Send + Clone + Debug>(
        &self,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>;

    /// Request contract info from the stored contract address.
    async fn wasm_contract_info(&self) -> ChainResult<ContractInfo>;

    /// Send a wasm tx.
    async fn wasm_send<T: Serialize + Sync + Send + Clone + Debug>(
        &self,
        payload: T,
        gas_limit: Option<U256>,
    ) -> ChainResult<TxResponse>;

    /// Estimate gas for a wasm tx.
    async fn wasm_estimate_gas<T: Serialize + Sync + Send + Clone + Debug>(
        &self,
        payload: T,
    ) -> ChainResult<u64>;
}

#[derive(Debug, Clone)]
/// CosmWasm GRPC provider.
pub struct WasmGrpcProvider {
    /// Hyperlane domain, used for special cases depending on the chain.
    domain: HyperlaneDomain,
    /// Connection configuration.
    conf: ConnectionConf,
    /// A contract address that can be used as the default
    /// for queries / sends / estimates.
    contract_address: CosmosAddress,
    /// Signer for transactions.
    signer: Option<Signer>,
    /// GRPC Channel that can be cheaply cloned.
    /// See `<https://docs.rs/tonic/latest/tonic/transport/struct.Channel.html#multiplexing-requests>`
    provider: CosmosFallbackProvider<CosmosChannel>,
    gas_price: CosmosAmount,
}

impl WasmGrpcProvider {
    /// Create new CosmWasm GRPC Provider.
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        gas_price: CosmosAmount,
        locator: &ContractLocator,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<ChainInfo>,
    ) -> ChainResult<Self> {
        // get all the configured grpc urls and convert them to a Vec<Endpoint>
        let channels: Result<Vec<CosmosChannel>, _> = conf
            .get_grpc_urls()
            .into_iter()
            .map(|url| {
                let metrics_config =
                    PrometheusConfig::from_url(&url, ClientConnectionType::Grpc, chain.clone());
                Endpoint::new(url.to_string())
                    .map(|e| e.timeout(Duration::from_secs(REQUEST_TIMEOUT)))
                    .map(|e| e.connect_timeout(Duration::from_secs(REQUEST_TIMEOUT)))
                    .map(|e| MetricsChannel::new(e.connect_lazy(), metrics.clone(), metrics_config))
                    .map(|m| CosmosChannel::new(m, url))
                    .map_err(Into::<HyperlaneCosmosError>::into)
            })
            .collect();
        let mut builder = FallbackProvider::builder();
        builder = builder.add_providers(channels?);
        let fallback_provider = builder.build();
        let provider = CosmosFallbackProvider::new(fallback_provider);

        let contract_address = CosmosAddress::from_h256(
            locator.address,
            &conf.get_bech32_prefix(),
            conf.get_contract_address_bytes(),
        )?;

        Ok(Self {
            domain,
            conf,
            contract_address,
            signer,
            provider,
            gas_price,
        })
    }

    /// Gets a signer, or returns an error if one is not available.
    fn get_signer(&self) -> ChainResult<&Signer> {
        self.signer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)
    }

    /// Get the gas price
    pub fn gas_price(&self) -> FixedPointNumber {
        self.gas_price.amount.clone()
    }

    /// Generates an unsigned SignDoc for a transaction and the Coin amount
    /// required to pay for tx fees.
    async fn generate_unsigned_sign_doc_and_fee(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: u64,
    ) -> ChainResult<(SignDoc, Coin)> {
        // As this function is only used for estimating gas or sending transactions,
        // we can reasonably expect to have a signer.
        let signer = self.get_signer()?;
        let account_info = self.account_query(signer.address.clone()).await?;
        let current_height = self.latest_block_height().await?;
        let timeout_height = current_height + TIMEOUT_BLOCKS;

        let tx_body = tx::Body::new(
            msgs,
            String::default(),
            TryInto::<u32>::try_into(timeout_height)
                .map_err(ChainCommunicationError::from_other)?,
        );
        let signer_info = SignerInfo::single_direct(Some(signer.public_key), account_info.sequence);

        let amount: u128 = (FixedPointNumber::from(gas_limit) * self.gas_price())
            .ceil_to_integer()
            .try_into()?;
        let fee_coin = Coin::new(
            // The fee to pay is the gas limit * the gas price
            amount,
            self.conf.get_canonical_asset().as_str(),
        )
        .map_err(Box::new)
        .map_err(Into::<HyperlaneCosmosError>::into)?;
        let auth_info =
            signer_info.auth_info(Fee::from_amount_and_gas(fee_coin.clone(), gas_limit));

        let chain_id = self
            .conf
            .get_chain_id()
            .parse()
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok((
            SignDoc::new(&tx_body, &auth_info, &chain_id, account_info.account_number)
                .map_err(Box::new)
                .map_err(Into::<HyperlaneCosmosError>::into)?,
            fee_coin,
        ))
    }

    /// Generates a raw signed transaction including `msgs`, estimating gas if a limit is not provided,
    /// and the Coin amount required to pay for tx fees.
    async fn generate_raw_signed_tx_and_fee(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: Option<u64>,
    ) -> ChainResult<(Vec<u8>, Coin)> {
        let gas_limit = if let Some(l) = gas_limit {
            l
        } else {
            self.estimate_gas(msgs.clone()).await?
        };

        let (sign_doc, fee) = self
            .generate_unsigned_sign_doc_and_fee(msgs, gas_limit)
            .await?;

        let signer = self.get_signer()?;
        let tx_signed = sign_doc
            .sign(&signer.signing_key()?)
            .map_err(Box::new)
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok((
            tx_signed
                .to_bytes()
                .map_err(Box::new)
                .map_err(Into::<HyperlaneCosmosError>::into)?,
            fee,
        ))
    }

    /// Estimates gas for a transaction containing `msgs`.
    async fn estimate_gas(&self, msgs: Vec<cosmrs::Any>) -> ChainResult<u64> {
        // Get a sign doc with 0 gas, because we plan to simulate
        let (sign_doc, _) = self.generate_unsigned_sign_doc_and_fee(msgs, 0).await?;

        let raw_tx = TxRaw {
            body_bytes: sign_doc.body_bytes,
            auth_info_bytes: sign_doc.auth_info_bytes,
            // The poorly documented trick to simulating a tx without a valid signature is to just pass
            // in a single empty signature. Taken from cosmjs:
            // https://github.com/cosmos/cosmjs/blob/44893af824f0712d1f406a8daa9fcae335422235/packages/stargate/src/modules/tx/queries.ts#L67
            signatures: vec![vec![]],
        };
        let tx_bytes = raw_tx
            .to_bytes()
            .map_err(ChainCommunicationError::from_other)?;
        let gas_used = self
            .provider
            .call(move |provider| {
                let tx_bytes = tx_bytes.clone();
                let future = async move { provider.estimate_gas(tx_bytes).await };
                Box::pin(future)
            })
            .await?;

        let gas_estimate = (gas_used as f64 * GAS_ESTIMATE_MULTIPLIER) as u64;

        Ok(gas_estimate)
    }

    /// Fetches balance for a given `address` and `denom`
    pub async fn get_balance(&self, address: String, denom: String) -> ChainResult<U256> {
        let response = self
            .provider
            .call(move |provider| {
                let address = address.clone();
                let denom = denom.clone();
                let future = async move { provider.get_balance(address, denom).await };
                Box::pin(future)
            })
            .await?;

        let balance = response
            .balance
            .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?;

        Ok(U256::from_dec_str(&balance.amount)?)
    }

    /// Queries an account.
    pub async fn account_query(&self, account: String) -> ChainResult<BaseAccount> {
        // Injective is a special case where their account query requires
        // the use of different protobuf types.
        if self.domain.is_injective() {
            return self.account_query_injective(account).await;
        }

        let response = self
            .provider
            .call(move |provider| {
                let address = account.clone();
                let future = async move { provider.account_query(address).await };
                Box::pin(future)
            })
            .await?;

        let account = BaseAccount::decode(
            response
                .account
                .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?
                .value
                .as_slice(),
        )
        .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok(account)
    }

    /// Injective-specific logic for querying an account.
    async fn account_query_injective(&self, account: String) -> ChainResult<BaseAccount> {
        let response = self
            .provider
            .call(move |provider| {
                let address = account.clone();
                let future = async move { provider.account_query_injective(address).await };
                Box::pin(future)
            })
            .await?;

        let mut eth_account = injective_protobuf::proto::account::EthAccount::parse_from_bytes(
            response
                .account
                .ok_or_else(|| ChainCommunicationError::from_other_str("account not present"))?
                .value
                .as_slice(),
        )
        .map_err(Into::<HyperlaneCosmosError>::into)?;

        let base_account = eth_account.take_base_account();
        let pub_key = base_account.pub_key.into_option();

        Ok(BaseAccount {
            address: base_account.address,
            pub_key: pub_key.map(|pub_key| Any {
                type_url: pub_key.type_url,
                value: pub_key.value,
            }),
            account_number: base_account.account_number,
            sequence: base_account.sequence,
        })
    }

    fn get_contract_address(&self) -> &CosmosAddress {
        &self.contract_address
    }
}

#[async_trait]
impl WasmProvider for WasmGrpcProvider {
    async fn latest_block_height(&self) -> ChainResult<u64> {
        let response = self
            .provider
            .call(move |provider| {
                let start = Instant::now();
                let future = async move { provider.latest_block_height().await };
                Box::pin(future)
            })
            .await?;

        let height = response
            .block
            .ok_or_else(|| ChainCommunicationError::from_other_str("block not present"))?
            .header
            .ok_or_else(|| ChainCommunicationError::from_other_str("header not present"))?
            .height;

        Ok(height as u64)
    }

    async fn wasm_query<T>(&self, payload: T, block_height: Option<u64>) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync + Clone + Debug,
    {
        let contract_address = self.get_contract_address();
        let query_data = serde_json::to_string(&payload)?.as_bytes().to_vec();
        let response = self
            .provider
            .call(move |provider| {
                let to = contract_address.address().clone();
                let query_data = query_data.clone();
                let future = async move { provider.wasm_query(to, query_data, block_height).await };
                Box::pin(future)
            })
            .await?;
        Ok(response)
    }

    async fn wasm_contract_info(&self) -> ChainResult<ContractInfo> {
        let contract_address = self.get_contract_address();
        let response = self
            .provider
            .call(move |provider| {
                let to = contract_address.address().clone();
                let future = async move { provider.wasm_contract_info(to).await };
                Box::pin(future)
            })
            .await?;

        Ok(response)
    }

    #[instrument(skip(self))]
    async fn wasm_send<T>(&self, payload: T, gas_limit: Option<U256>) -> ChainResult<TxResponse>
    where
        T: Serialize + Send + Sync + Clone + Debug,
    {
        let signer = self.get_signer()?;
        let contract_address = self.get_contract_address();
        let msg = MsgExecuteContract {
            sender: signer.address.clone(),
            contract: contract_address.address(),
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };
        let msgs = vec![Any::from_msg(&msg).map_err(ChainCommunicationError::from_other)?];
        let gas_limit: Option<u64> = gas_limit.and_then(|limit| match limit.try_into() {
            Ok(limit) => Some(limit),
            Err(err) => {
                tracing::warn!(
                    ?err,
                    "failed to convert gas_limit to u64, falling back to estimation"
                );
                None
            }
        });
        let (tx_bytes, fee) = self.generate_raw_signed_tx_and_fee(msgs, gas_limit).await?;

        // Check if the signer has enough funds to pay for the fee so we can get
        // a more informative error.
        let signer_balance = self
            .get_balance(signer.address.clone(), fee.denom.to_string())
            .await?;
        let fee_amount: U256 = fee.amount.into();
        if signer_balance < fee_amount {
            return Err(ChainCommunicationError::InsufficientFunds {
                required: Box::new(fee_amount),
                available: Box::new(signer_balance),
            });
        }

        let tx_res = self
            .provider
            .call(move |provider| {
                let tx_bytes = tx_bytes.clone();
                let future = async move { provider.wasm_send(tx_bytes).await };
                Box::pin(future)
            })
            .await?;
        debug!(tx_result=?tx_res, domain=?self.domain, ?payload, "Wasm transaction sent");
        Ok(tx_res)
    }

    async fn wasm_estimate_gas<T>(&self, payload: T) -> ChainResult<u64>
    where
        T: Serialize + Send + Sync,
    {
        // Estimating gas requires a signer, which we can reasonably expect to have
        // since we need one to send a tx with the estimated gas anyways.
        let signer = self.get_signer()?;
        let contract_address = self.get_contract_address();
        let msg = MsgExecuteContract {
            sender: signer.address.clone(),
            contract: contract_address.address(),
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };

        let response = self
            .estimate_gas(vec![
                Any::from_msg(&msg).map_err(ChainCommunicationError::from_other)?
            ])
            .await?;

        Ok(response)
    }
}

#[async_trait]
impl BlockNumberGetter for WasmGrpcProvider {
    async fn get_block_number(&self) -> ChainResult<u64> {
        self.latest_block_height().await
    }
}

#[cfg(test)]
mod tests;
