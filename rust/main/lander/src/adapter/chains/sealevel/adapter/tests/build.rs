use eyre::Result;

use hyperlane_sealevel::SealevelTxCostEstimate;

use crate::{
    adapter::{
        chains::sealevel::adapter::tests::common::{adapter, estimate, instruction, payload},
        AdaptsChain, SealevelTxPrecursor, TxBuildingResult,
    },
    error::LanderError,
    payload::PayloadDetails,
    transaction::{Transaction, VmSpecificTxData},
};

#[tokio::test]
async fn test_build_transactions() {
    // given
    let adapter = adapter();
    let payload = payload();
    let data = VmSpecificTxData::Svm(SealevelTxPrecursor::new(
        instruction(),
        SealevelTxCostEstimate::default(),
    ));
    let expected = (payload.details.clone(), data);

    // when
    let result = adapter.build_transactions(&[payload.clone()]).await;

    // then
    let actual = payload_details_and_data_in_transaction(result);
    assert_eq!(expected, actual);
}

fn payload_details_and_data_in_transaction(
    transactions: Vec<TxBuildingResult>,
) -> (PayloadDetails, VmSpecificTxData) {
    let transaction = transactions.first().unwrap();
    (
        transaction.payloads.first().unwrap().clone(),
        transaction
            .maybe_tx
            .clone()
            .unwrap()
            .vm_specific_data
            .clone(),
    )
}
