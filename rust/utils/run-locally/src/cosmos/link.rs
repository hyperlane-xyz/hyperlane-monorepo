use std::path::Path;

use cosmwasm_schema::cw_serde;
use hyperlane_cosmwasm_interface::{
    core,
    ism::{self},
};

use super::{cli::OsmosisCLI, crypto::KeyPair, CosmosNetwork};

#[cw_serde]
pub struct GeneralIsmMessage<T> {
    pub ism: T,
}

#[cw_serde]
pub struct GeneralRouterMessage<T> {
    pub router: T,
}

#[cw_serde]
pub struct GeneralHookMessage<T> {
    pub hook: T,
}

#[cw_serde]
pub struct MockRouterMsg {
    pub set_route: MockRouterMsgInner,
}

#[cw_serde]
pub struct MockRouterMsgInner {
    pub set: MockDomainRouteSet,
}

#[cw_serde]
pub struct MockDomainRouteSet {
    pub domain: u32,
    pub route: String,
}

#[cw_serde]
pub struct RemoteGasDataConfig {
    pub remote_domain: u32,
    pub token_exchange_rate: String,
    pub gas_price: String,
}

#[cw_serde]
pub struct RemoteGasDataConfigExecute {
    pub set_remote_gas_data_configs: RemoteGasDataConfigExecuteInner,
}

#[cw_serde]
pub struct RemoteGasDataConfigExecuteInner {
    pub configs: Vec<RemoteGasDataConfig>,
}

#[cw_serde]
pub struct MockHookQueryMsg {
    quote_dispatch: MockQuoteDispatch,
}

#[cw_serde]
pub struct MockQuoteDispatch {
    pub metadata: String,
    pub message: String,
}

#[cw_serde]
pub struct GeneralIsmValidatorMessage {
    pub set_validators: SetValidatorsMsg,
}

#[cw_serde]
pub struct SetValidatorsMsg {
    pub domain: u32,
    pub threshold: u8,
    pub validators: Vec<String>,
}

fn link_network(
    cli: &OsmosisCLI,
    network: &CosmosNetwork,
    hrp: &str,
    linker: &str,
    validator: &KeyPair,
    target_domain: u32,
) {
    let validator_addr = validator.addr(hrp);

    let dest_domain = if network.domain == 99990 {
        99991
    } else {
        99990
    };

    // hook routing

    // link src chain
    let public_key = validator.priv_key.verifying_key().to_encoded_point(false);
    let public_key = public_key.as_bytes();

    let hash = hyperlane_cosmwasm_interface::types::keccak256_hash(&public_key[1..]);

    let mut bytes = [0u8; 20];
    bytes.copy_from_slice(&hash.as_slice()[12..]);

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.ism_multisig,
        GeneralIsmValidatorMessage {
            set_validators: SetValidatorsMsg {
                threshold: 1,
                domain: target_domain,
                validators: vec![hex::encode(bytes).to_string()],
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.hook_routing,
        GeneralRouterMessage {
            router: MockRouterMsg {
                set_route: MockRouterMsgInner {
                    set: MockDomainRouteSet {
                        domain: target_domain,
                        route: network.deployments.hook_merkle.clone(),
                    },
                },
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.ism_routing,
        ism::routing::ExecuteMsg::Set {
            ism: ism::routing::IsmSet {
                domain: target_domain,
                address: network.deployments.ism_aggregate.clone(),
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.mailbox,
        core::mailbox::ExecuteMsg::SetDefaultHook {
            hook: network.deployments.hook_routing.clone(),
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.igp_oracle,
        RemoteGasDataConfigExecute {
            set_remote_gas_data_configs: RemoteGasDataConfigExecuteInner {
                configs: vec![RemoteGasDataConfig {
                    remote_domain: dest_domain,
                    token_exchange_rate: "10000".to_string(),
                    gas_price: "1000000000".to_string(),
                }],
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.igp,
        GeneralRouterMessage {
            router: MockRouterMsg {
                set_route: MockRouterMsgInner {
                    set: MockDomainRouteSet {
                        domain: target_domain,
                        route: network.deployments.igp_oracle.clone(),
                    },
                },
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.mailbox,
        core::mailbox::ExecuteMsg::SetRequiredHook {
            hook: network.deployments.igp.clone(),
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.mailbox,
        core::mailbox::ExecuteMsg::SetDefaultIsm {
            ism: network.deployments.ism_routing.clone(),
        },
        vec![],
    );

    cli.bank_send(
        &network.launch_resp.endpoint,
        linker,
        &validator_addr,
        "osmo1l83956lgpak5sun7ggupls7rk7p5cr95499jdf",
        "10000000uosmo",
    );

    // TODO
    // cli.wasm_execute(
    //     &network.launch_resp.endpoint,
    //     linker,
    //     &network.deployments.va,
    //     va::ExecuteMsg::Announce {
    //         validator: (),
    //         storage_location: (),
    //         signature: (),
    //     },
    //     vec![],
    // );
}

pub fn link_networks(
    bin: &Path,
    linker: &str,
    validator: &str,
    src: &CosmosNetwork,
    dst: &CosmosNetwork,
) {
    let src_cli = src.launch_resp.cli(bin);
    let dst_cli = dst.launch_resp.cli(bin);

    let keypair = src_cli.get_keypair(validator);

    link_network(&src_cli, src, "osmo", linker, &keypair, dst.domain);
    link_network(&dst_cli, dst, "osmo", linker, &keypair, src.domain);
}
