use std::{path::PathBuf, str::FromStr};

use hyperlane_core::InterchainGasPayment;
use hyperlane_core::{
    ContractLocator, HyperlaneDomain, HyperlaneMessage, Indexer, MerkleTreeInsertion,
    SequenceAwareIndexer, H256,
};

use serde_json::json;
use snarkvm::prelude::{ProgramID, TestnetV0};

use crate::{
    provider::mock::MockHttpClient,
    utils::{aleo_hash_to_h256, to_h256},
    AleoDeliveryIndexer, AleoDispatchIndexer, AleoProvider, ConnectionConf,
};
use crate::{AleoInterchainGasIndexer, AleoMerkleTreeHook};

const DOMAIN: HyperlaneDomain =
    HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Abstract);

fn connection_conf() -> ConnectionConf {
    ConnectionConf {
        rpcs: vec![url::Url::from_str("http://localhost:3030").unwrap()],
        mailbox_program: "test_mailbox.aleo".to_string(),
        hook_manager_program: "test_hook_manager.aleo".to_string(),
        ism_manager_program: "test_ism_manager.aleo".to_string(),
        validator_announce_program: "test_validator_announce.aleo".to_string(),
        chain_id: 1u16,
        priority_fee_multiplier: 0f64,
        proving_service: vec![],
    }
}

// Helper constructing provider with mock client
fn mock_provider() -> AleoProvider<MockHttpClient> {
    let base_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/indexer/mock_responses");
    let client: MockHttpClient = MockHttpClient::new(base_path);

    AleoProvider::with_client(client, DOMAIN, 1u16, None)
}

#[tokio::test]
async fn test_delivery_indexer_fetch_logs() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file("block/12618649", "delivery_block.json")
        .unwrap();

    let range = 12618645..=12618650;
    for height in range.clone() {
        mock.register_value(
            &format!(
                "program/test_mailbox.aleo/mapping/process_event_index/{}u32",
                height
            ),
            serde_json::Value::Null,
        );
    }
    mock.register_value(
        "program/test_mailbox.aleo/mapping/process_event_index/12618649u32",
        "1u32",
    );
    mock.register_value("program/test_mailbox.aleo/mapping/process_events/1u32", "[\n  306532680884196914369041306889957777502u128,\n  248078813986496060276330224523516710975u128\n]");

    let indexer = AleoDeliveryIndexer::new(mock, &locator, &connection_conf());

    let result = Indexer::<H256>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 1);
    let (indexed, meta) = &logs[0];
    let expected = aleo_hash_to_h256(&[
        306532680884196914369041306889957777502u128,
        248078813986496060276330224523516710975u128,
    ]);
    assert_eq!(*indexed.inner(), expected);
    assert_eq!(indexed.sequence, Some(1));
    assert_eq!(meta.block_number, 12618649);
    assert_eq!(meta.transaction_index, 0);
    assert_eq!(meta.log_index, 1.into());
    let tx_hash =
        H256::from_str("0x042cb7ff55639abdda73ace1fbf728dc48a314137842274742ae64060cd4480c")
            .unwrap();
    assert_eq!(meta.transaction_id, tx_hash.into());
    assert_eq!(
        meta.block_hash,
        H256::from_str("0x9dce4c2ad56256bd7213c343bb8059d3469fde0863ca51f804656d947575a007")
            .unwrap()
    );
    assert_eq!(meta.address, locator.address);
}

#[tokio::test]
async fn test_delivery_indexer_fetch_empty() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    let range = 12618645..=12618650;
    for height in range.clone() {
        mock.register_value(
            &format!(
                "program/test_mailbox.aleo/mapping/process_event_index/{}u32",
                height
            ),
            serde_json::Value::Null,
        );
    }
    let indexer = AleoDeliveryIndexer::new(mock, &locator, &connection_conf());

    let result = Indexer::<H256>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 0);
}

