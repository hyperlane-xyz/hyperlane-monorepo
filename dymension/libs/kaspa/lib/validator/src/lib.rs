pub mod confirmation;
pub mod deposit;
pub mod withdraw;
pub mod withdrawal;

use tracing::{error, info, warn};

use kaspa_wallet_core::{prelude::DynRpcApi, utxo::NetworkParams};
pub use secp256k1::Keypair as KaspaSecpKeypair;

use corelib::escrow::is_utxo_escrow_address;
use corelib::message::parse_hyperlane_metadata;
use std::error::Error;
use std::str::FromStr;

use corelib::deposit::DepositFXG;
use kaspa_addresses::Prefix;
use kaspa_consensus_core::Hash;
use kaspa_rpc_core::{api::rpc::RpcApi, RpcBlock, RpcScriptPublicKey};
use kaspa_txscript::extract_script_pub_key_address;
use kaspa_wrpc_client::{
    client::{ConnectOptions, ConnectStrategy},
    prelude::{NetworkId, NetworkType},
    KaspaRpcClient, Resolver, WrpcEncoding,
};
pub mod signer;
use kaspa_rpc_core::{RpcHash, RpcTransactionOutput};
use std::sync::Arc;

use eyre::Result;
use hyperlane_core::U256;
