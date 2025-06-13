pub(crate) use account::KaspaAccountId;
pub(crate) use address::KaspaAddress;

/// This module contains conversions from Kaspa AccountId to H56
mod account;

/// This module contains all the verification variables the libraries used by the Hyperlane Kaspa chain.
mod address;
