use std::str::FromStr;

use cosmrs::{
    cosmwasm::MsgExecuteContract as MsgExecuteContractRequest,
    proto::{
        self,
        cosmwasm::wasm::v1::{
            query_client::QueryClient as WasmQueryClient, ContractInfo, MsgExecuteContract,
            QueryContractInfoRequest, QuerySmartContractStateRequest,
        },
    },
    AccountId, Any, Tx,
};
use serde::Serialize;
use tonic::async_trait;
use tracing::warn;

use hyperlane_core::{ChainCommunicationError, ChainResult, H256, H512};

use crate::{
    BuildableQueryClient, CosmosAccountId, CosmosAddress, GrpcProvider, HyperlaneCosmosError,
};

use super::payloads::packet_data::PacketData;

/// A client for querying a CosmWasm contract.
/// This client is used to query the state of a contract, and to encode messages to be sent to the contract.
#[derive(Clone, Debug)]
pub struct CwQueryClient {
    /// grpc provider
    grpc: GrpcProvider,
    contract_address: CosmosAddress,
    signer: Option<crate::Signer>,
    prefix: String,
    address_bytes: usize,
}

#[async_trait]
impl BuildableQueryClient for CwQueryClient {
    fn build_query_client(
        grpc: GrpcProvider,
        conf: &crate::ConnectionConf,
        locator: &hyperlane_core::ContractLocator,
        signer: Option<crate::Signer>,
    ) -> hyperlane_core::ChainResult<Self> {
        let contract_address = CosmosAddress::from_h256(
            locator.address,
            &conf.get_bech32_prefix(),
            conf.get_contract_address_bytes(),
        )?;
        Ok(Self {
            grpc,
            contract_address,
            signer,
            prefix: conf.get_bech32_prefix(),
            address_bytes: conf.get_contract_address_bytes(),
        })
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        let cosmos_address = CosmosAddress::from_h256(*address, &self.prefix, self.address_bytes)?;
        match self.wasm_contract_info(cosmos_address.address()).await {
            Ok(_) => Ok(true),
            Err(_) => Ok(false),
        }
    }

    // extract the message recipient contract address from the tx
    // this is implementation specific
    fn parse_tx_message_recipient(&self, tx: &Tx, tx_hash: &H512) -> ChainResult<H256> {
        Self::contract(tx, tx_hash)
    }
}

impl CwQueryClient {
    // Extract contract address from transaction.
    fn contract(tx: &Tx, tx_hash: &H512) -> ChainResult<H256> {
        // We merge two error messages together so that both of them are reported
        match Self::contract_address_from_msg_execute_contract(tx) {
            Ok(contract) => Ok(contract),
            Err(msg_execute_contract_error) => {
                match Self::contract_address_from_msg_recv_packet(tx) {
                    Ok(contract) => Ok(contract),
                    Err(msg_recv_packet_error) => {
                        let errors = vec![msg_execute_contract_error, msg_recv_packet_error];
                        let error = HyperlaneCosmosError::ParsingAttemptsFailed(errors);
                        warn!(?tx_hash, ?error);
                        Err(ChainCommunicationError::from_other(error))?
                    }
                }
            }
        }
    }

    /// Assumes that there is only one `MsgExecuteContract` message in the transaction
    fn contract_address_from_msg_execute_contract(tx: &Tx) -> Result<H256, HyperlaneCosmosError> {
        let contract_execution_messages = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == "/cosmwasm.wasm.v1.MsgExecuteContract")
            .cloned()
            .collect::<Vec<Any>>();

        let contract_execution_messages_len = contract_execution_messages.len();
        if contract_execution_messages_len > 1 {
            let msg = "transaction contains multiple contract execution messages";
            Err(HyperlaneCosmosError::ParsingFailed(msg.to_owned()))?
        }

        let any = contract_execution_messages.first().ok_or_else(|| {
            let msg = "could not find contract execution message";
            HyperlaneCosmosError::ParsingFailed(msg.to_owned())
        })?;
        let proto: proto::cosmwasm::wasm::v1::MsgExecuteContract =
            any.to_msg().map_err(Into::<HyperlaneCosmosError>::into)?;
        let msg = MsgExecuteContractRequest::try_from(proto)?;
        let contract = H256::try_from(CosmosAccountId::new(&msg.contract))?;

