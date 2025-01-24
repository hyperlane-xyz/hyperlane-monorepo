use std::io::Cursor;

use cosmrs::{
    crypto::PublicKey,
    proto::{cosmos::base::abci::v1beta1::TxResponse, tendermint::types::Block},
    tx::{SequenceNumber, SignerInfo, SignerPublicKey},
    AccountId, Any, Coin, Tx,
};

use super::{grpc::GrpcProvider, rest::RestProvider, CosmosFallbackProvider};
use crate::{
    ConnectionConf, CosmosAccountId, CosmosAddress, CosmosAmount, HyperlaneCosmosError, Signer,
};
use hyperlane_core::{
    h512_to_bytes,
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    utils::{self, to_atto},
    AccountAddressType, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult,
    ContractLocator, HyperlaneChain, HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError,
    LogMeta, ModuleType, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};
use itertools::Itertools;
use prost::Message;
use reqwest::Error;
use serde::{de::DeserializeOwned, Deserialize};
use tendermint::{hash::Algorithm, Hash};
use tendermint_rpc::{
    client::CompatMode,
    endpoint::{block, block_results, tx},
    Client, HttpClient,
};
use time::OffsetDateTime;
use tonic::async_trait;
use tracing::{debug, trace, warn};

// proto structs for encoding and decoding transactions
#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgProcessMessage {
    #[prost(string, tag = "1")]
    pub mailbox_id: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub relayer: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub metadata: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub message: ::prost::alloc::string::String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgAnnounceValidator {
    #[prost(string, tag = "1")]
    pub validator: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub storage_location: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub signature: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub mailbox_id: ::prost::alloc::string::String,
    #[prost(string, tag = "5")]
    pub creator: ::prost::alloc::string::String,
}

#[derive(Clone, PartialEq, ::prost::Message)]
pub struct MsgRemoteTransfer {
    #[prost(string, tag = "1")]
    pub sender: ::prost::alloc::string::String,
    #[prost(string, tag = "2")]
    pub token_id: ::prost::alloc::string::String,
    #[prost(string, tag = "3")]
    pub recipient: ::prost::alloc::string::String,
    #[prost(string, tag = "4")]
    pub amount: ::prost::alloc::string::String,
}

#[derive(Debug, Clone)]
struct CosmosHttpClient {
    client: HttpClient,
}

#[derive(Debug, Clone)]
pub struct CosmosNativeProvider {
    connection_conf: ConnectionConf,
    provider: CosmosFallbackProvider<CosmosHttpClient>,
    grpc: GrpcProvider,
    rest: RestProvider,
    domain: HyperlaneDomain,
}

impl CosmosNativeProvider {
    #[doc = "Create a new Cosmos Provider instance"]
    pub fn new(
        domain: HyperlaneDomain,
        conf: ConnectionConf,
        locator: ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self> {
        let clients = conf
            .get_rpc_urls()
            .iter()
            .map(|url| {
                tendermint_rpc::Url::try_from(url.to_owned())
                    .map_err(ChainCommunicationError::from_other)
                    .and_then(|url| {
                        tendermint_rpc::HttpClientUrl::try_from(url)
                            .map_err(ChainCommunicationError::from_other)
                    })
                    .and_then(|url| {
                        HttpClient::builder(url)
                            .compat_mode(CompatMode::latest())
                            .build()
                            .map_err(ChainCommunicationError::from_other)
                    })
                    .map(|client| CosmosHttpClient { client })
            })
            .collect::<Result<Vec<_>, _>>()?;

        let providers = FallbackProvider::new(clients);
        let client = CosmosFallbackProvider::new(providers);

        let gas_price = CosmosAmount::try_from(conf.get_minimum_gas_price().clone())?;
        let grpc_provider = GrpcProvider::new(
            domain.clone(),
            conf.clone(),
            gas_price.clone(),
            locator,
            signer,
        )?;

        let rest = RestProvider::new(conf.get_api_urls().iter().map(|url| url.to_string()));

        Ok(CosmosNativeProvider {
            domain,
            connection_conf: conf,
            provider: client,
            grpc: grpc_provider,
            rest,
        })
    }

    // extract the contract address from the tx
    fn contract(tx: &Tx) -> ChainResult<H256> {
        // check for all transfer messages
        let remote_transfers: Vec<Any> = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == "/hyperlane.warp.v1.MsgRemoteTransfer")
            .cloned()
            .collect();

        if remote_transfers.len() > 1 {
            let msg = "transaction contains multiple execution messages";
            Err(HyperlaneCosmosError::ParsingFailed(msg.to_owned()))?
        }

        let msg = &remote_transfers[0];
        let result = MsgRemoteTransfer::decode(Cursor::new(msg.value.to_vec())).map_err(|err| {
            HyperlaneCosmosError::ParsingFailed(format!(
                "Can't parse any to MsgRemoteTransfer. {msg:?}"
            ))
        })?;

        let recipient = result.recipient;
        let recipient: H256 = recipient.parse()?;
        Ok(recipient)
    }

