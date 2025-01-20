use std::ops::RangeInclusive;

use base64::{engine::general_purpose, Engine};
use hyperlane_core::{
    accumulator::TREE_DEPTH, Announcement, ChainCommunicationError, HyperlaneDomain,
    HyperlaneMessage, HyperlaneProvider, Indexer, KnownHyperlaneDomain, Mailbox, MerkleTreeHook,
    ReorgPeriod, SequenceAwareIndexer, Signature, SignedType, ValidatorAnnounce, H160, H256, U256,
};
use reqwest::Client;
use tonlib_core::{cell::BagOfCells, wallet::TonWallet, TonAddress};
use tracing::{info, warn};
use url::Url;

use crate::{
    error::HyperlaneTonError, ton_api_center::TonApiCenter, ConversionUtils, TonConnectionConf,
    TonInterchainGasPaymaster, TonInterchainSecurityModule, TonMailbox, TonMerkleTreeHook,
    TonMerkleTreeHookIndexer, TonMultisigIsm, TonProvider, TonSigner, TonValidatorAnnounce,
};

pub struct TestContext {
    pub provider: TonProvider,
    pub signer: TonSigner,
    pub mailbox: TonMailbox,
    pub igp: TonInterchainGasPaymaster,
    pub ism: TonInterchainSecurityModule,
    pub multisig: TonMultisigIsm,
    pub validator_announce: TonValidatorAnnounce,
    pub merkle_hook: TonMerkleTreeHook,
    pub merkle_hook_indexer: TonMerkleTreeHookIndexer,
}

impl TestContext {
    pub fn new(
        api_url: &str,
        api_key: &str,
        wallet: &TonWallet,
        mailbox_address: &str,
        igp_address: &str,
        ism_address: &str,
        multisig_address: &str,
        validator_announce: &str,
        merkle_hook_address: &str,
    ) -> Result<Self, anyhow::Error> {
        let http_client = Client::new();
        let connection_config =
            TonConnectionConf::new(Url::parse(api_url)?, api_key.to_string(), 5);
        let domain = HyperlaneDomain::Known(KnownHyperlaneDomain::TonTest1); // It doesn't matter now.

        let provider = TonProvider::new(http_client, connection_config, domain);

        let signer = TonSigner {
            address: wallet.clone().address,
            wallet: wallet.clone(),
        };

        let mailbox = TonMailbox {
            workchain: 0,
            mailbox_address: mailbox_address.parse()?,
            provider: provider.clone(),
            signer: signer.clone(),
        };

        let igp = TonInterchainGasPaymaster {
            igp_address: TonAddress::from_base64_url(igp_address).unwrap(),
            provider: provider.clone(),
            signer: signer.clone(),
            workchain: 0,
        };

        let ism = TonInterchainSecurityModule {
            ism_address: TonAddress::from_base64_url(ism_address).unwrap(),
            provider: provider.clone(),
            workchain: 0,
            signer: signer.clone(),
        };

        let multisig = TonMultisigIsm::new(
            provider.clone(),
            TonAddress::from_base64_url(multisig_address).unwrap(),
        );

        let validator_announce = TonValidatorAnnounce::new(
            TonAddress::from_base64_url(validator_announce).unwrap(),
            provider.clone(),
            signer.clone(),
        );
        let merkle_hook = TonMerkleTreeHook::new(
            provider.clone(),
            TonAddress::from_base64_url(merkle_hook_address).unwrap(),
        )
        .unwrap();

        let merkle_hook_indexer = TonMerkleTreeHookIndexer::new(
            TonAddress::from_base64_url(merkle_hook_address).unwrap(),
            provider.clone(),
        )
        .unwrap();

        Ok(Self {
            provider,
            signer,
            mailbox,
            igp,
            ism,
            multisig,
            validator_announce,
            merkle_hook,
            merkle_hook_indexer,
        })
    }

    pub async fn test_wallet_information(&self) -> Result<(), anyhow::Error> {
        let s = self
            .provider
            .get_wallet_information(self.signer.address.to_hex().as_str(), true)
            .await
            .unwrap();
        println!("wallet information:{:?}", s);
        Ok(())
    }

    pub async fn test_is_contract(&self) -> Result<(), anyhow::Error> {
        let ton_address =
            TonAddress::from_base64_url("EQBxuFfnP5UVFIeWBiZJ9UStEGEVW_DqIgETU36GSkrhWuzD")
                .unwrap();
        let h256_address = ConversionUtils::ton_address_to_h256(&ton_address);
        let is_contract = self.provider.is_contract(&h256_address).await.unwrap();

        println!("is_contract:{:?}", is_contract);
        Ok(())
    }
    pub async fn test_mailbox_default_ism(&self) -> Result<(), anyhow::Error> {
        let default_ism = self.mailbox.default_ism().await.map_err(|e| {
            anyhow::Error::msg(format!("Failed to fetch Mailbox Default ISM: {:?}", e))
        })?;
        println!("Mailbox Default ISM: {:?}", default_ism);
        Ok(())
    }

