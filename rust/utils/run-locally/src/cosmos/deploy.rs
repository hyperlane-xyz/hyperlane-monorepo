use cosmwasm_schema::cw_serde;
use hpl_interface::{core, hook, igp, ism};
use macro_rules_attribute::apply;

use crate::utils::as_task;

use super::{
    cli::{InjectiveCLI, InjectiveEndpoint},
    types::{Codes, Deployments},
};

#[cw_serde]
pub struct IsmMultisigInstantiateMsg {
    pub owner: String,
}

#[cw_serde]
pub struct IsmPausableInstantiateMsg {
    pub owner: String,
    pub paused: bool,
}

#[cw_serde]
pub struct TestMockMsgReceiverInstantiateMsg {
    pub hrp: String,
}

#[cw_serde]
pub struct IGPOracleInstantiateMsg {
    pub owner: String,
}

#[cw_serde]
pub struct EmptyMsg {}

const PREFIX: &str = "inj";

pub async fn deploy_cw_hyperlane(
    cli: InjectiveCLI,
    endpoint: InjectiveEndpoint,
    deployer: String,
    codes: Codes,
    domain: u32,
) -> Deployments {
    let deployer_addr = &cli.get_addr(&deployer);

    let mailbox = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_mailbox,
            core::mailbox::InstantiateMsg {
                owner: deployer_addr.to_string(),
                hrp: PREFIX.to_string(),
                domain,
            },
            "hpl_mailbox",
        )
        .await;

    // deploy igp set
    #[cw_serde]
    pub struct GasOracleInitMsg {
        pub hrp: String,
        pub owner: String,
        pub gas_token: String,
        pub beneficiary: String,
        pub default_gas_usage: String,
    }

    let igp = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_igp,
            GasOracleInitMsg {
                hrp: PREFIX.to_string(),
                owner: deployer_addr.clone(),
                gas_token: "inj".to_string(),
                beneficiary: deployer_addr.clone(),
                default_gas_usage: "25000".to_string(),
            },
            "hpl_igp",
        )
        .await;

    let igp_oracle = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_igp_oracle,
            igp::oracle::InstantiateMsg {
                owner: deployer_addr.clone(),
            },
            "hpl_igp_oracle",
        )
        .await;

    // deploy ism - routing ism with empty routes
    let ism_routing = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_ism_routing,
            ism::routing::InstantiateMsg {
                owner: deployer_addr.clone(),
                isms: vec![],
            },
            "hpl_ism_routing",
        )
        .await;

    // deploy ism - multisig ism with no enrolled validators
    let ism_multisig = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_ism_multisig,
            IsmMultisigInstantiateMsg {
                owner: deployer_addr.clone(),
            },
            "hpl_ism_multisig",
        )
        .await;

    // deploy pausable ism
    let ism_pausable = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_ism_pausable,
            IsmPausableInstantiateMsg {
                owner: deployer_addr.clone(),
                paused: false,
            },
            "hpl_ism_pausable",
        )
        .await;

    // deploy ism - aggregation
    let ism_aggregate = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_ism_aggregate,
            ism::aggregate::InstantiateMsg {
                owner: deployer_addr.clone(),
                threshold: 2,
                isms: vec![ism_multisig.clone(), ism_pausable.clone()],
            },
            "hpl_ism_aggregate",
        )
        .await;

    // deploy merkle hook
    let hook_merkle = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_hook_merkle,
            hook::merkle::InstantiateMsg {
                owner: deployer_addr.clone(),
                mailbox: mailbox.to_string(),
            },
            "hpl_hook_merkle",
        )
        .await;

    // deploy routing hook
    let hook_routing = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_hook_routing,
            hook::routing::InstantiateMsg {
                owner: deployer_addr.clone(),
            },
            "hpl_hook_routing",
        )
        .await;

    // deploy va
    let va = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_validator_announce,
            core::va::InstantiateMsg {
                hrp: PREFIX.to_string(),
                mailbox: mailbox.to_string(),
            },
            "hpl_validator_announce",
        )
        .await;

    // ---------- mock area -----------
    // deploy mock receiver
    let mock_receiver = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_test_mock_msg_receiver,
            TestMockMsgReceiverInstantiateMsg {
                hrp: PREFIX.to_string(),
            },
            "hpl_test_mock_msg_receiver",
        )
        .await;

    // deploy mock hook
    let mock_hook = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_test_mock_hook,
            EmptyMsg {},
            "hpl_test_mock_hook",
        )
        .await;

    let mock_ism = cli
        .wasm_init(
            &endpoint,
            &deployer,
            Some(deployer_addr),
            codes.hpl_test_mock_ism,
            EmptyMsg {},
            "hpl_test_mock_ism",
        )
        .await;

    Deployments {
        hook_merkle,
        hook_routing,
        igp,
        igp_oracle,
        ism_aggregate,
        ism_routing,
        ism_multisig,
        mailbox,
        mock_receiver,
        mock_hook,
        mock_ism,
        va,
    }
}
