use anyhow::Result;
use kaspa_consensus_core::tx::TransactionOutpoint as KaspaUtxoOutpoint;
use kaspa_rpc_core::api::rpc::RpcApi;
use kaspa_wallet_core::account::Account;
use kaspa_wallet_pskt::prelude::{Signer, PSKT};
use std::sync::Arc;
use std::io::Cursor;
use hyperlane_core::{HyperlaneMessage, Decode, H256};
use hyperlane_warp_route::TokenMessage;
use hyperlane_cosmos_native::CosmosNativeProvider;
use kaspa_hashes;
use kaspa_txscript;
use kaspa_consensus_core::hashing::sighash_type::{
    SIG_HASH_ALL, SIG_HASH_ANY_ONE_CAN_PAY, SigHashType,
};
use kaspa_consensus_core::tx::{ScriptPublicKey, UtxoEntry};
use kaspa_wallet_core::utxo::UtxoIterator;
use kaspa_wallet_pskt::prelude::*;
use kaspa_txscript::standard::pay_to_address_script;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    TransactionOutpoint,
};

// EventDispatch needs to be imported from the cosmos types
// We'll define it temporarily or import from the appropriate location
#[derive(Debug, Clone)]
pub struct EventDispatch {
    pub origin_mailbox_id: String,
    pub sender: String,
    pub destination: u32,
    pub recipient: String,
    pub message: String,
}

// Assuming EscrowPublic is correctly defined in the `core` crate
// and `core` is a dependency in this crate's Cargo.toml (e.g., `core = { path = "../core" }`)
use core::escrow::EscrowPublic;

// ---------------------------------------------------------------------------
// Types & helpers - Updated to match specification
// ---------------------------------------------------------------------------

/// Details of a withdrawal extracted from HyperlaneMessage
#[derive(Debug, Clone)]
pub struct WithdrawalDetails {
    pub message_id: H256,            // MessageID from HyperlaneMessage.id()
    pub user_kaspa_address: kaspa_addresses::Address,
    pub amount_satoshi: u64,
}



/// Updated signature matching the specification
pub async fn build_kaspa_withdrawal_pskts(
    events: Vec<EventDispatch>,
    _hub_height: u64,  // Not used anymore but kept for API compatibility
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    current_hub_state: &TransactionOutpoint,
) -> Result<Option<Vec<PSKT<Signer>>>> {
    // 1. Initialization
    let mut prepared_pskts: Vec<PSKT<Signer>> = Vec::new();
    // Note: we don't need to track last_processed_l_for_this_batch in this implementation
    // as it's handled by the relayer's state management at a higher level

    // 2. Parse EventDispatch messages to extract withdrawal details
    let mut withdrawal_details = Vec::new();
    
    for event in events {
        // Parse the message bytes to extract Hyperlane message
        let message_bytes = hex::decode(event.message.strip_prefix("0x").unwrap_or(&event.message))?;
        let mut reader = Cursor::new(message_bytes);
        let hyperlane_message = HyperlaneMessage::read_from(&mut reader)?;
        
        // Extract MessageID (32-byte Keccak-256 hash) - this serves as our withdrawal ID
        let message_id = hyperlane_message.id();
        
        // Parse the message body using TokenMessage (standard Hyperlane warp-route format)
        let token_message = match TokenMessage::read_from(&mut Cursor::new(&hyperlane_message.body)) {
            Ok(msg) => msg,
            Err(e) => {
                eprintln!("Failed to parse TokenMessage for message_id {:?}: {}", message_id, e);
                continue;
            }
        };
        
        // Convert the recipient (32-byte address) to Kaspa address
        // TODO: Implement proper conversion from the recipient bytes to Kaspa address
        // For now, using a placeholder address - this needs to be implemented based on
        // how Kaspa addresses are encoded in your bridge protocol
        let kaspa_recipient = match kaspa_addresses::Address::try_from("kaspa:qpqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqhqrm9r2ln") {
            Ok(addr) => addr,
            Err(e) => {
                eprintln!("Failed to convert recipient to Kaspa address for message_id {:?}: {}", message_id, e);
                continue;
            }
        };
        
        // Extract amount from TokenMessage - amount is U256, convert to u64 satoshi
        let amount_satoshi = token_message.amount().as_u64();
        
        withdrawal_details.push(WithdrawalDetails {
            message_id,
            user_kaspa_address: kaspa_recipient.clone(),
            amount_satoshi,
        });
        
        println!("Parsed withdrawal: message_id={:?}, amount={}, recipient={:?}", 
                message_id, amount_satoshi, token_message.recipient());
    }

    // 3. Sort withdrawals by message_id for deterministic processing
    withdrawal_details.sort_by_key(|w| w.message_id);

    if withdrawal_details.is_empty() {
        return Ok(None);
    }

    // 4. Build PSKTs for each withdrawal
    for withdrawal in withdrawal_details {
        match build_single_withdrawal_pskt(
            &withdrawal,
            kaspa_rpc,
            escrow_public,
            relayer_kaspa_account,
            &current_hub_state.current_anchor_outpoint,
        ).await {
            Ok(pskt) => {
                prepared_pskts.push(pskt);
                
                println!("Successfully built PSKT for withdrawal {:?}", withdrawal.message_id);
            }
            Err(e) => {
                eprintln!("Failed to build PSKT for withdrawal {:?}: {}", withdrawal.message_id, e);
                // Continue processing other withdrawals
                continue;
            }
        }
    }

    // 5. Return results
    if prepared_pskts.is_empty() {
        Ok(None)
    } else {
        println!("Built {} PSKTs for withdrawals", prepared_pskts.len());
        Ok(Some(prepared_pskts))
    }
}

