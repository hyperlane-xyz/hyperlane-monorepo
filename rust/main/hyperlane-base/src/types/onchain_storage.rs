use crate::settings::ChainSigner;
use crate::{AgentMetadata, CheckpointSyncer};
use async_trait::async_trait;
use eyre::{Context, Result};
use hyperlane_core::{
    HyperlaneChain, HyperlaneDomainProtocol, HyperlaneProvider, OnchainCheckpointStorage,
    SignedAnnouncement, SignedCheckpointWithMessageId,
};
use serde_json;
use std::fmt::Debug;
/* use solana_sdk::signer::Signer;
use solana_client::rpc_client::RpcClient;
use cosmrs::tx::{SignDoc, SignerOptions};
use cosmrs::AccountId;
 */

#[derive(Debug)]
pub struct OnChainStorage {
    // <S: ChainSigner>
    chain: HyperlaneDomainProtocol,
    storage: Box<dyn OnchainCheckpointStorage>,
}

impl OnChainStorage {
    /* pub fn new(chain: HyperlaneDomainProtocol, contract_address: String, signer: S) -> Result<Self> {
        let storage: Box<dyn OnchainCheckpointStorage> = Box::new(chain.create_checkpoint_storage(&contract_address)?);

        Ok(Self {
            chain,
            contract_address,
            storage,
            signer,
        });
    } */

    async fn write_to_contract(&self, key: &str, data: &[u8]) -> Result<()> {
        self.storage.write_to_contract(key, data).await
    }

    async fn read_from_contract(&self, key: &str) -> Result<Option<Vec<u8>>> {
        self.storage.read_from_contract(key).await
    }
}

#[async_trait]
impl CheckpointSyncer for OnChainStorage {
    async fn latest_index(&self) -> Result<Option<u32>> {
        let data = self.read_from_contract("latest_index").await?;
        data.map(|d| serde_json::from_slice(&d).context("Deserializing latest index"))
            .transpose()
    }

    async fn write_latest_index(&self, index: u32) -> Result<()> {
        let serialized_index = serde_json::to_vec(&index)?;
        self.write_to_contract("latest_index", &serialized_index)
            .await
    }

    async fn fetch_checkpoint(&self, index: u32) -> Result<Option<SignedCheckpointWithMessageId>> {
        let key = format!("checkpoint_{}", index);
        let data = self.read_from_contract(&key).await?;
        data.map(|d| serde_json::from_slice(&d).context("Deserializing checkpoint"))
            .transpose()
    }

    async fn write_checkpoint(
        &self,
        signed_checkpoint: &SignedCheckpointWithMessageId,
    ) -> Result<()> {
        // FIXME reference this CheckpointWithMessageId { checkpoint: Checkpoint { in mod.rs
        let key = format!("checkpoint_{}", signed_checkpoint.value.index);
        let serialized_checkpoint = serde_json::to_vec(signed_checkpoint)?;
        self.storage
            .write_to_contract(&key, &serialized_checkpoint)
            .await
    }

    async fn write_metadata(&self, metadata: &AgentMetadata) -> Result<()> {
        let serialized_metadata = serde_json::to_vec(metadata)?;
        self.write_to_contract("metadata", &serialized_metadata)
            .await
    }

    async fn write_announcement(&self, signed_announcement: &SignedAnnouncement) -> Result<()> {
        let serialized_announcement = serde_json::to_vec(signed_announcement)?;
        self.write_to_contract("announcement", &serialized_announcement)
            .await
    }

    fn announcement_location(&self) -> String {
        todo!()
        /* format!("onchain://{}/{}", self.chain, self.contract_address) */
    }
}

/*
// TODO: modify this test
#[tokio::test]
async fn public_landset_no_auth_works_test() {
    const LANDSAT_BUCKET: &str = "gcp-public-data-landsat";
    const LANDSAT_KEY: &str = "LC08/01/001/003/LC08_L1GT_001003_20140812_20170420_01_T2/LC08_L1GT_001003_20140812_20170420_01_T2_B3.TIF";
    let client = GcsStorageClientBuilder::new(AuthFlow::NoAuth)
        .build(LANDSAT_BUCKET, None)
        .await
        .unwrap();
    assert!(client.get_by_path(LANDSAT_KEY).await.is_ok());
}
*/
