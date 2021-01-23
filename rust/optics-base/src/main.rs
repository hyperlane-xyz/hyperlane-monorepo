//! This repo contains a simple framework for building Optics agents.
//! It has common utils and tools for configuring the app, interacting with the
//! smart contracts, etc.
//!
//! Implementations of the `Home` and `Replica` traits on different chains
//! ought to live here.
//!
//! Settings parsers live here, while config toml files live with their agent.

#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(unused_extern_crates)]

/// Interfaces to the ethereum contracts
pub mod abis;

/// Settings and configuration from file
pub mod settings;

use optics_core::traits::{Home, Replica};

use jane_eyre::{eyre::WrapErr, Result};
use std::collections::HashMap;

/// The global app context.
///
/// We erase all type info to allow easier abstraction across chains without
/// managing insanely large, annoying type systems.
///
/// Usually this will be bundled in a larger
#[derive(Debug)]
struct ChainConnections {
    home: Box<dyn Home>,
    replicas: HashMap<String, Box<dyn Replica>>,
}

impl ChainConnections {
    pub async fn try_from_settings(settings: &settings::Settings) -> Result<Self> {
        let home = settings
            .home
            .try_into_home()
            .await
            .wrap_err("failed to instantiate Home")?;

        let mut replicas = HashMap::new();
        // TODO: parallelize if this becomes expensive
        for (key, value) in settings.replicas.iter() {
            replicas.insert(
                key.clone(),
                value
                    .try_into_replica()
                    .await
                    .wrap_err_with(|| format!("Failed to instantiate replica named {}", key))?,
            );
        }

        let app = ChainConnections { home, replicas };
        Ok(app)
    }
}

async fn _main(settings: settings::Settings) {
    println!("{:?}", &settings);

    let app = ChainConnections::try_from_settings(&settings).await;

    println!("\n{:#?}", &app);
}

fn main() {
    let settings = settings::Settings::new().expect("!config");

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(_main(settings))
}