    fn search_payer_in_signer_infos(
        &self,
        signer_infos: &[SignerInfo],
        payer: &AccountId,
    ) -> ChainResult<(AccountId, SequenceNumber)> {
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
    ) -> ChainResult<(AccountId, SequenceNumber)> {
        let signer_public_key = signer_info.public_key.clone().ok_or_else(|| {
            HyperlaneCosmosError::PublicKeyError("no public key for default signer".to_owned())
        })?;

        let (key, account_address_type) = self.normalize_public_key(signer_public_key)?;
        let public_key = PublicKey::try_from(key)?;

        let account_id = CosmosAccountId::account_id_from_pubkey(
            public_key,
            &self.connection_conf.get_bech32_prefix(),
            &account_address_type,
        )?;

        Ok((account_id, signer_info.sequence))
    }

    fn normalize_public_key(
        &self,
        signer_public_key: SignerPublicKey,
    ) -> ChainResult<(SignerPublicKey, AccountAddressType)> {
        let public_key_and_account_address_type = match signer_public_key {
            SignerPublicKey::Single(pk) => (SignerPublicKey::from(pk), AccountAddressType::Bitcoin),
            SignerPublicKey::LegacyAminoMultisig(pk) => {
                (SignerPublicKey::from(pk), AccountAddressType::Bitcoin)
            }
            SignerPublicKey::Any(pk) => {
                if pk.type_url != PublicKey::ED25519_TYPE_URL
                    && pk.type_url != PublicKey::SECP256K1_TYPE_URL
                {
                    let msg = format!(
                        "can only normalize public keys with a known TYPE_URL: {}, {}",
                        PublicKey::ED25519_TYPE_URL,
                        PublicKey::SECP256K1_TYPE_URL,
                    );
                    warn!(pk.type_url, msg);
                    Err(HyperlaneCosmosError::PublicKeyError(msg.to_owned()))?
                }

                let (pub_key, account_address_type) =
                    (PublicKey::try_from(pk)?, AccountAddressType::Bitcoin);

                (SignerPublicKey::Single(pub_key), account_address_type)
            }
        };

        Ok(public_key_and_account_address_type)
    }

    /// Calculates the sender and the nonce for the transaction.
    /// We use `payer` of the fees as the sender of the transaction, and we search for `payer`
    /// signature information to find the nonce.
    /// If `payer` is not specified, we use the account which signed the transaction first, as
    /// the sender.
    pub fn sender_and_nonce(&self, tx: &Tx) -> ChainResult<(H256, SequenceNumber)> {
        let (sender, nonce) = tx
            .auth_info
            .fee
            .payer
            .as_ref()
            .map(|payer| self.search_payer_in_signer_infos(&tx.auth_info.signer_infos, payer))
            .map_or_else(
                || {
                    #[allow(clippy::get_first)] // TODO: `rustc` 1.80.1 clippy issue
                    let signer_info = tx.auth_info.signer_infos.get(0).ok_or_else(|| {
                        HyperlaneCosmosError::SignerInfoError(
                            "no signer info in default signer".to_owned(),
                        )
                    })?;
                    self.convert_signer_info_into_account_id_and_nonce(signer_info)
                },
                |p| p,
            )
            .map(|(a, n)| CosmosAddress::from_account_id(a).map(|a| (a.digest(), n)))??;
        Ok((sender, nonce))
    }

    /// Reports if transaction contains fees expressed in unsupported denominations
    /// The only denomination we support at the moment is the one we express gas minimum price
    /// in the configuration of a chain. If fees contain an entry in a different denomination,
    /// we report it in the logs.
    fn report_unsupported_denominations(&self, tx: &Tx, tx_hash: &H256) -> ChainResult<()> {
        let supported_denomination = self.connection_conf.get_minimum_gas_price().denom;
        let unsupported_denominations = tx
            .auth_info
            .fee
            .amount
            .iter()
            .filter(|c| c.denom.as_ref() != supported_denomination)
            .map(|c| c.denom.as_ref())
            .fold("".to_string(), |acc, denom| acc + ", " + denom);

        if !unsupported_denominations.is_empty() {
            let msg = "transaction contains fees in unsupported denominations, manual intervention is required";
            warn!(
                ?tx_hash,
                ?supported_denomination,
                ?unsupported_denominations,
                msg,
            );
            Err(ChainCommunicationError::CustomError(msg.to_owned()))?
        }

        Ok(())
    }

    /// Converts fees to a common denomination if necessary.
    ///
    /// If fees are expressed in an unsupported denomination, they will be ignored.
    fn convert_fee(&self, coin: &Coin) -> ChainResult<U256> {
        let native_token = self.connection_conf.get_native_token();

        if coin.denom.as_ref() != native_token.denom {
            return Ok(U256::zero());
        }

        let amount_in_native_denom = U256::from(coin.amount);

        to_atto(amount_in_native_denom, native_token.decimals).ok_or(
            ChainCommunicationError::CustomError("Overflow in calculating fees".to_owned()),
        )
    }

