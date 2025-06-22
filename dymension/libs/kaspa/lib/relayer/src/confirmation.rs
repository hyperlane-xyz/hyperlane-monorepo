use hyperlane_cosmos_native::CosmosNativeProvider;
use kaspa_consensus_core::tx::{TransactionId, TransactionOutput};
use kaspa_rpc_core::RpcTransaction;
use kaspa_wallet_core::error::Error;
use hyperlane_cosmos_dymension_rs::dymensionxyz::dymension::kas::{ProgressIndication, QueryOutpointRequest, TransactionOutpoint, WithdrawalId};
use kaspa_rpc_core::api::rpc::RpcApi;

pub async fn prepare_progress_indication(
    rpc: &impl RpcApi,
    cosmos_provider: &CosmosNativeProvider,
    utxo: TransactionId,
) -> Result<ProgressIndication, Error> {
    // Step 1: Query the old_outpoint using the cosmos_provider
    let old_outpoint_response = cosmos_provider
        .grpc()
        .outpoint(None)
        .await
        .map_err(|e| Error::Custom(e.to_string()))?;
    let old_outpoint = old_outpoint_response.outpoint;
    let old_outpoint_tx_id = old_outpoint.as_ref().map(|o| o.transaction_id.clone());

    // Step 2: Assign the new_outpoint from the UTXO passed in the argument
    let new_outpoint = Some(TransactionOutpoint {
        transaction_id: utxo.to_bytes().to_vec(),
        index: 0,
    });

    // Step 3: Trace back from the new UTXO to the old UTXO
    // and for each trace step, log the arbitrary payload of the tx.
    let mut processed_withdrawals_payload = Vec::new();
    let mut current_tx_id = utxo;

    if let Some(old_tx_id_bytes) = old_outpoint_tx_id {
        let old_tx_id = TransactionId::from_bytes(
            old_tx_id_bytes
                .try_into()
                .map_err(|_| Error::Custom("Invalid old_tx_id format".to_string()))?,
        );

        while current_tx_id != old_tx_id {
            let tx = rpc
                .get_transaction(&current_tx_id, false)
                .await
                .map_err(|e| Error::Custom(format!("Failed to get transaction: {}", e)))?;

            let tx: RpcTransaction = tx
                .ok_or_else(|| Error::Custom("Transaction not found".into()))?
                .into();

            if let Some(payload) = tx.transaction.payload {
                processed_withdrawals_payload.push(payload);
            }

            // Assume the first input is the one to follow back
            let prev_outpoint = tx
                .transaction
                .inputs
                .get(0)
                .ok_or_else(|| Error::Custom("Transaction has no inputs".into()))?
                .previous_outpoint;

            current_tx_id = prev_outpoint.transaction_id;
        }
    }

    // TODO: parse it later to withdraw id
    let processed_withdrawals: Vec<WithdrawalId> = Vec::new();

    // Return the ProgressIndication struct
    Ok(ProgressIndication {
        old_outpoint,
        new_outpoint,
        processed_withdrawals,
    })
}
