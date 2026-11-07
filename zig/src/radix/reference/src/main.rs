use radix_common::prelude::*;
use radix_transactions::{builder::*, model::*, signing::PrivateKey};
use serde_json::json;
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
    if std::env::args().nth(1).as_deref() == Some("evidence") {
        return evidence_main();
    }
    if std::env::args().nth(1).as_deref() == Some("announcement") {
        #[derive(Sbor)]
        #[sbor(transparent)]
        struct EthAddress([u8; 20]);
        let signature = vec![6u8; 65];
        let args = manifest_args!(EthAddress([5u8; 20]), "s3://fixture/region", &signature);
        println!(
            "{}",
            json!({"source":"production SDK0ff82f3 EthAddress transparent ManifestSbor", "args":hex::encode(manifest_encode(&args).map_err(|_|"announcement encode")?)})
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("receipts") {
        return receipt_vectors();
    }
    if std::env::args().nth(1).as_deref() == Some("verify") {
        use std::io::BufRead;
        for line in std::io::stdin().lock().lines() {
            let value: serde_json::Value = serde_json::from_str(&line?)?;
            let digest = hex::decode(value["digest"].as_str().ok_or("digest")?)?;
            let public = hex::decode(value["public"].as_str().ok_or("public")?)?;
            let signature = hex::decode(value["signature"].as_str().ok_or("signature")?)?;
            let valid = match value["kind"].as_str() {
                Some("ed") => verify_ed25519(
                    &digest,
                    &Ed25519PublicKey(public.try_into().map_err(|_| "key size")?),
                    &Ed25519Signature(signature.try_into().map_err(|_| "signature size")?),
                ),
                Some("secp") => verify_secp256k1(
                    &Hash(digest.try_into().map_err(|_| "digest size")?),
                    &Secp256k1PublicKey(public.try_into().map_err(|_| "key size")?),
                    &Secp256k1Signature(signature.try_into().map_err(|_| "signature size")?),
                ),
                _ => return Err("kind".into()),
            };
            println!("{}", json!({"valid":valid}));
        }
        return Ok(());
    }
    let key = PrivateKey::Ed25519(Ed25519PrivateKey::from_bytes(&[0x11; 32]).map_err(|_| "key")?);
    let public_key = key.public_key();
    let account = ComponentAddress::preallocated_account_from_public_key(&public_key);
    let network = NetworkDefinition::mainnet();
    let account_text = AddressBech32Encoder::new(&network).encode(account.as_bytes())?;
    let component = FAUCET;
    use core_api_client::models as core;
    use gateway_api_client::models as gateway;
    let component_text = AddressBech32Encoder::new(&network).encode(component.as_bytes())?;
    let call_request = core::TransactionCallPreviewRequest {
        arguments: vec![],
        at_ledger_state: Some(core::LedgerStateSelector::ByStateVersion(
            core::VersionLedgerStateSelector { state_version: 100 },
        )),
        network: "mainnet".into(),
        target: core::TargetIdentifier::Method(core::ComponentMethodTargetIdentifier {
            component_address: component_text,
            method_name: "count".into(),
        }),
    };
    let mut stream_request = gateway::StreamTransactionsRequest::new();
    stream_request.from_ledger_state = Some(Some(gateway::LedgerStateSelector {
        state_version: Some(Some(100)),
        ..Default::default()
    }));
    stream_request.event_global_emitters_filter = Some(vec![account_text.clone()]);
    stream_request.order = Some(gateway::stream_transactions_request::Order::Asc);
    stream_request.opt_ins = Some(gateway::TransactionDetailsOptIns {
        receipt_events: Some(true),
        ..Default::default()
    });
    let api = json!({"call":call_request,"stream":stream_request,"status":core::NetworkStatusRequest{network:"mainnet".into()}});
    let values = json!({"bool":hex::encode(scrypto_encode(&true).unwrap()),"u32":hex::encode(scrypto_encode(&5u32).unwrap()),"optional_component":hex::encode(scrypto_encode(&Some(component)).unwrap()),"merkle":hex::encode(scrypto_encode(&([[0x11u8;32];32],3usize)).unwrap()),"multisig":hex::encode(scrypto_encode(&(vec![[0x22u8;20],[0x33u8;20]],2usize)).unwrap()),"locations":hex::encode(scrypto_encode(&vec![vec!["s3://fixture/region".to_string()]]).unwrap())});
    let mut cases = vec![];
    for length in [
        0usize, 1, 31, 32, 63, 64, 127, 128, 129, 255, 256, 511, 512, 1024,
    ] {
        let metadata = (0..length).map(|i| i as u8).collect::<Vec<_>>();
        let message = (0..77 + length).map(|i| (i * 17) as u8).collect::<Vec<_>>();
        let visible: Vec<ComponentAddress> = if length % 2 == 0 {
            vec![component]
        } else {
            vec![]
        };
        let args = manifest_args!(&metadata, &message, &visible);
        let manifest = ManifestBuilder::new_v2()
            .lock_fee(account, "1.5".parse::<Decimal>().unwrap())
            .call_method(
                component,
                "process",
                manifest_args!(&metadata, &message, &visible),
            )
            .build();
        let builder = TransactionBuilder::new_v2()
            .transaction_header(TransactionHeaderV2 {
                notary_public_key: public_key,
                notary_is_signatory: true,
                tip_basis_points: 0,
            })
            .intent_header(IntentHeaderV2 {
                network_id: 1,
                start_epoch_inclusive: Epoch::of(100),
                end_epoch_exclusive: Epoch::of(102),
                min_proposer_timestamp_inclusive: None,
                max_proposer_timestamp_exclusive: None,
                intent_discriminator: length as u64,
            })
            .manifest(manifest.clone());
        let preview = builder.clone().build_preview_transaction(vec![]);
        let built = builder.notarize(&key).build();
        let tx = built.transaction;
        let prepared = tx.prepare(&PreparationSettings::latest()).unwrap();
        let ti = &tx.signed_transaction_intent.transaction_intent;
        let core = &ti.root_intent_core;
        cases.push(json!({"length":length,"metadata":hex::encode(metadata),"message":hex::encode(message),"visible":visible.iter().map(|a|hex::encode(a.as_bytes())).collect::<Vec<_>>(),"args":hex::encode(manifest_encode(&args).unwrap()),"instructions":hex::encode(manifest_encode(&core.instructions).unwrap()),"intent_header":hex::encode(manifest_encode(&core.header).unwrap()),"transaction_header":hex::encode(manifest_encode(&ti.transaction_header).unwrap()),"intent":hex::encode(ti.to_raw().unwrap().as_slice()),"preview":hex::encode(preview.to_raw().unwrap().as_slice()),"signed_intent":hex::encode(tx.signed_transaction_intent.to_raw().unwrap().as_slice()),"notarized":hex::encode(tx.to_raw().unwrap().as_slice()),"intent_hash":hex::encode(prepared.transaction_intent_hash().0.0),"signed_intent_hash":hex::encode(prepared.signed_transaction_intent_hash().0.0),"notarized_hash":hex::encode(prepared.notarized_transaction_hash().0.0),"core_hash":hex::encode(prepared.signed_intent.transaction_intent.root_intent_core.summary.hash.0)}));
    }
    let mut crypto_cases = vec![];
    for (index, length) in [
        0usize, 1, 31, 32, 63, 64, 127, 128, 129, 255, 256, 511, 512, 1024, 2048, 4096,
    ]
    .into_iter()
    .enumerate()
    {
        let seed = [index as u8 + 1; 32];
        let payload = (0..length)
            .map(|n| (n * 31 + index) as u8)
            .collect::<Vec<_>>();
        let digest = hash(&payload);
        let ed = Ed25519PrivateKey::from_bytes(&seed).unwrap();
        let secp = Secp256k1PrivateKey::from_bytes(&seed).unwrap();
        let edsig = ed.sign(digest.as_bytes());
        let secpsig = secp.sign(&digest);
        assert!(verify_ed25519(digest.as_bytes(), &ed.public_key(), &edsig));
        assert!(verify_secp256k1(&digest, &secp.public_key(), &secpsig));
        crypto_cases.push(json!({"seed":hex::encode(seed),"payload":hex::encode(payload),"digest":hex::encode(digest.0),"ed_public":hex::encode(ed.public_key().0),"ed_signature":hex::encode(edsig.0),"secp_public":hex::encode(secp.public_key().0),"secp_signature":hex::encode(secpsig.0),"secp_account":hex::encode(ComponentAddress::preallocated_account_from_public_key(&secp.public_key()).as_bytes())}));
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"source":"production Radix SDK rev 0ff82f3ba44cd848d178b5b3ec780ea43ea03bba","key_seed":"11".repeat(32),"public_key":format!("{:?}",public_key),"account":hex::encode(account.as_bytes()),"account_text":account_text,"component":hex::encode(component.as_bytes()),"api":api,"values":values,"crypto_cases":crypto_cases,"cases":cases})
        )?
    );
    Ok(())
}

