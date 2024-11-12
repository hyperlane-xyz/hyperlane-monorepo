use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use lazy_static::lazy_static;
use solana_sdk::signature::Signature;
use solana_transaction_status::{
    option_serializer::OptionSerializer, EncodedTransaction, EncodedTransactionWithStatusMeta,
    UiInstruction, UiMessage, UiParsedInstruction, UiParsedMessage, UiTransaction,
    UiTransactionStatusMeta,
};
use tracing::warn;

use hyperlane_core::{
    utils::to_atto, BlockInfo, ChainCommunicationError, ChainInfo, ChainResult, HyperlaneChain,
    HyperlaneDomain, HyperlaneProvider, HyperlaneProviderError, NativeToken, TxnInfo,
    TxnReceiptInfo, H256, H512, U256,
};

use crate::error::HyperlaneSealevelError;
use crate::utils::{decode_h256, decode_h512, decode_pubkey};
use crate::{ConnectionConf, SealevelRpcClient};

lazy_static! {
    static ref NATIVE_PROGRAMS: HashSet<String> = HashSet::from([
        solana_sdk::bpf_loader_upgradeable::ID.to_string(),
        solana_sdk::compute_budget::ID.to_string(),
        solana_sdk::config::program::ID.to_string(),
        solana_sdk::ed25519_program::ID.to_string(),
        solana_sdk::secp256k1_program::ID.to_string(),
        solana_sdk::stake::program::ID.to_string(),
        solana_sdk::system_program::ID.to_string(),
        solana_sdk::vote::program::ID.to_string(),
    ]);
}

/// A wrapper around a Sealevel provider to get generic blockchain information.
#[derive(Debug)]
pub struct SealevelProvider {
    domain: HyperlaneDomain,
    rpc_client: Arc<SealevelRpcClient>,
    native_token: NativeToken,
}

impl SealevelProvider {
    /// Create a new Sealevel provider.
    pub fn new(domain: HyperlaneDomain, conf: &ConnectionConf) -> Self {
        // Set the `processed` commitment at rpc level
        let rpc_client = Arc::new(SealevelRpcClient::new(conf.url.to_string()));
        let native_token = conf.native_token.clone();

        Self {
            domain,
            rpc_client,
            native_token,
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
        Ok(())
    }

    fn sender(hash: &H512, txn: &UiTransaction) -> ChainResult<H256> {
        let message = Self::parsed_message(txn)?;

        let signer = message
            .account_keys
            .first()
            .ok_or(HyperlaneSealevelError::UnsignedTransaction(*hash))?;
        let pubkey = decode_pubkey(&signer.pubkey)?;
        let sender = H256::from_slice(&pubkey.to_bytes());
        Ok(sender)
    }

    fn recipient(hash: &H512, txn: &UiTransaction) -> ChainResult<H256> {
        let message = Self::parsed_message(txn)?;

        let programs = message
            .instructions
            .iter()
            .filter_map(|ii| {
                if let UiInstruction::Parsed(iii) = ii {
                    Some(iii)
                } else {
                    None
                }
            })
            .map(|ii| match ii {
                UiParsedInstruction::Parsed(iii) => &iii.program_id,
                UiParsedInstruction::PartiallyDecoded(iii) => &iii.program_id,
            })
            .filter(|program_id| !NATIVE_PROGRAMS.contains(*program_id))
            .collect::<Vec<&String>>();

        if programs.len() > 1 {
            Err(HyperlaneSealevelError::TooManyNonNativePrograms(*hash))?;
        }

        let program_id = programs
            .first()
            .ok_or(HyperlaneSealevelError::NoNonNativePrograms(*hash))?;

        let pubkey = decode_pubkey(program_id)?;
        let recipient = H256::from_slice(&pubkey.to_bytes());
        Ok(recipient)
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

    fn parsed_message(txn: &UiTransaction) -> ChainResult<&UiParsedMessage> {
        Ok(match &txn.message {
            UiMessage::Parsed(m) => m,
            m => Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::UnsupportedMessageEncoding(m.clone()),
            ))?,
        })
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
            native_token: self.native_token.clone(),
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

        let txn_confirmed = self.rpc_client.get_transaction(&signature).await?;
        let txn_with_meta = &txn_confirmed.transaction;

        let txn = match &txn_with_meta.transaction {
            EncodedTransaction::Json(t) => t,
            t => Err(Into::<ChainCommunicationError>::into(
                HyperlaneSealevelError::UnsupportedTransactionEncoding(t.clone()),
            ))?,
        };

        Self::validate_transaction(hash, txn)?;
        let sender = Self::sender(hash, txn)?;
        let recipient = Self::recipient(hash, txn)?;
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
        Ok(None)
    }
}
