//! Real HyperlaneRocksDB/TypedDB read-write oracle. Use only task-owned fixtures.
use hyperlane_base::db::{
    HyperlaneDb, HyperlaneRocksDB, InterchainGasPaymentData, PendingMessageRetryState, DB,
};
use hyperlane_core::{
    BackwardCursorProgress, HyperlaneDomain, HyperlaneMessage, KnownHyperlaneDomain,
    PendingOperationStatus, ReprepareReason, H256, U256,
};
use std::{collections::BTreeMap, error::Error, path::Path};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
fn chunks(bytes: &[u8]) -> Vec<String> {
    let text: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    text.as_bytes()
        .chunks(32)
        .map(|chunk| String::from_utf8_lossy(chunk).into_owned())
        .collect()
}
fn message() -> HyperlaneMessage {
    HyperlaneMessage {
        version: 3,
        nonce: 42,
        origin: 42161,
        sender: H256::repeat_byte(0x11),
        destination: 1,
        recipient: H256::repeat_byte(0x22),
        body: vec![1, 2, 3],
    }
}
fn populate(path: &Path) -> Result<()> {
    if path.exists() {
        return Err("fixture database path must not exist".into());
    }
    {
        let db = DB::from_path(path)?;
        let typed =
            HyperlaneRocksDB::new(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum), db);
        let message = message();
        typed.upsert_message(&message, 12345678)?;
        typed.store_processed_by_nonce(&42, &false)?;
        typed.store_interchain_gas_payment_data_by_gas_payment_key(
            &hyperlane_core::GasPaymentKey {
                message_id: message.id(),
                destination: 1,
            },
            &InterchainGasPaymentData {
                payment: U256::from(123),
                gas_amount: U256::from(456),
            },
        )?;
        typed.store_pending_message_retry_state_and_status_by_message_id(
            &message.id(),
            &PendingMessageRetryState::new(
                3,
                Some(1234567890),
                Some(1000),
                Some(ReprepareReason::ErrorSubmitting),
            ),
            &PendingOperationStatus::ReadyToSubmit,
        )?;
        typed.store_value_by_key(
            "message_backward_cursor_v2_",
            &7u32,
            &BackwardCursorProgress {
                sequence: 7,
                block: 88,
            },
        )?;
        typed.store_value_by_key("interop_empty_", &0u32, &Vec::<u32>::new())?;
    }
    let db = rocksdb::DB::open_for_read_only(&rocksdb::Options::default(), path, false)?;
    let records = db
        .iterator(rocksdb::IteratorMode::Start)
        .map(|row| {
            row.map(|(key, value)| serde_json::json!({"key":chunks(&key),"value":chunks(&value)}))
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    println!(
        "{}",
        serde_json::json!({"fixture_id":"ziggy-rust-rocksdb-interop-v1","domain":"arbitrum","message_id":chunks(message().id().as_bytes()),"records":records})
    );
    Ok(())
}
fn verify(path: &Path) -> Result<()> {
    let db = DB::from_path(path)?;
    let typed = HyperlaneRocksDB::new(&HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum), db);
    let message = message();
    assert_eq!(typed.retrieve_message_by_nonce(42)?, Some(message.clone()));
    assert_eq!(typed.retrieve_processed_by_nonce(&42)?, Some(true));
    assert!(typed.retrieve_pending_message_at_or_after(1, 42)?.is_none());
    let data = typed
        .retrieve_interchain_gas_payment_data_by_gas_payment_key(&hyperlane_core::GasPaymentKey {
            message_id: message.id(),
            destination: 1,
        })?
        .ok_or("missing gas data")?;
    assert_eq!(data.payment, U256::from(321));
    assert_eq!(data.gas_amount, U256::from(654));
    let retry = typed
        .retrieve_pending_message_retry_state_by_message_id(&message.id())?
        .ok_or("missing retry state")?;
    assert_eq!(retry.retry_count, 7);
    assert_eq!(retry.next_attempt_at_millis, None);
    assert_eq!(retry.retry_delay_millis, None);
    assert_eq!(
        typed.retrieve_pending_message_retry_count_by_message_id(&message.id())?,
        Some(7)
    );
    let cursor: BackwardCursorProgress = typed
        .retrieve_value_by_key("message_backward_cursor_v2_", &7u32)?
        .ok_or("missing cursor")?;
    assert_eq!(
        cursor,
        BackwardCursorProgress {
            sequence: 7,
            block: 987
        }
    );
    println!("{{\"verified\":true,\"reader\":\"production HyperlaneRocksDB and TypedDB\"}}");
    Ok(())
}
fn probe_domain(domain_id: u32, name: &str) -> Result<HyperlaneDomain> {
    use hyperlane_core::{HyperlaneDomainProtocol, HyperlaneDomainTechnicalStack};
    Ok(HyperlaneDomain::from_config(
        domain_id,
        name,
        HyperlaneDomainProtocol::Ethereum,
        HyperlaneDomainTechnicalStack::Other,
    )?)
}