#[tokio::test]
async fn test_delivery_latest_sequence() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file(
        "program/test_mailbox.aleo/mapping/mailbox/true",
        "mailbox_state.json",
    )
    .unwrap();
    let indexer = AleoDeliveryIndexer::new(mock, &locator, &connection_conf());

    let result = SequenceAwareIndexer::<H256>::latest_sequence_count_and_tip(&indexer).await;
    assert!(result.is_ok());
    let (sequence, tip) = result.unwrap();
    assert_eq!(sequence, Some(2));
    assert_eq!(tip, 12620133);
}

#[tokio::test]
async fn test_dispatch_indexer_fetch_logs() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file("block/12529863", "dispatch_block.json")
        .unwrap();

    mock.register_value(
        "program/test_mailbox.aleo/mapping/dispatch_events/1u32",
        "{\n  version: 3u8,\n  nonce: 1u32,\n  origin_domain: 1617853565u32,\n  sender: [\n    252u8,\n    80u8,\n    5u8,\n    58u8,\n    116u8,\n    217u8,\n    53u8,\n    34u8,\n    241u8,\n    170u8,\n    247u8,\n    201u8,\n    188u8,\n    11u8,\n    171u8,\n    50u8,\n    243u8,\n    244u8,\n    41u8,\n    110u8,\n    7u8,\n    22u8,\n    8u8,\n    25u8,\n    216u8,\n    103u8,\n    58u8,\n    89u8,\n    25u8,\n    199u8,\n    61u8,\n    12u8\n  ],\n  destination_domain: 11155111u32,\n  recipient: [\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    181u8,\n    169u8,\n    25u8,\n    159u8,\n    187u8,\n    73u8,\n    207u8,\n    247u8,\n    192u8,\n    213u8,\n    67u8,\n    37u8,\n    145u8,\n    36u8,\n    130u8,\n    151u8,\n    151u8,\n    20u8,\n    53u8,\n    244u8\n  ],\n  body: [\n    268787773892274112404478985243277131776u128,\n    101401562821467212002249661463377258879u128,\n    0u128,\n    85413587559041969264383023824439869440u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128\n  ]\n}",
    );
    let range = 12529863..=12529863;
    for height in range.clone() {
        mock.register_value(
            &format!(
                "program/test_mailbox.aleo/mapping/dispatch_event_index/{}u32",
                height
            ),
            serde_json::Value::Null,
        );
    }
    mock.register_value(
        "program/test_mailbox.aleo/mapping/dispatch_event_index/12529863u32",
        "1u32",
    );

    let indexer = AleoDispatchIndexer::new(mock, &locator, &connection_conf());
    let result = Indexer::<HyperlaneMessage>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 1);
    let (indexed, meta) = &logs[0];
    let expected = HyperlaneMessage::from(hex::decode("0300000001606e7c7dfc50053a74d93522f1aaf7c9bc0bab32f3f4296e07160819d8673a5919c73d0c00aa36a7000000000000000000000000b5a9199fbb49cff7c0d5432591248297971435f40000000000000000000000006aa436ca7fa9fc1c16108f3cd090ef350a3b494c00000000000000000000000000000000000000000000000000000000000f4240000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000").unwrap());
    assert_eq!(*indexed.inner(), expected);
    assert_eq!(indexed.sequence, Some(1));
    assert_eq!(meta.block_number, 12529863);
    assert_eq!(meta.transaction_index, 0);
    assert_eq!(meta.log_index, 1.into());
    let tx_hash =
        H256::from_str("0x7d7224d69af361af599f786303e1b5ebf0c1c8a382c82841035dc6b0b8286009")
            .unwrap();
    assert_eq!(meta.transaction_id, tx_hash.into());
    assert_eq!(
        meta.block_hash,
        H256::from_str("0x751cd2b445173cf83758b2aefea85c5c6817c2fc036892b3794293842f6e8a0a")
            .unwrap()
    );
    assert_eq!(meta.address, locator.address);
}

