use std::sync::Arc;

use crate::contracts::InterchainGasPaymaster;
use crate::core;
use color_eyre::Result;
use ethers::{
    providers::Middleware,
    signers::{LocalWallet, Signer},
};
use hyperlane_core::{H160, H256, U256};

/// Pay for message delivery on destination chain.
pub async fn pay<M: Middleware + 'static>(
    wallet: LocalWallet,
    client: Arc<M>,
    paymaster_addr: H160,
    message_id: H256,
    dest_chain_id: u32,
    gas: U256,
    verbose: bool,
) -> Result<()> {
    let gas_paymaster = InterchainGasPaymaster::new(paymaster_addr, client);

    let gas_quote = gas_paymaster.quote_gas_payment(dest_chain_id, gas).await?;
    println!("Quote for {gas} gas on destination chain: {gas_quote}");

    let tx_receipt = gas_paymaster
        .pay_for_gas(
            *message_id.as_fixed_bytes(),
            dest_chain_id,
            gas,
            wallet.address(),
        )
        .value(gas_quote)
        .send()
        .await?
        .confirmations(1)
        .await?;

    if verbose {
        println!("Transaction receipt: {:#?}", tx_receipt);
    };

    match tx_receipt {
        Some(receipt) => {
            println!(
                "Transaction completed in block {}, hash: {:?}",
                core::option_into_display_string(&receipt.block_number),
                receipt.transaction_hash
            );
        }
        None => println!("Transaction status unknown"),
    }

    Ok(())
}
