use std::{
    collections::HashMap,
    fmt::{self, Debug},
    sync::Arc,
};

use async_trait::async_trait;
use ethers::{
    abi::{ParamType, Token},
    providers::{Http, Middleware, Provider},
    types::{NameOrAddress, TransactionRequest},
    utils::id,
};
use eyre::{Context, Result};
use parking_lot::RwLock;
use prometheus::IntGauge;

use hyperlane_core::{
    accumulator::incremental::MerkleTreeSnapshot, Checkpoint, CheckpointWithMessageId, ReorgEvent,
    ReorgEventResponse, Signature, SignedAnnouncement, SignedCheckpointWithMessageId, H256,
};

use crate::CheckpointSyncer;

#[derive(Default, Debug)]
struct OnchainState {
    checkpoints: HashMap<(H256, u32), SignedCheckpointWithMessageId>,
    latest_index: HashMap<H256, u32>,
    metadata: HashMap<H256, String>,
    reorg_status: HashMap<H256, ReorgEvent>,
    merkle_snapshot: Option<MerkleTreeSnapshot>,
    announcements: HashMap<H256, SignedAnnouncement>,
    reorg_logs: Vec<String>,
}

/// An on-chain checkpoint syncer that reads and writes checkpoints, metadata,
/// and reorg status to an OnchainCheckpointStorage smart contract.
#[derive(Clone)]
pub struct OnchainStorage {
    chain_name: String,
    contract_address: H256,
    validator_address: Option<H256>,
    rpc_url: Option<String>,
    latest_index_gauge: Option<IntGauge>,
    state: Arc<RwLock<OnchainState>>,
}

impl Debug for OnchainStorage {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OnchainStorage")
            .field("chain_name", &self.chain_name)
            .field("contract_address", &self.contract_address)
            .field("validator_address", &self.validator_address)
            .field("rpc_url", &self.rpc_url)
            .finish()
    }
}

impl OnchainStorage {
    /// Create a new OnchainStorage instance
    pub fn new(
        chain_name: String,
        contract_address: H256,
        validator_address: Option<H256>,
        rpc_url: Option<String>,
        latest_index_gauge: Option<IntGauge>,
    ) -> Self {
        Self {
            chain_name,
            contract_address,
            validator_address,
            rpc_url,
            latest_index_gauge,
            state: Arc::new(RwLock::new(OnchainState::default())),
        }
    }

    /// Return a clone with the specified validator address bound
    pub fn with_validator(&self, validator: H256) -> Self {
        let mut cloned = self.clone();
        cloned.validator_address = Some(validator);
        cloned
    }

    /// Return the contract address
    pub fn contract_address(&self) -> H256 {
        self.contract_address
    }

    /// Return the chain name
    pub fn chain_name(&self) -> &str {
        &self.chain_name
    }

    /// Return the bound validator address if any
    pub fn validator_address(&self) -> Option<H256> {
        self.validator_address
    }

    fn effective_validator(&self) -> Result<H256> {
        self.validator_address
            .ok_or_else(|| eyre::eyre!("Validator address not configured for onchain storage"))
    }

    fn h256_to_address(h: &H256) -> ethers::types::Address {
        ethers::types::Address::from_slice(&h.as_bytes()[12..32])
    }

