use std::path::Path;

use cosmwasm_schema::cw_serde;
use hpl_interface::{
    core, igp,
    ism::{self, multisig},
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

fn link_network(
    cli: &OsmosisCLI,
    network: &CosmosNetwork,
    hrp: &str,
    linker: &str,
    validator: &KeyPair,
    target_domain: u32,
) {
    let validator_addr = validator.addr(hrp);
    let validator_pubkey = validator.pub_key_to_binary();

    let dest_domain = if network.domain == 26657 {
        26658
    } else {
        26657
    };

    // hook routing

    // link src chain
    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.ism_multisig,
        ism::multisig::ExecuteMsg::EnrollValidator {
            set: ism::multisig::ValidatorSet {
                domain: target_domain,
                validator: validator_addr.clone(),
                validator_pubkey: validator_pubkey.clone().into(),
            },
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.ism_multisig,
        ism::multisig::ExecuteMsg::SetThreshold {
            set: ism::multisig::ThresholdSet {
                domain: target_domain,
                threshold: 1,
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
                address: network.deployments.ism_multisig.clone(),
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