    fn calculate_gas_price(&self, hash: &H256, tx: &Tx) -> ChainResult<U256> {
        // TODO support multiple denominations for amount
        let supported = self.report_unsupported_denominations(tx, hash);
        if supported.is_err() {
            return Ok(U256::max_value());
        }

        let gas_limit = U256::from(tx.auth_info.fee.gas_limit);
        let fee = tx
            .auth_info
            .fee
            .amount
            .iter()
            .map(|c| self.convert_fee(c))
            .fold_ok(U256::zero(), |acc, v| acc + v)?;

        if fee < gas_limit {
            warn!(tx_hash = ?hash, ?fee, ?gas_limit, "calculated fee is less than gas limit. it will result in zero gas price");
        }

        Ok(fee / gas_limit)
    }

    pub fn grpc(&self) -> &GrpcProvider {
        &self.grpc
    }

    pub fn rest(&self) -> &RestProvider {
        &self.rest
    }

    pub async fn get_tx(&self, hash: &H512) -> ChainResult<tx::Response> {
        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));

        let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
            .expect("transaction hash should be of correct size");

        let response =
            self.provider
                .call(|client| {
                    let future = async move {
                        client.client.tx(tendermint_hash, false).await.map_err(|e| {
                            ChainCommunicationError::from(HyperlaneCosmosError::from(e))
                        })
                    };
                    Box::pin(future)
                })
                .await?;

        let received_hash = H256::from_slice(response.hash.as_bytes());
        if received_hash != hash {
            return Err(ChainCommunicationError::from_other_str(&format!(
                "received incorrect transaction, expected hash: {:?}, received hash: {:?}",
                hash, received_hash,
            )));
        }

        Ok(response)
    }

    pub async fn get_block(&self, height: u32) -> ChainResult<block::Response> {
        let response =
            self.provider
                .call(|client| {
                    let future = async move {
                        client.client.block(height).await.map_err(|e| {
                            ChainCommunicationError::from(HyperlaneCosmosError::from(e))
                        })
                    };
                    Box::pin(future)
                })
                .await?;

        Ok(response)
    }

    pub async fn get_block_results(&self, height: u32) -> ChainResult<block_results::Response> {
        let response =
            self.provider
                .call(|client| {
                    let future = async move {
                        client.client.block_results(height).await.map_err(|e| {
                            ChainCommunicationError::from(HyperlaneCosmosError::from(e))
                        })
                    };
                    Box::pin(future)
                })
                .await?;

        Ok(response)
    }
}

impl HyperlaneChain for CosmosNativeProvider {
    #[doc = " Return the domain"]
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    #[doc = " A provider for the chain"]
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for CosmosNativeProvider {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let response =
            self.provider
                .call(|client| {
                    let future = async move {
                        client.client.block(height as u32).await.map_err(|e| {
                            ChainCommunicationError::from(HyperlaneCosmosError::from(e))
                        })
                    };
                    Box::pin(future)
                })
                .await?;

        let block = response.block;
        let block_height = block.header.height.value();

        if block_height != height {
            Err(HyperlaneProviderError::IncorrectBlockByHeight(
                height,
                block_height,
            ))?
        }

        let hash = H256::from_slice(response.block_id.hash.as_bytes());
        let time: OffsetDateTime = block.header.time.into();

        let block_info = BlockInfo {
            hash: hash.to_owned(),
            timestamp: time.unix_timestamp() as u64,
            number: block_height,
        };

        Ok(block_info)
    }

    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));

        let tendermint_hash = Hash::from_bytes(Algorithm::Sha256, hash.as_bytes())
            .expect("transaction hash should be of correct size");

        let response =
            self.provider
                .call(|client| {
                    let future = async move {
                        client.client.tx(tendermint_hash, false).await.map_err(|e| {
                            ChainCommunicationError::from(HyperlaneCosmosError::from(e))
                        })
                    };
                    Box::pin(future)
                })
                .await?;

        let received_hash = H256::from_slice(response.hash.as_bytes());

        if received_hash != hash {
            return Err(ChainCommunicationError::from_other_str(&format!(
                "received incorrect transaction, expected hash: {:?}, received hash: {:?}",
                hash, received_hash,
            )));
        }

        let tx = Tx::from_bytes(&response.tx)?;

        let contract = Self::contract(&tx)?;
        let (sender, nonce) = self.sender_and_nonce(&tx)?;
        let gas_price = self.calculate_gas_price(&hash, &tx)?;

        let tx_info = TxnInfo {
            hash: hash.into(),
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
            raw_input_data: None,
        };

        Ok(tx_info)
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        // TODO: check if the address is a recipient
        return Ok(true);
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.grpc
            .get_balance(address, self.connection_conf.get_canonical_asset())
            .await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}

#[async_trait]
impl BlockNumberGetter for CosmosHttpClient {
    async fn get_block_number(&self) -> Result<u64, ChainCommunicationError> {
        let block = self
            .client
            .latest_block()
            .await
            .map_err(Into::<HyperlaneCosmosError>::into)?;
        Ok(block.block.header.height.value())
    }
}