    async fn query_latest_index_rpc(
        &self,
        provider: &Provider<Http>,
        validator: H256,
    ) -> Result<Option<u32>> {
        let selector = id("getLatestIndex(address)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector[..4]);
        calldata.extend_from_slice(&ethers::abi::encode(&[Token::Address(
            Self::h256_to_address(&validator),
        )]));

        let tx = TransactionRequest {
            to: Some(NameOrAddress::Address(Self::h256_to_address(
                &self.contract_address,
            ))),
            data: Some(calldata.into()),
            ..Default::default()
        };

        let raw_output = provider.call(&tx.into(), None).await?;
        let tokens = ethers::abi::decode(&[ParamType::Uint(32), ParamType::Bool], &raw_output)?;
        let exists = tokens
            .get(1)
            .and_then(|t| t.clone().into_bool())
            .unwrap_or(false);
        if exists {
            let index = tokens
                .first()
                .and_then(|t| t.clone().into_uint())
                .map(|u| u.as_u32());
            Ok(index)
        } else {
            Ok(None)
        }
    }

    async fn query_checkpoint_rpc(
        &self,
        provider: &Provider<Http>,
        validator: H256,
        index: u32,
    ) -> Result<Option<SignedCheckpointWithMessageId>> {
        let selector = id("getCheckpoint(address,uint32)");
        let mut calldata = Vec::with_capacity(68);
        calldata.extend_from_slice(&selector[..4]);
        calldata.extend_from_slice(&ethers::abi::encode(&[
            Token::Address(Self::h256_to_address(&validator)),
            Token::Uint(index.into()),
        ]));

        let tx = TransactionRequest {
            to: Some(NameOrAddress::Address(Self::h256_to_address(
                &self.contract_address,
            ))),
            data: Some(calldata.into()),
            ..Default::default()
        };

        let raw_output = match provider.call(&tx.into(), None).await {
            Ok(out) => out,
            Err(_) => return Ok(None),
        };

        let tuple_types = vec![
            ParamType::Uint(32),
            ParamType::FixedBytes(32),
            ParamType::FixedBytes(32),
            ParamType::Uint(32),
            ParamType::FixedBytes(32),
        ];
        let return_types = vec![ParamType::Tuple(tuple_types), ParamType::Bytes];

        let tokens = match ethers::abi::decode(&return_types, &raw_output) {
            Ok(t) => t,
            Err(_) => return Ok(None),
        };

        let (checkpoint_tuple, sig_bytes) = match (tokens.first(), tokens.get(1)) {
            (Some(Token::Tuple(cp)), Some(Token::Bytes(sig))) => (cp, sig),
            _ => return Ok(None),
        };

        if sig_bytes.len() != 65 || checkpoint_tuple.len() != 5 {
            return Ok(None);
        }

        let origin = checkpoint_tuple[0]
            .clone()
            .into_uint()
            .map(|u| u.as_u32())
            .unwrap_or(0);
        let merkle_tree = checkpoint_tuple[1]
            .clone()
            .into_fixed_bytes()
            .map(|b| H256::from_slice(&b))
            .unwrap_or_default();
        let root = checkpoint_tuple[2]
            .clone()
            .into_fixed_bytes()
            .map(|b| H256::from_slice(&b))
            .unwrap_or_default();
        let cp_index = checkpoint_tuple[3]
            .clone()
            .into_uint()
            .map(|u| u.as_u32())
            .unwrap_or(0);
        let message_id = checkpoint_tuple[4]
            .clone()
            .into_fixed_bytes()
            .map(|b| H256::from_slice(&b))
            .unwrap_or_default();

        let ethers_sig = ethers::types::Signature::try_from(sig_bytes.as_slice())
            .context("Parsing signature from onchain checkpoint")?;
        let signature = Signature::from(ethers_sig);

        let checkpoint = Checkpoint {
            merkle_tree_hook_address: merkle_tree,
            mailbox_domain: origin,
            root,
            index: cp_index,
        };

        let checkpoint_with_id = CheckpointWithMessageId {
            checkpoint,
            message_id,
        };

        Ok(Some(SignedCheckpointWithMessageId {
            value: checkpoint_with_id,
            signature,
        }))
    }

    async fn query_reorg_status_rpc(
        &self,
        provider: &Provider<Http>,
        validator: H256,
    ) -> Result<Option<Vec<u8>>> {
        let selector = id("getReorgStatus(address)");
        let mut calldata = Vec::with_capacity(36);
        calldata.extend_from_slice(&selector[..4]);
        calldata.extend_from_slice(&ethers::abi::encode(&[Token::Address(
            Self::h256_to_address(&validator),
        )]));

        let tx = TransactionRequest {
            to: Some(NameOrAddress::Address(Self::h256_to_address(
                &self.contract_address,
            ))),
            data: Some(calldata.into()),
            ..Default::default()
        };

        let raw_output = match provider.call(&tx.into(), None).await {
            Ok(out) => out,
            Err(_) => return Ok(None),
        };

        let tokens = match ethers::abi::decode(&[ParamType::Bytes], &raw_output) {
            Ok(t) => t,
            Err(_) => return Ok(None),
        };

        match tokens.first() {
            Some(Token::Bytes(b)) if !b.is_empty() => Ok(Some(b.clone())),
            _ => Ok(None),
        }
    }
}

#[async_trait]
impl CheckpointSyncer for OnchainStorage {
    async fn read_merkle_snapshot(&self) -> Result<Option<MerkleTreeSnapshot>> {
        let state = self.state.read();
        Ok(state.merkle_snapshot.clone())
    }

