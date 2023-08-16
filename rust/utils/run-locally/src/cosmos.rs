use crate::logging::log;

const OSMOSIS_CLI_GIT: &str = "https://github.com/osmosis-labs/osmosis";
const OSMOSIS_CLI_VERSION: &str = "16.1.1";

const CW_HYPERLANE_GIT: &str = "https://github.com/many-things/cw-hyperlane";
const CW_HYPERLANE_VERSION: &str = "0.0.1";

fn install_cli() {
    let target = {
        let os = if cfg!(target_os = "linux") {
            "linux"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            panic!("Current os is not supported by Osmosis")
        };

        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "amd64"
        };

        format!("{}-{}", os, arch)
    };

    let uri = format!("{OSMOSIS_CLI_GIT}/releases/download/v{OSMOSIS_CLI_VERSION}/osmosisd-{OSMOSIS_CLI_VERSION}-{target}.tar.gz");
    log!("Downloading Osmosis CLI from {}", uri);
}

fn install_codes() {
    let uri = format!("{CW_HYPERLANE_GIT}/releases/download/{CW_HYPERLANE_VERSION}/cw-hyperlane-v{CW_HYPERLANE_VERSION}.tar.gz");
    log!("Downloading cw-hyperlane from {}", uri);
}