fn destination_namespaces(input: &str) -> Result<BTreeMap<u32, String>> {
    let raw: BTreeMap<String, String> = serde_json::from_str(input)?;
    if raw.is_empty() {
        return Err("at least one destination namespace is required".into());
    }
    let mut result = BTreeMap::new();
    for (domain, name) in raw {
        if name.is_empty() || result.insert(domain.parse()?, name).is_some() {
            return Err("invalid or duplicate destination namespace".into());
        }
    }
    Ok(result)
}

fn json_bytes(value: &serde_json::Value, expected: usize) -> Result<Vec<u8>> {
    let values = value.as_array().ok_or("missing JSON byte array")?;
    if values.len() != expected {
        return Err("incorrect JSON byte array length".into());
    }
    values
        .iter()
        .map(|value| {
            value
                .as_u64()
                .and_then(|number| u8::try_from(number).ok())
                .ok_or_else(|| "invalid JSON byte".into())
        })
        .collect()
}

fn exact_gas_estimate(value: &serde_json::Value) -> Result<Option<String>> {
    let text = match value {
        serde_json::Value::Null => return Ok(None),
        serde_json::Value::Number(number) => number.to_string(),
        _ => return Err("sealed estimated gas must be a JSON integer or null".into()),
    };
    // arbitrary_precision preserves Zig's unquoted u256 decimal token. Reject
    // signed, fractional, exponent and out-of-u256 values rather than round.
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err("sealed estimated gas is not an unsigned decimal integer".into());
    }
    Ok(Some(U256::from_dec_str(&text)?.to_string()))
}

fn private_operation_stage(
    database: &DB,
    name: &str,
    message: &HyperlaneMessage,
    link: &serde_json::Value,
) -> Result<Option<String>> {
    let mut key = format!("{name}_zig_relayer_operation_v1/").into_bytes();
    key.extend_from_slice(message.id().as_bytes());
    let Some(bytes) = database.retrieve(&key)? else {
        return Ok(None);
    };
    let record: serde_json::Value = serde_json::from_slice(&bytes)?;
    if record["version"].as_u64() != Some(1)
        || record["nonce"].as_u64() != Some(u64::from(message.nonce))
        || record["destination"].as_u64() != Some(u64::from(message.destination))
        || json_bytes(&record["operation"]["id"], 32)?.as_slice() != message.id().as_bytes()
        || json_bytes(&record["context"], 32)? != json_bytes(&link["context"], 32)?
    {
        return Err("sealed private operation identity/context mismatch".into());
    }
    let stage = record["operation"]["stage"]
        .as_str()
        .ok_or("sealed private operation stage is missing")?;
    if !matches!(
        stage,
        "pending" | "preparing" | "ready" | "submitting" | "confirming" | "delivered" | "denied"
    ) {
        return Err("sealed private operation stage is invalid".into());
    }
    Ok(Some(stage.to_owned()))
}

