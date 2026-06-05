use async_trait::async_trait;
use ethers::{
    abi::{Token, Tokenizable},
    prelude::Middleware,
    providers::{Http, Provider},
    types::{transaction::eip2718::TypedTransaction, Bytes, Eip1559TransactionRequest, H160, U256},
};
use eyre::{Context, Result};
use hyperlane_core::{
    Checkpoint, CheckpointWithMessageId, ReorgEvent, ReorgEventResponse, SignedAnnouncement,
    SignedCheckpointWithMessageId, H256,
};
use prometheus::IntGauge;
use tracing::{info, instrument};

use crate::traits::CheckpointSyncer;

/// A checkpoint syncer that reads checkpoints from the CheckpointStorage contract.
///
/// Storage location format: `onchain://chainName/contractAddress`
///
/// The CheckpointStorage contract stores signed checkpoints in a mapping
/// of (validator => index => SignedCheckpoint). Validators submit their
/// checkpoints as transactions to the contract directly via their signer.
/// This syncer handles read operations (latest_index, fetch_checkpoint).
#[derive(Debug, Clone)]
pub struct OnChainCheckpointSyncer {
    /// The chain name (e.g. "ethereum", "citrea")
    chain_name: String,
    /// The CheckpointStorage contract address
    contract_address: H160,
    /// The validator's address
    validator_address: H160,
    /// The RPC URL for the chain
    rpc_url: String,
    /// Prometheus gauge for latest index
    latest_index: Option<IntGauge>,
}

impl OnChainCheckpointSyncer {
    /// Create a new OnChainCheckpointSyncer
    pub fn new(
        chain_name: String,
        contract_address: H160,
        validator_address: H160,
        rpc_url: String,
        latest_index: Option<IntGauge>,
    ) -> Self {
        Self {
            chain_name,
            contract_address,
            validator_address,
            rpc_url,
            latest_index,
        }
    }

    /// Get the announcement storage location string
    pub fn announcement_location_str(&self) -> String {
        format!(
            "onchain://{}/{}",
            self.chain_name,
            hex::encode(self.contract_address)
        )
    }

    /// Get an ethers Provider connected to the RPC URL
    fn get_provider(&self) -> Result<Provider<Http>> {
        Provider::<Http>::try_from(&self.rpc_url)
            .with_context(|| format!("Failed to create provider for {}", self.rpc_url))
    }
}

#[async_trait]
impl CheckpointSyncer for OnChainCheckpointSyncer {
    #[instrument(ret, skip(self))]
    async fn latest_index(&self) -> Result<Option<u32>> {
        let provider = self.get_provider()?;

        // Call latestIndex(address) on the contract
        // Function selector: keccak256("latestIndex(address)")[..4]
        let selector = ethers::utils::keccak256(b"latestIndex(address)");
        let mut data = selector[..4].to_vec();
        data.extend_from_slice(
            &Token::Address(self.validator_address)
                .into_token()
                .abi_encode_params(),
        );

        let call = TypedTransaction::Eip1559(
            Eip1559TransactionRequest::new()
                .to(self.contract_address)
                .data(Bytes::from(data)),
        );

        let result = provider
            .call(&call, None)
            .await
            .with_context(|| "Failed to call latestIndex")?;

        if result.is_empty() || result.as_ref().iter().all(|&b| b == 0) {
            return Ok(None);
        }

        let index = U256::from_big_endian(&result.as_ref()[..32]).as_u32();
        if let Some(gauge) = &self.latest_index {
            gauge.set(index as i64);
        }
        Ok(Some(index))
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        // The CheckpointStorage contract auto-updates the latest index when
        // writeCheckpoint is called. This method is a no-op for on-chain storage.
        info!(?index, chain=%self.chain_name, "write_latest_index is a no-op for on-chain storage");
        Ok(())
    }

    #[instrument(ret, skip(self))]
    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let provider = self.get_provider()?;

        // Call fetchCheckpoint(address,uint32) on the contract
        let selector = ethers::utils::keccak256(b"fetchCheckpoint(address,uint32)");
        let mut data = selector[..4].to_vec();
        data.extend_from_slice(
            &Token::Address(self.validator_address)
                .into_token()
                .abi_encode_params(),
        );
        data.extend_from_slice(
            &Token::Uint(U256::from(index))
                .into_token()
                .abi_encode_params(),
        );

        let call = TypedTransaction::Eip1559(
            Eip1559TransactionRequest::new()
                .to(self.contract_address)
                .data(Bytes::from(data)),
        );

        let result = provider
            .call(&call, None)
            .await
            .with_context(|| format!("Failed to call fetchCheckpoint for index {index}"))?;

        if result.is_empty() || result.as_ref().iter().all(|&b| b == 0) {
            return Ok(None);
        }

