use radix_common::prelude::*;
use radix_transactions::{builder::*, model::*, signing::PrivateKey};
use serde_json::json;
use std::error::Error;

fn main() -> Result<(), Box<dyn Error>> {
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
