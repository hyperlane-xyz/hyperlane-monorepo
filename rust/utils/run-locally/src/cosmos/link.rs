use std::path::Path;

use hpl_interface::{core, ism};

use super::{cli::OsmosisCLI, crypto::KeyPair, CosmosNetwork};

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
        &network.deployments.ism_routing,
        ism::routing::ExecuteMsg::Set {
            ism: ism::routing::ISMSet {
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
            hook: network.deployments.hook_merkle.clone(),
        },
        vec![],
    );

    cli.wasm_execute(
        &network.launch_resp.endpoint,
        linker,
        &network.deployments.mailbox,
        core::mailbox::ExecuteMsg::SetRequiredHook {
            hook: network.deployments.hook_merkle.clone(),
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
