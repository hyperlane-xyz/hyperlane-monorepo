use anyhow::Result;
use hyperlane_cosmos_native::CosmosNativeProvider;
use hyperlane_cosmos_rs::dymensionxyz::dymension::kas::{
    ProgressIndication, QueryOutpointRequest, WithdrawalId,
};

use kaspa_consensus_core::tx::{ScriptPublicKey, TransactionId, TransactionOutpoint, UtxoEntry};
use kaspa_rpc_core::api::rpc::RpcApi;

use kaspa_addresses::Address;

use api_rs::models::{TxInput, TxModel, TxOutput};

use crate::confirmation::get_previous_utxo_in_lineage;


#[cfg(test)]
mod tests {
    use super::*;
    use kaspa_hashes::Hash;
    use hex;

    #[test]
    // FIXME: update after integration with withdraw flow
    fn test_withdrawal_id_creation() {
        // Test creating a WithdrawalId with a message ID
        let message_id = "test_message_id_1234567890abcdef".to_string();
        let withdrawal_id = WithdrawalId {
            message_id: message_id.clone(),
        };

        assert_eq!(withdrawal_id.message_id, message_id);
    }

    #[test]
    fn test_trace_transactions() {
        // Define the anchor UTXO
        let anchor_utxo = TransactionOutpoint {
            transaction_id: Hash::from_bytes(
                hex::decode("6e45af65a6efdef6683b45a78dfdd4250e2d5de4132b1dd8d1bb76374c817eca")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 10,
        };

        let lineage_address = "kaspa:qp9z8a0w7jedatvpr3l0knc6l0vdlpz7sp9kcd4yqq0up9hp87q4zyzr5ave9".to_string();

        // Build test data transaction
        // (based on https://explorer.kaspa.org/txs/a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0?blockHash=2e802dccafa9f443199a1f646a2f4497ff769cda6126075e67e83017b4f2287c)
        let test_transaction = TxModel {
            transaction_id: Some("a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string()),
            hash: Some("0562f3edfd181f490fc04cb9bd38e0b044a6d1938f3d628b8d5b1c83535c1001".to_string()),
            subnetwork_id: Some("0000000000000000000000000000000000000000".to_string()),
            mass: Some("6884".to_string()),
            block_time: Some(1750525207328),
            block_hash: Some(vec!["2e802dccafa9f443199a1f646a2f4497ff769cda6126075e67e83017b4f2287c".to_string()]),
            accepting_block_time: Some(1750525207328),
            is_accepted: Some(true),
            accepting_block_blue_score: None,
            accepting_block_hash: Some("51c7e993576d18954d38fdb49079c4f47b9e2bbcaa91d6126d4f7a26ace7d4a6".to_string()),
            payload: None,
            inputs: Some(vec![
                TxInput {
                    transaction_id: "a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string(),
                    index: 0,
                    previous_outpoint_hash: "ae7ffb67ce809b74c86b013cfd2d9b5db332d822b12f077c69874e71460462ce".to_string(),
                    previous_outpoint_index: "5".to_string(),
                    previous_outpoint_resolved: None,
                    previous_outpoint_address: Some("kaspa:qpy827u4r43hp36nu2w78dphwgzjr3e9xdwwvm7k7dalyhpfkr84qucn4ecud".to_string()),
                    previous_outpoint_amount: Some(519130872),
                    signature_script: Some("41d300ca5d2939f888ecb7f6f942c8e23b02097ed4c0679c40a415a832af3f9fc92bf80f163d5d5e4d4aaf0075f23298a3631506db888f4b3af0b5c0fcd191954201".to_string()),
                    sig_op_count: None,
                },
                // THIS IS THE ANCHOR UTXO
                TxInput {
                    transaction_id: "a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string(),
                    index: 1,
                    previous_outpoint_hash: "6e45af65a6efdef6683b45a78dfdd4250e2d5de4132b1dd8d1bb76374c817eca".to_string(),
                    previous_outpoint_index: "10".to_string(),
                    previous_outpoint_resolved: None,
                    previous_outpoint_address: Some("kaspa:qp9z8a0w7jedatvpr3l0knc6l0vdlpz7sp9kcd4yqq0up9hp87q4zyzr5ave9".to_string()),
                    previous_outpoint_amount: Some(16045208624753),
                    signature_script: Some("41c883ae342089412336949c60d41be10fcc8c8bae3388311688df02dcda94d35aa38a4e937324940b922f201db41eaceeefe04399b325510139832024f04d0d5b01".to_string()),
                    sig_op_count: None,
                },
            ]),
            outputs: Some(vec![
                TxOutput {
                    transaction_id: "a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string(),
                    index: 0,
                    amount: 102618815,
                    script_public_key: Some("20389f718498daba262c79daa9b199c998553195ce301a24bb5b2b7f22ab39a985ac".to_string()),
                    script_public_key_address: Some("kaspa:qquf7uvynrdt5f3v08d2nvveexv92vv4eccp5f9mtv4h7g4t8x5c2ytlyud9p".to_string()),
                    script_public_key_type: None,
                    accepting_block_hash: None,
                },
                TxOutput {
                    transaction_id: "a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string(),
                    index: 1,
                    amount: 102654645,
                    script_public_key: Some("20d9ef9f8336773246dad955d5a4fa7bac48069d01ff93e9ee45faafac817e59e0ac".to_string()),
                    script_public_key_address: Some("kaspa:qp9z8a0w7jedatvpr3l0knc6l0vdlpz7sp9kcd4yqq0up9hp87q4zyzr5ave9".to_string()),
                    script_public_key_type: None,
                    accepting_block_hash: None,
                },
            ]),
        };
        
        // Assert the result
        let result = get_previous_utxo_in_lineage(&test_transaction, &lineage_address, anchor_utxo);
        assert!(result.is_ok());
        assert_eq!( result.unwrap(),None); // We reached the anchor UTXO, so we should return None

        // modify the test transaction to not contain the anchor UTXO
        let mut new_test_transaction = test_transaction.clone();
        if let Some(ref mut inputs) = new_test_transaction.inputs {
            inputs.remove(1);
        }
        
        // Assert the result
        let result = get_previous_utxo_in_lineage(&new_test_transaction, &lineage_address, anchor_utxo);
        assert!(result.is_err()); // we expect an error because we have no anchor UTXO in the new transaction and no previous UTXO

        // modify the test transaction to contain lineage input (but not the anchor UTXO)
        let mut new_test_transaction = test_transaction.clone();
        let expected_new_utxo = TransactionOutpoint{ 
            transaction_id: Hash::from_bytes(
                hex::decode("e17ccebfab0f814978a94a22de5389127128e83e912492faf9aa3a521b163eef")
                    .unwrap()
                    .try_into()
                    .unwrap(),
            ),
            index: 12,
        };
        if let Some(ref mut inputs) = new_test_transaction.inputs {
            inputs.remove(1);
            // we put dummy input, from the same address
            inputs.push(TxInput {
                transaction_id: "a778eb4676deba2b120e6d983eb74c1a0d4a9017361faedbb141b9632242e6d0".to_string(),
                index: 1,
                previous_outpoint_hash: expected_new_utxo.transaction_id.to_string(),
                previous_outpoint_index: expected_new_utxo.index.to_string(),
                previous_outpoint_resolved: None,
                previous_outpoint_address: Some(lineage_address.clone()),
                previous_outpoint_amount: Some(519130872),
                signature_script: Some("41d300ca5d2939f888ecb7f6f942c8e23b02097ed4c0679c40a415a832af3f9fc92bf80f163d5d5e4d4aaf0075f23298a3631506db888f4b3af0b5c0fcd191954201".to_string()),
                sig_op_count: None,
            });
        }

        // Call the get_previous_utxo_in_lineage function   
        let result = get_previous_utxo_in_lineage(&new_test_transaction, &lineage_address, anchor_utxo);

        // Assert the result
        assert!(result.is_ok());

        assert_eq!( result.unwrap(),Some(expected_new_utxo)); 
    }
}   