// Closed, bounded evidence protocol. This is independent SDK validation, not a
// decoder of a digest supplied by the implementation under test.
const EVIDENCE_LIMIT: usize = 4 * 1024 * 1024;
type EvidenceResult<T> = Result<T, Box<dyn Error>>;

fn fields(value: &serde_json::Value, names: &[&str]) -> EvidenceResult<()> {
    let object = value.as_object().ok_or("object required")?;
    if object.len() != names.len() || names.iter().any(|name| !object.contains_key(*name)) {
        return Err("unexpected/missing evidence field".into());
    }
    Ok(())
}

fn text<'a>(value: &'a serde_json::Value, name: &str) -> EvidenceResult<&'a str> {
    value[name].as_str().ok_or_else(|| "string required".into())
}

fn evidence_hex(value: &str, maximum: usize) -> EvidenceResult<Vec<u8>> {
    if value.len() > maximum * 2 || !value.len().is_multiple_of(2) {
        return Err("hex size bound".into());
    }
    Ok(hex::decode(value.strip_prefix("0x").unwrap_or(value))?)
}

fn evidence_main() -> EvidenceResult<()> {
    use std::io::Read;
    let mut input = Vec::new();
    std::io::stdin()
        .lock()
        .take((EVIDENCE_LIMIT + 1) as u64)
        .read_to_end(&mut input)?;
    if input.len() > EVIDENCE_LIMIT {
        return Err("request limit".into());
    }
    let request = parse_evidence_input(&input)?;
    let result = evidence(&request)?;
    let output = serde_json::to_vec(&result)?;
    if output.len() > EVIDENCE_LIMIT {
        return Err("response limit".into());
    }
    use std::io::Write;
    std::io::stdout().lock().write_all(&output)?;
    Ok(())
}