/// One complete origin nonce scan. Destination selects each message's payment
/// and payload database; it never changes the meaning of the nonce bound.
fn relayer_probe_value(
    database: &DB,
    domain_id: u32,
    name: &str,
    destinations: &BTreeMap<u32, String>,
    count: u32,
    strict_destinations: bool,
) -> Result<serde_json::Value> {
    let origin = HyperlaneRocksDB::new(&probe_domain(domain_id, name)?, database.clone());
    let mut targets = BTreeMap::new();
    for (domain, namespace) in destinations {
        targets.insert(
            *domain,
            HyperlaneRocksDB::new(&probe_domain(*domain, namespace)?, database.clone()),
        );
    }
    let mut rows = Vec::new();
    for nonce in 0..count {
        let Some(message) = origin.retrieve_message_by_nonce(nonce)? else {
            rows.push(serde_json::json!({"nonce":nonce,"present":false}));
            continue;
        };
        if message.nonce != nonce || message.origin != domain_id {
            return Err("origin message identity does not match requested nonce/domain".into());
        }
        let target = targets.get(&message.destination);
        if strict_destinations && target.is_none() {
            return Err(
                format!("destination namespace missing for {}", message.destination).into(),
            );
        }
        let id = message.id();
        let insertion = origin.retrieve_merkle_tree_insertion_by_leaf_index(&nonce)?;
        let payment =
            origin.retrieve_gas_payment_by_gas_payment_key(hyperlane_core::GasPaymentKey {
                message_id: id,
                destination: message.destination,
            })?;
        let spent_record = origin.retrieve_interchain_gas_expenditure_data_by_message_id(&id)?;
        let spent = origin.retrieve_gas_expenditure_by_message_id(id)?;
        // Rust MessageProcessor owns destination-scoped mappings. Native Zig
        // journals own origin-scoped mappings. Decode both without inventing a
        // missing payload or counting a UUID twice when both mappings exist.
        let mut mappings: Vec<(lander::PayloadUuid, Vec<String>)> = Vec::new();
        if let Some(target) = target {
            for uuid in target
                .retrieve_payload_uuids_by_message_id(&id)?
                .unwrap_or_default()
            {
                if !mappings.iter().any(|(existing, _)| existing == &uuid) {
                    mappings.push((uuid, vec![destinations[&message.destination].clone()]));
                }
            }
        }
        for uuid in origin
            .retrieve_payload_uuids_by_message_id(&id)?
            .unwrap_or_default()
        {
            if let Some((_, namespaces)) =
                mappings.iter_mut().find(|(existing, _)| existing == &uuid)
            {
                if !namespaces.iter().any(|namespace| namespace == name) {
                    namespaces.push(name.to_owned());
                }
            } else {
                mappings.push((uuid, vec![name.to_owned()]));
            }
        }
        let mut payload_rows = Vec::new();
        for (uuid, namespaces) in mappings {
            let value: Option<lander::FullPayload> = match target {
                Some(target) => target.retrieve_value_by_key("payload_by_uuid_", &uuid)?,
                None => None,
            };
            if value
                .as_ref()
                .is_some_and(|payload| payload.details.uuid != uuid)
            {
                return Err("payload record UUID does not match mapping".into());
            }
            payload_rows.push(serde_json::json!({
                "uuid":uuid.to_string(),
                "present":value.is_some(),
                "status":value.map(|payload|format!("{:?}",payload.status)),
                "mapping_namespaces":namespaces,
                "destination_namespace":destinations.get(&message.destination),
            }));
        }
        rows.push(serde_json::json!({
            "nonce":nonce,
            "present":true,
            "origin":message.origin,
            "destination":message.destination,
            "destination_namespace":destinations.get(&message.destination),
            "id_chunks":chunks(id.as_bytes()),
            "processed":origin.retrieve_processed_by_nonce(&nonce)?,
            "insertion_id_chunks":insertion.map(|value|chunks(value.message_id().as_bytes())),
            "payment":payment.map(|value|serde_json::json!({"payment":value.payment.to_string(),"gas_amount":value.gas_amount.to_string()})),
            "spent":{"gas_used":spent.gas_used.to_string(),"tokens_used":spent.tokens_used.to_string()},
            "gas_expenditure_record_present":spent_record.is_some(),
            "payloads":payload_rows,
        }));
    }
    let links = database
        .retrieve_values_by_prefix(format!("{name}_zig_relayer_payload_link_v1/").as_bytes())?;
    let mut sealed = Vec::new();
    for bytes in links {
        let value: serde_json::Value = serde_json::from_slice(&bytes)?;
        let uuid = json_bytes(&value["payload"]["uuid"], 16)?;
        let id = H256::from_slice(&json_bytes(&value["message_id"], 32)?);
        let (message, message_source) = match origin.retrieve_message_by_id(&id)? {
            Some(message) => (message, "canonical"),
            None => (
                origin
                    .retrieve_value_by_key::<_, HyperlaneMessage>(
                        "zig_public_receipt_message_v1/",
                        &id,
                    )?
                    .ok_or("sealed link message is absent from origin store")?,
                "public_receipt_sidecar",
            ),
        };
        if message.id() != id || message.origin != domain_id {
            return Err("sealed link message identity does not match origin".into());
        }
        let target = targets.get(&message.destination);
        if strict_destinations && target.is_none() {
            return Err(format!(
                "sealed link destination namespace missing for {}",
                message.destination
            )
            .into());
        }
        let present = if target.is_some() {
            let mut key =
                format!("{}_payload_by_uuid_", destinations[&message.destination]).into_bytes();
            key.extend_from_slice(&uuid);
            Some(database.retrieve(&key)?.is_some())
        } else {
            None
        };
        let estimate = exact_gas_estimate(&value["estimated_gas"])?;
        let stage = private_operation_stage(database, name, &message, &value)?;
        let canonical = origin.retrieve_message_by_nonce(message.nonce)?;
        let spent_record = origin.retrieve_interchain_gas_expenditure_data_by_message_id(&id)?;
        let spent = origin.retrieve_gas_expenditure_by_message_id(id)?;
        sealed.push(serde_json::json!({
            "uuid_chunks":chunks(&uuid),
            "message_id_chunks":chunks(id.as_bytes()),
            "nonce":message.nonce,
            "origin":message.origin,
            "estimated_gas":estimate,
            "spent":{"gas_used":spent.gas_used.to_string(),"tokens_used":spent.tokens_used.to_string()},
            "gas_expenditure_record_present":spent_record.is_some(),
            "message_source":message_source,
            "canonical_nonce_message_present":canonical.is_some(),
            "canonical_nonce_matches_message":canonical.as_ref().is_some_and(|value|value.id() == id),
            "private_operation_stage":stage,
            "destination":message.destination,
            "destination_namespace":destinations.get(&message.destination),
            "destination_payload_present":present,
        }));
    }
    Ok(serde_json::json!({
        "reader":"actual production HyperlaneRocksDB + FullPayload decoder",
        "origin_domain":domain_id,
        "origin_namespace":name,
        "origin_nonce_count":count,
        "destination_namespaces":destinations,
        "messages":rows,
        "sealed_payload_links":sealed,
    }))
}

