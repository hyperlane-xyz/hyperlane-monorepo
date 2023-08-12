use async_trait::async_trait;
use cosmrs::crypto::secp256k1::SigningKey;
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
use cosmrs::Coin;
use hyperlane_core::{ChainResult, ContractLocator, U256};
use serde::Serialize;
use std::num::NonZeroU64;
use std::str::FromStr;

use crate::verify;
use crate::{signers::Signer, ConnectionConf};

#[async_trait]
/// Cosmwasm GRPC Provider
pub trait WasmProvider: Send + Sync {
    /// get latest block height
    async fn latest_block_height(&self) -> ChainResult<u64>;
    /// query to already define contract address
    async fn wasm_query<T: Serialize + Sync + Send>(
        &self,
        payload: T,
        maybe_lag: Option<NonZeroU64>,
    ) -> ChainResult<Vec<u8>>;
    /// query to specific contract address
    async fn wasm_query_to<T: Serialize + Sync + Send>(
        &self,
        to: String,
        payload: T,
        maybe_lag: Option<NonZeroU64>,
    ) -> ChainResult<Vec<u8>>;
    /// query account info
    async fn account_query(&self, address: String) -> ChainResult<BaseAccount>;
    /// generate raw tx
    async fn generate_raw_tx<T: Serialize + Sync + Send>(
        &self,
        payload: T,
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
pub struct WasmGrpcProvider<'a> {
    conf: &'a ConnectionConf,
    locator: &'a ContractLocator<'a>,
    signer: &'a Signer,
}

impl<'a> WasmGrpcProvider<'a> {
    /// create new Cosmwasm GRPC Provider
    pub fn new(conf: &'a ConnectionConf, locator: &'a ContractLocator, signer: &'a Signer) -> Self {
        Self {
            conf,
            locator,
            signer,
        }
    }

    fn get_conn_url(&self) -> ChainResult<String> {
        Ok(self.conf.get_grpc_url())
    }

    fn get_contract_addr(&self) -> ChainResult<String> {
        verify::digest_to_addr(self.locator.address, self.signer.prefix.as_str())
    }
}

#[async_trait]
impl WasmProvider for WasmGrpcProvider<'_> {
    async fn latest_block_height(&self) -> ChainResult<u64> {
        let mut client = ServiceClient::connect(self.get_conn_url()?).await?;
        let request = tonic::Request::new(GetLatestBlockRequest {});

        let response = client.get_latest_block(request).await.unwrap().into_inner();
        let height = response.block.unwrap().header.unwrap().height;

        Ok(height as u64)
    }

    async fn wasm_query<T>(&self, payload: T, maybe_lag: Option<NonZeroU64>) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = WasmQueryClient::connect(self.get_conn_url()?).await?;

        let mut request = tonic::Request::new(QuerySmartContractStateRequest {
            address: self.signer.address(),
            query_data: serde_json::to_string(&payload)?.as_bytes().to_vec(),
        });

        if let Some(lag) = maybe_lag {
            let height = self.latest_block_height().await?;
            let height = height.saturating_sub(lag.get());

            request
                .metadata_mut()
                .insert("x-cosmos-block-height", height.into());
        }

        let response = client
            .smart_contract_state(request)
            .await
            .unwrap()
            .into_inner();

        // TODO: handle query to specific block number
        Ok(response.data)
    }

    async fn wasm_query_to<T>(
        &self,
        to: String,
        payload: T,
        maybe_lag: Option<NonZeroU64>,
    ) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = WasmQueryClient::connect(self.get_conn_url()?).await?;
        let mut request = tonic::Request::new(QuerySmartContractStateRequest {
            address: to,
            query_data: serde_json::to_string(&payload)?.as_bytes().to_vec(),
        });

        if let Some(lag) = maybe_lag {
            let height = self.latest_block_height().await?;
            let height = height.saturating_sub(lag.get());

            request
                .metadata_mut()
                .insert("x-cosmos-block-height", height.into());
        }

        let response = client
            .smart_contract_state(request)
            .await
            .unwrap()
            .into_inner();

        // TODO: handle query to specific block number
        Ok(response.data)
    }

    async fn account_query(&self, account: String) -> ChainResult<BaseAccount> {
        let mut client = QueryAccountClient::connect(self.get_conn_url()?).await?;

        let request = tonic::Request::new(QueryAccountRequest { address: account });
        let response = client.account(request).await.unwrap().into_inner();

        let account = BaseAccount::decode(response.account.unwrap().value.as_slice())?;
        Ok(account)
    }

    async fn generate_raw_tx<T>(&self, payload: T, gas_limit: Option<U256>) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync,
    {
        let account_info = self.account_query(self.signer.address()).await?;
        let contract_addr = self.get_contract_addr()?;

        let msg = MsgExecuteContract {
            sender: contract_addr.clone(),
            contract: contract_addr.clone(),
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };

        let private_key = SigningKey::from_slice(&self.signer.private_key).unwrap();
        let public_key = private_key.public_key();

        let tx_body = tx::Body::new(vec![msg.to_any().unwrap()], "", 900u16);
        let signer_info = SignerInfo::single_direct(Some(public_key), account_info.sequence);

        let gas_limit: u64 = gas_limit
            .unwrap_or(U256::from_str("100000").unwrap())
            .as_u64();

        let auth_info = signer_info.auth_info(Fee::from_amount_and_gas(
            Coin {
                denom: format!("u{}", self.signer.prefix.clone()).parse().unwrap(),
                amount: 10000u128,
            },
            gas_limit,
        ));

        // signing
        let sign_doc = SignDoc::new(
            &tx_body,
            &auth_info,
            &self.conf.get_chain_id().parse().unwrap(),
            account_info.account_number,
        )
        .unwrap();
        let tx_signed = sign_doc.sign(&private_key).unwrap();

        Ok(tx_signed.to_bytes().unwrap())
    }

    async fn wasm_send<T>(&self, payload: T, gas_limit: Option<U256>) -> ChainResult<TxResponse>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = TxServiceClient::connect(self.get_conn_url()?).await?;
        let tx_bytes = self.generate_raw_tx(payload, gas_limit).await?;
        let request = tonic::Request::new(BroadcastTxRequest {
            tx_bytes,
            mode: BroadcastMode::Block as i32,
        });

        let response = client.broadcast_tx(request).await.unwrap().into_inner();
        Ok(response.tx_response.unwrap())
    }

    async fn wasm_simulate<T>(&self, payload: T) -> ChainResult<SimulateResponse>
    where
        T: Serialize + Send + Sync,
    {
        let mut client = TxServiceClient::connect(self.get_conn_url()?).await?;
        let tx_bytes = self.generate_raw_tx(payload, None).await?;

        let request = tonic::Request::new(SimulateRequest { tx: None, tx_bytes });
        let response = client.simulate(request).await.unwrap().into_inner();

        Ok(response)
    }
}