    async fn write_merkle_snapshot(&self, snapshot: &MerkleTreeSnapshot) -> Result<()> {
        let mut state = self.state.write();
        state.merkle_snapshot = Some(snapshot.clone());
        Ok(())
    }

    async fn latest_index(&self) -> Result<Option<u32>> {
        let Some(validator) = self.validator_address else {
            return Ok(None);
        };

        if let Some(rpc_url) = &self.rpc_url {
            if let Ok(provider) = Provider::<Http>::try_from(rpc_url.as_str()) {
                if let Ok(Some(idx)) = self.query_latest_index_rpc(&provider, validator).await {
                    if let Some(gauge) = &self.latest_index_gauge {
                        gauge.set(idx as i64);
                    }
                    return Ok(Some(idx));
                }
            }
        }

        let state = self.state.read();
        let idx = state.latest_index.get(&validator).copied();
        if let Some(idx) = idx {
            if let Some(gauge) = &self.latest_index_gauge {
                gauge.set(idx as i64);
            }
        }
        Ok(idx)
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let validator = self.effective_validator()?;
        {
            let mut state = self.state.write();
            let curr = state.latest_index.entry(validator).or_insert(index);
            if index > *curr {
                *curr = index;
            }
        }
        if let Some(gauge) = &self.latest_index_gauge {
            gauge.set(index as i64);
        }
        Ok(())
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let Some(validator) = self.validator_address else {
            return Ok(None);
        };

        if let Some(rpc_url) = &self.rpc_url {
            if let Ok(provider) = Provider::<Http>::try_from(rpc_url.as_str()) {
                if let Ok(Some(cp)) = self.query_checkpoint_rpc(&provider, validator, index).await {
                    return Ok(Some(cp));
                }
            }
        }

        let state = self.state.read();
        Ok(state.checkpoints.get(&(validator, index)).cloned())
    }

    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        let signer = signed_checkpoint.recover()?;
        let validator = H256::from(signer);

        {
            let mut state = self.state.write();
            state.checkpoints.insert(
                (validator, signed_checkpoint.value.index),
                signed_checkpoint.clone(),
            );
            let curr = state
                .latest_index
                .entry(validator)
                .or_insert(signed_checkpoint.value.index);
            if signed_checkpoint.value.index > *curr {
                *curr = signed_checkpoint.value.index;
            }
        }

        if let Some(gauge) = &self.latest_index_gauge {
            gauge.set(signed_checkpoint.value.index as i64);
        }

        Ok(())
    }

    async fn write_metadata(&self, serialized_metadata: &str) -> Result<()> {
        let validator = self.effective_validator()?;
        let mut state = self.state.write();
        state
            .metadata
            .insert(validator, serialized_metadata.to_owned());
        Ok(())
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        let validator = H256::from(signed_announcement.value.validator);
        let mut state = self.state.write();
        state
            .announcements
            .insert(validator, signed_announcement.clone());
        Ok(())
    }

    fn announcement_location(&self) -> String {
        format!(
            "onchain://{}/0x{:x}",
            self.chain_name, self.contract_address
        )
    }