#[tokio::test]
async fn test_dispatch_latest_sequence() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file(
        "program/test_mailbox.aleo/mapping/mailbox/true",
        "mailbox_state.json",
    )
    .unwrap();
    let indexer = AleoDispatchIndexer::new(mock, &locator, &connection_conf());

    let result =
        SequenceAwareIndexer::<HyperlaneMessage>::latest_sequence_count_and_tip(&indexer).await;
    assert!(result.is_ok());
    let (sequence, tip) = result.unwrap();
    assert_eq!(sequence, Some(2));
    assert_eq!(tip, 12620133);
}

#[tokio::test]
async fn test_igp_indexer_fetch_logs() {
    let locator = ContractLocator::new(
        &DOMAIN,
        H256::from_str("0xaf8aedee874608851c51f359cefbdfa45ae1edd859df6a8f892bf5cf87d0df03")
            .unwrap(),
    );

    let mock = mock_provider();
    mock.register_file("block/12529863", "dispatch_block.json")
        .unwrap();
    mock.register_value(
        "program/test_hook_manager.aleo/mapping/gas_payment_events/{hook:aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2,index:1u32}",
        "{\n  id: [\n    256267490544060419649858878342859086153u128,\n    278497652737802013060047005208637375179u128\n  ],\n  destination_domain: 11155111u32,\n  gas_amount: 50000u128,\n  payment: 0u64,\n  index: 1u32\n}",
    );
    let range = 12529863..=12529863;
    for height in range.clone() {
        mock.register_value(
            &format!(
                "program/test_hook_manager.aleo/mapping/last_event_index/{{hook:aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2,block_height:{}u32}}",
                height
            ),
            serde_json::Value::Null,
        );
    }
    mock.register_value(
        "program/test_hook_manager.aleo/mapping/last_event_index/{hook:aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2,block_height:12529863u32}",
        "1u32",
    );
    let indexer = AleoInterchainGasIndexer::new(mock, &locator, &connection_conf()).unwrap();

    let result = Indexer::<InterchainGasPayment>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 1);
    let (indexed, meta) = &logs[0];
    let expected = InterchainGasPayment {
        message_id: H256::from_str(
            "0x4959c85b87e052bc1520df1bc952cbc0cb82fcce533efd863c74fb0c67b284d1",
        )
        .unwrap(),
        destination: 11155111,
        payment: 0.into(),
        gas_amount: 50000.into(),
    };
    assert_eq!(*indexed.inner(), expected);
    assert_eq!(indexed.sequence, Some(1));
    assert_eq!(meta.block_number, 12529863);
    assert_eq!(meta.transaction_index, 0);
    assert_eq!(meta.log_index, 1.into());
    let tx_hash =
        H256::from_str("0x7d7224d69af361af599f786303e1b5ebf0c1c8a382c82841035dc6b0b8286009")
            .unwrap();
    assert_eq!(meta.transaction_id, tx_hash.into());
    assert_eq!(
        meta.block_hash,
        H256::from_str("0x751cd2b445173cf83758b2aefea85c5c6817c2fc036892b3794293842f6e8a0a")
            .unwrap()
    );
}

#[tokio::test]
async fn test_igp_latest_sequence() {
    let locator = ContractLocator::new(
        &DOMAIN,
        H256::from_str("0xaf8aedee874608851c51f359cefbdfa45ae1edd859df6a8f892bf5cf87d0df03")
            .unwrap(),
    );

    let mock = mock_provider();
    mock.register_value(
        "program/test_hook_manager.aleo/mapping/igps/aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2",
        json!({
            "data": "{count: 2u32}",
            "height": 12620133
        }),
    );
    let indexer = AleoInterchainGasIndexer::new(mock, &locator, &connection_conf()).unwrap();

    let result =
        SequenceAwareIndexer::<InterchainGasPayment>::latest_sequence_count_and_tip(&indexer).await;
    assert!(result.is_ok());
    let (sequence, tip) = result.unwrap();
    assert_eq!(sequence, Some(2));
    assert_eq!(tip, 12620133);
}

