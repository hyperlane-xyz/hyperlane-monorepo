use eyre::Result;

use crate::chain_tx_adapter::chains::sealevel::adapter::tests::common::{
    adapter, estimate, instruction, payload,
};
use crate::chain_tx_adapter::{AdaptsChain, SealevelTxPrecursor};
use crate::payload::PayloadDetails;
use crate::transaction::{Transaction, VmSpecificTxData};

#[tokio::test]
async fn test_build_transactions() {
    // given
    let adapter = adapter();
    let payload = payload();
    let data = VmSpecificTxData::Svm(SealevelTxPrecursor::new(instruction(), estimate()));
    let expected = (payload.details.clone(), data);

    // when
    let result = adapter.build_transactions(&[payload.clone()]).await;

    // then
    assert!(result.is_ok());
    let actual = payload_details_and_data_in_transaction(result);
    assert_eq!(expected, actual);
}

fn payload_details_and_data_in_transaction(
    result: Result<Vec<Transaction>>,
) -> (PayloadDetails, VmSpecificTxData) {
    let transactions = result.unwrap();
    let transaction = transactions.first().unwrap();
    (
        transaction.payload_details.first().unwrap().clone(),
        transaction.vm_specific_data.clone(),
    )
}
