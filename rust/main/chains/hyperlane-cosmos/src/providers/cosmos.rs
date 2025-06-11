use cosmrs::{
    crypto::PublicKey,
    tx::{SequenceNumber, SignerInfo},
    AccountId, Coin, Tx,
};
use itertools::Itertools;
use time::OffsetDateTime;
use tonic::async_trait;
use tracing::warn;

use hyperlane_core::{
    h512_to_bytes, rpc_clients::BlockNumberGetter, utils::to_atto, BlockInfo,
    ChainCommunicationError, ChainInfo, ChainResult, ContractLocator, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, ReorgPeriod, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::{utils, ConnectionConf, CosmosAccountId, CosmosAddress, HyperlaneCosmosError, Signer};

use super::{grpc::GrpcProvider, rpc::RpcProvider};

/// Trait for the QueryClient to be used in the CosmosProvider
#[async_trait]
pub trait BuildableQueryClient: Sized + std::fmt::Debug + Sync + Send + 'static + Clone {
    /// Build the QueryClient
    fn build_query_client(
        grpc: GrpcProvider,
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signer>,
    ) -> ChainResult<Self>;

    /// Whether or not the given address is a contract
    async fn is_contract(&self, address: &H256) -> ChainResult<bool>;

    /// Extract the message recipient contract address from the tx
    /// this is implementation specific
    fn parse_tx_message_recipient(&self, tx: &Tx, hash: &H512) -> ChainResult<H256>;
}

/// Cosmos Provider
///
/// implements the HyperlaneProvider trait
#[derive(Debug, Clone)]
pub struct CosmosProvider<QueryClient> {
    conf: ConnectionConf,
    rpc: RpcProvider,
    domain: HyperlaneDomain,
    query: QueryClient,
}

impl<QueryClient: BuildableQueryClient> CosmosProvider<QueryClient> {
    /// Create a new Cosmos Provider instance
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let rpc = RpcProvider::new(conf.clone(), signer.clone(), metrics.clone(), chain.clone())?;
        let grpc = GrpcProvider::new(conf, metrics, chain)?;
        let query = QueryClient::build_query_client(grpc.clone(), conf, locator, signer)?;

        Ok(CosmosProvider {
            domain: locator.domain.clone(),
            conf: conf.clone(),
            rpc,
            query,
        })
    }

    /// RPC Provider
    ///
    /// This is used for general chain communication like getting the block number, block, transaction, etc.
    pub fn rpc(&self) -> &RpcProvider {
        &self.rpc
    }

    /// gRPC Provider
    ///
    /// This is used for the Module Communication and querying the module state. Like mailboxes, isms etc.
    pub fn query(&self) -> &QueryClient {
        &self.query
    }

    /// Get the block number according to the reorg period
    pub async fn reorg_to_height(&self, reorg: &ReorgPeriod) -> ChainResult<u64> {
        let height = self.rpc.get_block_number().await?;
        match reorg {
            ReorgPeriod::None => Ok(height),
            // height has to be at least 1 -> block 0 does not exist in cosmos
            ReorgPeriod::Blocks(blocks) => Ok(height.checked_sub(blocks.get() as u64).unwrap_or(1)),
            ReorgPeriod::Tag(_) => Err(ChainCommunicationError::InvalidReorgPeriod(reorg.clone())),
        }
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
            .filter_ok(|(a, _)| payer == a)
            // If we have Ok entry, use it since it is the payer, if not, use the first entry with error
            .find_or_first(|r| match r {
                Ok((a, _)) => payer == a,
                Err(_) => false,
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

        let (key, account_address_type) = utils::normalize_public_key(signer_public_key)?;
        let public_key = PublicKey::try_from(key)?;

        let account_id = CosmosAccountId::account_id_from_pubkey(
            public_key,
            &self.conf.get_bech32_prefix(),
            &account_address_type,
        )?;

        Ok((account_id, signer_info.sequence))
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
        let supported_denomination = self.conf.get_minimum_gas_price().denom;
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
        let native_token = self.conf.get_native_token();

        if coin.denom.as_ref() != native_token.denom {
            return Ok(U256::zero());
        }

        let amount_in_native_denom = U256::from(coin.amount);

        to_atto(amount_in_native_denom, native_token.decimals).ok_or(
            ChainCommunicationError::CustomError("Overflow in calculating fees".to_owned()),
        )
    }

    fn calculate_gas_price(&self, hash: &H256, tx: &Tx) -> ChainResult<U256> {
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
}

impl<T: BuildableQueryClient> HyperlaneChain for CosmosProvider<T> {
    /// Return the domain
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    /// A provider for the chain
    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl<T: BuildableQueryClient> HyperlaneProvider for CosmosProvider<T> {
    async fn get_block_by_height(&self, height: u64) -> ChainResult<BlockInfo> {
        let response = self.rpc.get_block(height as u32).await?;
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
        if hash.is_zero() {
            return Err(HyperlaneProviderError::CouldNotFindTransactionByHash(*hash).into());
        }
        let response = self.rpc.get_tx(hash).await?;
        let tx = Tx::from_bytes(&response.tx)?;

        let contract = self.query.parse_tx_message_recipient(&tx, hash)?;
        let (sender, nonce) = self.sender_and_nonce(&tx)?;

        let hash: H256 = H256::from_slice(&h512_to_bytes(hash));
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
                gas_used: response.tx_result.gas_used.into(),
                cumulative_gas_used: response.tx_result.gas_used.into(),
                effective_gas_price: Some(gas_price),
            }),
            raw_input_data: None,
        };

        Ok(tx_info)
    }

    async fn is_contract(&self, address: &H256) -> ChainResult<bool> {
        self.query.is_contract(address).await
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.rpc.get_balance(address).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let height = self.rpc().get_block_number().await?;
        let response = self.rpc().get_block(height as u32).await?;
        let hash = response.block.header.hash();
        let block_info = BlockInfo {
            hash: H256::from_slice(hash.as_bytes()),
            timestamp: response.block.header.time.unix_timestamp() as u64,
            number: height,
        };
        Ok(Some(ChainInfo {
            latest_block: block_info,
            min_gas_price: None,
        }))
    }
}
