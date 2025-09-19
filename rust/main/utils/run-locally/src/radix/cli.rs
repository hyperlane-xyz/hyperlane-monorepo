use crate::{
    logging::log,
    radix::{types::Contracts, KEY},
};
use core_api_client::models::{self, StateUpdates};
use ethers_core::rand;
use hyperlane_core::{H256, H512};
use hyperlane_radix::RadixGatewayProvider;
use hyperlane_radix::RadixProvider;
use radix_common::prelude::*;
use radix_engine_interface::metadata_init;
use radix_transactions::{
    builder::ManifestBuilder,
    model::{
        HasTransactionIntentHash, PreparationSettings, TransactionHashBech32Encoder,
        TransactionHeaderV1, TransactionPayload,
    },
    prelude::{TransactionBuilder, TransactionManifestV1Builder},
};
use scrypto::{
    blueprints::{package::PackageDefinition, resource::OwnerRole},
    prelude::dec,
};
use std::collections::HashMap;
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
    signer: ComponentAddress,
    network: NetworkDefinition,
    decoder: AddressBech32Decoder,
    encoder: AddressBech32Encoder,
}

impl Clone for RadixCli {
    fn clone(&self) -> Self {
        Self {
            provider: self.provider.clone(),
            package: self.package.clone(),
            signer: self.signer.clone(),
            network: self.network.clone(),
            decoder: AddressBech32Decoder::new(&self.network),
            encoder: AddressBech32Encoder::new(&self.network),
        }
    }
}

impl RadixCli {
    pub fn new(provider: RadixProvider, network: NetworkDefinition) -> RadixCli {
        let decoder = AddressBech32Decoder::new(&network);
        let encoder = AddressBech32Encoder::new(&network);
        let private_key = provider.get_signer().unwrap().get_signer().unwrap();
        let pub_key = private_key.public_key();
        let account = ComponentAddress::preallocated_account_from_public_key(&pub_key);

        Self {
            provider,
            package: None,
            signer: account,
            decoder,
            encoder,
            network,
        }
    }

    async fn send_tx(
        &self,
        build_manifest: impl FnOnce(TransactionManifestV1Builder) -> TransactionManifestV1Builder,
    ) -> StateUpdates {
        let epoch = self
            .provider
            .gateway_status()
            .await
            .unwrap()
            .ledger_state
            .epoch as u64;

        let private_key = self.provider.get_signer().unwrap();
        let private_key = private_key.get_signer().unwrap();

        let tx = TransactionBuilder::new().header(TransactionHeaderV1 {
            notary_public_key: private_key.public_key(),
            notary_is_signatory: true,
            network_id: self.network.id,
            start_epoch_inclusive: Epoch::of(epoch),
            end_epoch_exclusive: Epoch::of(epoch + 10), // ~5 minutes per epoch -> 10min timeout
            nonce: rand::random::<u32>(),
            tip_percentage: 0,
        });
        let manifest = build_manifest(ManifestBuilder::new().lock_fee_from_faucet())
            .deposit_entire_worktop(self.signer)
            .build();

        let tx = tx.manifest(manifest).notarize(&private_key).build();
        let raw_transaction = tx.to_raw().unwrap();
        let transaction_intent_hash = raw_transaction
            .prepare(PreparationSettings::latest_ref())
            .expect("Transaction could not be prepared")
            .transaction_intent_hash();

        let encoder = TransactionHashBech32Encoder::new(&self.network);
        let tx_hash_str = encoder.encode(&transaction_intent_hash).unwrap();
        log!("Transaction hash: {}", tx_hash_str);

        log!("Submitting transaction...");
        let _result = self
            .provider
            .submit_transaction(raw_transaction.to_vec())
            .await
            .unwrap();

        let tx_hash: H512 = H256::from_slice(transaction_intent_hash.0.as_bytes()).into();

        log!("Waiting for transaction confirmation...");
        let mut result = self.get_tx_by_hash(&tx_hash).await;
        for retry in 1..=120 {
            if result.is_ok() {
                break;
            }
            if retry % 10 == 0 {
                log!(
                    "Still waiting for transaction confirmation... ({} seconds)",
                    retry
                );
            }
            // we resubmit the tx in case it got lost
            sleep(Duration::from_secs(1)).await;
            // let _ = self.provider.submit_transaction(raw.clone()).await;
            result = self.get_tx_by_hash(&tx_hash).await;
        }
        let result = result.unwrap();
        log!("Transaction confirmed");
        let update: serde_json::Value = result.receipt.unwrap().state_updates.unwrap();
        let update: StateUpdates = serde_json::from_value(update).unwrap();
        update
    }