#[tokio::test]
async fn test_merkle_tree_indexer_fetch_logs() {
    let locator = ContractLocator::new(
        &DOMAIN,
        H256::from_str("3ccf041f02d031ed3049f8cffe94fc78eae38cbac15cd367357332b833827b0d").unwrap(),
    );

    let mock = mock_provider();
    mock.register_file("block/12529863", "dispatch_block.json")
        .unwrap();
    mock.register_value(
        "program/test_hook_manager.aleo/mapping/inserted_into_tree_events/{hook:aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vxs0r2hk8,index:1u32}",
        "{\n  id: [\n    256267490544060419649858878342859086153u128,\n    278497652737802013060047005208637375179u128\n  ],\n  index: 1u32\n}"
    );
    let range = 12529863..=12529863;
    for height in range.clone() {
        mock.register_value(
            &format!(
        "program/test_hook_manager.aleo/mapping/last_event_index/{{hook:aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vxs0r2hk8,block_height:{}u32}}",
                height
            ),
            serde_json::Value::Null,
        );
    }
    mock.register_value(
        "program/test_hook_manager.aleo/mapping/last_event_index/{hook:aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vxs0r2hk8,block_height:12529863u32}",
        "1u32",
    );
    let indexer = AleoMerkleTreeHook::new(mock, &locator, &connection_conf()).unwrap();

    let result = Indexer::<MerkleTreeInsertion>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 1);
    let (indexed, meta) = &logs[0];
    let expected = MerkleTreeInsertion::new(
        1,
        H256::from_str("0x4959c85b87e052bc1520df1bc952cbc0cb82fcce533efd863c74fb0c67b284d1")
            .unwrap(),
    );
    assert_eq!(*indexed.inner(), expected);
    assert_eq!(indexed.sequence, Some(1));
    assert_eq!(meta.block_number, 12529863);
    assert_eq!(meta.transaction_index, 0);
    assert_eq!(meta.log_index, 1.into());
    let tx_hash =
        H256::from_str("0x7d7224d69af361af599f786303e1b5ebf0c1c8a382c82841035dc6b0b8286009")
            .unwrap();
    assert_eq!(meta.transaction_id, tx_hash.into());
    assert_eq!(
        meta.block_hash,
        H256::from_str("0x751cd2b445173cf83758b2aefea85c5c6817c2fc036892b3794293842f6e8a0a")
            .unwrap()
    );
}

#[tokio::test]
async fn test_merkle_tree_latest_sequence() {
    let locator = ContractLocator::new(
        &DOMAIN,
        H256::from_str("3ccf041f02d031ed3049f8cffe94fc78eae38cbac15cd367357332b833827b0d").unwrap(),
    );

    let mock = mock_provider();
    mock.register_file(
        "program/test_hook_manager.aleo/mapping/merkle_tree_hooks/aleo18n8sg8cz6qc76vzflr8la98u0r4w8r96c9wdxee4wvetsvuz0vxs0r2hk8",
        "merkle_tree_hook.json",
    ).unwrap();
    let indexer = AleoMerkleTreeHook::new(mock, &locator, &connection_conf()).unwrap();

    let result =
        SequenceAwareIndexer::<MerkleTreeInsertion>::latest_sequence_count_and_tip(&indexer).await;
    assert!(result.is_ok());
    let (sequence, tip) = result.unwrap();
    assert_eq!(sequence, Some(2));
    assert_eq!(tip, 1337);
}

