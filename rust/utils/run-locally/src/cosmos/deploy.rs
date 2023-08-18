use hpl_interface::{hub, igp_core, igp_gas_oracle, ism, va};
use macro_rules_attribute::apply;

use crate::utils::as_task;

use super::{
    cli::{OsmosisCLI, OsmosisEndpoint},
    types::{Codes, Deployments},
};

fn deploy_hub_mailbox(
    cli: &OsmosisCLI,
    endpoint: &OsmosisEndpoint,
    (deployer, deployer_addr): (&str, &str), // (name, addr)
    hub_code_id: u64,
    mailbox_code_id: u64,
    default_ism: &str,
    origin_domain: u32,
) -> (String, String) {
    // deploy hub
    let hub = cli.wasm_init(
        endpoint,
        deployer,
        Some(deployer_addr),
        hub_code_id,
        hub::InstantiateMsg {
            origin_domain,
            mailbox_code: mailbox_code_id,
        },
        "hpl_hub",
    );

    let init_resp = cli.wasm_execute(
        endpoint,
        deployer,
        &hub,
        hub::ExecuteMsg::Instantiate {
            owner: deployer_addr.to_string(),
            default_ism: default_ism.to_string(),
        },
        vec![],
    );

    let init_log = init_resp.logs.first().unwrap();
    let init_evt = init_log
        .events
        .iter()
        .find(|v| v.typ == "wasm-mailbox_instantiated")
        .unwrap();

    let mailbox_addr = &init_evt
        .attributes
        .iter()
        .find(|v| v.key == "_contract_address")
        .unwrap()
        .value;

    (hub, mailbox_addr.clone())
}

#[apply(as_task)]
pub fn deploy_cw_hyperlane(
    cli: OsmosisCLI,
    endpoint: OsmosisEndpoint,
    deployer: String,
    codes: Codes,
    domain: u32,
) -> Deployments {
    let deployer_addr = &cli.get_addr(&deployer);

    // deploy igp set
    let igp = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_igp_core,
        igp_core::InstantiateMsg {
            owner: deployer_addr.clone(),
            gas_token: "uosmo".to_string(),
            beneficiary: deployer_addr.clone(),
        },
        "hpl_igp_core",
    );

    let igp_oracle = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_igp_gas_oracle,
        igp_gas_oracle::InstantiateMsg {},
        "hpl_igp_gas_oracle",
    );

    // deploy ism - routing ism with empty routes
    let default_ism = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_ism_routing,
        ism::routing::InstantiateMsg {
            owner: deployer_addr.clone(),
            isms: vec![],
        },
        "hpl_routing_ism",
    );

    let (hub, mailbox) = deploy_hub_mailbox(
        &cli,
        &endpoint,
        (&deployer, deployer_addr),
        codes.hpl_hub,
        codes.hpl_mailbox,
        &default_ism,
        domain,
    );

    // deploy va
    let va = cli.wasm_init(
        &endpoint,
        &deployer,
        Some(deployer_addr),
        codes.hpl_validator_announce,
        va::InstantiateMsg {
            addr_prefix: "osmo".to_string(),
            mailbox: mailbox.to_string(),
            local_domain: domain,
        },
        "hpl_validator_announce",
    );

    Deployments {
        igp,
        igp_oracle,
        hub,
        mailbox,
        va,
    }
}
