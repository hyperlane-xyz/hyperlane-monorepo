use async_trait::async_trait;
use cosmrs::proto::cosmos::auth::v1beta1::BaseAccount;
use cosmrs::proto::cosmos::auth::v1beta1::{
    query_client::QueryClient as QueryAccountClient, QueryAccountRequest,
};
use cosmrs::proto::cosmos::base::abci::v1beta1::TxResponse;
use cosmrs::proto::cosmos::base::tendermint::v1beta1::{
    service_client::ServiceClient, GetLatestBlockRequest,
};
use cosmrs::proto::cosmos::tx::v1beta1::service_client::ServiceClient as TxServiceClient;
use cosmrs::proto::cosmos::tx::v1beta1::{
    BroadcastMode, BroadcastTxRequest, SimulateRequest, SimulateResponse,
};
use cosmrs::proto::cosmwasm::wasm::v1::{
    query_client::QueryClient as WasmQueryClient, MsgExecuteContract,
    QuerySmartContractStateRequest,
};
use cosmrs::proto::traits::Message;

use cosmrs::tx::{self, Fee, MessageExt, SignDoc, SignerInfo};
use cosmrs::{Amount, Coin};
use hyperlane_core::{ChainCommunicationError, ChainResult, ContractLocator, H256, U256};
use serde::Serialize;
use tonic::transport::{Channel, Endpoint};

use crate::{signers::Signer, ConnectionConf};
use crate::{verify, HyperlaneCosmosError};

const DEFAULT_GAS_PRICE: f32 = 0.05;
const DEFAULT_GAS_ADJUSTMENT: f32 = 1.25;

#[async_trait]
/// Cosmwasm GRPC Provider
pub trait WasmProvider: Send + Sync {
    /// get latest block height
    async fn latest_block_height(&self) -> ChainResult<u64>;

    /// query to already define contract address
    async fn wasm_query<T: Serialize + Sync + Send>(
        &self,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>;

    /// query to specific contract address
    async fn wasm_query_to<T: Serialize + Sync + Send>(
        &self,
        to: String,
        payload: T,
        block_height: Option<u64>,
    ) -> ChainResult<Vec<u8>>;

    /// query account info
    async fn account_query(&self, address: String) -> ChainResult<BaseAccount>;

    /// simulate raw tx
    async fn simulate_raw_tx<I: IntoIterator<Item = cosmrs::Any> + Sync + Send>(
        &self,
        msgs: I,
    ) -> ChainResult<SimulateResponse>;

    /// generate raw tx
    async fn generate_raw_tx<I: IntoIterator<Item = cosmrs::Any> + Sync + Send>(
        &self,
        msgs: I,
        gas_limit: Option<U256>,
    ) -> ChainResult<Vec<u8>>;

    /// send tx
    async fn wasm_send<T: Serialize + Sync + Send>(
        &self,
        payload: T,
        gas_limit: Option<U256>,
    ) -> ChainResult<TxResponse>;

    /// simulate tx
    async fn wasm_simulate<T: Serialize + Sync + Send>(
        &self,
        payload: T,
    ) -> ChainResult<SimulateResponse>;
}

#[derive(Debug)]
/// Cosmwasm GRPC Provider
pub struct WasmGrpcProvider {
    conf: ConnectionConf,
    address: H256,
    signer: Signer,
    /// GRPC Channel that can be cheaply cloned.
    /// See https://docs.rs/tonic/latest/tonic/transport/struct.Channel.html#multiplexing-requests
    channel: Channel,
}

impl WasmGrpcProvider {
    /// create new Cosmwasm GRPC Provider
    pub fn new(
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Signer,
    ) -> ChainResult<Self> {
        let channel = Endpoint::new(conf.get_grpc_url())?.connect_lazy();
        Ok(Self {
            conf,
            address: locator.address,
            signer,
            channel,
        })
    }