    pub async fn test_mailbox_recipient_ism(&self) -> Result<(), anyhow::Error> {
        let recipient = ConversionUtils::ton_address_to_h256(
            &TonAddress::from_base64_url("EQCb3n0SkpKTNyNlhKEnndYSG0DQ2nK6za0oFhl5bRr3n4hc")
                .unwrap(),
        );
        let default_ism = self.mailbox.recipient_ism(recipient).await.map_err(|e| {
            anyhow::Error::msg(format!("Failed to fetch Mailbox recipient ISM: {:?}", e))
        })?;
        println!("recipient ISM: {:?}", default_ism);
        Ok(())
    }
    pub async fn test_mailbox_delievered(&self) -> Result<(), anyhow::Error> {
        let delievered = self.mailbox.delivered(H256::zero()).await.unwrap();

        println!("delievered:{:?}", delievered);

        Ok(())
    }

    pub async fn test_mailbox_process(&self) -> Result<(), anyhow::Error> {
        let message = HyperlaneMessage {
            version: 7,
            nonce: 0,
            origin: 777001,
            sender: Default::default(),
            destination: 777002,
            recipient: H256::zero(),
            body: vec![],
        };
        let metadata = [0u8; 64];
        let tx = self
            .mailbox
            .process(&message, &metadata, None)
            .await
            .map_err(|e| anyhow::Error::msg(format!("Failed to send process message: {:?}", e)))?;
        println!("TxOutcome:{:?}", tx);

        Ok(())
    }

    pub async fn test_validator_announce_get_locations(&self) -> Result<(), anyhow::Error> {
        let validators = vec![H256::from(H160::from_slice(
            &hex::decode("15d34aaf54267db7d7c367839aaf71a00a2c6a65").unwrap(),
        ))];

        let locations = self
            .validator_announce
            .get_announced_storage_locations(&validators)
            .await?;

        info!("Retrieved storage locations: {:?}", locations);

        assert!(!locations.is_empty(), "Locations should not be empty");
        for (i, location_set) in locations.iter().enumerate() {
            info!("Validator {} has locations: {:?}", i, location_set);
            assert!(
                !location_set.is_empty(),
                "Validator {} should have at least one location",
                i
            );
        }

        Ok(())
    }

    pub async fn test_mailbox_indexer(&self) -> Result<(), anyhow::Error> {
        let hash = "+wybmbTcVrfQRXN31E4wclfrj9MhE+MkDx8hA+hkQwY=";
        let decoded = match general_purpose::STANDARD.decode(hash) {
            Ok(decoded) => decoded,
            Err(err) => {
                warn!("error decode:{:?}", err);
                return Ok(());
            }
        };

        if decoded.len() != 32 {
            return Ok(());
        }
        let result = H256::from_slice(decoded.as_slice());
        info!("indexer H256:{:?}", result);
        Ok(())
    }
    pub async fn test_validator_announce_get_storage_locations(&self) -> Result<(), anyhow::Error> {
        let boc = "te6cckEBAwEAbwABQ6AAAAAAAAAAAAAAAAACumlV6oTPtvr4bPBzVe40AUWNTLABAUOgDrViCHwsJlBivdpOn+cAsU1R7j8qhoxHPC7ZNnmBvWWQAgBGZmlsZTovLy4vcGVyc2lzdGVudF9kYXRhL2NoZWNrcG9pbnRYdWdj";

        let cell_boc_decoded = general_purpose::STANDARD.decode(boc).unwrap();

        let boc = BagOfCells::parse(&cell_boc_decoded).unwrap();

        let cell = boc.single_root().unwrap();

        let storage_locations =
            ConversionUtils::parse_address_storage_locations(&cell).map_err(|e| {
                ChainCommunicationError::from(HyperlaneTonError::ParsingError(format!(
                    "Failed to parse address storage locations: {}",
                    e
                )))
            })?;
        info!("storage_locations:{:?}", storage_locations);
        let locations_vec: Vec<Vec<String>> = storage_locations.into_values().collect();
        info!("locations_vec:{:?}", locations_vec);
        Ok(())
    }

    pub async fn test_validator_announce_announce(&self) -> Result<(), anyhow::Error> {
        let announcement = Announcement {
            validator: ConversionUtils::parse_eth_address_to_h160(
                "0x15d34aaf54267db7d7c367839aaf71a00a2c6a65",
            )
            .unwrap(),
            mailbox_address: ConversionUtils::ton_address_to_h256(&self.mailbox.mailbox_address),
            mailbox_domain: 777001,
            storage_location: "file://./persistent_data/checkpoint".to_string(),
        };

        let signature = Signature {
            r: U256::from_str_radix(
                "0x6ba624ff0c89fb239dd570a8b9d40be9758ea113cb7a690f54ca579ad5cf3db0",
                16,
            )
            .unwrap(),
            s: U256::from_str_radix(
                "0x39ff136a5844c7222612c32b1e5e441b7dc8baa50a93dc9d4335e9bd5ac38a80",
                16,
            )
            .unwrap(),
            v: 27,
        };
        let data = SignedType {
            value: announcement,
            signature,
        };
        info!("announce data:{:?}", data);

        let announce = self.validator_announce.announce(data).await.unwrap();
        info!("TxOutcome:{:?}", announce);
        Ok(())
    }