fn parse_evidence_input(input: &[u8]) -> EvidenceResult<serde_json::Value> {
    if input.len() > EVIDENCE_LIMIT {
        return Err("request limit".into());
    }
    let request: serde_json::Value = serde_json::from_slice(input)?;
    if serde_json::to_vec(&request)? != input {
        return Err("canonical JSON request required (no duplicate keys)".into());
    }
    Ok(request)
}

fn evidence(request: &serde_json::Value) -> EvidenceResult<serde_json::Value> {
    if request["schema"].as_u64() != Some(1) {
        return Err("evidence schema".into());
    }
    match text(request, "op")? {
        "notarized" => notarized_evidence(request),
        "byte_argument" => {
            fields(request, &["schema", "op", "kind", "hex"])?;
            if text(request, "kind")? == "decode_bytes" {
                let raw = evidence_hex(text(request, "hex")?, 1024 * 1024)?;
                let bytes: Vec<u8> = manifest_decode(&raw).map_err(|_| "byte argument decode")?;
                if manifest_encode(&bytes).map_err(|_| "byte argument reencode")? != raw {
                    return Err("noncanonical byte argument".into());
                }
                return Ok(json!({"schema":1,"op":"byte_argument","hex":hex::encode(bytes)}));
            }
            let encoded = match text(request, "kind")? {
                "bytes" => manifest_encode(&evidence_hex(text(request, "hex")?, 1024 * 1024)?)
                    .map_err(|_| "argument encode")?,
                "validators" => {
                    let values = request["hex"].as_array().ok_or("validators array")?;
                    if values.is_empty() || values.len() > 256 {
                        return Err("validators bound".into());
                    }
                    let mut validators = Vec::<[u8; 20]>::new();
                    for value in values {
                        validators.push(
                            evidence_hex(value.as_str().ok_or("validator hex")?, 20)?
                                .try_into()
                                .map_err(|_| "validator width")?,
                        );
                    }
                    manifest_encode(&validators).map_err(|_| "validator argument encode")?
                }
                _ => return Err("unknown byte argument kind".into()),
            };
            Ok(json!({"schema":1,"op":"byte_argument","hex":hex::encode(encoded)}))
        }
        "call_output" => output_evidence(request),
        _ => Err("unknown evidence operation".into()),
    }
}

