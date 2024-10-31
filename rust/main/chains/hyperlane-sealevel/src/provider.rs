use std::sync::Arc;

use async_trait::async_trait;
use solana_sdk::signature::Signature;
use solana_transaction_status::EncodedTransaction;

use hyperlane_core::{
    BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain, HyperlaneDomain,
    HyperlaneProvider, HyperlaneProviderError, TxnInfo, TxnReceiptInfo, H256, H512, U256,
};

use crate::error::HyperlaneSealevelError;
use crate::utils::{decode_h256, decode_h512, decode_pubkey};
use crate::{ConnectionConf, SealevelRpcClient};

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Debug)]
pub struct SealevelProvider {
    domain: HyperlaneDomain,
    rpc_client: Arc<SealevelRpcClient>,
}

impl SealevelProvider {
    /// Create a new Sealevel provider.
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client = Arc::new(SealevelRpcClient::new(conf.url.to_string()));

        SealevelProvider { domain, rpc_client }
    }

    /// Get an rpc client
    pub fn rpc(&self) -> &SealevelRpcClient {
        &self.rpc_client
    }
}

impl HyperlaneChain for SealevelProvider {
    fn domain(&self) -> &HyperlaneDomain {
        &self.domain
    }

    fn provider(&self) -> Box<dyn HyperlaneProvider> {
        Box::new(SealevelProvider {
            domain: self.domain.clone(),
            rpc_client: self.rpc_client.clone(),
        })
    }
}

#[async_trait]
impl HyperlaneProvider for SealevelProvider {
    async fn get_block_by_height(&self, slot: u64) -> ChainResult<BlockInfo> {
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

    /// TODO This method is superfluous for Solana.
    /// Since we have to request full block to find transaction hash and transaction index
    /// for Solana, we have all the data about transaction mach earlier before this
    /// method is invoked.
    /// We can refactor abstractions so that our chain-agnostic code is more suitable
    /// for all chains, not only Ethereum-like chains.
    async fn get_txn_by_hash(&self, hash: &H512) -> ChainResult<TxnInfo> {
        let signature = Signature::new(hash.as_bytes());
        let transaction = self.rpc_client.get_transaction(&signature).await?;

        let ui_transaction = match transaction.transaction.transaction {
            EncodedTransaction::Json(t) => t,
            t => Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::UnsupportedTransactionEncoding(t),
            ))?,
        };

        let received_signature = ui_transaction
            .signatures
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(*hash))?;
        let received_hash = decode_h512(received_signature)?;

        if &received_hash != hash {
            Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::IncorrectTransaction(
                    Box::new(*hash),
                    Box::new(received_hash),
                ),
            ))?;
        }

        let receipt = TxnReceiptInfo {
            gas_used: Default::default(),
            cumulative_gas_used: Default::default(),
            effective_gas_price: None,
        };

        Ok(TxnInfo {
            hash: *hash,
            gas_limit: Default::default(),
            max_priority_fee_per_gas: None,
            max_fee_per_gas: None,
            gas_price: None,
            nonce: 0,
            sender: Default::default(),
            recipient: None,
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
        Ok(None)
    }
}
