use std::{
    fmt::{Debug, Formatter},
    ops::Deref,
};

use async_trait::async_trait;
use base64::Engine;
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
        prost::{self, Message},
    },
    tx::{self, Fee, MessageExt, SignDoc, SignerInfo},
    Any, Coin,
};
use derive_new::new;
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

use crate::CosmosAmount;
use crate::HyperlaneCosmosError;
use crate::{ConnectionConf, CosmosAddress, Signer};

/// A multiplier applied to a simulated transaction's gas usage to
/// calculate the estimated gas.
const GAS_ESTIMATE_MULTIPLIER: f64 = 2.0; // TODO: this has to be adjusted accordingly and per chain
/// The number of blocks in the future in which a transaction will
/// be valid for.
const TIMEOUT_BLOCKS: u64 = 1000;

#[derive(new, Clone)]
pub struct CosmosFallbackProvider<T> {
    fallback_provider: FallbackProvider<T, T>,
}

impl<T> Deref for CosmosFallbackProvider<T> {
    type Target = FallbackProvider<T, T>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl<C> Debug for CosmosFallbackProvider<C>
where
    C: Debug,
{
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        self.fallback_provider.fmt(f)
    }
}

#[derive(Debug, Clone, new)]
struct CosmosChannel {
    channel: Channel,
    /// The url that this channel is connected to.
    /// Not explicitly used, but useful for debugging.
    _url: Url,
}

#[async_trait]
impl BlockNumberGetter for CosmosChannel {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let mut client = ServiceClient::new(self.channel.clone());
        let request = tonic::Request::new(GetLatestBlockRequest {});

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

#[derive(Debug, Clone)]
/// CosmWasm GRPC provider.
pub struct GrpcProvider {
    /// Connection configuration.
    conf: ConnectionConf,
    /// Signer for transactions.
    signer: Option<Signer>,
    /// GRPC Channel that can be cheaply cloned.
    /// See `<https://docs.rs/tonic/latest/tonic/transport/struct.Channel.html#multiplexing-requests>`
    provider: CosmosFallbackProvider<CosmosChannel>,
    gas_price: CosmosAmount,
}

impl GrpcProvider {
    /// Create new CosmWasm GRPC Provider.
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        gas_price: CosmosAmount,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        // get all the configured grpc urls and convert them to a Vec<Endpoint>
        let channels: Result<Vec<CosmosChannel>, _> = conf
            .get_grpc_urls()
            .into_iter()
            .map(|url| {
                Endpoint::new(url.to_string())
                    .map(|e| CosmosChannel::new(e.connect_lazy(), url))
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
            conf,
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
        .map_err(Into::<HyperlaneCosmosError>::into)?;
        let auth_info =
            signer_info.auth_info(Fee::from_amount_and_gas(fee_coin.clone(), gas_limit));

        let chain_id = self
            .conf
            .get_chain_id()
            .parse()
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok((
            SignDoc::new(&tx_body, &auth_info, &chain_id, account_info.account_number)
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
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok((
            tx_signed
                .to_bytes()
                .map_err(Into::<HyperlaneCosmosError>::into)?,
            fee,
        ))
    }

    /// send a transaction
    pub async fn send(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: Option<u64>,
    ) -> ChainResult<TxResponse> {
        let gas_limit = if let Some(l) = gas_limit {
            l
        } else {
            self.estimate_gas(msgs.clone()).await?
        };

        let (tx_bytes, _) = self
            .generate_raw_signed_tx_and_fee(msgs, Some(gas_limit))
            .await?;
        let tx_response = self
            .provider
            .call(move |provider| {
                let tx_bytes_clone = tx_bytes.clone();
                let future = async move {
                    let mut client = TxServiceClient::new(provider.channel.clone());
                    let request = tonic::Request::new(BroadcastTxRequest {
                        tx_bytes: tx_bytes_clone,
                        mode: BroadcastMode::Sync as i32,
                    });

                    let tx_response = client
                        .broadcast_tx(request)
                        .await
                        .map_err(ChainCommunicationError::from_other)?
                        .into_inner()
                        .tx_response
                        .ok_or_else(|| {
                            ChainCommunicationError::from_other_str("tx_response not present")
                        })?;
                    Ok(tx_response)
                };
                Box::pin(future)
            })
            .await?;
        Ok(tx_response)
    }

    /// Estimates gas for a transaction containing `msgs`.
    pub async fn estimate_gas(&self, msgs: Vec<cosmrs::Any>) -> ChainResult<u64> {
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
                let tx_bytes_clone = tx_bytes.clone();
                let future = async move {
                    let mut client = TxServiceClient::new(provider.channel.clone());
                    #[allow(deprecated)]
                    let sim_req = tonic::Request::new(SimulateRequest {
                        tx: None,
                        tx_bytes: tx_bytes_clone,
                    });
                    let gas_used = client
                        .simulate(sim_req)
                        .await
                        .map_err(ChainCommunicationError::from_other)?
                        .into_inner()
                        .gas_info
                        .ok_or_else(|| {
                            ChainCommunicationError::from_other_str("gas info not present")
                        })?
                        .gas_used;

                    Ok(gas_used)
                };
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
                let future = async move {
                    let mut client = QueryBalanceClient::new(provider.channel.clone());
                    let balance_request =
                        tonic::Request::new(QueryBalanceRequest { address, denom });
                    let response = client
                        .balance(balance_request)
                        .await
                        .map_err(ChainCommunicationError::from_other)?
                        .into_inner();
                    Ok(response)
                };
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
        let response = self
            .provider
            .call(move |provider| {
                let address = account.clone();
                let future = async move {
                    let mut client = QueryAccountClient::new(provider.channel.clone());
                    let request = tonic::Request::new(QueryAccountRequest { address });
                    let response = client
                        .account(request)
                        .await
                        .map_err(ChainCommunicationError::from_other)?
                        .into_inner();
                    Ok(response)
                };
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

    async fn latest_block_height(&self) -> ChainResult<u64> {
        let height = self
            .provider
            .call(move |provider| {
                let future = async move { provider.get_block_number().await };
                Box::pin(future)
            })
            .await?;
        Ok(height)
    }
}

#[async_trait]
impl BlockNumberGetter for GrpcProvider {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        self.latest_block_height().await
    }
}