fn notarized_evidence(request: &serde_json::Value) -> EvidenceResult<serde_json::Value> {
    use radix_transactions::validation::TransactionValidator;
    fields(
        request,
        &[
            "schema",
            "op",
            "network",
            "public_key",
            "account",
            "mailbox",
            "hex",
        ],
    )?;
    if request["network"].as_u64() != Some(240) {
        return Err("only Source localnet network240".into());
    }
    let network = NetworkDefinition::localnet();
    let public_bytes: [u8; 32] = evidence_hex(text(request, "public_key")?, 32)?
        .try_into()
        .map_err(|_| "public key width")?;
    let public = PublicKey::Ed25519(Ed25519PublicKey(public_bytes));
    let account = ComponentAddress::preallocated_account_from_public_key(&public);
    if evidence_hex(text(request, "account")?, 30)? != account.as_bytes() {
        return Err("account/notary authority differs".into());
    }
    let mailbox_bytes: [u8; 30] = evidence_hex(text(request, "mailbox")?, 30)?
        .try_into()
        .map_err(|_| "mailbox width")?;
    let mailbox = ComponentAddress::try_from(mailbox_bytes).map_err(|_| "mailbox component")?;
    let bytes = evidence_hex(text(request, "hex")?, 1024 * 1024)?;
    let raw = RawNotarizedTransaction::from_vec(bytes.clone());
    let UserTransaction::V2(transaction) = raw.into_typed().map_err(|_| "notarized decode")? else {
        return Err("V2 required".into());
    };
    if transaction
        .to_raw()
        .map_err(|_| "canonical encode")?
        .as_slice()
        != bytes
    {
        return Err("noncanonical notarized bytes".into());
    }
    let validator = TransactionValidator::new_with_latest_config(&network);
    raw.validate_as_known_v2(&validator)
        .map_err(|_| "SDK transaction/signature validation")?;
    let prepared = transaction
        .prepare(validator.preparation_settings())
        .map_err(|_| "prepare")?;
    let signed = &transaction.signed_transaction_intent;
    let intent = &signed.transaction_intent;
    let core = &intent.root_intent_core;
    if intent.transaction_header.notary_public_key != public
        || !intent.transaction_header.notary_is_signatory
        || core.header.network_id != 240
    {
        return Err("notary/network authority".into());
    }
    if !intent.non_root_subintents.0.is_empty()
        || !core.children.children.is_empty()
        || !core.blobs.blobs.is_empty()
        || core.message != MessageV2::None
        || !signed.transaction_intent_signatures.signatures.is_empty()
        || !signed.non_root_subintent_signatures.by_subintent.is_empty()
    {
        return Err("unexpected subintent/blob/message/intent signatures".into());
    }
    if core.instructions.0.len() != 2 {
        return Err("exact fee and process calls required".into());
    }
    let InstructionV2::CallMethod(fee) = &core.instructions.0[0] else {
        return Err("fee call required".into());
    };
    let InstructionV2::CallMethod(call) = &core.instructions.0[1] else {
        return Err("process call required".into());
    };
    if fee.address != ManifestGlobalAddress::Static(account.into())
        || fee.method_name != "lock_fee"
        || call.address != ManifestGlobalAddress::Static(mailbox.into())
        || call.method_name != "process"
    {
        return Err("unexpected transaction effect/target/method".into());
    }
    let fee_encoded = manifest_encode(&fee.args).map_err(|_| "fee args encode")?;
    let (amount,): (Decimal,) = manifest_decode(&fee_encoded).map_err(|_| "fee tuple")?;
    if amount <= Decimal::ZERO {
        return Err("positive fee required".into());
    }
    let call_encoded = manifest_encode(&call.args).map_err(|_| "process args encode")?;
    let (metadata, message, visible): (Vec<u8>, Vec<u8>, Vec<ComponentAddress>) =
        manifest_decode(&call_encoded).map_err(|_| "process tuple")?;
    if message.len() < 77 || message[0] != 3 || metadata.len() > 1024 * 1024 || visible.len() > 256
    {
        return Err("process payload bound/version".into());
    }
    Ok(
        json!({"schema":1,"op":"notarized","network":240,"public_key":hex::encode(public_bytes),"account":hex::encode(account.as_bytes()),"mailbox":hex::encode(mailbox.as_bytes()),"intent_hash":hex::encode(prepared.transaction_intent_hash().0.0),"signed_intent_hash":hex::encode(prepared.signed_transaction_intent_hash().0.0),"notarized_hash":hex::encode(prepared.notarized_transaction_hash().0.0),"start_epoch_inclusive":core.header.start_epoch_inclusive.number(),"end_epoch_exclusive":core.header.end_epoch_exclusive.number(),"intent_discriminator":core.header.intent_discriminator,"locked_fee":amount.to_string(),"metadata":hex::encode(metadata),"message":hex::encode(message),"visible_components":visible.iter().map(|v|hex::encode(v.as_bytes())).collect::<Vec<_>>() }),
    )
}