    pub async fn test_merkle_tree_hook_tree(&self) -> Result<(), anyhow::Error> {
        let tree = self.merkle_hook.tree(&ReorgPeriod::None).await?;
        println!("Incremental Merkle Tree: {:?}", tree);

        assert_eq!(tree.branch.len(), TREE_DEPTH);
        println!("Tree depth is valid.");
        Ok(())
    }

    pub async fn test_merkle_tree_hook_count(&self) -> Result<(), anyhow::Error> {
        let count = self.merkle_hook.count(&ReorgPeriod::None).await?;
        info!("Merkle Tree Count: {}", count);

        Ok(())
    }
    pub async fn test_merkle_tree_hook_latest_checkpoint(&self) -> Result<(), anyhow::Error> {
        let checkpoint = self
            .merkle_hook
            .latest_checkpoint(&ReorgPeriod::None)
            .await?;
        info!("Merkle Tree Latest Checkpoint: {:?}", checkpoint);

        assert_ne!(
            checkpoint.root,
            H256::zero(),
            "Checkpoint root should not be zero."
        );
        info!("Checkpoint root is valid.");

        Ok(())
    }

    pub async fn test_merkle_tree_hook_indexer(&self) -> Result<(), anyhow::Error> {
        let end_block = self
            .merkle_hook_indexer
            .get_finalized_block_number()
            .await
            .unwrap();
        let logs = self
            .merkle_hook_indexer
            .fetch_logs_in_range(RangeInclusive::new(10, end_block))
            .await
            .unwrap();

        info!("Events:{:?}", logs);

        Ok(())
    }

    pub async fn test_merkle_tree_hook_get_finalized_block_number(
        &self,
    ) -> Result<(), anyhow::Error> {
        let res = self
            .merkle_hook_indexer
            .get_finalized_block_number()
            .await
            .unwrap();
        info!("get_finalized_block_number:{:?}", res);
        Ok(())
    }
    pub async fn test_merkle_tree_hook_latest_sequence_count_and_tip(
        &self,
    ) -> Result<(), anyhow::Error> {
        let cursor = self
            .merkle_hook_indexer
            .latest_sequence_count_and_tip()
            .await
            .unwrap();
        info!("latest_sequence_count_and_tip:{:?}", cursor);
        Ok(())
    }

    pub async fn test_multisig_validators_and_threshold(&self) -> Result<(), anyhow::Error> {
        Ok(())
    }
    pub fn parse_metadata(&self, metadata: &[u8]) {
        if metadata.len() < 100 {
            println!("Metadata is too short to parse. Length: {}", metadata.len());
            return;
        }

        let mut offset = 0;

        // Extract origin_merkle_hook (32 bytes)
        let origin_merkle_hook = &metadata[offset..offset + 32];
        offset += 32;

        // Extract root (32 bytes)
        let root = &metadata[offset..offset + 32];
        offset += 32;

        // Extract index (4 bytes)
        let index = u32::from_be_bytes([
            metadata[offset],
            metadata[offset + 1],
            metadata[offset + 2],
            metadata[offset + 3],
        ]);
        offset += 4;

        println!("origin_merkle_hook: {:x?}", origin_merkle_hook);
        println!("root: {:x?}", root);
        println!("index: {}", index);

        // Handle the remaining 65 bytes as a single signature
        if offset + 65 == metadata.len() {
            let signature = &metadata[offset..];
            println!("Signature: {:x?}", signature);
            println!("Metadata parsed successfully. All bytes processed.");
            return;
        }

        // Parse signatures if there are multiple entries (with keys)
        while offset + 69 <= metadata.len() {
            // Extract signature key
            let key = u32::from_be_bytes([
                metadata[offset],
                metadata[offset + 1],
                metadata[offset + 2],
                metadata[offset + 3],
            ]);
            offset += 4;

            // Extract signature
            let signature = &metadata[offset..offset + 65];
            offset += 65;

            println!("Signature key: {}", key);
            println!("Signature: {:x?}", signature);
        }

        // Check for leftover bytes
        if offset != metadata.len() {
            println!(
                "Unexpected leftover bytes in metadata: {} bytes",
                metadata.len() - offset
            );
        } else {
            println!("Metadata parsed successfully. All bytes processed.");
        }
    }
}