/// Helper function to build a single withdrawal PSKT
/// Adapts logic from withdraw.rs::build_withdrawal_tx
async fn build_single_withdrawal_pskt(
    withdrawal_details: &WithdrawalDetails,
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
    current_anchor_outpoint: &KaspaUtxoOutpoint,
) -> Result<PSKT<Signer>> {
    // 1. Get escrow UTXO (current anchor)
    let utxos_e = kaspa_rpc.get_utxos_by_addresses(vec![escrow_public.addr.clone()]).await
        .map_err(|e| anyhow::anyhow!("Failed to get escrow UTXOs: {}", e))?;
    
    // Find the specific anchor UTXO we want to spend
    let utxo_e_first = utxos_e
        .into_iter()
        .find(|utxo| {
            utxo.outpoint.transaction_id == current_anchor_outpoint.transaction_id
                && utxo.outpoint.index == current_anchor_outpoint.index
        })
        .ok_or_else(|| anyhow::anyhow!("Anchor UTXO not found"))?;
    
    let utxo_e_entry = UtxoEntry::from(utxo_e_first.utxo_entry);
    let utxo_e_out = kaspa_consensus_core::tx::TransactionOutpoint::from(utxo_e_first.outpoint);

    // 2. Get relayer UTXO for fees
    let utxo_r = UtxoIterator::new(relayer_kaspa_account.utxo_context())
        .next()
        .ok_or_else(|| anyhow::anyhow!("Relayer has no UTXOs"))?;
    let utxo_r_entry: UtxoEntry = (utxo_r.utxo.as_ref()).into();
    let utxo_r_out = kaspa_consensus_core::tx::TransactionOutpoint::from(utxo_r.outpoint());

    // 3. Calculate amounts
    let withdrawal_amount = withdrawal_details.amount_satoshi;
    let fee = 1000; // TODO: Calculate proper fee
    
    // Verify escrow has enough funds
    if utxo_e_entry.amount < withdrawal_amount {
        return Err(anyhow::anyhow!(
            "Insufficient escrow funds: {} < {}", 
            utxo_e_entry.amount, 
            withdrawal_amount
        ));
    }
    
    // Verify relayer has enough for fees
    if utxo_r_entry.amount < fee {
        return Err(anyhow::anyhow!(
            "Insufficient relayer funds for fee: {} < {}", 
            utxo_r_entry.amount, 
            fee
        ));
    }

    // 4. Build escrow input (spending the anchor UTXO)
    let input_e = InputBuilder::default()
        .utxo_entry(utxo_e_entry.clone())
        .previous_outpoint(utxo_e_out)
        .redeem_script(escrow_public.redeem_script.clone())
        .sig_op_count(escrow_public.n() as u8) // Total possible signers
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build escrow input: {}", e))?;

    // 5. Build relayer input (for fees)
    let input_r = InputBuilder::default()
        .utxo_entry(utxo_r_entry.clone())
        .previous_outpoint(utxo_r_out)
        .sig_op_count(1)
        .sighash_type(
            SigHashType::from_u8(SIG_HASH_ALL.to_u8() | SIG_HASH_ANY_ONE_CAN_PAY.to_u8()).unwrap(),
        )
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build relayer input: {}", e))?;

    // 6. Build output to user
    let output_e_to_user = OutputBuilder::default()
        .amount(withdrawal_amount)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(&withdrawal_details.user_kaspa_address)))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build user output: {}", e))?;

    // 7. Build new escrow anchor output (escrow change)
    let escrow_change_amount = utxo_e_entry.amount - withdrawal_amount;
    let output_e_change = OutputBuilder::default()
        .amount(escrow_change_amount)
        .script_public_key(escrow_public.p2sh.clone())
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build escrow change output: {}", e))?;

    // 8. Build relayer change output
    let relayer_change_amount = utxo_r_entry.amount - fee;
    let output_r_change = OutputBuilder::default()
        .amount(relayer_change_amount)
        .script_public_key(ScriptPublicKey::from(pay_to_address_script(
            &relayer_kaspa_account.change_address()
                .map_err(|e| anyhow::anyhow!("Failed to get relayer change address: {}", e))?,
        )))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build relayer change output: {}", e))?;

    // 9. Encode L' (withdrawal_id) as payload
    // For now, we'll add it as an OP_RETURN output to encode the message_id
    // This serves as the withdrawal identifier for the bridge
    let mut script_builder = kaspa_txscript::script_builder::ScriptBuilder::new();
    script_builder
        .add_op(kaspa_txscript::opcodes::codes::OpReturn)
        .map_err(|e| anyhow::anyhow!("Failed to add OP_RETURN: {}", e))?;
    script_builder
        .add_data(withdrawal_details.message_id.as_bytes())
        .map_err(|e| anyhow::anyhow!("Failed to add message_id data: {}", e))?;
    let payload_script = script_builder.drain();
    
    let output_payload = OutputBuilder::default()
        .amount(0) // OP_RETURN output with zero value
        .script_public_key(ScriptPublicKey::new(0, payload_script.into()))
        .build()
        .map_err(|e| anyhow::anyhow!("Failed to build payload output: {}", e))?;

    // 10. Build the PSKT
    let pskt = PSKT::<Creator>::default()
        .constructor()
        .input(input_e)
        .input(input_r)
        .output(output_e_to_user)
        .output(output_e_change)
        .output(output_r_change)
        .output(output_payload) // Include withdrawal_id payload
        .no_more_inputs()
        .no_more_outputs()
        .signer();

    Ok(pskt)
}