#[tokio::test]
async fn test_indexer_multi_fetch_logs() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file("block/12625985", "multi_dispatch.json")
        .unwrap();

    mock.register_value(
        "program/test_mailbox.aleo/mapping/dispatch_event_index/12625985u32",
        "3u32",
    );
    mock.register_value(
        "program/test_mailbox.aleo/mapping/dispatch_events/2u32",
        "{\n  version: 3u8,\n  nonce: 2u32,\n  origin_domain: 1617853565u32,\n  sender: [\n    252u8,\n    80u8,\n    5u8,\n    58u8,\n    116u8,\n    217u8,\n    53u8,\n    34u8,\n    241u8,\n    170u8,\n    247u8,\n    201u8,\n    188u8,\n    11u8,\n    171u8,\n    50u8,\n    243u8,\n    244u8,\n    41u8,\n    110u8,\n    7u8,\n    22u8,\n    8u8,\n    25u8,\n    216u8,\n    103u8,\n    58u8,\n    89u8,\n    25u8,\n    199u8,\n    61u8,\n    12u8\n  ],\n  destination_domain: 11155111u32,\n  recipient: [\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    181u8,\n    169u8,\n    25u8,\n    159u8,\n    187u8,\n    73u8,\n    207u8,\n    247u8,\n    192u8,\n    213u8,\n    67u8,\n    37u8,\n    145u8,\n    36u8,\n    130u8,\n    151u8,\n    151u8,\n    20u8,\n    53u8,\n    244u8\n  ],\n  body: [\n    268787773892274112404478985243277131776u128,\n    101401562821467212002249661463377258879u128,\n    0u128,\n    85413587559041969264383023824439869440u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128\n  ]\n}",
    );
    mock.register_value(
        "program/test_mailbox.aleo/mapping/dispatch_events/3u32",
        "{\n  version: 3u8,\n  nonce: 3u32,\n  origin_domain: 1617853565u32,\n  sender: [\n    252u8,\n    80u8,\n    5u8,\n    58u8,\n    116u8,\n    217u8,\n    53u8,\n    34u8,\n    241u8,\n    170u8,\n    247u8,\n    201u8,\n    188u8,\n    11u8,\n    171u8,\n    50u8,\n    243u8,\n    244u8,\n    41u8,\n    110u8,\n    7u8,\n    22u8,\n    8u8,\n    25u8,\n    216u8,\n    103u8,\n    58u8,\n    89u8,\n    25u8,\n    199u8,\n    61u8,\n    12u8\n  ],\n  destination_domain: 11155111u32,\n  recipient: [\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    0u8,\n    181u8,\n    169u8,\n    25u8,\n    159u8,\n    187u8,\n    73u8,\n    207u8,\n    247u8,\n    192u8,\n    213u8,\n    67u8,\n    37u8,\n    145u8,\n    36u8,\n    130u8,\n    151u8,\n    151u8,\n    20u8,\n    53u8,\n    244u8\n  ],\n  body: [\n    268787773892274112404478985243277131776u128,\n    101401562821467212002249661463377258879u128,\n    0u128,\n    85413587559041969264383023824439869440u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128,\n    0u128\n  ]\n}",
    );

    let indexer = AleoDispatchIndexer::new(mock, &locator, &connection_conf());

    let result =
        Indexer::<HyperlaneMessage>::fetch_logs_in_range(&indexer, 12625985..=12625985).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 2);
    for log in logs {
        let (indexed, _) = &log;
        assert_eq!(indexed.inner().nonce, indexed.sequence.unwrap());
    }
}

#[tokio::test]
async fn test_indexer_reverted_fetch_logs() {
    let program_id = ProgramID::<TestnetV0>::from_str("test_mailbox.aleo").unwrap();
    let locator = ContractLocator::new(&DOMAIN, to_h256(program_id.to_address().unwrap()).unwrap());

    let mock = mock_provider();
    mock.register_file("block/12640906", "reverted_dispatch.json")
        .unwrap();
    let range = 12640906..=12640906;
    for height in range.clone() {
        mock.register_value(
            &format!(
                "program/test_mailbox.aleo/mapping/dispatch_event_index/{}u32",
                height
            ),
            serde_json::Value::Null,
        );
    }

    let indexer = AleoDispatchIndexer::new(mock, &locator, &connection_conf());

    let result = Indexer::<HyperlaneMessage>::fetch_logs_in_range(&indexer, range).await;
    assert!(result.is_ok());
    let logs = result.unwrap();
    assert_eq!(logs.len(), 0);
}
