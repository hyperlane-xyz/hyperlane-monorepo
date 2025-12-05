use crate::kas_bridge::{confirmation::ConfirmationFXG, payload::MessageID};
use dym_kas_core::api::client::HttpClient;
use eyre::Result;
use hex;
use kaspa_consensus_core::tx::TransactionOutpoint;
use kaspa_wallet_core::error::Error;
use tracing::info;

/// WARNING: ONLY FOR UNHAPPY PATH
///
/// Traces transactions in reverse from a new UTXO to an old anchor UTXO, collecting
/// all withdrawal payloads that were processed in between. This follows the transaction
/// lineage of the escrow address to create a confirmation progress indication.
///
/// # Arguments
/// * `client` - The HTTP client for querying Kaspa API transactions
/// * `escrow_addresses` - The escrow address to trace transactions for
/// * `new_out` - The new transaction outpoint to start tracing from
/// * `old_out` - The old anchor transaction outpoint to trace to
///
/// # Returns
/// * `Result<ConfirmationFXG>` - The confirmation FXG containing the progress indication
///   with old and new outpoints and a list of processed withdrawal message IDs
pub async fn expensive_trace_transactions(
    client: &HttpClient,
    escrow_addresses: &str,
    out_new_candidate: TransactionOutpoint,
    out_old: TransactionOutpoint,
) -> Result<ConfirmationFXG> {
    let mut processed_withdrawals: Vec<MessageID> = Vec::new();
    let mut outpoint_sequence = Vec::new();

    recursive_trace_transactions(
        client,
        escrow_addresses,
        out_new_candidate,
        out_old,
        &mut outpoint_sequence,
        &mut processed_withdrawals,
    )
    .await?;

    info!(
        new_anchor = ?out_new_candidate,
        old_anchor = ?out_old,
        utxos_count = outpoint_sequence.len(),
        processed_withdrawals_count = processed_withdrawals.len(),
        "kaspa relayer: traced transaction lineage"
    );
    for o in outpoint_sequence.clone() {
        info!(outpoint = ?o, "kaspa relayer: traced lineage outpoint");
    }
    Ok(ConfirmationFXG::from_msgs_outpoints(
        processed_withdrawals,
        outpoint_sequence,
    ))
}

pub async fn recursive_trace_transactions(
    client_rest: &HttpClient,
    escrow_addr: &str,
    out_curr: TransactionOutpoint,
    out_old: TransactionOutpoint,
    outpoint_sequence: &mut Vec<TransactionOutpoint>,
    processed_withdrawals: &mut Vec<MessageID>,
) -> Result<()> {
    if out_curr == out_old {
        // we reached the end, success!
        outpoint_sequence.push(out_curr);
        return Ok(());
    }

    info!(utxo = ?out_curr, "kaspa relayer: tracing lineage backwards from UTXO");

    // tx that created the candidate
    let tx = client_rest
        .get_tx_by_id(&out_curr.transaction_id.to_string())
        .await?;

    info!(tx = ?tx, "kaspa relayer: queried transaction for lineage trace");

    let inputs = tx
        .inputs
        .as_ref()
        .ok_or(Error::Custom("Inputs not found".to_string()))?;

    // we skip inputs that are not from the escrow address
    // we do recursive call for inputs that are from the escrow address
    for input in inputs {
        let spent_escrow_funds = {
            let input_address = input
                .previous_outpoint_address
                .as_ref()
                .ok_or(Error::Custom("Input address not found".to_string()))?;

            input_address == escrow_addr
        };
        if !spent_escrow_funds {
            info!(input_index = ?input.index, "kaspa relayer: skipped input from non-escrow address");
            continue;
        }

        // TODO: have ::From method to get utxo from TxInput
        let out_input = TransactionOutpoint {
            transaction_id: kaspa_hashes::Hash::from_bytes(
                hex::decode(&input.previous_outpoint_hash)?
                    .try_into()
                    .map_err(|_| eyre::eyre!("Invalid hex in previous_outpoint_hash"))?,
            ),
            index: input.previous_outpoint_index.parse()?,
        };

        let res = Box::pin(recursive_trace_transactions(
            client_rest,
            escrow_addr,
            out_input,
            out_old,
            outpoint_sequence,
            processed_withdrawals,
        ))
        .await;

        // this input is not part of the lineage, continue to other input
        if res.is_err() {
            continue;
        }

        /* ------------ the input is part of the lineage! ------------ */
        let payload = tx
            .payload
            .clone()
            .ok_or_else(|| eyre::eyre!("No payload found in transaction"))?;

        let message_ids = crate::kas_bridge::payload::MessageIDs::from_tx_payload(&payload)?;

        processed_withdrawals.extend(message_ids.0);
        outpoint_sequence.push(out_curr);
        return Ok(());
    }

    // if reached here, return error as we're not followed the lineage
    Err(eyre::eyre!("No lineage UTXOs found in transaction inputs"))
}
