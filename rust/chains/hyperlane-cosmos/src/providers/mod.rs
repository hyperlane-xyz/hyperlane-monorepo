use async_trait::async_trait;
use cosmrs::cosmwasm::MsgExecuteContract;
use cosmrs::crypto::PublicKey;
use cosmrs::tx::{MessageExt, SequenceNumber, SignerInfo};
use cosmrs::{AccountId, Tx};
use itertools::Itertools;
use tendermint::hash::Algorithm;
use tendermint::Hash;
use tendermint_rpc::{client::CompatMode, Client, HttpClient};
use time::OffsetDateTime;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, TxnInfo, TxnReceiptInfo, H256, U256,
};

use crate::address::CosmosAddress;
use crate::grpc::WasmProvider;
use crate::libs::account::CosmosAccountId;
use crate::{ConnectionConf, CosmosAmount, HyperlaneCosmosError, Signer};

use self::grpc::WasmGrpcProvider;

/// cosmos grpc provider
pub mod grpc;
/// cosmos rpc provider
pub mod rpc;

/// Abstraction over a connection to a Cosmos chain
#[derive(Debug, Clone)]
pub struct CosmosProvider {
    domain: HyperlaneDomain,
    connection_conf: ConnectionConf,
    grpc_client: WasmGrpcProvider,
    rpc_client: HttpClient,
}

impl CosmosProvider {
    /// Create a reference to a Cosmos chain
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        locator: Option<ContractLocator>,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let gas_price = CosmosAmount::try_from(conf.get_minimum_gas_price().clone())?;
        let grpc_client = WasmGrpcProvider::new(
            domain.clone(),
            conf.clone(),
            gas_price.clone(),
            locator,
            signer,
        )?;
        let rpc_client = HttpClient::builder(
            conf.get_rpc_url()
                .parse()
                .map_err(Into::<HyperlaneCosmosError>::into)?,
        )
        // Consider supporting different compatibility modes.
        .compat_mode(CompatMode::latest())
        .build()
        .map_err(Into::<HyperlaneCosmosError>::into)?;

        Ok(Self {
            domain,
            connection_conf: conf,
            rpc_client,
            grpc_client,
        })
    }

    /// Get a grpc client
    pub fn grpc(&self) -> &WasmGrpcProvider {
        &self.grpc_client
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &HttpClient {
        &self.rpc_client
    }

    fn search_payer_in_signer_infos(
        &self,
        signer_infos: &[SignerInfo],
        payer: &AccountId,
    ) -> Result<(AccountId, SequenceNumber), ChainCommunicationError> {
        signer_infos
            .iter()
            .map(|si| self.convert_signer_info_into_account_id_and_nonce(si))
            // After the following we have a single Ok entry and, possibly, many Err entries
            .filter_ok(|(a, s)| payer == a)
            // If we have Ok entry, use it since it is the payer, if not, use the first entry with error
            .find_or_first(|r| match r {
                Ok((a, s)) => payer == a,
                Err(e) => false,
            })
            // If there were not any signer info with non-empty public key or no signers for the transaction,
            // we get None here
            .unwrap_or_else(|| Err(ChainCommunicationError::from_other_str("no signer info")))
    }

    fn convert_signer_info_into_account_id_and_nonce(
        &self,
        signer_info: &SignerInfo,
    ) -> Result<(AccountId, SequenceNumber), ChainCommunicationError> {
        let signer_public_key = signer_info.public_key.clone().ok_or_else(|| {
            ChainCommunicationError::from_other_str("no public key for default signer")
        })?;

        let public_key = PublicKey::try_from(signer_public_key)?;

        let account_id = CosmosAccountId::account_id_from_pubkey(
            public_key,
            &self.connection_conf.get_bech32_prefix(),
        )?;

        Ok((account_id, signer_info.sequence))
    }
}