        // Parse the result as (checkpoint: (merkleTreeHookAddress, mailboxDomain, root, index), messageId, signature)
        // The contract returns: SignedCheckpointWithMessageId { value: CheckpointWithMessageId { checkpoint: Checkpoint, messageId }, signature }
        // ABI: (((bytes32,uint32,bytes32,uint32),bytes32),bytes)
        let tokens: Vec<Token> = ethers::abi::decode(
            &[ethers::abi::ParamType::Tuple(vec![
                ethers::abi::ParamType::Tuple(vec![
                    ethers::abi::ParamType::Tuple(vec![
                        ethers::abi::ParamType::FixedBytes(32),
                        ethers::abi::ParamType::Uint(32),
                        ethers::abi::ParamType::FixedBytes(32),
                        ethers::abi::ParamType::Uint(32),
                    ]),
                    ethers::abi::ParamType::FixedBytes(32),
                ]),
                ethers::abi::ParamType::Bytes,
            ])],
            &result,
        )
        .with_context(|| "Failed to decode fetchCheckpoint result")?;

        if tokens.is_empty() {
            return Ok(None);
        }

        let outer_tuple = tokens[0]
            .clone()
            .into_tuple()
            .ok_or_else(|| eyre::eyre!("Expected outer tuple"))?;
        if outer_tuple.len() < 2 {
            return Ok(None);
        }

        let value_tuple = outer_tuple[0]
            .clone()
            .into_tuple()
            .ok_or_else(|| eyre::eyre!("Expected value tuple"))?;
        if value_tuple.len() < 2 {
            return Ok(None);
        }

        let checkpoint_tuple = value_tuple[0]
            .clone()
            .into_tuple()
            .ok_or_else(|| eyre::eyre!("Expected checkpoint tuple"))?;
        if checkpoint_tuple.len() < 4 {
            return Ok(None);
        }

        let merkle_tree_hook_address = H256::from_slice(
            &checkpoint_tuple[0]
                .clone()
                .into_fixed_bytes()
                .unwrap_or_default()[..32],
        );
        let mailbox_domain = checkpoint_tuple[1]
            .clone()
            .into_uint()
            .map(|u| u.as_u32())
            .unwrap_or(0);
        let root = H256::from_slice(
            &checkpoint_tuple[2]
                .clone()
                .into_fixed_bytes()
                .unwrap_or_default()[..32],
        );
        let cp_index = checkpoint_tuple[3]
            .clone()
            .into_uint()
            .map(|u| u.as_u32())
            .unwrap_or(0);

        let message_id = H256::from_slice(
            &value_tuple[1]
                .clone()
                .into_fixed_bytes()
                .unwrap_or_default()[..32],
        );

        let checkpoint = Checkpoint {
            merkle_tree_hook_address,
            mailbox_domain,
            root,
            index: cp_index,
        };

        let checkpoint_with_id = CheckpointWithMessageId {
            checkpoint,
            message_id,
        };

        let signature_bytes = outer_tuple[1].clone().into_bytes().unwrap_or_default();
        let signature: [u8; 65] = {
            if signature_bytes.len() < 65 {
                let mut padded = [0u8; 65];
                padded[..signature_bytes.len()].copy_from_slice(&signature_bytes);
                padded
            } else {
                let mut arr = [0u8; 65];
                arr.copy_from_slice(&signature_bytes[..65]);
                arr
            }
        };

        Ok(Some(SignedCheckpointWithMessageId {
            value: checkpoint_with_id,
            signature,
        }))
    }

    #[instrument(skip(self, _signed_checkpoint))]
    async fn write_checkpoint(
        &self,
        _signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        Err(eyre::eyre!(
            "OnChainCheckpointSyncer::write_checkpoint requires a signer. \
             Use the CheckpointStorage contract directly via the validator's signer. \
             Contract address: {:?} on chain: {}",
            self.contract_address,
            self.chain_name
        ))
    }

    async fn write_metadata(&self, _serialized_metadata: &str) -> Result<()> {
        Err(eyre::eyre!(
            "OnChainCheckpointSyncer::write_metadata requires a signer"
        ))
    }

    async fn write_announcement(&self, _signed_announcement: &SignedAnnouncement) -> Result<()> {
        Err(eyre::eyre!(
            "OnChainCheckpointSyncer::write_announcement requires a signer"
        ))
    }

    fn announcement_location(&self) -> String {
        self.announcement_location_str()
    }

    async fn write_reorg_status(&self, _reorg_event: &ReorgEvent) -> Result<()> {
        Err(eyre::eyre!(
            "OnChainCheckpointSyncer::write_reorg_status requires a signer"
        ))
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        Ok(ReorgEventResponse {
            exists: false,
            event: None,
            content: None,
        })
    }
}

#[cfg(test)]
mod test {
    use std::str::FromStr;

    use ethers::types::H160;

    use super::*;

    #[test]
    fn test_announcement_location() {
        let syncer = OnChainCheckpointSyncer::new(
            "citrea".to_string(),
            H160::from_str("0xd9cbf08cac905f78d961a72716ef8eed3ab7e5eb").unwrap(),
            H160::from_str("0x221fa9cbafcd6c1c3d206571cf4427703e023ffa").unwrap(),
            "http://localhost:8545".to_string(),
            None,
        );
        let loc = syncer.announcement_location();
        assert!(loc.starts_with("onchain://citrea/"));
        assert!(loc.contains("d9cbf08cac905f78d961a72716ef8eed3ab7e5eb"));
    }
}