fn output_evidence(request: &serde_json::Value) -> EvidenceResult<serde_json::Value> {
    fields(request, &["schema", "op", "kind", "hex"])?;
    let bytes = evidence_hex(text(request, "hex")?, 1024 * 1024)?;
    macro_rules! decoded {
        ($ty:ty) => {{
            let value: $ty = scrypto_decode(&bytes).map_err(|_| "typed output decode")?;
            if scrypto_encode(&value).map_err(|_| "output encode")? != bytes {
                return Err("noncanonical output".into());
            }
            value
        }};
    }
    let kind = text(request, "kind")?;
    let value = match kind {
        "bool" => json!(decoded!(bool)),
        "u32" => json!(decoded!(u32)),
        "merkle" => {
            let (frontier, count) = decoded!(([[u8; 32]; 32], usize));
            if count > u32::MAX as usize {
                return Err("merkle count".into());
            }
            json!({"frontier":frontier.iter().map(hex::encode).collect::<Vec<_>>(),"count":count})
        }
        "multisig" => {
            let (validators, threshold) = decoded!((Vec<[u8; 20]>, usize));
            if validators.len() > 256 || threshold == 0 || threshold > validators.len() {
                return Err("multisig bounds".into());
            }
            json!({"validators":validators.iter().map(hex::encode).collect::<Vec<_>>(),"threshold":threshold})
        }
        "locations" => {
            let rows = decoded!(Vec<Vec<String>>);
            if rows.len() > 256
                || rows
                    .iter()
                    .any(|v| v.len() > 256 || v.iter().any(|s| s.len() > 8192))
            {
                return Err("location bounds".into());
            }
            json!(rows)
        }
        "optional_component" => {
            let value = decoded!(Option<ComponentAddress>);
            json!(value.map(|v| hex::encode(v.as_bytes())))
        }
        "component" => json!(hex::encode(decoded!(ComponentAddress).as_bytes())),
        _ => return Err("unknown typed output".into()),
    };
    Ok(json!({"schema":1,"op":"call_output","kind":kind,"value":value}))
}

// Independent source algorithm using the pinned SDK lexer/parser, never Zig.
fn receipt_vectors() -> Result<(), Box<dyn Error>> {
    use radix_transactions::manifest::{
        ast::{Instruction, Value},
        lexer, parser,
    };
    let network = NetworkDefinition::mainnet();
    let encoder = AddressBech32Encoder::new(&network);
    let account = ComponentAddress::preallocated_account_from_public_key(
        &Ed25519PrivateKey::from_bytes(&[0x11; 32])
            .unwrap()
            .public_key(),
    );
    let account_text = encoder.encode(account.as_bytes())?;
    let component_text = encoder.encode(FAUCET.as_bytes())?;
    let mut cases = vec![];
    for method in [
        "lock_fee",
        "lock_fee_and_withdraw",
        "lock_fee_and_withdraw_non_fungibles",
        "lock_fee_from_faucet",
        "lock_fee_custom",
        "withdraw",
    ] {
        let call = format!(
            "CALL_METHOD Address(\"{}\") \"{}\" Decimal(\"1.5\");",
            account_text, method
        );
        for manifest in [
            call.clone(),
            format!(
                "# fake CALL_METHOD Address(\"{}\") \"lock_fee\";\n{}",
                component_text, call
            ),
            format!(
                "CALL_METHOD Address(\"{}\") \"deposit\" \"fake ; CALL_METHOD lock_fee\";{}",
                component_text, call
            ),
            call.replace("lock_fee", "lock_\\u0066ee"),
            format!("{}@", call),
            format!("{}# comment", call),
        ] {
            let mut found = None;
            if let Ok(tokens) = lexer::tokenize(&manifest) {
                if let Ok(mut parser) = parser::Parser::new(tokens, parser::PARSER_MAX_DEPTH) {
                    while !parser.is_eof() {
                        let Ok(instruction) = parser.parse_instruction() else {
                            continue;
                        };
                        let Instruction::CallMethod {
                            address,
                            method_name,
                            ..
                        } = instruction.instruction
                        else {
                            continue;
                        };
                        let Value::String(method) = method_name.value else {
                            continue;
                        };
                        if !method.starts_with("lock_fee") {
                            continue;
                        };
                        let Value::Address(address) = address.value else {
                            continue;
                        };
                        let Value::String(address) = address.value else {
                            continue;
                        };
                        if let Ok((_, bytes)) =
                            AddressBech32Decoder::new(&network).validate_and_decode(&address)
                        {
                            found = Some(hex::encode(bytes));
                            break;
                        }
                    }
                }
            }
            cases.push(json!({"manifest":manifest,"sender":found}));
        }
    }
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"source":"production Radix SDK rev 0ff82f3ba44cd848d178b5b3ec780ea43ea03bba; Hyperlane manifest/mod.rs AST selection", "account":hex::encode(account.as_bytes()),"account_text":account_text,"component":hex::encode(FAUCET.as_bytes()),"component_text":component_text,"cases":cases})
        )?
    );
    Ok(())
}

