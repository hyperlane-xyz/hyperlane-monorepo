use std::{collections::BTreeMap, fs, path::PathBuf};

use tempfile::tempdir;

use crate::{
    logging::log,
    starknet::utils::{download, make_target, make_target_starkli, untar, unzip},
    utils::concat_path,
};

use super::{CAIRO_HYPERLANE_GIT, CAIRO_HYPERLANE_VERSION, STARKNET_CLI_GIT, STARKNET_CLI_VERSION};

pub enum CodeSource {
    Local { path: String },
    Remote { url: String, version: String },
}

impl Default for CodeSource {
    fn default() -> Self {
        Self::remote(CAIRO_HYPERLANE_GIT, CAIRO_HYPERLANE_VERSION)
    }
}

impl CodeSource {
    pub fn local(path: &str) -> Self {
        Self::Local {
            path: path.to_string(),
        }
    }

    pub fn remote(url: &str, version: &str) -> Self {
        Self::Remote {
            url: url.to_string(),
            version: version.to_string(),
        }
    }
}

impl CodeSource {
    fn install_local(src: String) -> BTreeMap<String, PathBuf> {
        // make contract_name => path map
        fs::read_dir(src)
            .unwrap()
            .map(|v| {
                let entry = v.unwrap();
                (entry.file_name().into_string().unwrap(), entry.path())
            })
            .filter(|(filename, _)| filename.ends_with(".contract_class.json"))
            .filter(|(filename, _)| !filename.to_lowercase().contains("test"))
            .filter(|(filename, _)| !filename.to_lowercase().contains("mock"))
            .map(|v| (v.0.replace(".contract_class.json", ""), v.1))
            .collect()
    }

    fn install_remote(
        dir: Option<PathBuf>,
        git: String,
        version: String,
    ) -> BTreeMap<String, PathBuf> {
        let dir_path = match dir {
            Some(path) => path,
            None => tempdir().unwrap().into_path(),
        };
        let dir_path = dir_path.to_str().unwrap();

        let release_name = format!("hyperlane-starknet-v{version}");
        let release_comp = format!("{release_name}.zip");

        log!("Downloading hyperlane-starknet v{}", version);
        let uri = format!("{git}/releases/download/v{version}/{release_comp}");
        download(&release_comp, &uri, dir_path);

        log!("Uncompressing hyperlane-starknet release");
        unzip(&release_comp, dir_path);

        // make contract_name => path map
        fs::read_dir(dir_path)
            .unwrap()
            .map(|v| {
                let entry = v.unwrap();
                (entry.file_name().into_string().unwrap(), entry.path())
            })
            .filter(|(filename, _)| filename.ends_with(".contract_class.json"))
            .filter(|(filename, _)| !filename.to_lowercase().contains("test"))
            .filter(|(filename, _)| !filename.to_lowercase().contains("mock"))
            .map(|v| (v.0.replace(".contract_class.json", ""), v.1))
            .collect()
    }

    #[allow(dead_code)]
    pub fn install(self, dir: Option<PathBuf>) -> BTreeMap<String, PathBuf> {
        match self {
            CodeSource::Local { path } => Self::install_local(path),
            CodeSource::Remote { url, version } => Self::install_remote(dir, url, version),
        }
    }
}

pub enum StarknetCLISource {
    Local { path: String },
    Remote { url: String, version: String },
}

impl Default for StarknetCLISource {
    fn default() -> Self {
        if make_target().starts_with("darwin") {
            Self::remote(
                "https://github.com/xJonathanLEI/starkli",
                STARKNET_CLI_VERSION,
            )
        } else {
            Self::remote(STARKNET_CLI_GIT, STARKNET_CLI_VERSION)
        }
    }
}

impl StarknetCLISource {
    pub fn local(path: &str) -> Self {
        Self::Local {
            path: path.to_string(),
        }
    }

    pub fn remote(url: &str, version: &str) -> Self {
        Self::Remote {
            url: url.to_string(),
            version: version.to_string(),
        }
    }
}

impl StarknetCLISource {
    fn install_remote(dir: Option<PathBuf>, git: String, version: String) -> PathBuf {
        let target = make_target_starkli();

        let dir_path = match dir {
            Some(path) => path,
            None => tempdir().unwrap().into_path(),
        };
        let dir_path = dir_path.to_str().unwrap();

        let release_name = format!("starkli-{target}");
        let release_comp = format!("{release_name}.tar.gz");

        log!("Downloading Starkli CLI v{}", version);
        let uri = format!("{git}/releases/download/v{version}/{release_comp}");
        download(&release_comp, &uri, dir_path);

        log!("Uncompressing Starkli release");
        untar(&release_comp, dir_path);

        concat_path(dir_path, "starkli")
    }

    pub fn install(self, dir: Option<PathBuf>) -> PathBuf {
        match self {
            StarknetCLISource::Local { path } => path.into(),
            StarknetCLISource::Remote { url, version } => Self::install_remote(dir, url, version),
        }
    }
}