impl HyperlaneChain for CosmosProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for CosmosProvider {
    async fn get_block_by_hash(&self, hash: &H256) -> ChainResult<BlockInfo> {
        let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
            .expect("block hash should be of correct size");

        let response = self
            .rpc_client
            .block_by_hash(tendermint_hash)
            .await
            .map_err(ChainCommunicationError::from_other)?;

        let received_hash = H256::from_slice(response.block_id.hash.as_bytes());

        if &received_hash != hash {
            return Err(ChainCommunicationError::from_other_str(
                &format!("received incorrect block, expected hash: {hash:?}, received hash: {received_hash:?}")
            ));
        }

        let block = response.block.ok_or_else(|| {
            ChainCommunicationError::from_other_str(&format!(
                "empty block info for block: {:?}",
                hash
            ))
        })?;

        let time: OffsetDateTime = block.header.time.into();

        let block_info = BlockInfo {
            hash: hash.to_owned(),
            timestamp: time.unix_timestamp() as u64,
            number: block.header.height.value(),
        };

        Ok(block_info)
    }

    async fn get_txn_by_hash(&self, hash: &H256) -> ChainResult<TxnInfo> {
        let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
            .expect("transaction hash should be of correct size");

        // TODO add proper error handling
        let response = self
            .rpc_client
            .tx(tendermint_hash, false)
            .await
            .map_err(|_| ChainCommunicationError::from_other_str("generic error"))?;

        let received_hash = H256::from_slice(response.hash.as_bytes());

        if &received_hash != hash {
            return Err(ChainCommunicationError::from_other_str(
                "received incorrect transaction",
            ));
        }

        let tx = Tx::from_bytes(&response.tx).map_err(|_| {
            ChainCommunicationError::from_other_str("could not deserialize transaction")
        })?;

        // TODO assuming that there is only one message in the transaction and it is execute contract message
        let any = tx.body.messages.get(0).unwrap();
        let proto =
            cosmrs::proto::cosmwasm::wasm::v1::MsgExecuteContract::from_any(any).map_err(|e| {
                ChainCommunicationError::from_other_str(
                    "could not decode contract execution message",
                )
            })?;
        let msg = MsgExecuteContract::try_from(proto)
            .map_err(|e| ChainCommunicationError::from_other_str("could not convert from proto"))?;
        let contract = H256::try_from(CosmosAccountId::new(&msg.contract))?;

        let (sender, nonce) = tx
            .auth_info
            .fee
            .payer
            .as_ref()
            .map(|payer| self.search_payer_in_signer_infos(&tx.auth_info.signer_infos, payer))
            .unwrap_or_else(|| {
                let signer_info = tx.auth_info.signer_infos.get(0).ok_or_else(|| {
                    ChainCommunicationError::from_other_str("no signer info in default signer")
                })?;
                self.convert_signer_info_into_account_id_and_nonce(signer_info)
            })
            .map(|(a, n)| CosmosAddress::from_account_id(a).map(|a| (a.digest(), n)))??;

        // TODO support multiple denomination for amount
        let gas_limit = U256::from(tx.auth_info.fee.gas_limit);
        let fee = tx
            .auth_info
            .fee
            .amount
            .iter()
            .fold(U256::zero(), |acc, a| acc + a.amount);

        let gas_price = fee / gas_limit;

        let tx_info = TxnInfo {
            hash: hash.to_owned(),
            gas_limit: U256::from(response.tx_result.gas_wanted),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: Some(gas_price),
            nonce,
            sender,
            recipient: Some(contract),
            receipt: Some(TxnReceiptInfo {
                gas_used: U256::from(response.tx_result.gas_used),
                cumulative_gas_used: U256::from(response.tx_result.gas_used),
                effective_gas_price: Some(gas_price),
            }),
        };

        Ok(tx_info)
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        match self.grpc_client.wasm_contract_info().await {
            Ok(c) => Ok(true),
            Err(e) => Ok(false),
        }
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        Ok(self
            .grpc_client
            .get_balance(address, self.connection_conf.get_canonical_asset())
            .await?)
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        Ok(None)
    }
}
