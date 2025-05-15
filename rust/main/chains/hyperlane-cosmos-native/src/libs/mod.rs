pub(crate) use account::CosmosAccountId;
pub(crate) use address::CosmosAddress;

/// This module contains conversions from Cosmos AccountId to H56
mod account;

/// This module contains all the verification variables the libraries used by the Hyperlane Cosmos chain.
mod address;