    fn get_contract_addr(&self) -> ChainResult<String> {
        verify::digest_to_addr(self.address, self.signer.prefix.as_str())
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
        self.wasm_query_to(self.get_contract_addr()?, payload, block_height)
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

    async fn account_query(&self, account: String) -> ChainResult<BaseAccount> {
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
        )?;
        Ok(account)
    }

    async fn simulate_raw_tx<I>(&self, msgs: I) -> ChainResult<SimulateResponse>
    where
        I: IntoIterator<Item = cosmrs::Any> + Send + Sync,
    {
        let mut client = TxServiceClient::new(self.channel.clone());

        let tx_bytes = self.generate_raw_tx(msgs, None).await?;
        #[allow(deprecated)]
        let sim_req = tonic::Request::new(SimulateRequest { tx: None, tx_bytes });
        let mut sim_res = client
            .simulate(sim_req)
            .await
            .map_err(ChainCommunicationError::from_other)?
            .into_inner();

        // apply gas adjustment
        sim_res.gas_info.as_mut().map(|v| {
            v.gas_used = (v.gas_used as f32 * DEFAULT_GAS_ADJUSTMENT) as u64;
            v
        });

        Ok(sim_res)
    }

    async fn generate_raw_tx<I>(&self, msgs: I, gas_limit: Option<U256>) -> ChainResult<Vec<u8>>
    where
        I: IntoIterator<Item = cosmrs::Any> + Send + Sync,
    {
        let account_info = self.account_query(self.signer.address.clone()).await?;

        let private_key = self.signer.signing_key()?;
        let public_key = private_key.public_key();

        let tx_body = tx::Body::new(msgs, "", 9000000u32);
        let signer_info =
            SignerInfo::single_direct(Some(self.signer.public_key), account_info.sequence);

        let gas_limit: u64 = gas_limit.unwrap_or(U256::from(300000u64)).as_u64();

        let auth_info = signer_info.auth_info(Fee::from_amount_and_gas(
            Coin::new(
                Amount::from((gas_limit as f32 * DEFAULT_GAS_PRICE) as u64),
                self.conf.get_canonical_asset().as_str(),
            )?,
            gas_limit,
        ));

        // signing
        let sign_doc = SignDoc::new(
            &tx_body,
            &auth_info,
            &self.conf.get_chain_id().parse()?,
            account_info.account_number,
        )?;

        let tx_signed = sign_doc.sign(&private_key)?;

        Ok(tx_signed.to_bytes()?)
    }

    async fn wasm_send<T>(&self, payload: T, gas_limit: Option<U256>) -> ChainResult<TxResponse>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = TxServiceClient::new(self.channel.clone());

        let msgs = vec![MsgExecuteContract {
            sender: self.signer.address.clone(),
            contract: self.get_contract_addr()?,
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        }
        .to_any()
        .map_err(ChainCommunicationError::from_other)?];

        let tx_req = BroadcastTxRequest {
            tx_bytes: self.generate_raw_tx(msgs, gas_limit).await?,
            mode: BroadcastMode::Sync as i32,
        };

        let tx_res = client
            .broadcast_tx(tx_req)
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?
            .into_inner()
            .tx_response
            .ok_or_else(|| ChainCommunicationError::from_other_str("Empty tx_response"))?;
        if tx_res.code != 0 {
            println!("TX_ERROR: {}", tx_res.raw_log);
        }

        Ok(tx_res)
    }

    async fn wasm_simulate<T>(&self, payload: T) -> ChainResult<SimulateResponse>
    where
        T: Serialize + Send + Sync,
    {
        let msg = MsgExecuteContract {
            sender: self.signer.address.clone(),
            contract: self.get_contract_addr()?,
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };

        let response = self
            .simulate_raw_tx(vec![msg
                .to_any()
                .map_err(ChainCommunicationError::from_other)?])
            .await?;

        Ok(response)
    }
}