        Ok(contract)
    }

    fn contract_address_from_msg_recv_packet(tx: &Tx) -> Result<H256, HyperlaneCosmosError> {
        let packet_data = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == "/ibc.core.channel.v1.MsgRecvPacket")
            .map(PacketData::try_from)
            .flat_map(|r| r.ok())
            .next()
            .ok_or_else(|| {
                let msg = "could not find IBC receive packets message containing receiver address";
                HyperlaneCosmosError::ParsingFailed(msg.to_owned())
            })?;

        let account_id = AccountId::from_str(&packet_data.receiver).map_err(Box::new)?;
        let address = H256::try_from(CosmosAccountId::new(&account_id))?;

        Ok(address)
    }

    /// Gets a signer, or returns an error if one is not available.
    fn get_signer(&self) -> ChainResult<&crate::Signer> {
        self.signer
            .as_ref()
            .ok_or(ChainCommunicationError::SignerUnavailable)
    }

    /// Gets the contract info for the configured address in the query client
    /// Can check if the contract is a valid CosmWasm contract
    pub async fn wasm_contract_info(&self, address: String) -> ChainResult<ContractInfo> {
        let response = self
            .grpc
            .call(move |provider| {
                let address = address.clone();
                let future = async move {
                    let address = address.clone();
                    let mut client = WasmQueryClient::new(provider.channel());
                    let request = tonic::Request::new(QueryContractInfoRequest { address });

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
                };
                Box::pin(future)
            })
            .await?;

        Ok(response)
    }

    /// Encodes a contract payload to a message that can be sent to the chain
    pub fn wasm_encode_msg<T>(&self, payload: T) -> ChainResult<Any>
    where
        T: Serialize + Send + Sync,
    {
        // Estimating gas requires a signer, which we can reasonably expect to have
        // since we need one to send a tx with the estimated gas anyways.
        let signer = self.get_signer()?;
        let contract_address = self.contract_address.address();
        let msg = MsgExecuteContract {
            sender: signer.address.clone(),
            contract: contract_address,
            msg: serde_json::to_string(&payload)?.as_bytes().to_vec(),
            funds: vec![],
        };

        Any::from_msg(&msg).map_err(ChainCommunicationError::from_other)
    }

    /// Executes a state query on the contract
    pub async fn wasm_query<T>(&self, payload: T, block_height: Option<u64>) -> ChainResult<Vec<u8>>
    where
        T: Serialize + Send + Sync + Clone + std::fmt::Debug,
    {
        let contract_address = self.contract_address.address();
        let query_data = serde_json::to_string(&payload)?.as_bytes().to_vec();
        let response = self
            .grpc
            .call(move |provider| {
                let to = contract_address.clone();
                let query_data = query_data.clone();
                let future = async move {
                    let mut client = WasmQueryClient::new(provider.channel());
                    let mut request = tonic::Request::new(QuerySmartContractStateRequest {
                        address: to.clone(),
                        query_data: query_data.clone(),
                    });
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
                };
                Box::pin(future)
            })
            .await?;
        Ok(response)
    }
}

#[cfg(test)]

mod test {
    use std::str::FromStr;

    use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;
    use url::Url;

    use hyperlane_core::{
        config::OpSubmissionConfig, ContractLocator, HyperlaneDomain, KnownHyperlaneDomain,
        NativeToken,
    };

    use super::{BuildableQueryClient, CwQueryClient};
    use crate::{ConnectionConf, CosmosAddress, GrpcProvider, RawCosmosAmount};

    #[ignore]
    #[tokio::test]
    async fn test_wasm_contract_info_success() {
        // given
        let provider =
            provider("neutron1sjzzd4gwkggy6hrrs8kxxatexzcuz3jecsxm3wqgregkulzj8r7qlnuef4");

        // when
        let result = provider
            .wasm_contract_info(provider.contract_address.address())
            .await;

        // then
        assert!(result.is_ok());

        let contract_info = result.unwrap();

        assert_eq!(
            contract_info.creator,
            "neutron1dwnrgwsf5c9vqjxsax04pdm0mx007yrre4yyvm",
        );
        assert_eq!(
            contract_info.admin,
            "neutron1fqf5mprg3f5hytvzp3t7spmsum6rjrw80mq8zgkc0h6rxga0dtzqws3uu7",
        );
    }

    #[ignore]
    #[tokio::test]
    async fn test_wasm_contract_info_no_contract() {
        // given
        let provider = provider("neutron1dwnrgwsf5c9vqjxsax04pdm0mx007yrre4yyvm");

        // when
        let result = provider
            .wasm_contract_info(provider.contract_address.address())
            .await;

        // then
        assert!(result.is_err());
    }

    fn provider(address: &str) -> CwQueryClient {
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::Neutron);
        let address = CosmosAddress::from_str(address).unwrap();
        let locator = ContractLocator::new(&domain, address.digest());
        let conf = ConnectionConf::new(
            vec![Url::parse("http://grpc-kralum.neutron-1.neutron.org:80").unwrap()],
            vec![Url::parse("https://rpc-kralum.neutron-1.neutron.org").unwrap()],
            "neutron-1".to_owned(),
            "neutron".to_owned(),
            "untrn".to_owned(),
            RawCosmosAmount::new("untrn".to_owned(), "0".to_owned()),
            32,
            OpSubmissionConfig {
                batch_contract_address: None,
                max_batch_size: 1,
                ..Default::default()
            },
            NativeToken {
                decimals: 6,
                denom: "untrn".to_owned(),
            },
            1.4f64,
        );

        let grpc = GrpcProvider::new(&conf, PrometheusClientMetrics::default(), None).unwrap();

        CwQueryClient::build_query_client(grpc, &conf, &locator, None).unwrap()
    }
}
