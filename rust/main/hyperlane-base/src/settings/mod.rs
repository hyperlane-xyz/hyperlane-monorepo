//! Common settings and configuration for Hyperlane agents
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the exact shape
//! and validations it defines are not applied here, we should mirror them.
//! ANY CHANGES HERE NEED TO BE REFLECTED IN THE TYPESCRIPT SDK.
//!
//! ## Introduction
//!
//! Hyperlane Agents have a shared core, which contains connection info for rpc,
//! relevant contract addresses on each chain, etc. In addition, each agent has
//! agent-specific settings. By convention above, we represent these as a base
//! config per-Mailbox contract, and a "partial" config per agent. On bootup,
//! the agent loads the configuration, establishes RPC connections, and monitors
//! each configured chain.
//!
//! All agents share the [`Settings`] struct in this crate, and then define any
//! additional `Settings` in their own crate.
//!
//! ### Configuration
//!
//! Agents read settings from the config files, then from environment, and
//! finally from program arguments.
//!
//! #### N.B.: Environment variable names correspond 1:1 with cfg file's JSON object hierarchy.
//!
//! In particular, note that any environment variables whose names are prefixed
//! with `HYP_` will be read as an override to be applied against the hierarchical structure
//! of the configuration provided by the json config file at
//! `./config/<env>/<config>.json`.
//!
//! For example, if the config file `example_config.json` is:
//!
//! ```json
//! {
//!   "signers": {},
//!   "chains": {
//!     "test2": {
//!       "domainId": "9913372",
//!       ...
//!     },
//!     ...
//!   },
//! }
//! ```
//!
//! and an environment variable is supplied which defines
//! `HYP_CHAINS_TEST2_DOMAINID=1`, then the config parser will directly override the value of
//! the field found in config to be `1`, since the fields in the environment variable name describe
//! the path traversal to arrive at this field in the JSON config object.
//!
//! ### Configuration value precedence
//!
//! Configuration key/value pairs are loaded in the following order, with later
//! sources taking precedence:
//!
//! 1. The files matching `config/<env>/<config>.json`.
//! 2. The order of configs in `CONFIG_FILES` with each sequential one
//!    overwriting previous ones as appropriate.
//! 3. Configuration env vars with the prefix `HYP` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export HYP_CHAINS_ARBITRUM_DOMAINID=3000`
//! 5. Arguments passed to the agent on the command line.
//!    E.g. `--originChainName ethereum`

pub use base::*;
pub use chains::*;
pub use checkpoint_syncer::*;
pub use signers::*;
pub use trace::*;

mod envs {
    pub use hyperlane_cosmos as h_cosmos;
    pub use hyperlane_cosmos_native as h_cosmos_native;
    pub use hyperlane_ethereum as h_eth;
    pub use hyperlane_fuel as h_fuel;
    pub use hyperlane_sealevel as h_sealevel;
}

/// AWS Credentials provider.
pub(crate) mod aws_credentials;
mod base;
/// Chain configuration
mod chains;
pub mod loader;
/// Signer configuration
mod signers;
/// Tracing subscriber management
mod trace;

mod checkpoint_syncer;
pub mod parser;

/// Declare that an agent can be constructed from settings.
///
/// E.g.
/// ```ignore
/// impl_loadable_from_settings!(MyAgent, RawSettingsForMyAgent -> SettingsForMyAgent);
/// ```
#[macro_export]
macro_rules! impl_loadable_from_settings {
    ($agent:ident, $settingsparser:ident -> $settingsobj:ident) => {
        impl hyperlane_base::LoadableFromSettings for $settingsobj {
            fn load() -> hyperlane_core::config::ConfigResult<Self> {
                hyperlane_base::settings::loader::load_settings::<$settingsparser, Self>()
            }
        }
    };
}
