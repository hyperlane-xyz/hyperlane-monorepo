use std::collections::HashMap;
use std::{fs, ops::Deref, path::Path, time::Duration};

use hyperlane_core::{H256, H512};
use hyperlane_radix::RadixGatewayProvider;
use hyperlane_radix::RadixProvider;

use core_api_client::models::{self, StateUpdates};
use ethers_core::rand;
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
use tokio::time::sleep;

use crate::{
    logging::log,
    radix::{
        types::{ComponentCreationResult, Contracts, CoreContracts, TokenContract, WarpContracts},
        KEY,
    },
};

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
            package: self.package,
            signer: self.signer,
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
        let private_key = provider
            .get_signer()
            .expect("Failed to get signer from provider")
            .get_signer()
            .expect("Failed to get private key from signer");
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
            .expect("Failed to get gateway status")
            .ledger_state
            .epoch as u64;

        let private_key = self
            .provider
            .get_signer()
            .expect("Failed to get signer from provider");
        let private_key = private_key
            .get_signer()
            .expect("Failed to get private key from signer");

        let tx = TransactionBuilder::new().header(TransactionHeaderV1 {
            notary_public_key: private_key.public_key(),
            notary_is_signatory: true,
            network_id: self.network.id,
            start_epoch_inclusive: Epoch::of(epoch),
            end_epoch_exclusive: Epoch::of(epoch.saturating_add(2)), // ~5 minutes per epoch -> 10min timeout
            nonce: rand::random::<u32>(),
            tip_percentage: 0,
        });
        let manifest = build_manifest(ManifestBuilder::new().lock_fee_from_faucet())
            .deposit_entire_worktop(self.signer)
            .build();

        let tx = tx.manifest(manifest).notarize(&private_key).build();
        let raw_transaction = tx
            .to_raw()
            .expect("Failed to convert transaction to raw format");
        let transaction_intent_hash = raw_transaction
            .prepare(PreparationSettings::latest_ref())
            .expect("Transaction could not be prepared")
            .transaction_intent_hash();

        let encoder = TransactionHashBech32Encoder::new(&self.network);
        let tx_hash_str = encoder
            .encode(&transaction_intent_hash)
            .expect("Failed to encode transaction hash");
        log!("Transaction hash: {}", tx_hash_str);

        log!("Submitting transaction...");
        let _result = self
            .provider
            .submit_transaction(raw_transaction.to_vec())
            .await
            .expect("Failed to submit transaction");

        let tx_hash: H512 = H256::from_slice(transaction_intent_hash.0.as_bytes()).into();

        log!("Waiting for transaction confirmation...");
        let mut result = self.get_tx_by_hash(&tx_hash).await;
        for _ in 1..=10 {
            if result.is_ok() {
                break;
            }
            // we resubmit the tx in case it got lost
            sleep(Duration::from_secs(1)).await;
            result = self.get_tx_by_hash(&tx_hash).await;
        }
        let result = result.expect("Transaction failed to confirm after multiple retries");
        log!("Transaction confirmed");
        let update: serde_json::Value = result
            .receipt
            .expect("Transaction receipt is missing")
            .state_updates
            .expect("State updates are missing from receipt");
        let update: StateUpdates = serde_json::from_value(update)
            .expect("Failed to parse state updates from transaction receipt");
        update
    }

    pub async fn publish_package(&mut self, code_path: &Path, rpd: &Path) {
        log!("Publishing package from {:?}", code_path);
        let code = fs::read(code_path).expect("Failed to read package code from file");
        let package_definition: PackageDefinition =
            manifest_decode(&fs::read(rpd).expect("Failed to read package definition file"))
                .expect("Failed to decode package definition");
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
            .expect("Published package not found in transaction result");

        log!("Package published at address: {}", package.entity_address);

        self.package = PackageAddress::try_from_bech32(&self.decoder, &package.entity_address)
    }

    pub async fn fund_account(&self) {
        log!("Funding account from faucet... {}", self.signer.to_hex());
        self.send_tx(|builder| builder.get_free_xrd_from_faucet())
            .await;
    }

    pub async fn create_component(
        &self,
        blueprint: &str,
        args: ManifestArgs,
    ) -> ComponentCreationResult {
        log!("Creating component from blueprint: {}", blueprint);
        let update = self
            .send_tx(|builder| {
                builder.call_function(
                    self.package
                        .expect("Package must be published before creating components"),
                    blueprint,
                    "instantiate",
                    args,
                )
            })
            .await;

        let package = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalGenericComponent)
            .expect("Created component not found in transaction result");

        let badge = update
            .new_global_entities
            .iter()
            .find(|x| x.entity_type == models::EntityType::GlobalFungibleResource)
            .map(|x| {
                ResourceAddress::try_from_bech32(&self.decoder, &x.entity_address)
                    .expect("Failed to decode badge resource address")
            });

        let address = ComponentAddress::try_from_bech32(&self.decoder, &package.entity_address)
            .expect("Failed to decode component address");
        log!("Component created at address: {}", package.entity_address);
        if badge.is_some() {
            log!("Badge resource created");
        }
        ComponentCreationResult { address, badge }
    }

    pub async fn call_method(
        &self,
        component: ComponentAddress,
        method: &str,
        args: ManifestArgs,
        proof: Option<ResourceAddress>,
    ) -> StateUpdates {
        let component_str = self
            .encoder
            .encode(component.as_bytes())
            .expect("Failed to encode component address");
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
        let token_str = encoder
            .encode(token.as_bytes())
            .expect("Failed to encode token address");
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
        let token_str = self
            .encoder
            .encode(token.as_bytes())
            .expect("Failed to encode token address");
        log!(
            "Enrolling {} remote routers for token {}",
            routers.len(),
            token_str
        );

        for (domain, router) in routers {
            let router_str = self
                .encoder
                .encode(router.as_bytes())
                .expect("Failed to encode router address");
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

    pub async fn deploy_warp_contracts(&self, mailbox: ComponentAddress) -> WarpContracts {
        let mailbox_str = self
            .encoder
            .encode(mailbox.as_bytes())
            .expect("Failed to encode mailbox address");
        log!("Deploying warp contracts with mailbox: {}", mailbox_str);

        log!("Deploying collateral token...");
        let args = ManifestValue::enum_variant(
            0u8,
            vec![ManifestValue::Custom {
                value: ManifestCustomValue::Address(ManifestAddress::Static(*XRD.as_node_id())),
            }],
        );

        let collateral_result = self
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
        let synthetic_result = self
            .create_component("HypToken", manifest_args!(args, mailbox))
            .await;

        log!("Warp contracts deployed successfully");
        WarpContracts {
            collateral: TokenContract {
                address: collateral_result.address,
                owner: collateral_result
                    .badge
                    .expect("Collateral token should have an owner badge"),
            },
            synthetic: TokenContract {
                address: synthetic_result.address,
                owner: synthetic_result
                    .badge
                    .expect("Synthetic token should have an owner badge"),
            },
        }
    }

    pub async fn deploy_core_contracts(
        &self,
        local_domain: u32,
        remote_domains: Vec<u32>,
    ) -> CoreContracts {
        log!("Deploying core contracts for domain: {}", local_domain);

        let mailbox_result = self
            .create_component("Mailbox", manifest_args!(local_domain))
            .await;

        let merkle_tree_hook_result = self
            .create_component("MerkleTreeHook", manifest_args!(mailbox_result.address))
            .await;

        let igp_result = self
            .create_component("InterchainGasPaymaster", manifest_args!(XRD))
            .await;

        let validator_announce_result = self
            .create_component("ValidatorAnnounce", manifest_args!(mailbox_result.address))
            .await;

        let validator: [u8; 20] = hex::decode(KEY.0)
            .expect("Failed to decode validator key")
            .try_into()
            .expect("Validator key should be exactly 20 bytes");
        let multisig_result = self
            .create_component(
                "MerkleRootMultisigIsm",
                manifest_args!(vec![validator], 1usize),
            )
            .await;

        let args = remote_domains
            .iter()
            .map(|x| (*x, multisig_result.address))
            .collect::<Vec<_>>();
        let routing_ism_result = self
            .create_component("RoutingIsm", manifest_args!(args))
            .await;

        let configs = remote_domains
            .iter()
            .map(|domain| (domain, ((10_000_000_000u128, 1u128), 10u128)))
            .collect::<Vec<_>>();
        self.call_method(
            igp_result.address,
            "set_destination_gas_configs",
            manifest_args!(configs),
            igp_result.badge,
        )
        .await;

        self.call_method(
            mailbox_result.address,
            "set_default_hook",
            manifest_args!(igp_result.address),
            mailbox_result.badge,
        )
        .await;

        self.call_method(
            mailbox_result.address,
            "set_required_hook",
            manifest_args!(merkle_tree_hook_result.address),
            mailbox_result.badge,
        )
        .await;

        self.call_method(
            mailbox_result.address,
            "set_default_ism",
            manifest_args!(routing_ism_result.address),
            mailbox_result.badge,
        )
        .await;

        log!(
            "Core contracts deployed and configured successfully for domain {}",
            local_domain
        );
        CoreContracts {
            mailbox: mailbox_result.address,
            merkle_tree_hook: merkle_tree_hook_result.address,
            interchain_gas_paymaster: igp_result.address,
            validator_announce: validator_announce_result.address,
        }
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
        let mut cores: HashMap<u32, CoreContracts> = HashMap::new();
        for &domain in &domains {
            let remotes: Vec<u32> = domains.iter().copied().filter(|d| *d != domain).collect();
            let core = self.deploy_core_contracts(domain, remotes).await;
            cores.insert(domain, core);
        }

        // 2. Deploy warp contracts (collateral + synthetic) for each domain
        log!("Step 2: Deploying warp contracts for each domain");
        let mut warps: HashMap<u32, WarpContracts> = HashMap::new();
        for &domain in &domains {
            log!("Deploying warp contracts for domain {}", domain);
            let core = cores
                .get(&domain)
                .expect("Core contracts should have been deployed for this domain");
            let warp = self.deploy_warp_contracts(core.mailbox).await;
            warps.insert(domain, warp);
        }

        // 3. Enroll remote routers for every ordered pair of distinct domains
        log!("Step 3: Enrolling remote routers across domains");
        for &local in &domains {
            log!("Setting up routing for domain {}", local);
            let local_warp = warps
                .get(&local)
                .expect("Warp contracts should have been deployed for this domain");
            let collateral_remote_warp_routes = warps
                .iter()
                .filter(|x| *x.0 != local)
                .map(|warp| (*warp.0, warp.1.collateral.address))
                .collect::<Vec<_>>();
            let synthetic_remote_warp_routes = warps
                .iter()
                .filter(|x| *x.0 != local)
                .map(|warp| (*warp.0, warp.1.synthetic.address))
                .collect::<Vec<_>>();
            log!(
                "Enrolling remote routers for collateral token on domain {}",
                local
            );
            self.enroll_remote_routers(
                local_warp.collateral.address,
                local_warp.collateral.owner,
                &synthetic_remote_warp_routes,
            )
            .await;
            log!(
                "Enrolling remote routers for synthetic token on domain {}",
                local
            );
            self.enroll_remote_routers(
                local_warp.synthetic.address,
                local_warp.synthetic.owner,
                &collateral_remote_warp_routes,
            )
            .await;
        }

        let to_string = |component: ComponentAddress| -> String {
            self.encoder
                .encode(component.as_bytes())
                .expect("Failed to encode component address")
        };

        log!("Finalizing contract deployments");
        let mut contracts: Vec<Contracts> = Vec::new();
        for &domain in &domains {
            let core = cores
                .get(&domain)
                .expect("Core contracts should have been deployed for this domain");
            let warp = warps
                .get(&domain)
                .expect("Warp contracts should have been deployed for this domain");
            contracts.push(Contracts {
                mailbox: to_string(core.mailbox),
                merkle_tree_hook: to_string(core.merkle_tree_hook),
                igp: to_string(core.interchain_gas_paymaster),
                validator_announce: to_string(core.validator_announce),
                collateral: warp.collateral.address,
            });
        }

        log!("Contract deployment completed successfully for all domains");
        contracts
    }
}