    pub async fn publish_package(&mut self, code_path: &Path, rpd: &Path) {
        log!("Publishing package from {:?}", code_path);
        let code = fs::read(code_path).unwrap();
        let package_definition: PackageDefinition =
            manifest_decode(&fs::read(&rpd).unwrap()).unwrap();
        let update = self
            .send_tx(|builder| {
                builder.publish_package_advanced(
                    None,
                    code,
                    package_definition,
                    metadata_init! {},
                    OwnerRole::None,
                )
            })
            .await;

        let package = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalPackage)
            .unwrap();

        log!("Package published at address: {}", package.entity_address);

        self.package = PackageAddress::try_from_bech32(&self.decoder, &package.entity_address)
    }

    pub async fn fund_account(&self) {
        log!("Funding account from faucet...");
        self.send_tx(|builder| builder.get_free_xrd_from_faucet())
            .await;
    }

    pub async fn create_component(
        &self,
        blueprint: &str,
        args: ManifestArgs,
    ) -> (ComponentAddress, Option<ResourceAddress>) {
        log!("Creating component from blueprint: {}", blueprint);
        let update = self
            .send_tx(|builder| {
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
            .map(|x| ResourceAddress::try_from_bech32(&self.decoder, &x.entity_address).unwrap());

        let address =
            ComponentAddress::try_from_bech32(&self.decoder, &package.entity_address).unwrap();
        log!("Component created at address: {}", package.entity_address);
        if badge.is_some() {
            log!("Badge resource created");
        }
        (address, badge)
    }

    pub async fn call_method(
        &self,
        component: ComponentAddress,
        method: &str,
        args: ManifestArgs,
        proof: Option<ResourceAddress>,
    ) -> StateUpdates {
        let component_str = self.encoder.encode(component.as_bytes()).unwrap();
        log!(
            "Calling method '{}' on component: {}",
            method,
            component_str
        );

        let update = self
            .send_tx(|builder| match proof {
                Some(proof) => builder
                    .create_proof_from_account_of_amount(self.signer, proof, 1)
                    .call_method(component, method, args),
                None => builder.call_method(component, method, args),
            })
            .await;
        log!("Method call completed successfully");
        update
    }

    pub async fn remote_transfer(&self, token: ComponentAddress, destination: u32, nonce: u32) {
        let encoder = AddressBech32Encoder::new(&NetworkDefinition::stokenet());
        let token_str = encoder.encode(token.as_bytes()).unwrap();
        log!(
            "Initiating remote transfer of token {} to domain {}",
            token_str,
            destination
        );

        let mut recipient = [0u8; 32];
        recipient[2..].copy_from_slice(self.signer.as_bytes());

        let _ = self
            .send_tx(|builder| {
                builder
                    .withdraw_from_account(self.signer, XRD, dec!(11))
                    .withdraw_from_account(self.signer, XRD, Decimal::from(nonce))
                    .take_from_worktop(XRD, dec!(11), "hyperlane_fee")
                    .take_from_worktop(XRD, Decimal::from(nonce), "amount")
                    .call_method_with_name_lookup(token, "transfer_remote", |lookup| {
                        manifest_args!(
                            destination,
                            recipient,
                            lookup.bucket("amount"),
                            vec![lookup.bucket("hyperlane_fee")],
                            None::<Option<ComponentAddress>>,
                            ManifestValue::enum_variant(0, vec![]),
                        )
                    })
            })
            .await;
        log!("Remote transfer completed successfully");
    }

    pub async fn enroll_remote_routers(
        &self,
        token: ComponentAddress,
        owner: ResourceAddress,
        routers: &Vec<(u32, ComponentAddress)>,
    ) {
        let token_str = self.encoder.encode(token.as_bytes()).unwrap();
        log!(
            "Enrolling {} remote routers for token {}",
            routers.len(),
            token_str
        );

        for (domain, router) in routers {
            let router_str = self.encoder.encode(router.as_bytes()).unwrap();
            log!("Enrolling router {} for domain {}", router_str, domain);

            let mut hex = [0u8; 32];
            let router_bytes = router.as_bytes();
            hex[2..].copy_from_slice(router_bytes);
            self.call_method(
                token,
                "enroll_remote_router",
                manifest_args!(domain, hex, dec!(1)),
                Some(owner),
            )
            .await;
        }
        log!("All remote routers enrolled successfully");
    }

    pub async fn deploy_warp_contracts(
        &self,
        mailbox: ComponentAddress,
    ) -> (
        (ComponentAddress, ResourceAddress),
        (ComponentAddress, ResourceAddress),
    ) {
        let mailbox_str = self.encoder.encode(mailbox.as_bytes()).unwrap();
        log!("Deploying warp contracts with mailbox: {}", mailbox_str);

        log!("Deploying collateral token...");
        let args = ManifestValue::enum_variant(
            0u8,
            vec![ManifestValue::Custom {
                value: ManifestCustomValue::Address(ManifestAddress::Static(*XRD.as_node_id())),
            }],
        );

        let (collateral, collateral_owner) = self
            .create_component("HypToken", manifest_args!(args, mailbox))
            .await;

        log!("Deploying synthetic token...");
        let args = ManifestValue::enum_variant(
            1u8,
            vec![
                ManifestValue::String {
                    value: "".to_string(),
                },
                ManifestValue::String {
                    value: "".to_string(),
                },
                ManifestValue::String {
                    value: "".to_string(),
                },
                ManifestValue::U8 { value: 18 },
            ],
        );
        let (synthetic, synthetic_owner) = self
            .create_component("HypToken", manifest_args!(args, mailbox))
            .await;

        log!("Warp contracts deployed successfully");
        (
            (collateral, collateral_owner.unwrap()),
            (synthetic, synthetic_owner.unwrap()),
        )
    }

    pub async fn deploy_core_contracts(
        &self,
        local_domain: u32,
        remote_domains: Vec<u32>,
    ) -> (
        ComponentAddress,
        ComponentAddress,
        ComponentAddress,
        ComponentAddress,
    ) {
        log!("Deploying core contracts for domain: {}", local_domain);

        let (mailbox, mailbox_owner) = self
            .create_component("Mailbox", manifest_args!(local_domain))
            .await;

        let (merkle_tree_hook, _) = self
            .create_component("MerkleTreeHook", manifest_args!(mailbox))
            .await;

        let (igp, igp_owner) = self
            .create_component("InterchainGasPaymaster", manifest_args!(XRD))
            .await;

        let (validator_announce, _) = self
            .create_component("ValidatorAnnounce", manifest_args!(mailbox))
            .await;

        let validator: [u8; 20] = hex::decode(KEY.0).unwrap().try_into().unwrap();
        let (multisig, _) = self
            .create_component(
                "MerkleRootMultisigIsm",
                manifest_args!(vec![validator], 1usize),
            )
            .await;

        let args = remote_domains
            .iter()
            .map(|x| (*x, multisig))
            .collect::<Vec<_>>();
        let (routing_ism, _) = self
            .create_component("RoutingIsm", manifest_args!(args))
            .await;

        let configs = remote_domains
            .iter()
            .map(|domain| (domain, ((10_000_000_000u128, 1u128), 10u128)))
            .collect::<Vec<_>>();
        self.call_method(
            igp,
            "set_destination_gas_configs",
            manifest_args!(configs),
            igp_owner,
        )
        .await;

        self.call_method(
            mailbox,
            "set_default_hook",
            manifest_args!(igp),
            mailbox_owner,
        )
        .await;

        self.call_method(
            mailbox,
            "set_required_hook",
            manifest_args!(merkle_tree_hook),
            mailbox_owner,
        )
        .await;

        self.call_method(
            mailbox,
            "set_default_ism",
            manifest_args!(routing_ism),
            mailbox_owner,
        )
        .await;

        log!(
            "Core contracts deployed and configured successfully for domain {}",
            local_domain
        );
        (mailbox, merkle_tree_hook, igp, validator_announce)
    }

    pub async fn deploy_contracts(&self, domains: Vec<u32>) -> Vec<Contracts> {
        assert!(domains.len() >= 2, "Need at least two domains");
        log!(
            "Deploying contracts for {} domains: {:?}",
            domains.len(),
            domains
        );

        // 1. Deploy core contracts for each domain (remote domains = all others)
        log!("Step 1: Deploying core contracts for each domain");
        let mut cores: HashMap<
            u32,
            (
                ComponentAddress,
                ComponentAddress,
                ComponentAddress,
                ComponentAddress,
            ),
        > = HashMap::new();
        for &domain in &domains {
            let remotes: Vec<u32> = domains.iter().copied().filter(|d| *d != domain).collect();
            let core = self.deploy_core_contracts(domain, remotes).await;
            cores.insert(domain, core);
        }

        // 2. Deploy warp contracts (collateral + synthetic) for each domain
        log!("Step 2: Deploying warp contracts for each domain");
        let mut warps: HashMap<
            u32,
            (
                (ComponentAddress, ResourceAddress),
                (ComponentAddress, ResourceAddress),
            ),
        > = HashMap::new();
        for &domain in &domains {
            log!("Deploying warp contracts for domain {}", domain);
            let core = cores.get(&domain).unwrap();
            let warp = self.deploy_warp_contracts(core.0).await;
            warps.insert(domain, warp);
        }

        // 3. Enroll remote routers for every ordered pair of distinct domains
        log!("Step 3: Enrolling remote routers across domains");
        for &local in &domains {
            log!("Setting up routing for domain {}", local);
            let local_warp = warps.get(&local).unwrap();
            let collateral_remote_warp_routes = warps
                .iter()
                .filter(|x| *x.0 != local)
                .map(|warp| (*warp.0, warp.1 .0 .0))
                .collect::<Vec<_>>();
            let synthetic_remote_warp_routes = warps
                .iter()
                .filter(|x| *x.0 != local)
                .map(|warp| (*warp.0, warp.1 .1 .0))
                .collect::<Vec<_>>();
            log!(
                "Enrolling remote routers for collateral token on domain {}",
                local
            );
            self.enroll_remote_routers(
                local_warp.0 .0,
                local_warp.0 .1,
                &synthetic_remote_warp_routes,
            )
            .await;
            log!(
                "Enrolling remote routers for synthetic token on domain {}",
                local
            );
            self.enroll_remote_routers(
                local_warp.1 .0,
                local_warp.1 .1,
                &collateral_remote_warp_routes,
            )
            .await;
        }

        let to_string = |component: ComponentAddress| -> String {
            self.encoder.encode(component.as_bytes()).unwrap()
        };

        log!("Finalizing contract deployments");
        let mut contracts: Vec<Contracts> = Vec::new();
        for &domain in &domains {
            let core = cores.get(&domain).unwrap();
            let warp = warps.get(&domain).unwrap();
            contracts.push(Contracts {
                mailbox: to_string(core.0),
                merkle_tree_hook: to_string(core.1),
                igp: to_string(core.2),
                validator_announce: to_string(core.3),
                collateral: warp.0 .0,
            });
        }

        log!("Contract deployment completed successfully for all domains");
        contracts
    }
}
