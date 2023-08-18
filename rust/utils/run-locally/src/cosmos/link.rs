use std::path::PathBuf;

use hpl_interface::ism;

use super::{CosmosNetwork, OsmosisCLI};

pub fn link_network(
    bin: &PathBuf,
    linker: &str,
    validator: &str,
    src: &CosmosNetwork,
    dst: &CosmosNetwork,
) {
    let src_cli = src.launch_resp.cli(bin);
    let dst_cli = dst.launch_resp.cli(bin);

    let src_linker_addr = src_cli.get_addr(linker);
    let dst_linker_addr = dst_cli.get_addr(linker);

    let keypair = src_cli.get_keypair(validator);

    let src_to_dst_ism = src_cli.wasm_init(
        &src.launch_resp.endpoint,
        linker,
        Some(&src_linker_addr),
        src.launch_resp.codes.hpl_ism_multisig,
        ism::multisig::InstantiateMsg {
            owner: src_linker_addr.to_string(),
            addr_prefix: "osmo".to_string(),
        },
        &format!("[{} => {}]hpl-ism-multisig", src.domain, dst.domain),
    );

    let dst_to_src_ism = dst_cli.wasm_init(
        &dst.launch_resp.endpoint,
        linker,
        Some(&dst_linker_addr),
        dst.launch_resp.codes.hpl_ism_multisig,
        ism::multisig::InstantiateMsg {
            owner: dst_linker_addr.to_string(),
            addr_prefix: "osmo".to_string(),
        },
        &format!("[{} => {}]hpl-ism-multisig", dst.domain, src.domain),
    );
}