    async fn write_reorg_status(&self, reorg_event: &ReorgEvent) -> Result<()> {
        let validator = self.effective_validator()?;
        let mut state = self.state.write();
        state.reorg_status.insert(validator, reorg_event.clone());
        Ok(())
    }

    async fn write_reorg_rpc_responses(&self, log: String) -> Result<()> {
        let mut state = self.state.write();
        state.reorg_logs.push(log);
        Ok(())
    }

    async fn reorg_status(&self) -> Result<ReorgEventResponse> {
        let Some(validator) = self.validator_address else {
            return Ok(ReorgEventResponse {
                exists: false,
                event: None,
                content: None,
            });
        };

        if let Some(rpc_url) = &self.rpc_url {
            if let Ok(provider) = Provider::<Http>::try_from(rpc_url.as_str()) {
                if let Ok(Some(data)) = self.query_reorg_status_rpc(&provider, validator).await {
                    let event = serde_json::from_slice::<ReorgEvent>(&data).ok();
                    let content = Some(String::from_utf8_lossy(&data).to_string());
                    return Ok(ReorgEventResponse {
                        exists: true,
                        event,
                        content,
                    });
                }
            }
        }

        let state = self.state.read();
        if let Some(reorg) = state.reorg_status.get(&validator) {
            let serialized = serde_json::to_string(reorg).ok();
            Ok(ReorgEventResponse {
                exists: true,
                event: Some(reorg.clone()),
                content: serialized,
            })
        } else {
            Ok(ReorgEventResponse {
                exists: false,
                event: None,
                content: None,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use ethers::signers::{LocalWallet, Signer};
    use hyperlane_core::{
        accumulator::incremental::IncrementalMerkle, Checkpoint, CheckpointWithMessageId, Signable,
    };

    use super::*;

    #[tokio::test]
    async fn test_onchain_storage_lifecycle() {
        let wallet: LocalWallet = "01".repeat(32).parse().unwrap();
        let validator_address = H256::from(wallet.address());
        let contract_address = H256::repeat_byte(0x12);

        let storage = OnchainStorage::new(
            "ethereum".to_string(),
            contract_address,
            Some(validator_address),
            None,
            None,
        );

        assert_eq!(
            storage.announcement_location(),
            format!("onchain://ethereum/0x{:x}", contract_address)
        );

        let initial_index = storage.latest_index().await.unwrap();
        assert_eq!(initial_index, None);

        let checkpoint = Checkpoint {
            merkle_tree_hook_address: H256::repeat_byte(1),
            mailbox_domain: 1,
            root: H256::repeat_byte(2),
            index: 42,
        };
        let checkpoint_with_id = CheckpointWithMessageId {
            checkpoint,
            message_id: H256::repeat_byte(3),
        };

        let eth_hash = checkpoint_with_id.eth_signed_message_hash();
        let ethers_sig = wallet.sign_hash(ethers::types::H256::from_slice(eth_hash.as_bytes()));
        let signature = Signature::from(ethers_sig);

        let signed_checkpoint = SignedCheckpointWithMessageId {
            value: checkpoint_with_id,
            signature,
        };

        storage.write_checkpoint(&signed_checkpoint).await.unwrap();

        let latest = storage.latest_index().await.unwrap();
        assert_eq!(latest, Some(42));

        let fetched = storage.fetch_checkpoint(42).await.unwrap();
        assert!(fetched.is_some());
        assert_eq!(fetched.unwrap().value.index, 42);

        let non_existent = storage.fetch_checkpoint(99).await.unwrap();
        assert!(non_existent.is_none());

        let mut tree = IncrementalMerkle::default();
        tree.ingest(H256::from_low_u64_be(1));
        let snapshot = MerkleTreeSnapshot::capture(&tree).unwrap();
        storage.write_merkle_snapshot(&snapshot).await.unwrap();
        let read_snapshot = storage.read_merkle_snapshot().await.unwrap();
        assert!(read_snapshot.is_some());
    }
}
