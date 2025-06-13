use std::ops::Deref;

use cosmrs::{
    crypto::PublicKey,
    tx::{SequenceNumber, SignerInfo, SignerPublicKey},
    AccountId, Any, Coin, Tx,
};
use derive_new::new;
use hyperlane_cosmos_rs::{
    hyperlane::{core::v1::MsgProcessMessage, warp::v1::MsgRemoteTransfer},
    prost::{Message, Name},
};
use itertools::Itertools;
use time::OffsetDateTime;
use tonic::async_trait;
use tracing::warn;

use hyperlane_core::{
    h512_to_bytes,
    rpc_clients::{BlockNumberGetter, FallbackProvider},
    utils::to_atto,
    AccountAddressType, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult,
    ContractLocator, HyperlaneChain, HyperlaneDomain, HyperlaneMessage, HyperlaneProvider,
    HyperlaneProviderError, RawHyperlaneMessage, ReorgPeriod, TxnInfo, TxnReceiptInfo, H256, H512,
    U256,
};
use hyperlane_metric::prometheus_metric::PrometheusClientMetrics;

use crate::{
    ConnectionConf, GrpcProvider, HyperlaneKaspaError, KaspaAccountId, KaspaAddress, Signer,
};

use super::RpcProvider;

/// Wrapper of `FallbackProvider` for use in `hyperlane-kaspa-native`
#[derive(new, Clone)]
pub(crate) struct KaspaFallbackProvider<T> {
    fallback_provider: FallbackProvider<T, T>,
}

impl<T> Deref for KaspaFallbackProvider<T> {
    type Target = FallbackProvider<T, T>;

    fn deref(&self) -> &Self::Target {
        &self.fallback_provider
    }
}

impl<C> std::fmt::Debug for KaspaFallbackProvider<C>
where
    C: std::fmt::Debug,
{
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.fallback_provider.fmt(f)
    }
}

/// Kaspa Native Provider
///
/// implements the HyperlaneProvider trait
#[derive(Debug, Clone)]
pub struct KaspaProvider {
    conf: ConnectionConf,
    rpc: RpcProvider,
    domain: HyperlaneDomain,
    grpc: GrpcProvider,
}

impl KaspaProvider {
    /// Create a new Kaspa Provider instance
    pub fn new(
        conf: &ConnectionConf,
        locator: &ContractLocator,
        signer: Option<Signer>,
        metrics: PrometheusClientMetrics,
        chain: Option<hyperlane_metric::prometheus_metric::ChainInfo>,
    ) -> ChainResult<Self> {
        let rpc = RpcProvider::new(conf.clone(), signer, metrics.clone(), chain.clone())?;
        let grpc = GrpcProvider::new(conf.clone(), metrics, chain)?;

        Ok(KaspaProvider {
            domain: locator.domain.clone(),
            conf: conf.clone(),
            rpc,
            grpc,
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
    pub fn grpc(&self) -> &GrpcProvider {
        &self.grpc
    }

    /// Get the block number according to the reorg period
    pub async fn reorg_to_height(&self, reorg: &ReorgPeriod) -> ChainResult<u32> {
        let height = self.rpc.get_block_number().await? as u32;
        match reorg {
            ReorgPeriod::None => Ok(height),
            // height has to be at least 1 -> block 0 does not exist in kaspa
            ReorgPeriod::Blocks(blocks) => Ok(height.checked_sub(blocks.get()).unwrap_or(1)),
            ReorgPeriod::Tag(_) => Err(ChainCommunicationError::InvalidReorgPeriod(reorg.clone())),
        }
    }

    /// parses the message recipient if the transaction contains a MsgProcessMessage
    fn parse_msg_process_recipient(tx: &Tx) -> ChainResult<Option<H256>> {
        // check for all messages processes
        let processed_messages: Vec<Any> = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == MsgProcessMessage::type_url())
            .cloned()
            .collect();

        // right now one transaction can include max. one process
        if processed_messages.len() > 1 {
            let msg = "transaction contains multiple execution messages";
            Err(HyperlaneKaspaError::ParsingFailed(msg.to_owned()))?
        }

        let msg = processed_messages.first();
        match msg {
            Some(msg) => {
                let result = MsgProcessMessage::decode(msg.value.as_slice())
                    .map_err(HyperlaneKaspaError::from)?;
                let message: RawHyperlaneMessage = hex::decode(result.message)?;
                let message = HyperlaneMessage::from(message);
                Ok(Some(message.recipient))
            }
            None => Ok(None),
        }
    }

    /// parses the message recipient if the transaction contains a MsgRemoteTransfer
    fn parse_msg_remote_transfer_recipient(tx: &Tx) -> ChainResult<Option<H256>> {
        // check for all remote transfers
        let remote_transfers: Vec<Any> = tx
            .body
            .messages
            .iter()
            .filter(|a| a.type_url == MsgRemoteTransfer::type_url())
            .cloned()
            .collect();

        // right now one transaction can include max. one transfer
        if remote_transfers.len() > 1 {
            let msg = "transaction contains multiple execution messages";
            Err(HyperlaneKaspaError::ParsingFailed(msg.to_owned()))?
        }

        let msg = remote_transfers.first().ok_or_else(|| {
            ChainCommunicationError::from_other_str("tx does not contain any remote transfers")
        })?;
        let result =
            MsgRemoteTransfer::decode(msg.value.as_slice()).map_err(HyperlaneKaspaError::from)?;
        // the recipient is the token id of the transfer, which is the address that the user interacts with
        let recipient: H256 = result.token_id.parse()?;
        Ok(Some(recipient))
    }

    // extract the message recipient contract address from the tx
    // the tx is either a MsgPorcessMessage on the destination or a MsgRemoteTransfer on the origin
    // we check for both tx types, if both are missing or an error occurred while parsing we return the error
    fn parse_tx_message_recipient(tx: &Tx) -> ChainResult<H256> {
        // first check for the process message
        if let Some(recipient) = Self::parse_msg_process_recipient(tx)? {
            return Ok(recipient);
        }
        // if not found check for the remote transfer
        if let Some(recipient) = Self::parse_msg_remote_transfer_recipient(tx)? {
            return Ok(recipient);
        }
        // if both are missing we return an error
        Err(HyperlaneKaspaError::ParsingFailed(
            "transaction does not contain any process message or remote transfer".to_owned(),
        ))?
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
            HyperlaneKaspaError::PublicKeyError("no public key for default signer".to_owned())
        })?;

        let (key, account_address_type) = self.normalize_public_key(signer_public_key)?;
        let public_key = PublicKey::try_from(key)?;

        let account_id = KaspaAccountId::account_id_from_pubkey(
            public_key,
            &self.conf.get_bech32_prefix(),
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
                    Err(HyperlaneKaspaError::PublicKeyError(msg.to_owned()))?
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
                        HyperlaneKaspaError::SignerInfoError(
                            "no signer info in default signer".to_owned(),
                        )
                    })?;
                    self.convert_signer_info_into_account_id_and_nonce(signer_info)
                },
                |p| p,
            )
            .map(|(a, n)| KaspaAddress::from_account_id(a).map(|a| (a.digest(), n)))??;
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

impl HyperlaneChain for KaspaProvider {
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
impl HyperlaneProvider for KaspaProvider {
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

        let contract = Self::parse_tx_message_recipient(&tx)?;
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

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // TODO: check if the address is a recipient
        return Ok(true);
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        self.rpc.get_balance(address).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        return Ok(None);
    }
}
