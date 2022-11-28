use std::error::Error;
use std::fmt::{Debug, Display, Formatter, Pointer};
use std::ops::Deref;
use std::sync::Arc;

use async_trait::async_trait;
use ethers::prelude::{Http, JsonRpcClient, Middleware, NonceManagerMiddleware, Provider, QuorumProvider, SignerMiddleware, Ws};
use serde::de::DeserializeOwned;
use serde::Serialize;

use abacus_core::Signers;
use ethers_prometheus::json_rpc_client::PrometheusJsonRpcClient;
use ethers_prometheus::middleware::PrometheusMiddleware;
use paste::paste;

use crate::RetryingProvider;


// Middleware
type TSignerNoncePrometheus = SignerMiddleware<
    NonceManagerMiddleware<Arc<PrometheusMiddleware<Provider<DynamicJsonRpcClient>>>>,
    Signers,
>;
type TSignerNoncePrometheusError = <TSignerNoncePrometheus as Middleware>::Error;

type TSignerNonce =
    SignerMiddleware<NonceManagerMiddleware<Provider<DynamicJsonRpcClient>>, Signers>;
type TSignerNonceError = <TSignerNonce as Middleware>::Error;

// TODO: use derive more?

macro_rules! make_dyn_json_rpc_client {
    {$($n:ident($t:ty)),*$(,)?} => {
        #[derive(Debug)]
        pub enum DynamicJsonRpcClient {
            $($n(Box<$t>),)*
        }

        $(paste! {
        pub type [<T $n>] = $t;
        pub type [<T $n Error>] = <$t as JsonRpcClient>::Error;
        })*

        #[async_trait]
        impl JsonRpcClient for DynamicJsonRpcClient {
            type Error = DynamicJsonRpcClientError;

            async fn request<T, R>(&self, method: &str, params: T) -> Result<R, Self::Error>
            where
                T: Debug + Serialize + Send + Sync,
                R: DeserializeOwned,
            {
                match self {
                    $(Self::$n(p) => p.request(method, params).await.map_err(DynamicJsonRpcClientError::from),)*
                }
            }
        }

        $(
        impl From<$t> for DynamicJsonRpcClient {
            fn from(p: $t) -> Self {
                Self::$n(Box::new(p))
            }
        }
        impl From<Box<$t>> for DynamicJsonRpcClient {
            fn from(p: Box<$t>) -> Self {
                Self::$n(p)
            }
        }
        )*
    };
}

macro_rules! make_dyn_json_rpc_client_error {
    {$($n:ident($t:ty)),*$(,)?} => {
        #[derive(Debug)]
        pub enum DynamicJsonRpcClientError {
            $($n(Box<<$t as JsonRpcClient>::Error>),)*
        }

        impl Display for DynamicJsonRpcClientError {
            fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
                match self {
                    $(Self::$n(p) => write!(f, "{p}"),)*
                }
            }
        }

        impl Error for DynamicJsonRpcClientError {
            fn source(&self) -> Option<&(dyn Error + 'static)> {
                match self {
                    $(Self::$n(e) => e.source(),)*
                }
            }
        }

        $(
        impl From<<$t as JsonRpcClient>::Error> for DynamicJsonRpcClientError {
            fn from(p: <$t as JsonRpcClient>::Error) -> Self {
                Self::$n(Box::new(p))
            }
        }

        impl From<Box<<$t as JsonRpcClient>::Error>> for DynamicJsonRpcClientError {
            fn from(p: Box<<$t as JsonRpcClient>::Error>) -> Self {
                Self::$n(p)
            }
        }
        )*
    };
}

make_dyn_json_rpc_client! {
    RetryingPrometheusHttp(RetryingProvider<PrometheusJsonRpcClient<Http>>),
    PrometheusWs(PrometheusJsonRpcClient<Ws>),
    Quorum(QuorumProvider<DynamicJsonRpcClient>),
}

make_dyn_json_rpc_client_error! {
    RetryingPrometheusHttp(RetryingProvider<PrometheusJsonRpcClient<Http>>),
}

pub struct DynamicMiddleware {}

impl Debug for DynamicMiddleware {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        todo!()
    }
}

impl Middleware for DynamicMiddleware {
    type Error = ();
    type Provider = ();
    type Inner = ();

    fn inner(&self) -> &Self::Inner {
        todo!()
    }
}

// /// A wrapper for the middleware that allows for eliding inner details.
// ///
// /// Ideally this would be the last middleware in the chain to reduce dispatch
// /// cost.
// ///
// /// Sadly due to the associated types including `Inner` it is
// /// impossible to do this truly dynamically without unsafe code so instead we
// /// will just handle each of the specific cases we need to.
// pub enum DynamicMiddleware {
//     SignerNoncePrometheus(Box<TSignerNoncePrometheus>),
// }

impl From<TSignerNoncePrometheus> for DynamicMiddleware {
    fn from(m: TSignerNoncePrometheus) -> Self {
        // Self::SignerNoncePrometheus(Box::new(m))
        todo!()
    }
}

impl From<TSignerNonce> for DynamicMiddleware {
    fn from(_: TSignerNonce) -> Self {
        todo!()
    }
}

// impl Debug for DynamicMiddleware {
//     fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
//         match self {
//             DynamicMiddleware::SignerNoncePrometheus(m) => m.fmt(f),
//         }
//     }
// }
//
// impl Middleware for DynamicMiddleware {
//     type Error = DynamicMiddlewareError;
//     type Provider = DynamicJsonRpcClient;
//     type Inner = Self;
//
//     /// Warning: This might create an infinite loop if this middleware gets
//     /// wrapped.
//     fn inner(&self) -> &Self::Inner {
//         &self
//     }
// }

// enum DynamicMiddlewareError {
//     SignerNoncePrometheus(Box<TSignerNoncePrometheusError>),
// }
//
// impl Debug for DynamicMiddlewareError {
//     fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
//         match self {
//             DynamicMiddlewareError::SignerNoncePrometheus(e) => e.fmt(f),
//         }
//     }
// }
//
// impl Display for DynamicMiddlewareError {
//     fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
//         match self {
//             DynamicMiddlewareError::SignerNoncePrometheus(e) => e.fmt(f),
//         }
//     }
// }
//
// impl Error for DynamicMiddlewareError {
//     fn source(&self) -> Option<&(dyn Error + 'static)> {
//         match self {
//             DynamicMiddlewareError::SignerNoncePrometheus(e) => e.source(),
//         }
//     }
// }
