//! Common settings and configuration for Hyperlane agents
//!
//! The correct settings shape is defined in the TypeScript SDK metadata. While the the exact shape
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
//! additional `Settings` in their own crate. By convention this is done in
//! `settings.rs` using the [`decl_settings!`] macro.
//!
//! ### Configuration
//!
//! Agents read settings from the config files, then from environment, and
//! finally from program arguments.
//!
//! #### N.B.: Environment variable names correspond 1:1 with cfg file's JSON object hierarchy.
//!
//! In particular, note that any environment variables whose names are prefixed
//! with:
//!
//! * `HYP_BASE`
//!
//! * `HYP_[agentname]`, where `[agentmame]` is agent-specific, e.g.
//!   `HYP_VALIDATOR` or `HYP_RELAYER`.
//!
//! will be read as an override to be applied against the hierarchical structure
//! of the configuration provided by the json config file at
//! `./config/<env>/<config>.json`.
//!
//! For example, if the config file `example_config.json` is:
//!
//! ```json
//! {
//!   "environment": "test",
//!   "signers": {},
//!   "chains": {
//!     "test2": {
//!       "domain": "13372",
//!       ...
//!     },
//!     ...
//!   },
//! }
//! ```
//!
//! and an environment variable is supplied which defines
//! `HYP_BASE_CHAINS_TEST2_DOMAIN=1`, then the `decl_settings` macro in
//! `rust/hyperlane-base/src/macros.rs` will directly override the 'domain'
//! field found in the json config to be `1`, since the fields in the
//! environment variable name describe the path traversal to arrive at this
//! field in the JSON config object.
//!
//! ### Configuration value precedence
//!
//! Configuration key/value pairs are loaded in the following order, with later
//! sources taking precedence:
//!
//! 1. The files matching `config/<env>/<config>.json`.
//! 2. The order of configs in `CONFIG_FILES` with each sequential one
//!    overwriting previous ones as appropriate.
//! 3. Configuration env vars with the prefix `HYP_BASE` intended
//!    to be shared by multiple agents in the same environment
//!    E.g. `export HYP_BASE_INBOXES_KOVAN_DOMAIN=3000`
//! 4. Configuration env vars with the prefix `HYP_<agent_prefix>`
//!    intended to be used by a specific agent.
//!    E.g. `export HYP_RELAYER_ORIGINCHAIN="ethereum"`
//! 5. Arguments passed to the agent on the command line.
//!    E.g. `--originChainName ethereum`

pub use base::*;
pub use chains::*;
pub use checkpoint_syncer::*;
/// Export this so they don't need to import paste.
#[doc(hidden)]
pub use paste;
pub use signers::*;
pub use trace::*;

mod envs {
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
pub mod deprecated_parser;
pub mod parser;

#[doc(hidden)]
pub use derive_more;

/// Declare a new settings block
///
/// This macro declares a settings struct for an agent. The new settings block
/// contains a [`crate::Settings`] and any other specified attributes.
///
/// Please note that integers must be specified as `String` in order to allow
/// them to be configured via env var. They must then be parsed in the
/// [`Agent::from_settings`](crate::agent::Agent::from_settings)
/// method.
///
/// ### Usage
///
/// ```ignore
/// decl_settings!(Validator {
///    validator: SignerConf,
///    checkpointsyncer: CheckpointSyncerConf,
///    reorgperiod: String,
///    interval: String,
/// });
/// ```
#[macro_export]
macro_rules! decl_settings {
    (
        $name:ident,
        Parsed {
            $($(#[$parsed_tags:meta])* $parsed_prop:ident: $parsed_type:ty,)*
        },
        Raw {
            $($(#[$raw_tags:meta])* $raw_prop:ident: $raw_type:ty,)*
        }$(,)?
    ) => {
        hyperlane_base::settings::paste::paste! {
            #[doc = "Settings for `" $name "`"]
            #[derive(
                Debug,
                hyperlane_base::settings::derive_more::AsRef,
                hyperlane_base::settings::derive_more::AsMut,
                hyperlane_base::settings::derive_more::Deref,
                hyperlane_base::settings::derive_more::DerefMut,
            )]
            pub struct [<$name Settings>] {
                #[as_ref] #[as_mut]
                #[deref] #[deref_mut]
                base: hyperlane_base::settings::Settings,
                $(
                    $(#[$parsed_tags])*
                    pub(crate) $parsed_prop: $parsed_type,
                )*
            }

            #[doc = "Raw settings for `" $name "`"]
            #[derive(
                Debug,
                serde::Deserialize,
                hyperlane_base::settings::derive_more::AsMut,
            )]
            #[serde(rename_all = "camelCase")]
            pub struct [<Raw $name Settings>] {
                #[serde(flatten, default)]
                #[as_mut]
                base: hyperlane_base::settings::deprecated_parser::DeprecatedRawSettings,
                $(
                    $(#[$raw_tags])*
                    $raw_prop: $raw_type,
                )*
            }

            hyperlane_base::impl_loadable_from_settings!(stringify!($name), [<Raw $name Settings>] -> [<$name Settings>]);
        }
    };
}

/// Declare that an agent can be constructed from settings.
///
/// E.g.
/// ```ignore
/// impl_loadable_from_settings!(MyAgent, RawSettingsForMyAgent -> SettingsForMyAgent);
/// ```
#[macro_export]
macro_rules! impl_loadable_from_settings {
    ($agent:expr, $settingsparser:ident -> $settingsobj:ident) => {
        impl hyperlane_base::LoadableFromSettings for $settingsobj {
            fn load() -> hyperlane_core::config::ConfigResult<Self> {
                hyperlane_base::settings::loader::load_settings::<$settingsparser, $settingsobj>(
                    $agent,
                )
            }
        }
    };
}