fn relayer_probe(
    path: &Path,
    domain_id: u32,
    name: &str,
    destination: u32,
    destination_name: &str,
    count: u32,
) -> Result<()> {
    let database = DB::from_path(path)?;
    let destinations = BTreeMap::from([(destination, destination_name.to_owned())]);
    println!(
        "{}",
        relayer_probe_value(&database, domain_id, name, &destinations, count, false)?
    );
    Ok(())
}

fn relayer_probe_all(
    path: &Path,
    domain_id: u32,
    name: &str,
    count: u32,
    destinations: &str,
) -> Result<()> {
    let destinations = destination_namespaces(destinations)?;
    let database = DB::from_path(path)?;
    println!(
        "{}",
        relayer_probe_value(&database, domain_id, name, &destinations, count, true)?
    );
    Ok(())
}
fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("relayer-probe-all") {
        if args.len() != 7 {
            return Err(
                "usage: relayer-probe-all PATH ORIGIN_DOMAIN ORIGIN_NAME COUNT DESTINATIONS_JSON"
                    .into(),
            );
        }
        return relayer_probe_all(
            Path::new(&args[2]),
            args[3].parse()?,
            &args[4],
            args[5].parse()?,
            &args[6],
        );
    }
    if args.get(1).map(String::as_str) == Some("relayer-probe") {
        if args.len() != 8 {
            return Err("usage: relayer-probe PATH DOMAIN NAME DEST_DOMAIN DEST_NAME COUNT".into());
        }
        return relayer_probe(
            Path::new(&args[2]),
            args[3].parse()?,
            &args[4],
            args[5].parse()?,
            &args[6],
            args[7].parse()?,
        );
    }
    if args.len() != 3 {
        return Err("usage: ziggy-rocks-oracle populate|verify PATH".into());
    }
    match args[1].as_str() {
        "populate" => populate(Path::new(&args[2])),
        "verify" => verify(Path::new(&args[2])),
        _ => Err("unknown operation".into()),
    }
}

