//! Oracle uses actual generated Hyperlane cainome types and starknet-rs account
//! encoding/hash/crypto. Every account input is explicit: no RPC method is run.
#[allow(warnings)]
mod mailbox {
    include!(concat!(env!("OUT_DIR"), "/mailbox.rs"));
}
use cainome::cairo_serde::{CairoSerde, U256};
use serde_json::json;
use starknet::{
    accounts::{Account, ExecutionEncoder, ExecutionEncoding, SingleOwnerAccount},
    core::{
        crypto::ecdsa_sign,
        types::{
            BroadcastedInvokeTransactionV3, Call, DataAvailabilityMode, Felt, ResourceBounds,
            ResourceBoundsMapping,
        },
        utils::{cairo_short_string_to_felt, get_selector_from_name},
    },
    providers::{jsonrpc::HttpTransport, JsonRpcClient},
    signers::{LocalWallet, SigningKey},
};
type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;
fn chunks(text: &str) -> Vec<String> {
    text.chars()
        .collect::<Vec<_>>()
        .chunks(32)
        .map(|p| p.iter().collect())
        .collect()
}
fn bytes(data: &[u8]) -> Vec<String> {
    chunks(&data.iter().map(|b| format!("{b:02x}")).collect::<String>())
}
fn felt(value: Felt) -> Vec<String> {
    bytes(&value.to_bytes_be())
}
fn felts(values: &[Felt]) -> Vec<Vec<String>> {
    values.iter().map(|v| felt(*v)).collect()
}
// Same pure byte conversion as production utils::to_packed_bytes. The actual
// serialization itself is provided by the generated production CairoSerde impl.
fn packed(data: &[u8]) -> mailbox::Bytes {
    mailbox::Bytes {
        size: data.len() as u32,
        data: data
            .chunks(16)
            .map(|part| {
                let mut word = [0; 16];
                word[..part.len()].copy_from_slice(part);
                u128::from_be_bytes(word)
            })
            .collect(),
    }
}
fn main() -> Result<()> {
    let secret = Felt::from(17u64);
    let public = SigningKey::from_secret_scalar(secret)
        .verifying_key()
        .scalar();
    let chain = cairo_short_string_to_felt("SN_SEPOLIA")?;
    let account_address = Felt::from(0x1234u64);
    for length in [0, 1, 15, 16, 17, 31, 32, 33, 55, 127, 128, 255, 256] {
        let body: Vec<u8> = (0..length).map(|i| (i * 13) as u8).collect();
        let sender = U256::from_bytes_be(&[0x22; 32]);
        let recipient = U256::from_bytes_be(&[0x33; 32]);
        let message = mailbox::Message {
            version: 3,
            nonce: 42,
            origin: 100,
            sender,
            destination: 200,
            recipient,
            body: packed(&body),
        };
        let encoded = mailbox::Message::cairo_serialize(&message);
        let metadata = packed(b"metadata\0\0");
        let mut process = mailbox::Bytes::cairo_serialize(&metadata);
        process.extend(&encoded);
        let mut dispatch = U256::cairo_serialize(&message.sender);
        dispatch.push(Felt::from(200u64));
        dispatch.extend(U256::cairo_serialize(&message.recipient));
        dispatch.extend(&encoded);
        println!(
            "{}",
            json!({"kind":"message","input":{"version":3,"nonce":42,"origin":100,"destination":200,"sender":bytes(&[0x22;32]),"recipient":bytes(&[0x33;32]),"body":bytes(&body),"metadata":bytes(b"metadata\0\0")},"expected":{"message":felts(&encoded),"process":felts(&process),"dispatch":felts(&dispatch)}})
        );
    }
    for legacy in [false, true] {
        let rpc = JsonRpcClient::new(HttpTransport::new(
            "https://fixture.invalid/rpc".parse::<starknet::providers::Url>()?,
        ));
        let account = SingleOwnerAccount::new(
            rpc,
            LocalWallet::from(SigningKey::from_secret_scalar(secret)),
            account_address,
            chain,
            if legacy {
                ExecutionEncoding::Legacy
            } else {
                ExecutionEncoding::New
            },
        );
        for n in [0u64, 1, 127, 128, 65535, 65536, u64::MAX] {
            let calls = vec![
                Call {
                    to: Felt::from(0x456u64),
                    selector: get_selector_from_name("process")?,
                    calldata: vec![Felt::from(n), Felt::from(1u64)],
                },
                Call {
                    to: Felt::from(0x789u64),
                    selector: get_selector_from_name("delivered")?,
                    calldata: vec![],
                },
            ];
            let prepared = account
                .execute_v3(calls.clone())
                .nonce(Felt::from(n))
                .l1_gas(n)
                .l1_gas_price(1000)
                .l2_gas(2000)
                .l2_gas_price(3000)
                .l1_data_gas(4000)
                .l1_data_gas_price(u128::MAX)
                .tip(n)
                .prepared()?;
            let hash = prepared.transaction_hash(false);
            let query_hash = prepared.transaction_hash(true);
            let signature = ecdsa_sign(&secret, &hash)?;
            let query_signature = ecdsa_sign(&secret, &query_hash)?;
            let calldata = account.encode_calls(&calls);
            let request = BroadcastedInvokeTransactionV3 {
                sender_address: account_address,
                calldata: calldata.clone(),
                signature: vec![signature.r, signature.s],
                nonce: Felt::from(n),
                resource_bounds: ResourceBoundsMapping {
                    l1_gas: ResourceBounds {
                        max_amount: n,
                        max_price_per_unit: 1000,
                    },
                    l2_gas: ResourceBounds {
                        max_amount: 2000,
                        max_price_per_unit: 3000,
                    },
                    l1_data_gas: ResourceBounds {
                        max_amount: 4000,
                        max_price_per_unit: u128::MAX,
                    },
                },
                tip: n,
                paymaster_data: vec![],
                account_deployment_data: vec![],
                nonce_data_availability_mode: DataAvailabilityMode::L1,
                fee_data_availability_mode: DataAvailabilityMode::L1,
                is_query: false,
            };
            println!(
                "{}",
                json!({"kind":"invoke","input":{"legacy":legacy,"chain_id":felt(chain),"sender":felt(account_address),"nonce":n.to_string(),"l1_gas":n.to_string(),"l1_gas_price":"1000","l2_gas":"2000","l2_gas_price":"3000","l1_data_gas":"4000","l1_data_gas_price":u128::MAX.to_string(),"tip":n.to_string(),"calls":calls.iter().map(|c|json!({"to":felt(c.to),"selector":felt(c.selector),"calldata":felts(&c.calldata)})).collect::<Vec<_>>()},"expected":{"encoded":felts(&calldata),"hash":felt(hash),"query_hash":felt(query_hash),"public":felt(public),"signature":felts(&[signature.r,signature.s]),"query_signature":felts(&[query_signature.r,query_signature.s]),"request_utf8_chunks":chunks(&serde_json::to_string(&request)?)}})
            );
        }
    }
    {
        use starknet::core::types::{
            BlockWithTxHashes, EmittedEvent, EventsChunk, FeeEstimate,
            TransactionReceiptWithBlockInfo,
        };
        let price = json!({"price_in_fri":"0x1","price_in_wei":"0x2"});
        let raw = json!({"status":"ACCEPTED_ON_L2","block_hash":"0xaa","parent_hash":"0x99","block_number":10,"new_root":"0x1","timestamp":1700000000,"sequencer_address":"0x123","l1_gas_price":price,"l2_gas_price":price,"l1_data_gas_price":price,"l1_da_mode":"CALLDATA","starknet_version":"0.14.0","transactions":["0x66","0x55"]});
        let typed: BlockWithTxHashes = serde_json::from_value(raw.clone())?;
        println!(
            "{}",
            json!({"kind":"rpc_header","wire_utf8_chunks":chunks(&serde_json::to_string(&typed)?)})
        );
        let mut full_block = raw;
        let transactions:Vec<_> = [2u64,6].into_iter().enumerate().map(|(i,tip)|json!({"type":"INVOKE","version":"0x3","transaction_hash":format!("0x{:x}",0x55+i),"sender_address":"0x1234","calldata":[],"signature":[],"nonce":"0x0","resource_bounds":{"l1_gas":{"max_amount":"0x1","max_price_per_unit":"0x2"},"l2_gas":{"max_amount":"0x3","max_price_per_unit":"0x4"},"l1_data_gas":{"max_amount":"0x5","max_price_per_unit":"0x6"}},"tip":format!("0x{tip:x}"),"paymaster_data":[],"account_deployment_data":[],"nonce_data_availability_mode":"L1","fee_data_availability_mode":"L1"})).collect();
        full_block["transactions"] = json!(transactions);
        let full_typed: starknet::core::types::BlockWithTxs = serde_json::from_value(full_block)?;
        let expected_tip =
            starknet::core::types::MaybePreConfirmedBlockWithTxs::Block(full_typed.clone())
                .median_tip();
        println!(
            "{}",
            json!({"kind":"rpc_block_transactions","expected_tip":expected_tip,"wire_utf8_chunks":chunks(&serde_json::to_string(&full_typed)?)})
        );
        let selector = get_selector_from_name("InsertedIntoTree")?;
        let raw_event = json!({"from_address":"0x1234","keys":[format!("{selector:#x}")],"data":["0x1","0x0","0x2"],"block_hash":"0xaa","block_number":10,"transaction_hash":"0x55"});
        let event: EmittedEvent = serde_json::from_value(raw_event)?;
        for (name, token) in [
            ("rpc_page_continue", Some("fixture-page-token".to_owned())),
            ("rpc_page_end", None),
        ] {
            let page = EventsChunk {
                events: vec![event.clone(), event.clone()],
                continuation_token: token,
            };
            println!(
                "{}",
                json!({"kind":name,"wire_utf8_chunks":chunks(&serde_json::to_string(&page)?)})
            );
        }
        let receipt = json!({"type":"INVOKE","transaction_hash":"0x55","actual_fee":{"amount":"0x123","unit":"FRI"},"finality_status":"ACCEPTED_ON_L2","messages_sent":[],"events":[{"from_address":"0x999","keys":[],"data":[]},{"from_address":"0x1234","keys":[format!("{selector:#x}")],"data":["0x1","0x0","0x2"]}],"execution_resources":{"l1_gas":1,"l2_gas":2,"l1_data_gas":3},"execution_status":"SUCCEEDED","block_hash":"0xaa","block_number":10});
        let typed: TransactionReceiptWithBlockInfo = serde_json::from_value(receipt)?;
        println!(
            "{}",
            json!({"kind":"rpc_receipt","wire_utf8_chunks":chunks(&serde_json::to_string(&typed)?)})
        );
        let estimate = json!({"l1_gas_consumed":"0x1","l1_gas_price":"0x2","l2_gas_consumed":"0x3","l2_gas_price":"0x4","l1_data_gas_consumed":"0x5","l1_data_gas_price":"0x6","overall_fee":"0x2c"});
        let typed: FeeEstimate = serde_json::from_value(estimate.clone())?;
        println!(
            "{}",
            json!({"kind":"rpc_fee_without_unit","wire_utf8_chunks":chunks(&serde_json::to_string(&estimate)?)})
        );
        println!(
            "{}",
            json!({"kind":"rpc_fee","wire_utf8_chunks":chunks(&serde_json::to_string(&typed)?)})
        );
    }
    Ok(())
}
