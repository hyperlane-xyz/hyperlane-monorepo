pub mod confirmation;
pub mod deposit;
pub mod withdraw;
pub mod withdrawal;

use std::error::Error;
use std::io::Cursor;
use std::str::FromStr;
use std::time::Duration;

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

use hyperlane_core::Decode;
use hyperlane_core::U256;
use hyperlane_warp_route::TokenMessage;

const ESCROW_ADDRESS: &'static str =
    "kaspatest:qzwyrgapjnhtjqkxdrmp7fpm3yddw296v2ajv9nmgmw5k3z0r38guevxyk7j0";

async fn validate_transaction(deposits: Vec<DepositFXG>) -> Result<Vec<bool>, Box<dyn Error>> {
    // Select encoding method to use, depending on node settings
    let encoding = WrpcEncoding::Borsh;

    // If you want to connect to your own node, define your node address and wRPC port using let url = Some("ws://0.0.0.0:17110")
    // Verify your Kaspa node is runnning with --rpclisten-borsh=0.0.0.0:17110 parameter
    let url = Some("ws://127.0.0.1:17210"); // TODO: factor out
    let resolver = Some(Resolver::default());
    // Define the network your Kaspa node is connected to
    // You can select NetworkType::Mainnet, NetworkType::Testnet, NetworkType::Devnet, NetworkType::Simnet
    let network_type = NetworkType::Testnet;
    let selected_network = Some(NetworkId::with_suffix(network_type, 10));

    // Advanced options
    let subscription_context = None;

    // Create new wRPC client with parameters defined above
    let client = KaspaRpcClient::new(
        encoding,
        url,
        resolver,
        selected_network,
        subscription_context,
    )?;

    // Advanced connection options
    let timeout = 5_000;
    let options = ConnectOptions {
        block_async_connect: true,
        connect_timeout: Some(Duration::from_millis(timeout)),
        strategy: ConnectStrategy::Fallback,
        ..Default::default()
    };

    // Connect to selected Kaspa node
    client.connect(Some(options)).await?;

    let mut results: Vec<bool> = vec![];
    // iterate over all deposits and validate one by one
    for deposit in &deposits {
        let block_hash = Hash::from_str(&deposit.block_id)?;
        let tx_hash = Hash::from_str(&deposit.tx_id)?;

        let RpcBlock {
            header,
            transactions,
            verbose_data,
        } = client.get_block(block_hash, true).await?;

        // find tx in block
        let tx_index = verbose_data
            .ok_or("block data not found")?
            .transaction_ids
            .iter()
            .position(|id| id == &tx_hash)
            .ok_or("transaction not found in block")?;

        // get utxo in the tx from index in deposit
        let utxo: &kaspa_rpc_core::RpcTransactionOutput = transactions[tx_index]
            .outputs
            .get(deposit.utxo_index)
            .ok_or("utxo not found by index")?;

        let mut reader = Cursor::new(deposit.payload.body.as_slice());
        let token_message = TokenMessage::read_from(&mut reader)?;

        if U256::from(utxo.value) < token_message.amount() {
            results.push(false);
            continue;
        }

        let is_escrow = is_utxo_escrow_address(utxo.script_public_key.clone())?;

        if !is_escrow {
            results.push(false);
            continue;
        }
        results.push(true);
    }
    Ok(results)
}

fn is_utxo_escrow_address(pk: RpcScriptPublicKey) -> Result<bool, Box<dyn Error>> {
    let address = extract_script_pub_key_address(&pk, Prefix::Testnet)?;
    if address.to_string() == ESCROW_ADDRESS {
        return Ok(true);
    }
    Ok(false)
}
