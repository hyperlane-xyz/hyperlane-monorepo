use std::{collections::BTreeMap, fs, path::PathBuf};

use tempfile::tempdir;

use crate::{
    cosmos::{
        make_target,
        utils::{download, untar},
    },
    logging::log,
    utils::concat_path,
};

use super::{CW_HYPERLANE_GIT, CW_HYPERLANE_VERSION, OSMOSIS_CLI_GIT, OSMOSIS_CLI_VERSION};

pub enum CodeSource {
    Local { path: String },
    Remote { url: String, version: String },
}

impl Default for CodeSource {
    fn default() -> Self {
        Self::remote(CW_HYPERLANE_GIT, CW_HYPERLANE_VERSION)
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
            .filter(|(filename, _)| filename.ends_with(".wasm"))
            .map(|v| (v.0.replace(".wasm", ""), v.1))
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

        let release_name = format!("cw-hyperlane-v{version}");
        let release_comp = format!("{release_name}.tar.gz");

        log!("Downloading cw-hyperlane v{}", version);
        let uri = format!("{git}/releases/download/v{version}/{release_comp}");
        download(&release_comp, &uri, dir_path);

        log!("Uncompressing cw-hyperlane release");
        untar(&release_comp, dir_path);

        // make contract_name => path map
        fs::read_dir(concat_path(dir_path, release_name))
            .unwrap()
            .map(|v| {
                let entry = v.unwrap();
                (entry.file_name().into_string().unwrap(), entry.path())
            })
            .filter(|(filename, _)| filename.ends_with(".wasm"))
            .map(|v| (v.0.replace(".wasm", ""), v.1))
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

#[derive(Debug)]
pub enum CLISource {
    Local { path: String },
    Remote { url: String, version: String },
}

impl Default for CLISource {
    fn default() -> Self {
        if make_target().starts_with("darwin") {
            Self::remote("https://github.com/hashableric/osmosis", "19.0.0-mnts")
        } else {
            Self::remote(OSMOSIS_CLI_GIT, OSMOSIS_CLI_VERSION)
        }
    }
}

impl CLISource {
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

impl CLISource {
    fn install_remote(dir: Option<PathBuf>, git: String, version: String) -> PathBuf {
        let target = make_target();

        let dir_path = match dir {
            Some(path) => path,
            None => tempdir().unwrap().into_path(),
        };
        let dir_path = dir_path.to_str().unwrap();

        let release_name = format!("osmosisd-{version}-{target}");
        let release_comp = format!("{release_name}.tar.gz");

        log!("Downloading Osmosis CLI v{}", version);
        let uri = format!("{git}/releases/download/v{version}/{release_comp}");
        download(&release_comp, &uri, dir_path);

        log!("Uncompressing Osmosis release");
        untar(&release_comp, dir_path);
        concat_path(dir_path, "release/osmosisd-26.0.1-linux-amd64")
    }

    pub fn install(self, dir: Option<PathBuf>) -> PathBuf {
        match self {
            CLISource::Local { path } => path.into(),
            CLISource::Remote { url, version } => Self::install_remote(dir, url, version),
        }
    }
}
