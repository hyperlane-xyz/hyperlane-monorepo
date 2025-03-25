use std::sync::Arc;

use async_trait::async_trait;
use solana_sdk::signature::Signature;
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransactionWithStatusMeta, UiTransaction,
    UiTransactionStatusMeta,
};
use tracing::warn;

use hyperlane_core::{
    utils::to_atto, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, NativeToken, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};

use crate::error::HyperlaneSealevelError;
use crate::provider::recipient::RecipientProvider;
use crate::provider::transaction::{parsed_message, txn};
use crate::utils::{decode_h256, decode_h512, decode_pubkey};
use crate::{ConnectionConf, SealevelRpcClient};

mod recipient;
mod transaction;

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Clone, Debug)]
pub struct SealevelProvider {
    rpc_client: Arc<SealevelRpcClient>,
    domain: HyperlaneDomain,
    native_token: NativeToken,
    recipient_provider: RecipientProvider,
}

impl SealevelProvider {
    /// constructor
    pub fn new(
        rpc_client: Arc<SealevelRpcClient>,
        domain: HyperlaneDomain,
        contract_addresses: &[H256],
        conf: &ConnectionConf,
    ) -> Self {
        let native_token = conf.native_token.clone();
        let recipient_provider = RecipientProvider::new(contract_addresses);
        Self {
            rpc_client,
            domain,
            native_token,
            recipient_provider,
        }
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &SealevelRpcClient {
        &self.rpc_client
    }

    fn validate_transaction(hash: &H512, txn: &UiTransaction) -> ChainResult<()> {
        let received_signature = txn
            .signatures
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(Box::new(*hash)))?;
        let received_hash = decode_h512(received_signature)?;

        if &received_hash != hash {
            Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::IncorrectTransaction(
                    Box::new(*hash),
                    Box::new(received_hash),
                ),
            ))?;
        }
        Ok(())
    }

    fn sender(hash: &H512, txn: &UiTransaction) -> ChainResult<H256> {
        let message = parsed_message(txn)?;

        let signer = message
            .account_keys
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(Box::new(*hash)))?;
        let pubkey = decode_pubkey(&signer.pubkey)?;
        let sender = H256::from_slice(&pubkey.to_bytes());
        Ok(sender)
    }

    fn gas(meta: &UiTransactionStatusMeta) -> ChainResult<U256> {
        let OptionSerializer::Some(gas) = meta.compute_units_consumed else {
            Err(HyperlaneSealevelError::EmptyComputeUnitsConsumed)?
        };

        Ok(U256::from(gas))
    }

    /// Extracts and converts fees into atto (10^-18) units.
    ///
    /// We convert fees into atto units since otherwise a compute unit price (gas price)
    /// becomes smaller than 1 lamport (or 1 unit of native token) and the price is rounded
    /// to zero. We normalise the gas price for all the chain to be expressed in atto units.
    fn fee(&self, meta: &UiTransactionStatusMeta) -> ChainResult<U256> {
        let amount_in_native_denom = U256::from(meta.fee);

        to_atto(amount_in_native_denom, self.native_token.decimals).ok_or(
            ChainCommunicationError::CustomError("Overflow in calculating fees".to_owned()),
        )
    }

    fn meta(txn: &EncodedTransactionWithStatusMeta) -> ChainResult<&UiTransactionStatusMeta> {
        let meta = txn
            .meta
            .as_ref()
            .ok_or(HyperlaneSealevelError::EmptyMetadata)?;
        Ok(meta)
    }

    async fn block_info_by_height(&self, slot: u64) -> Result<BlockInfo, ChainCommunicationError> {
        let confirmed_block = self.rpc_client.get_block(slot).await?;

        let block_hash = decode_h256(&confirmed_block.blockhash)?;

        let block_time = confirmed_block
            .block_time
            .ok_or(HyperlaneProviderError::CouldNotFindBlockByHeight(slot))?;

        let block_info = BlockInfo {
            hash: block_hash,
            timestamp: block_time as u64,
            number: slot,
        };
        Ok(block_info)
    }
}

impl HyperlaneChain for SealevelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(self.clone())
    }
}

#[async_trait]
impl HyperlaneProvider for SealevelProvider {
    async fn get_block_by_height(&self, slot: u64) -> ChainResult<BlockInfo> {
        let block_info = self.block_info_by_height(slot).await?;
        Ok(block_info)
    }

    /// TODO This method is superfluous for Solana.
    /// Since we have to request full block to find transaction hash and transaction index
    /// for Solana, we have all the data about transaction mach earlier before this
    /// method is invoked.
    /// We can refactor abstractions so that our chain-agnostic code is more suitable
    /// for all chains, not only Ethereum-like chains.
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let signature = Signature::new(hash.as_bytes());

        let txn_confirmed = self.rpc_client.get_transaction(&signature).await?;
        let txn_with_meta = &txn_confirmed.transaction;

        let txn = txn(txn_with_meta)?;

        Self::validate_transaction(hash, txn)?;
        let sender = Self::sender(hash, txn)?;
        let recipient = self.recipient_provider.recipient(hash, txn)?;
        let meta = Self::meta(txn_with_meta)?;
        let gas_used = Self::gas(meta)?;
        let fee = self.fee(meta)?;

        if fee < gas_used {
            warn!(tx_hash = ?hash, ?fee, ?gas_used, "calculated fee is less than gas used. it will result in zero gas price");
        }

        let gas_price = Some(fee / gas_used);

        let receipt = TxnReceiptInfo {
            gas_used,
            cumulative_gas_used: gas_used,
            effective_gas_price: gas_price,
        };

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: gas_used,
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price,
            nonce: 0,
            sender,
            recipient: Some(recipient),
            receipt: Some(receipt),
            raw_input_data: None,
        })
    }

    async fn is_contract(&self, _address: &H256) -> ChainResult<bool> {
        // FIXME
        Ok(true)
    }

    async fn get_balance(&self, address: String) -> ChainResult<U256> {
        let pubkey = decode_pubkey(&address)?;
        self.rpc_client.get_balance(&pubkey).await
    }

    async fn get_chain_metrics(&self) -> ChainResult<Option<ChainInfo>> {
        let slot = self.rpc_client.get_slot_raw().await?;
        let latest_block = self.block_info_by_height(slot).await?;
        let chain_info = ChainInfo {
            latest_block,
            min_gas_price: None,
        };
        Ok(Some(chain_info))
    }
}
