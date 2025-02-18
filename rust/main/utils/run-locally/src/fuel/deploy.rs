use ethers::types::H160;
use fuels::{
    accounts::wallet::WalletUnlocked,
    programs::contract::{Contract, LoadConfiguration},
    types::{transaction::TxPolicies, Bits256, ContractId, EvmAddress, Identity, Salt},
};
use rand::{thread_rng, Rng};

use crate::{fuel::abis::*, log};

pub struct FuelDeployments {
    pub gas_paymaster: GasPaymaster<WalletUnlocked>,
    pub mailbox: Mailbox<WalletUnlocked>,
    pub merkle_tree_hook: MerkleTreeHook<WalletUnlocked>,
    pub msg_recipient_test: MsgRecipientTest<WalletUnlocked>,
    pub validator_announce: ValidatorAnnounce<WalletUnlocked>,
}

/// Ensures random deployment addresses each run
fn get_deployment_config() -> LoadConfiguration {
    let mut bytes = [0u8; 32];
    thread_rng().fill(&mut bytes[..]);
    let salt = Salt::new(bytes);

    LoadConfiguration::default().with_salt(salt)
}

pub async fn deploy_fuel_hyperlane(
    wallet: WalletUnlocked,
    origin_domain: u32,
    target_domain: u32,
    validator_addr: H160,
) -> FuelDeployments {
    let aggregation_ism_id = Contract::load_from(
        "./src/fuel/fuel-contracts/aggregation-ism.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let domain_routing_ism_id = Contract::load_from(
        "./src/fuel/fuel-contracts/domain-routing-ism.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let fallback_domain_routing_hook_id = Contract::load_from(
        "./src/fuel/fuel-contracts/fallback-domain-routing-hook.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let gas_oracle_id = Contract::load_from(
        "./src/fuel/fuel-contracts/gas-oracle.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let igp_id = Contract::load_from(
        "./src/fuel/fuel-contracts/gas-paymaster.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let configurables = MailboxConfigurables::default()
        .with_LOCAL_DOMAIN(origin_domain)
        .unwrap();
    let mailbox_id = Contract::load_from(
        "./src/fuel/fuel-contracts/mailbox.bin",
        get_deployment_config().with_configurables(configurables),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let configurables = MessageIdMultisigISMConfigurables::default()
        .with_THRESHOLD(1)
        .unwrap();
    let message_id_multisig_ism_id = Contract::load_from(
        "./src/fuel/fuel-contracts/message-id-multisig-ism.bin",
        get_deployment_config().with_configurables(configurables),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let pausable_ism_id = Contract::load_from(
        "./src/fuel/fuel-contracts/pausable-ism.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let merkle_tree_hook_id = Contract::load_from(
        "./src/fuel/fuel-contracts/merkle-tree-hook.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let msg_recipient_test_id = Contract::load_from(
        "./src/fuel/fuel-contracts/msg-recipient-test.bin",
        get_deployment_config(),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    let configurables = ValidatorAnnounceConfigurables::default()
        .with_LOCAL_DOMAIN(origin_domain)
        .unwrap()
        .with_MAILBOX_ID(mailbox_id.clone().into())
        .unwrap();

    let validator_announce_id = Contract::load_from(
        "./src/fuel/fuel-contracts/validator-announce.bin",
        get_deployment_config().with_configurables(configurables),
    )
    .unwrap()
    .deploy(&wallet, TxPolicies::default())
    .await
    .unwrap();

    log!("Fuel contracts deployed on {:?} ✅", origin_domain);
    log!("Initializing contracts...");

    let owner = Identity::from(wallet.address());
    let aggregation_ism = AggregationISM::new(aggregation_ism_id.clone(), wallet.clone());

    let aggregate_isms: Vec<ContractId> = vec![
        message_id_multisig_ism_id.clone().into(),
        pausable_ism_id.clone().into(),
    ];
    aggregation_ism
        .methods()
        .initialize(owner, aggregate_isms, 2)
        .call()
        .await
        .unwrap();

    let domain_routing_ism = DomainRoutingISM::new(domain_routing_ism_id.clone(), wallet.clone());

    domain_routing_ism
        .methods()
        .initialize_with_domains(
            owner,
            vec![target_domain],
            vec![Bits256(ContractId::from(aggregation_ism_id.clone()).into())],
        )
        .call()
        .await
        .unwrap();

    let fallback_domain_routing_hook =
        FallbackDomainRoutingHook::new(fallback_domain_routing_hook_id.clone(), wallet.clone());

    fallback_domain_routing_hook
        .methods()
        .initialize_ownership(owner)
        .call()
        .await
        .unwrap();
    fallback_domain_routing_hook
        .methods()
        .set_hook(
            target_domain,
            Bits256(ContractId::from(merkle_tree_hook_id.clone()).into()),
        )
        .call()
        .await
        .unwrap();

    let gas_oracle = GasOracle::new(gas_oracle_id.clone(), wallet.clone());

    gas_oracle
        .methods()
        .initialize_ownership(owner)
        .call()
        .await
        .unwrap();
    let gas_oracle_configs = vec![RemoteGasDataConfig {
        domain: target_domain,
        remote_gas_data: RemoteGasData {
            domain: target_domain,
            gas_price: 500,
            token_exchange_rate: 1, // since sending Fuel to Fuel
            token_decimals: 9,
        },
    }];
    gas_oracle
        .methods()
        .set_remote_gas_data_configs(gas_oracle_configs)
        .call()
        .await
        .unwrap();

    let gas_paymaster = GasPaymaster::new(igp_id.clone(), wallet.clone());

    gas_paymaster
        .methods()
        .initialize(owner, owner)
        .call()
        .await
        .unwrap();
    gas_paymaster
        .methods()
        .set_gas_oracle(
            target_domain,
            Bits256(ContractId::from(gas_oracle_id.clone()).into()),
        )
        .call()
        .await
        .unwrap();

    let mailbox = Mailbox::new(mailbox_id.clone(), wallet.clone());

    mailbox
        .methods()
        .initialize(
            owner,
            Bits256(ContractId::from(domain_routing_ism_id.clone()).into()),
            Bits256(ContractId::from(fallback_domain_routing_hook_id.clone()).into()),
            Bits256(ContractId::from(igp_id.clone()).into()),
        )
        .call()
        .await
        .unwrap();

    let message_id_multisig_ism =
        MessageIdMultisigISM::new(message_id_multisig_ism_id, wallet.clone());

    let validators = {
        let mut padded = [0u8; 32];
        padded[12..].copy_from_slice(&validator_addr.0);
        vec![EvmAddress::from(Bits256(padded))]
    };
    message_id_multisig_ism
        .methods()
        .initialize(validators)
        .call()
        .await
        .unwrap();

    let pausable_ism = PausableISM::new(pausable_ism_id, wallet.clone());
    pausable_ism
        .methods()
        .initialize_ownership(owner)
        .call()
        .await
        .unwrap();

    let merkle_tree_hook = MerkleTreeHook::new(merkle_tree_hook_id, wallet.clone());
    merkle_tree_hook
        .methods()
        .initialize(mailbox_id)
        .call()
        .await
        .unwrap();

    log!("Fuel contracts initialized on {:?} ✅", origin_domain);

    FuelDeployments {
        gas_paymaster,
        mailbox,
        merkle_tree_hook,
        msg_recipient_test: MsgRecipientTest::new(msg_recipient_test_id, wallet.clone()),
        validator_announce: ValidatorAnnounce::new(validator_announce_id, wallet.clone()),
    }
}
