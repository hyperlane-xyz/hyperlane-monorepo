use std::path::Path;

use cosmwasm_schema::cw_serde;
use hpl_interface::{
    core,
    ism::{self, multisig},
};

use super::{cli::OsmosisCLI, crypto::KeyPair, CosmosNetwork};

#[cw_serde]
pub struct GeneralIsmMessage<T> {
    pub ism: T,
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

    cli.wasm_query(
        &network.launch_resp.endpoint,
        &network.deployments.ism_multisig,
        multisig::QueryMsg::Ism(
            ism::IsmQueryMsg::Verify {
            message: hex::decode("0000000000000068220000000000000000000000000d1255b09d94659bb0888e0aa9fca60245ce402a0000682155208cd518cffaac1b5d8df216a9bd050c9a03f0d4f3ba88e5268ac4cd12ee2d68656c6c6f").unwrap().into(),
            metadata: hex::decode("986a1625d44e4b3969b08a5876171b2b4fcdf61b3e5c70a86ad17b304f17740a9f45d99ea6bec61392a47684f4e5d1416ddbcb5fdef0f132c27d7034e9bbff1c00000000ba9911d78ec6d561413e3589f920388cbd7554fbddd8ce50739337250853ec3577a51fa40e727c05b50f15db13f5aad5857c89d432644be48d70325ea83fdb6c1c").unwrap().into(),
        })
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
