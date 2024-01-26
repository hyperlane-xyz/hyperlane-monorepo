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
            query_client::QueryClient as WasmQueryClient, MsgExecuteContract,
            QuerySmartContractStateRequest,
        },
        traits::Message,
    },
    tx::{self, Fee, MessageExt, SignDoc, SignerInfo},
    Any, Coin,
};
use hyperlane_core::{
    ChainCommunicationError, ChainResult, ContractLocator, FixedPointNumber, HyperlaneDomain, U256,
};
use protobuf::Message as _;
use serde::Serialize;
use tonic::{
    transport::{Channel, Endpoint},
    GrpcMethod, IntoRequest,
};

use crate::HyperlaneCosmosError;
use crate::{address::CosmosAddress, CosmosAmount};
use crate::{signers::Signer, ConnectionConf};

/// A multiplier applied to a simulated transaction's gas usage to
/// calculate the estimated gas.
const GAS_ESTIMATE_MULTIPLIER: f64 = 1.25;
/// The number of blocks in the future in which a transaction will
/// be valid for.
const TIMEOUT_BLOCKS: u64 = 1000;

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
    async fn wasm_query<T: Serialize + Sync + Send>(
        &self,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>;

    /// Perform a wasm query against a specified contract address.
    async fn wasm_query_to<T: Serialize + Sync + Send>(
        &self,
        to: String,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>;

    /// Send a wasm tx.
    async fn wasm_send<T: Serialize + Sync + Send>(
        &self,
        payload: T,
        gas_limit: Option<U256>,
    ) -> ChainResult<TxResponse>;

    /// Estimate gas for a wasm tx.
    async fn wasm_estimate_gas<T: Serialize + Sync + Send>(&self, payload: T) -> ChainResult<u64>;
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
    contract_address: Option<CosmosAddress>,
    /// Signer for transactions.
    signer: Option<Signer>,
    /// GRPC Channel that can be cheaply cloned.
    /// See `<https://docs.rs/tonic/latest/tonic/transport/struct.Channel.html#multiplexing-requests>`
    channel: Channel,
    gas_price: CosmosAmount,
}

impl WasmGrpcProvider {
    /// Create new CosmWasm GRPC Provider.
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        gas_price: CosmosAmount,
        locator: Option<ContractLocator>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let endpoint =
            Endpoint::new(conf.get_grpc_url()).map_err(Into::<HyperlaneCosmosError>::into)?;
        let channel = endpoint.connect_lazy();
        let contract_address = locator
            .map(|l| {
                CosmosAddress::from_h256(
                    l.address,
                    &conf.get_bech32_prefix(),
                    conf.get_contract_address_bytes(),
                )
            })
            .transpose()?;

        Ok(Self {
            domain,
            conf,
            contract_address,
            signer,
            channel,
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

    /// Generates an unsigned SignDoc for a transaction.
    async fn generate_unsigned_sign_doc(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: u64,
    ) -> ChainResult<SignDoc> {
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
        let auth_info = signer_info.auth_info(Fee::from_amount_and_gas(
            Coin::new(
                // The fee to pay is the gas limit * the gas price
                amount,
                self.conf.get_canonical_asset().as_str(),
            )
            .map_err(Into::<HyperlaneCosmosError>::into)?,
            gas_limit,
        ));

        let chain_id = self
            .conf
            .get_chain_id()
            .parse()
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(
            SignDoc::new(&tx_body, &auth_info, &chain_id, account_info.account_number)
                .map_err(Into::<HyperlaneCosmosError>::into)?,
        )
    }

    /// Generates a raw signed transaction including `msgs`, estimating gas if a limit is not provided.
    async fn generate_raw_signed_tx(
        &self,
        msgs: Vec<cosmrs::Any>,
        gas_limit: Option<u64>,
    ) -> ChainResult<Vec<u8>> {
        let gas_limit = if let Some(l) = gas_limit {
            l
        } else {
            self.estimate_gas(msgs.clone()).await?
        };

        let sign_doc = self.generate_unsigned_sign_doc(msgs, gas_limit).await?;

        let signer = self.get_signer()?;
        let tx_signed = sign_doc
            .sign(&signer.signing_key()?)
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok(tx_signed
            .to_bytes()
            .map_err(Into::<HyperlaneCosmosError>::into)?)
    }

    /// Estimates gas for a transaction containing `msgs`.
    async fn estimate_gas(&self, msgs: Vec<cosmrs::Any>) -> ChainResult<u64> {
        // Get a sign doc with 0 gas, because we plan to simulate
        let sign_doc = self.generate_unsigned_sign_doc(msgs, 0).await?;

        let raw_tx = TxRaw {
            body_bytes: sign_doc.body_bytes,
            auth_info_bytes: sign_doc.auth_info_bytes,
            // The poorly documented trick to simuluating a tx without a valid signature is to just pass
            // in a single empty signature. Taken from cosmjs:
            // https://github.com/cosmos/cosmjs/blob/44893af824f0712d1f406a8daa9fcae335422235/packages/stargate/src/modules/tx/queries.ts#L67
            signatures: vec![vec![]],
        };

        let mut client = TxServiceClient::new(self.channel.clone());
        let tx_bytes = raw_tx
            .to_bytes()
            .map_err(ChainCommunicationError::from_other)?;
        #[allow(deprecated)]
        let sim_req = tonic::Request::new(SimulateRequest { tx: None, tx_bytes });
        let gas_used = client
            .simulate(sim_req)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner()
            .gas_info
            .ok_or_else(|| ChainCommunicationError::from_other_str("gas info not present"))?
            .gas_used;

        let gas_estimate = (gas_used as f64 * GAS_ESTIMATE_MULTIPLIER) as u64;

        Ok(gas_estimate)
    }

    /// Fetches balance for a given `address` and `denom`
    pub async fn get_balance(&self, address: String, denom: String) -> ChainResult<U256> {
        let mut client = QueryBalanceClient::new(self.channel.clone());

        let balance_request = tonic::Request::new(QueryBalanceRequest { address, denom });
        let response = client
            .balance(balance_request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

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

        let mut client = QueryAccountClient::new(self.channel.clone());

        let request = tonic::Request::new(QueryAccountRequest { address: account });
        let response = client
            .account(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

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
        let request = tonic::Request::new(
            injective_std::types::cosmos::auth::v1beta1::QueryAccountRequest { address: account },
        );

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
            .map_err(Into::<HyperlaneCosmosError>::into)?;

        let mut eth_account = injective_protobuf::proto::account::EthAccount::parse_from_bytes(
            response
                .into_inner()
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
}

#[async_trait]
impl WasmProvider for WasmGrpcProvider {
    async fn latest_block_height(&self) -> ChainResult<u64> {
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

    async fn wasm_query<T>(&self, payload: T, block_height: Option<u64>) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync,
    {
        let contract_address = self.contract_address.as_ref().ok_or_else(|| {
            ChainCommunicationError::from_other_str("No contract address available")
        })?;
        self.wasm_query_to(contract_address.address(), payload, block_height)
            .await
    }

    async fn wasm_query_to<T>(
        &self,
        to: String,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = WasmQueryClient::new(self.channel.clone());
        let mut request = tonic::Request::new(QuerySmartContractStateRequest {
            address: to,
            query_data: serde_json::to_string(&payload)?.as_bytes().to_vec(),
        });

        if let Some(block_height) = block_height {
            request
                .metadata_mut()
                .insert("x-cosmos-block-height", block_height.into());
        }

        let response = client
            .smart_contract_state(request)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        Ok(response.data)
    }

    async fn wasm_send<T>(&self, payload: T, gas_limit: Option<U256>) -> ChainResult<TxResponse>
    where
        T: Serialize + Send + Sync,
    {
        let signer = self.get_signer()?;
        let mut client = TxServiceClient::new(self.channel.clone());
        let contract_address = self.contract_address.as_ref().ok_or_else(|| {
            ChainCommunicationError::from_other_str("No contract address available")
        })?;

        let msgs = vec![MsgExecuteContract {
            sender: signer.address.clone(),
            contract: contract_address.address(),
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        }
        .to_any()
        .map_err(ChainCommunicationError::from_other)?];

        // We often use U256s to represent gas limits, but Cosmos expects u64s. Try to convert,
        // and if it fails, just fallback to None which will result in gas estimation.
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

        let tx_req = BroadcastTxRequest {
            tx_bytes: self.generate_raw_signed_tx(msgs, gas_limit).await?,
            mode: BroadcastMode::Sync as i32,
        };

        let tx_res = client
            .broadcast_tx(tx_req)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?
            .into_inner()
            .tx_response
            .ok_or_else(|| ChainCommunicationError::from_other_str("Empty tx_response"))?;

        Ok(tx_res)
    }

    async fn wasm_estimate_gas<T>(&self, payload: T) -> ChainResult<u64>
    where
        T: Serialize + Send + Sync,
    {
        // Estimating gas requires a signer, which we can reasonably expect to have
        // since we need one to send a tx with the estimated gas anyways.
        let signer = self.get_signer()?;
        let contract_address = self.contract_address.as_ref().ok_or_else(|| {
            ChainCommunicationError::from_other_str("No contract address available")
        })?;
        let msg = MsgExecuteContract {
            sender: signer.address.clone(),
            contract: contract_address.address(),
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };

        let response = self
            .estimate_gas(vec![msg
                .to_any()
                .map_err(ChainCommunicationError::from_other)?])
            .await?;

        Ok(response)
    }
}
