use cosmwasm_schema::cw_serde;
use hpl_interface::{core, hook, igp, ism};
use macro_rules_attribute::apply;

use crate::utils::as_task;

use super::{
    cli::{OsmosisCLI, OsmosisEndpoint},
    types::{Codes, Deployments},
};

#[cw_serde]
pub struct IsmMultisigInstantiateMsg {
    pub owner: String,
    pub hrp: String,
}

#[cw_serde]
pub struct TestMockMsgReceiverInstantiateMsg {
    pub hrp: String,
}

const PREFIX: &str = "osmo";

#[apply(as_task)]
pub fn deploy_cw_hyperlane(
    cli: OsmosisCLI,
    endpoint: OsmosisEndpoint,
    deployer: String,
    codes: Codes,
    domain: u32,
) -> Deployments {
    let deployer_addr = &cli.get_addr(&deployer);

    let mailbox = cli.wasm_init(
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
    );

    // deploy igp set
    let igp = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_igp,
        igp::core::InstantiateMsg {
            owner: deployer_addr.clone(),
            gas_token: "uosmo".to_string(),
            mailbox: mailbox.to_string(),
            beneficiary: deployer_addr.clone(),
            hrp: PREFIX.to_string(),
        },
        "hpl_igp",
    );

    let igp_oracle = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_igp_oracle,
        igp::oracle::InstantiateMsg {},
        "hpl_igp_gas_oracle",
    );

    // deploy ism - routing ism with empty routes
    let ism_routing = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_ism_routing,
        ism::routing::InstantiateMsg {
            owner: deployer_addr.clone(),
            isms: vec![],
        },
        "hpl_ism_routing",
    );

    // deploy ism - multisig ism with no enrolled validators
    let ism_multisig = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_ism_multisig,
        IsmMultisigInstantiateMsg {
            owner: deployer_addr.clone(),
            hrp: PREFIX.to_string(),
        },
        "hpl_ism_multisig",
    );

    // deploy merkle hook
    let hook_merkle = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_hook_merkle,
        hook::merkle::InstantiateMsg {
            owner: deployer_addr.clone(),
            mailbox: mailbox.to_string(),
        },
        "hpl_hook_merkle",
    );

    // deploy routing hook
    let hook_routing = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_hook_routing,
        hook::routing::InstantiateMsg {
            owner: deployer_addr.clone(),
            mailbox: mailbox.to_string(),
        },
        "hpl_hook_routing",
    );

    // deploy va
    let va = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_validator_announce,
        core::va::InstantiateMsg {
            hrp: PREFIX.to_string(),
            mailbox: mailbox.to_string(),
        },
        "hpl_validator_announce",
    );

    // ---------- mock area -----------
    // deploy mock receiver
    let mock_receiver = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_test_mock_msg_receiver,
        TestMockMsgReceiverInstantiateMsg {
            hrp: PREFIX.to_string(),
        },
        "hpl_test_mock_msg_receiver",
    );

    // deploy mock hook
    let mock_hook = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_test_mock_hook,
        igp::oracle::InstantiateMsg {},
        "hpl_test_mock_hook",
    );

    Deployments {
        hook_merkle,
        hook_routing,
        igp,
        igp_oracle,
        ism_routing,
        ism_multisig,
        mailbox,
        mock_receiver,
        mock_hook,
        va,
    }
}