#[cfg(test)]
mod evidence_tests {
    use super::*;

    fn transaction(extra: bool) -> serde_json::Value {
        let key = PrivateKey::Ed25519(
            Ed25519PrivateKey::from_bytes(&[0x11; 32]).expect("public fixture key"),
        );
        let public = key.public_key();
        let account = ComponentAddress::preallocated_account_from_public_key(&public);
        let mut message = vec![0u8; 77];
        message[0] = 3;
        let metadata = vec![5u8; 192];
        let visible = vec![FAUCET];
        let mut builder = ManifestBuilder::new_v2()
            .lock_fee(account, "1.5".parse::<Decimal>().expect("fixture decimal"))
            .call_method(
                FAUCET,
                "process",
                manifest_args!(&metadata, &message, &visible),
            );
        if extra {
            builder = builder.call_method(FAUCET, "unrelated", manifest_args!());
        }
        let tx = TransactionBuilder::new_v2()
            .transaction_header(TransactionHeaderV2 {
                notary_public_key: public,
                notary_is_signatory: true,
                tip_basis_points: 0,
            })
            .intent_header(IntentHeaderV2 {
                network_id: 240,
                start_epoch_inclusive: Epoch::of(100),
                end_epoch_exclusive: Epoch::of(102),
                min_proposer_timestamp_inclusive: None,
                max_proposer_timestamp_exclusive: None,
                intent_discriminator: u64::MAX,
            })
            .manifest(builder.build())
            .notarize(&key)
            .build()
            .transaction;
        let PublicKey::Ed25519(public) = public else {
            panic!("fixture is Ed25519")
        };
        json!({"schema":1,"op":"notarized","network":240,"public_key":hex::encode(public.0),"account":hex::encode(account.as_bytes()),"mailbox":hex::encode(FAUCET.as_bytes()),"hex":hex::encode(tx.to_raw().expect("fixture raw").as_slice())})
    }

    #[test]
    fn actual_sdk_notarized_authority_hashes_and_process_fields() {
        let request = transaction(false);
        let result = evidence(&request).expect("valid SDK transaction");
        assert_eq!(result["network"], 240);
        assert_eq!(result["intent_discriminator"], u64::MAX);
        assert_eq!(result["metadata"], "05".repeat(192));
        assert_eq!(result["message"], format!("03{}", "00".repeat(76)));
        assert_eq!(result["locked_fee"], "1.5");
        assert_eq!(
            result["visible_components"],
            json!([hex::encode(FAUCET.as_bytes())])
        );
        for name in ["intent_hash", "signed_intent_hash", "notarized_hash"] {
            assert_eq!(result[name].as_str().expect("hash").len(), 64);
        }
        assert_ne!(result["intent_hash"], result["signed_intent_hash"]);
        assert_ne!(result["signed_intent_hash"], result["notarized_hash"]);
    }

