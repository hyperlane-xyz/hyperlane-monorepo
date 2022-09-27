#[macro_export]
/// Shortcut for aborting a joinhandle and then awaiting and discarding its result
macro_rules! cancel_task {
    ($task:ident) => {
        #[allow(unused_must_use)]
        {
            let t = $task.into_inner();
            t.abort();
            t.await;
        }
    };
}

#[macro_export]
/// Shortcut for implementing agent traits
macro_rules! impl_as_ref_core {
    ($agent:ident) => {
        impl AsRef<abacus_base::AbacusAgentCore> for $agent {
            fn as_ref(&self) -> &abacus_base::AbacusAgentCore {
                &self.core
            }
        }
    };
}

#[macro_export]
/// Declare a new agent struct with the additional fields
macro_rules! decl_agent {
    (
        $(#[$outer:meta])*
        $name:ident{
            $($prop:ident: $type:ty,)*
        }) => {

        $(#[$outer])*
        #[derive(Debug)]
        pub struct $name {
            $($prop: $type,)*
            core: abacus_base::AbacusAgentCore,
        }

        $crate::impl_as_ref_core!($name);
    };
}

/// Export this so they don't need to import paste.
#[doc(hidden)]
pub use paste;
use serde::Deserialize;

#[macro_export]
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
macro_rules! decl_settings {
    (
        $name:ident {
            $($(#[$tags:meta])* $prop:ident: $type:ty,)*
        }
    ) => {
        abacus_base::macros::paste::paste! {
            #[derive(Debug, serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            #[doc = "Settings for `" $name]
            pub struct [<$name Settings>] {
                #[serde(flatten)]
                pub(crate) base: abacus_base::Settings,
                $(
                    $(#[$tags])*
                    pub(crate) $prop: $type,
                )*
            }

            impl AsRef<abacus_base::Settings> for [<$name Settings>] {
                fn as_ref(&self) -> &abacus_base::Settings {
                    &self.base
                }
            }

            impl [<$name Settings>] {
                /// Read settings from the config files and/or env
                /// The config will be located at `config/default` unless specified
                /// otherwise
                ///
                /// Configs are loaded in the following precedence order:
                ///
                /// 1. The file specified by the `RUN_ENV` and `BASE_CONFIG`
                ///    env vars. `RUN_ENV/BASECONFIG`
                /// 2. The file specified by the `RUN_ENV` env var and the
                ///    agent's name. `RUN_ENV/AGENT-partial.json`
                /// 3. Configuration env vars with the prefix `HYP_BASE` intended
                ///    to be shared by multiple agents in the same environment
                /// 4. Configuration env vars with the prefix `HYP_AGENTNAME`
                ///    intended to be used by a specific agent.
                ///
                /// Specify a configuration directory with the `RUN_ENV` env
                /// variable. Specify a configuration file with the `BASE_CONFIG`
                /// env variable.
                pub fn new() -> Result<Self, config::ConfigError> {
                    abacus_base::macros::_new_settings(stringify!($name))
                }
            }
        }
    }
}

/// Static logic called by the decl_settings! macro. Do not call directly!
pub fn _new_settings<'de, T: Deserialize<'de>>(name: &str) -> Result<T, config::ConfigError> {
    use config::{Config, Environment, File};
    use std::env;

    let env = env::var("RUN_ENV").unwrap_or_else(|_| "default".into());
    let fname = env::var("BASE_CONFIG").unwrap_or_else(|_| "base".into());

    // Derive additional prefix from agent name
    let prefix = format!("HYP_{}", name).to_ascii_uppercase();

    Config::builder()
        .add_source(File::with_name(&format!("./config/{}/{}", env, fname)))
        .add_source(
            File::with_name(&format!("./config/{}/{}-partial", env, name.to_lowercase()))
                .required(false),
        )
        // Use a base configuration env variable prefix
        .add_source(Environment::with_prefix("HYP_BASE").separator("_"))
        .add_source(Environment::with_prefix(&prefix).separator("_"))
        .build()?
        .try_deserialize()
}