/// Fetch the current Hub x/kas state using CosmosNativeProvider
/// This replaces the mock HubKaspaState with real data from the x/kas module
pub async fn fetch_hub_kas_state(
    cosmos_provider: &CosmosNativeProvider,
    height: Option<u32>,
) -> Result<TransactionOutpoint> {
    // Query the current outpoint from x/kas module
    let outpoint_response = match height {
        Some(h) => cosmos_provider.grpc().outpoint(Some(h)).await,
        None => cosmos_provider.grpc().outpoint(None).await,
    }.map_err(|e| anyhow::anyhow!("Failed to query outpoint from x/kas module: {}", e))?;
    
    // Extract outpoint data and convert to KaspaUtxoOutpoint
    // Note: This assumes the outpoint response contains txid and index fields
    // You may need to adjust this based on the actual structure of QueryOutpointResponse
    let outpoint_data = outpoint_response.outpoint
        .ok_or_else(|| anyhow::anyhow!("No outpoint data in response"))?;
    
    // Convert the transaction ID to kaspa transaction ID
    // The transaction_id field might already be in the correct format
    let kaspa_tx_id = if outpoint_data.transaction_id.len() == 32 {
        // If it's already 32 bytes, use it directly
        kaspa_hashes::Hash::from_bytes(
            outpoint_data.transaction_id.as_slice().try_into()
                .map_err(|e| anyhow::anyhow!("Failed to convert transaction ID to array: {:?}", e))?
        )
    } else {
        // If it's a hex string, decode it
        let tx_id_str = String::from_utf8(outpoint_data.transaction_id.clone())
            .map_err(|e| anyhow::anyhow!("Failed to convert transaction ID to string: {}", e))?;
        let tx_id_hex = tx_id_str.strip_prefix("0x").unwrap_or(&tx_id_str);
        let tx_id_bytes = hex::decode(tx_id_hex)
            .map_err(|e| anyhow::anyhow!("Failed to decode transaction ID: {}", e))?;
        
        if tx_id_bytes.len() != 32 {
            return Err(anyhow::anyhow!(
                "Invalid transaction ID length: expected 32 bytes, got {}",
                tx_id_bytes.len()
            ));
        }
        
        let mut tx_id_array = [0u8; 32];
        tx_id_array.copy_from_slice(&tx_id_bytes);
        kaspa_hashes::Hash::from_bytes(tx_id_array)
    };
    
    let current_anchor_outpoint = KaspaUtxoOutpoint {
        transaction_id: kaspa_tx_id,
        index: outpoint_data.index,
    };
    
    Ok(TransactionOutpoint {
        current_anchor_outpoint,
    })
}

/// Enhanced version of build_kaspa_withdrawal_pskts that fetches real x/kas state
/// This is the main integration function that replaces mock data with real queries
pub async fn build_kaspa_withdrawal_pskts_with_provider(
    events: Vec<EventDispatch>,
    cosmos_provider: &CosmosNativeProvider,
    hub_height: Option<u32>,
    kaspa_rpc: &impl RpcApi,
    escrow_public: &EscrowPublic,
    relayer_kaspa_account: &Arc<dyn Account>,
) -> Result<Option<Vec<PSKT<Signer>>>> {
    // 1. Fetch current Hub x/kas state using the real provider
    let current_hub_state = fetch_hub_kas_state(cosmos_provider, hub_height).await?;
    
    println!(
        "Fetched Hub x/kas state: outpoint={:?}, last_processed={}",
        current_hub_state.current_anchor_outpoint,
    );
    
    // 2. Use the existing logic with the real state
    build_kaspa_withdrawal_pskts(
        events,
        hub_height.unwrap_or(0) as u64, // Convert height for compatibility
        kaspa_rpc,
        escrow_public,
        relayer_kaspa_account,
        &current_hub_state,
    ).await
}