    #[test]
    fn sdk_signature_truncation_trailing_and_foreign_effects_reject() {
        let original = transaction(false);
        for field in ["account", "mailbox", "public_key"] {
            let mut request = original.clone();
            request[field] = json!("00".repeat(if field == "public_key" { 32 } else { 30 }));
            assert!(evidence(&request).is_err(), "foreign {field}");
        }
        for length in [0usize, 1, 17] {
            let mut request = original.clone();
            request["hex"] = json!(&original["hex"].as_str().expect("hex")[..length * 2]);
            assert!(evidence(&request).is_err());
        }
        let raw = hex::decode(original["hex"].as_str().expect("hex")).expect("fixture hex");
        let mut bad_signature = raw.clone();
        let last = bad_signature.len() - 1;
        bad_signature[last] ^= 1;
        let mut request = original.clone();
        request["hex"] = json!(hex::encode(bad_signature));
        assert!(evidence(&request).is_err());
        request["hex"] = json!(format!("{}00", hex::encode(raw)));
        assert!(evidence(&request).is_err());
        assert!(evidence(&transaction(true)).is_err());
        request = original;
        request["network"] = json!(1);
        assert!(evidence(&request).is_err());
        request["network"] = json!(240);
        request["unexpected"] = json!(true);
        assert!(evidence(&request).is_err());
    }

    #[test]
    fn typed_outputs_use_real_sdk_decode_canonical_reencode() {
        let rows = [
            ("bool", scrypto_encode(&true).expect("encode"), json!(true)),
            (
                "u32",
                scrypto_encode(&u32::MAX).expect("encode"),
                json!(u32::MAX),
            ),
            (
                "optional_component",
                scrypto_encode(&Some(FAUCET)).expect("encode"),
                json!(hex::encode(FAUCET.as_bytes())),
            ),
            (
                "locations",
                scrypto_encode(&vec![vec!["file:///fixture/checkpoints".to_string()]])
                    .expect("encode"),
                json!([["file:///fixture/checkpoints"]]),
            ),
        ];
        for (kind, raw, value) in rows {
            let request =
                json!({"schema":1,"op":"call_output","kind":kind,"hex":hex::encode(&raw)});
            assert_eq!(evidence(&request).expect("valid output")["value"], value);
            let mut trailing = request.clone();
            trailing["hex"] = json!(format!("{}00", hex::encode(raw)));
            assert!(evidence(&trailing).is_err());
        }
        assert!(evidence(&json!({"schema":1,"op":"call_output","kind":"bool","hex":hex::encode(scrypto_encode(&1u32).expect("encode"))})).is_err());
    }

    #[test]
    fn byte_argument_is_sdk_vec_encoding_and_validators_are_full_width() {
        let request = json!({"schema":1,"op":"byte_argument","kind":"bytes","hex":"112233"});
        let result = evidence(&request).expect("byte argument");
        let raw = hex::decode(result["hex"].as_str().expect("hex")).expect("hex decode");
        assert_eq!(
            manifest_decode::<Vec<u8>>(&raw).expect("SDK bytes"),
            vec![0x11, 0x22, 0x33]
        );
        let result = evidence(
            &json!({"schema":1,"op":"byte_argument","kind":"validators","hex":["11".repeat(20)]}),
        )
        .expect("validators");
        assert_eq!(
            manifest_decode::<Vec<[u8; 20]>>(
                &hex::decode(result["hex"].as_str().expect("hex")).expect("hex decode")
            )
            .expect("SDK validator"),
            vec![[0x11; 20]]
        );
        assert!(evidence(
            &json!({"schema":1,"op":"byte_argument","kind":"validators","hex":["11".repeat(19)]})
        )
        .is_err());
        assert!(
            evidence(&json!({"schema":1,"op":"byte_argument","kind":"bytes","hex":"0"})).is_err()
        );
        let decoded = evidence(
            &json!({"schema":1,"op":"byte_argument","kind":"decode_bytes","hex":hex::encode(&raw)}),
        )
        .expect("decode byte argument");
        assert_eq!(decoded["hex"], "112233");
    }

    #[test]
    fn input_bounds_duplicate_keys_and_unknown_schema_fail_closed() {
        assert!(parse_evidence_input(br#"{"op":"byte_argument","schema":1,"schema":1}"#).is_err());
        assert!(parse_evidence_input(br#"{"schema":1} trailing"#).is_err());
        assert!(parse_evidence_input(&vec![b' '; EVIDENCE_LIMIT + 1]).is_err());
        assert!(
            evidence(&json!({"schema":2,"op":"byte_argument","kind":"bytes","hex":"00"})).is_err()
        );
        assert!(evidence(
            &json!({"schema":1,"op":"byte_argument","kind":"bytes","hex":"00".repeat(1024*1024+1)})
        )
        .is_err());
    }
}