#[cfg(test)]
mod relayer_probe_tests {
    use super::*;
    use hyperlane_base::db::InterchainGasExpenditureData;

    struct Scratch(std::path::PathBuf);
    impl Scratch {
        fn new() -> Self {
            Self(std::env::temp_dir().join(format!(
                "ziggy-relayer-oracle-{}",
                lander::PayloadUuid::random()
            )))
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn all_destinations_cover_origin_nonces_and_both_real_mapping_namespaces() -> Result<()> {
        let scratch = Scratch::new();
        let database = DB::from_path(&scratch.0)?;
        let origin_domain = 9_913_371;
        let first_destination = 9_913_372;
        let second_destination = 9_913_373;
        let names = BTreeMap::from([
            (first_destination, "test2".to_owned()),
            (second_destination, "test3".to_owned()),
        ]);
        let origin =
            HyperlaneRocksDB::new(&probe_domain(origin_domain, "test1")?, database.clone());
        let first =
            HyperlaneRocksDB::new(&probe_domain(first_destination, "test2")?, database.clone());
        let second = HyperlaneRocksDB::new(
            &probe_domain(second_destination, "test3")?,
            database.clone(),
        );
        let mut messages = Vec::new();
        for (nonce, destination) in [first_destination, second_destination, first_destination]
            .into_iter()
            .enumerate()
        {
            let mut value = message();
            value.nonce = u32::try_from(nonce)?;
            value.origin = origin_domain;
            value.destination = destination;
            origin.upsert_message(&value, 10)?;
            origin.store_processed_by_nonce(&value.nonce, &true)?;
            origin.store_interchain_gas_payment_data_by_gas_payment_key(
                &hyperlane_core::GasPaymentKey {
                    message_id: value.id(),
                    destination,
                },
                &InterchainGasPaymentData {
                    payment: U256::from(100),
                    gas_amount: U256::from(200),
                },
            )?;
            messages.push(value);
        }
        let uuids = [
            lander::PayloadUuid::random(),
            lander::PayloadUuid::random(),
            lander::PayloadUuid::random(),
        ];
        // Actual Rust mapping is destination-scoped. A duplicate mapping plus
        // a matching native-origin mapping still represents only one payload.
        first.store_payload_uuids_by_message_id(
            &messages[0].id(),
            vec![uuids[0].clone(), uuids[0].clone()],
        )?;
        origin.store_payload_uuids_by_message_id(&messages[0].id(), vec![uuids[0].clone()])?;
        second.store_payload_uuids_by_message_id(&messages[1].id(), vec![uuids[1].clone()])?;
        // Actual native Zig mapping is origin-scoped, even though its payload
        // record is stored under the destination namespace.
        origin.store_payload_uuids_by_message_id(&messages[2].id(), vec![uuids[2].clone()])?;
        for (index, value) in messages.iter().enumerate() {
            let target = if value.destination == first_destination {
                &first
            } else {
                &second
            };
            let mut payload = lander::FullPayload::default();
            payload.details.uuid = uuids[index].clone();
            target.store_value_by_key("payload_by_uuid_", &uuids[index], &payload)?;
            let mut key = b"test1_zig_relayer_payload_link_v1/".to_vec();
            key.extend_from_slice(value.id().as_bytes());
            database.store(
                &key,
                &serde_json::to_vec(&serde_json::json!({
                    "message_id":value.id().as_bytes(),
                    "payload":{"uuid":uuids[index].as_bytes()},
                }))?,
            )?;
        }
        // Distinguish missing Source aggregate(default zero), recorded positive
        // cost, and an explicitly recorded zero-fee expenditure.
        origin.store_interchain_gas_expenditure_data_by_message_id(
            &messages[1].id(),
            &InterchainGasExpenditureData {
                gas_used: U256::from(7),
                tokens_used: U256::from(11),
            },
        )?;
        origin.store_interchain_gas_expenditure_data_by_message_id(
            &messages[2].id(),
            &InterchainGasExpenditureData {
                gas_used: U256::zero(),
                tokens_used: U256::zero(),
            },
        )?;
        let result = relayer_probe_value(&database, origin_domain, "test1", &names, 4, true)?;
        let rows = result["messages"].as_array().ok_or("missing messages")?;
        assert_eq!(rows.len(), 4);
        for (nonce, row) in rows.iter().enumerate() {
            assert_eq!(row["nonce"], nonce);
        }
        for (index, value) in messages.iter().enumerate() {
            let row = &rows[index];
            assert_eq!(row["destination"], value.destination);
            assert_eq!(
                row["id_chunks"],
                serde_json::json!(chunks(value.id().as_bytes()))
            );
            assert_eq!(row["payment"]["gas_amount"], "200");
            assert_eq!(row["processed"], true);
            assert_eq!(row["payloads"].as_array().map(Vec::len), Some(1));
            assert_eq!(row["payloads"][0]["uuid"], uuids[index].to_string());
            assert_eq!(row["payloads"][0]["present"], true);
        }
        assert_eq!(
            rows[0]["payloads"][0]["mapping_namespaces"],
            serde_json::json!(["test2", "test1"])
        );
        assert_eq!(
            rows[1]["payloads"][0]["mapping_namespaces"],
            serde_json::json!(["test3"])
        );
        assert_eq!(
            rows[2]["payloads"][0]["mapping_namespaces"],
            serde_json::json!(["test1"])
        );
        assert_eq!(rows[0]["gas_expenditure_record_present"], false);
        assert_eq!(rows[0]["spent"]["gas_used"], "0");
        assert_eq!(rows[1]["gas_expenditure_record_present"], true);
        assert_eq!(rows[1]["spent"]["tokens_used"], "11");
        assert_eq!(rows[2]["gas_expenditure_record_present"], true);
        assert_eq!(rows[2]["spent"]["tokens_used"], "0");
        assert_eq!(rows[3]["present"], false);
        let links = result["sealed_payload_links"]
            .as_array()
            .ok_or("missing sealed links")?;
        assert_eq!(links.len(), 3);
        assert!(links
            .iter()
            .all(|link| link["destination_payload_present"] == true));
        let legacy_names = BTreeMap::from([(first_destination, "test2".to_owned())]);
        let legacy =
            relayer_probe_value(&database, origin_domain, "test1", &legacy_names, 1, false)?;
        assert_eq!(legacy["messages"][0]["payloads"][0]["present"], true);
        assert!(
            relayer_probe_value(&database, origin_domain, "test1", &legacy_names, 3, true).is_err()
        );
        Ok(())
    }

    #[test]
    fn sealed_public_sidecar_reports_exact_estimate_private_stage_and_id_accounting() -> Result<()>
    {
        let scratch = Scratch::new();
        let database = DB::from_path(&scratch.0)?;
        let mut value = message();
        value.origin = 9_913_371;
        value.destination = 9_913_372;
        value.nonce = 0;
        let origin = HyperlaneRocksDB::new(&probe_domain(value.origin, "test1")?, database.clone());
        let target =
            HyperlaneRocksDB::new(&probe_domain(value.destination, "test2")?, database.clone());
        let names = BTreeMap::from([(value.destination, "test2".to_owned())]);
        // Exact production sidecar wire, with no canonical nonce row and no
        // processed-by-nonce marker. Its independent ID owns the cost proof.
        origin.store_value_by_key("zig_public_receipt_message_v1/", &value.id(), &value)?;
        origin.store_interchain_gas_expenditure_data_by_message_id(
            &value.id(),
            &InterchainGasExpenditureData {
                gas_used: U256::from(7),
                tokens_used: U256::from(21),
            },
        )?;
        let uuid = lander::PayloadUuid::random();
        let mut payload = lander::FullPayload::default();
        payload.details.uuid = uuid.clone();
        target.store_value_by_key("payload_by_uuid_", &uuid, &payload)?;
        let context = [4u8; 32];
        let estimate = U256::MAX.to_string();
        let mut link = serde_json::json!({
            "version":1,"context":context,"message_id":value.id().as_bytes(),
            "generation":1,"estimated_gas":null,"payload":{"uuid":uuid.as_bytes()},
        });
        // Parse the unquoted Zig u256 JSON number, including all256 bits.
        link["estimated_gas"] = serde_json::from_str(&estimate)?;
        let mut link_key = b"test1_zig_relayer_payload_link_v1/".to_vec();
        link_key.extend_from_slice(value.id().as_bytes());
        database.store(&link_key, &serde_json::to_vec(&link)?)?;
        let before = relayer_probe_value(&database, value.origin, "test1", &names, 1, true)?;
        assert_eq!(
            before["sealed_payload_links"][0]["private_operation_stage"],
            serde_json::Value::Null
        );

        let mut operation = serde_json::json!({
            "version":1,"context":context,"nonce":value.nonce,"destination":value.destination,
            "operation":{
                "id":value.id().as_bytes(),"stage":"delivered","generation":1,"retries":0,
                "next_attempt_ms":0,"confirmation_started":true,"transaction":null,
                "policy":{"max_retries":66,"confirm_delay_ms":600000},
            },
            "deadline":null,"transaction_bytes":null,
        });
        let mut operation_key = b"test1_zig_relayer_operation_v1/".to_vec();
        operation_key.extend_from_slice(value.id().as_bytes());
        database.store(&operation_key, &serde_json::to_vec(&operation)?)?;
        let result = relayer_probe_value(&database, value.origin, "test1", &names, 1, true)?;
        assert_eq!(result["messages"][0]["present"], false);
        let sealed = &result["sealed_payload_links"][0];
        assert_eq!(sealed["message_source"], "public_receipt_sidecar");
        assert_eq!(sealed["nonce"], 0);
        assert_eq!(sealed["origin"], value.origin);
        assert_eq!(sealed["canonical_nonce_message_present"], false);
        assert_eq!(sealed["canonical_nonce_matches_message"], false);
        assert_eq!(sealed["private_operation_stage"], "delivered");
        assert_eq!(sealed["estimated_gas"], estimate);
        assert_eq!(sealed["spent"]["gas_used"], "7");
        assert_eq!(sealed["spent"]["tokens_used"], "21");
        assert_eq!(sealed["gas_expenditure_record_present"], true);
        assert_eq!(sealed["destination_payload_present"], true);
        assert!(origin.retrieve_message_by_nonce(0)?.is_none());
        assert_ne!(origin.retrieve_processed_by_nonce(&0)?, Some(true));
        // Existing canonical fixtures and legacy CLI receive the same fields.
        let legacy = relayer_probe_value(&database, value.origin, "test1", &names, 0, false)?;
        assert_eq!(legacy["sealed_payload_links"][0], *sealed);

        // A delivered string alone cannot manufacture identity authority.
        for field in ["nonce", "destination", "context", "id", "stage", "version"] {
            let previous = operation.clone();
            match field {
                "nonce" => operation["nonce"] = serde_json::json!(1),
                "destination" => {
                    operation["destination"] = serde_json::json!(value.destination + 1)
                }
                "context" => operation["context"] = serde_json::json!(vec![5u8; 32]),
                "id" => operation["operation"]["id"] = serde_json::json!(vec![6u8; 32]),
                "stage" => operation["operation"]["stage"] = serde_json::json!("unknown"),
                "version" => operation["version"] = serde_json::json!(2),
                _ => unreachable!(),
            }
            database.store(&operation_key, &serde_json::to_vec(&operation)?)?;
            assert!(
                relayer_probe_value(&database, value.origin, "test1", &names, 1, true).is_err(),
                "accepted incorrect {field}"
            );
            operation = previous;
        }
        assert!(exact_gas_estimate(&serde_json::from_str("1.5")?).is_err());
        assert!(exact_gas_estimate(&serde_json::from_str("-1")?).is_err());
        assert!(exact_gas_estimate(&serde_json::from_str(&format!("{estimate}0"))?).is_err());
        Ok(())
    }

    #[test]
    fn destination_map_rejects_empty_or_normalized_duplicate_domains() -> Result<()> {
        assert!(destination_namespaces("{}").is_err());
        assert!(destination_namespaces("{\"9913372\":\"test2\",\"09913372\":\"other\"}").is_err());
        assert!(destination_namespaces("{\"9913372\":\"\"}").is_err());
        assert_eq!(
            destination_namespaces("{\"9913372\":\"test2\"}")?
                .get(&9_913_372)
                .map(String::as_str),
            Some("test2")
        );
        Ok(())
    }
}
