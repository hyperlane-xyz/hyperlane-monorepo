#[macro_export]
/// Shortcut for aborting a joinhandle and then awaiting and discarding its
/// result
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
        impl AsRef<hyperlane_base::HyperlaneAgentCore> for $agent {
            fn as_ref(&self) -> &hyperlane_base::HyperlaneAgentCore {
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
            core: hyperlane_base::HyperlaneAgentCore,
        }

        $crate::impl_as_ref_core!($name);
    };
}

use crate::Settings;
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
        hyperlane_base::macros::paste::paste! {
            #[derive(Debug, serde::Deserialize)]
            #[serde(rename_all = "camelCase")]
            #[doc = "Settings for `" $name]
            pub struct [<$name Settings>] {
                #[serde(flatten)]
                pub(crate) base: hyperlane_base::Settings,
                $(
                    $(#[$tags])*
                    pub(crate) $prop: $type,
                )*
            }

            impl std::ops::Deref for [<$name Settings>] {
                type Target = hyperlane_base::Settings;

                fn deref(&self) -> &Self::Target {
                    &self.base
                }
            }

            impl AsRef<hyperlane_base::Settings> for [<$name Settings>] {
                fn as_ref(&self) -> &hyperlane_base::Settings {
                    &self.base
                }
            }

            impl AsMut<hyperlane_base::Settings> for [<$name Settings>] {
                fn as_mut(&mut self) -> &mut hyperlane_base::Settings {
                    &mut self.base
                }
            }

            impl hyperlane_base::NewFromSettings for [<$name Settings>] {
                type Error = eyre::Report;

                /// See `load_settings_object` for more information about how settings are loaded.
                fn new() -> Result<Self, Self::Error> {
                    hyperlane_base::macros::_new_settings(stringify!($name))
                }
            }
        }
    }
}

/// Static logic called by the decl_settings! macro. Do not call directly!
#[doc(hidden)]
pub fn _new_settings<'de, T>(name: &str) -> eyre::Result<T>
where
    T: Deserialize<'de> + AsMut<Settings>,
{
    use crate::settings::loader::load_settings_object;

    load_settings_object::<T, &str>(name, &[])
}
