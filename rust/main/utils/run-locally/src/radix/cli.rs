use core_api_client::models::{self, StateUpdates};
use hyperlane_core::{H256, H512};
use hyperlane_radix::RadixProvider;
use radix_common::prelude::*;
use radix_engine_interface::metadata_init;
use radix_transactions::{
    builder::{
        ManifestBuilder, TransactionBuilder, TransactionManifestV2Builder, TransactionV2Builder,
    },
    model::{
        IntentHeaderV2, TransactionHashBech32Encoder, TransactionHeaderV2, TransactionPayload,
    },
    signing::PrivateKey,
};
use scrypto::blueprints::{
    package::{PackageDefinition, PACKAGE_BLUEPRINT},
    resource::OwnerRole,
};
use std::{fs, ops::Deref, path::Path, time::Duration};
use tokio::time::sleep;

impl Deref for RadixCli {
    type Target = RadixProvider;

    fn deref(&self) -> &Self::Target {
        &self.provider
    }
}

pub struct RadixCli {
    provider: RadixProvider,
    package: Option<PackageAddress>,
}

impl RadixCli {
    pub fn new(provider: RadixProvider) -> RadixCli {
        Self {
            provider,
            package: None,
        }
    }

    async fn send_tx(
        &self,
        build_manifest: impl FnOnce(TransactionManifestV2Builder) -> TransactionManifestV2Builder,
    ) -> StateUpdates {
        let (tx, _, private_key) = self.get_tx_builder().await.unwrap();
        let pub_key = private_key.public_key();
        let address = ComponentAddress::preallocated_account_from_public_key(&pub_key);
        let manifest = build_manifest(ManifestBuilder::new_v2().lock_fee_from_faucet())
            .try_deposit_entire_worktop_or_abort(address, None)
            .build();

        let tx = tx
            .manifest(manifest)
            .sign(&private_key)
            .notarize(&private_key)
            .build();

        let encoder = TransactionHashBech32Encoder::new(&NetworkDefinition::stokenet());
        let super_result = encoder.encode(&tx.transaction_hashes.transaction_intent_hash);
        println!("{:#?}", super_result);

        println!("Submitting tx...");
        let result = self.submit_tx(tx.raw.to_vec()).await;

        let tx_hash: H512 =
            H256::from_slice(tx.transaction_hashes.transaction_intent_hash.0.as_bytes()).into();
        sleep(Duration::from_secs(10)).await;

        let result = self.get_tx_by_hash(&tx_hash).await.unwrap();
        let update: serde_json::Value = result.receipt.unwrap().state_updates.unwrap();
        let update: StateUpdates = serde_json::from_value(update).unwrap();
        update
    }

    pub async fn publish_package(&self, code_path: &Path, rpd: &Path) -> String {
        let code = fs::read(code_path).unwrap();
        let package_definition: PackageDefinition =
            manifest_decode(&fs::read(&rpd).unwrap()).unwrap();
        let update = self
            .send_tx(|builder| {
                let namer = builder.name_lookup();
                builder
                    .allocate_global_address(
                        PACKAGE_PACKAGE,
                        PACKAGE_BLUEPRINT,
                        "package_reservation",
                        "package_named_address",
                    )
                    .publish_package_advanced(
                        namer.address_reservation("package_reservation"),
                        code,
                        package_definition,
                        metadata_init! {
                            "name" => "Hyperlane Radix", locked;

                        },
                        OwnerRole::None,
                    )
            })
            .await;

        let package = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalPackage)
            .unwrap();

        package.entity_address.clone()
    }

    pub async fn create_component(
        &self,
        blueprint: &str,
        args: ManifestArgs,
    ) -> (String, Option<String>) {
        let update = self
            .send_tx(|builder| {
                let namer = builder.name_lookup();
                builder.call_function(self.package.unwrap(), blueprint, "instantiate", args)
            })
            .await;

        let package = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalGenericComponent)
            .unwrap();

        let badge = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalFungibleResource)
            .map(|x| x.entity_address.clone());

        (package.entity_address.clone(), badge)
    }
}
