//! Independent SDK fixture generator. Disposable known test keys only.
use cosmos_sdk_proto::{
    cosmos::{base::v1beta1::Coin, tx::v1beta1 as tx},
    Any,
};
use ed25519_dalek::Signer;
use prost::Message;
use serde_json::json;
use sha2::{Digest, Sha256};
use solana_address::Address;
use solana_instruction::{AccountMeta, Instruction};
use solana_message::legacy::Message as SolanaMessage;

fn hex(bytes: impl AsRef<[u8]>) -> String {
    hex::encode(bytes)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    if std::env::args().nth(1).as_deref() == Some("svm-ism") {
        println!("{}", serde_json::to_string_pretty(&svm_ism_fixtures()?)?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("svm-destination") {
        println!(
            "{}",
            serde_json::to_string_pretty(&svm_destination_fixtures()?)?
        );
        return Ok(());
    }

    if std::env::args().nth(1).as_deref() == Some("announcements") {
        println!(
            "{}",
            serde_json::to_string_pretty(&announcement_fixtures()?)?
        );
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("cosmos") {
        println!("{}", serde_json::to_string_pretty(&cosmos_fixtures()?)?);
        return Ok(());
    }
    if std::env::args().nth(1).as_deref() == Some("compiler") {
        println!("{}", serde_json::to_string(&compiler_fixtures()?)?);
        return Ok(());
    }
    let sealevel = sealevel_fixtures()?;
    let seed = [0u8; 32];
    let key = ed25519_dalek::SigningKey::from_bytes(&seed);
    let payer = Address::new_from_array(key.verifying_key().to_bytes());
    let program = Address::new_from_array([2u8; 32]);
    let instruction = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(Address::new_from_array([1u8; 32]), false),
            AccountMeta::new_readonly(payer, false),
        ],
        data: b"test".to_vec(),
    };
    let message = SolanaMessage::new_with_blockhash(
        &[instruction],
        Some(&payer),
        &solana_hash::Hash::new_from_array([3u8; 32]),
    );
    let message_bytes = message.serialize();
    let signed = key.sign(&message_bytes);
    let mut transaction = vec![1];
    transaction.extend(signed.to_bytes());
    transaction.extend(&message_bytes);
    let v0_instruction = Instruction {
        program_id: program,
        accounts: vec![
            AccountMeta::new(Address::new_from_array([1u8; 32]), false),
            AccountMeta::new_readonly(Address::new_from_array([4u8; 32]), false),
            AccountMeta::new_readonly(payer, false),
        ],
        data: b"test".to_vec(),
    };
    let table = solana_message::AddressLookupTableAccount {
        key: Address::new_from_array([9; 32]),
        addresses: vec![
            Address::new_from_array([4; 32]),
            Address::new_from_array([1; 32]),
            program,
            payer,
        ],
    };
    let v0 = solana_message::v0::Message::try_compile(
        &payer,
        &[v0_instruction],
        &[table],
        solana_hash::Hash::new_from_array([3; 32]),
    )?
    .serialize();
    let mut v0_transaction = vec![1];
    v0_transaction.extend(key.sign(&v0).to_bytes());
    v0_transaction.extend(&v0);
    use solana_address_lookup_table_interface::state::{AddressLookupTable, LookupTableMeta};
    let alt = AddressLookupTable {
        meta: LookupTableMeta {
            deactivation_slot: u64::MAX,
            last_extended_slot: 10,
            last_extended_slot_start_index: 1,
            authority: Some([8u8; 32].into()),
            _padding: 0,
        },
        addresses: vec![[4u8; 32].into(), [1u8; 32].into()].into(),
    }
    .serialize_for_tests()?;
    let pda_program = Address::new_from_array([0x11u8; 32]);
    let mut pdas = vec![];
    for seeds in [
        vec![b"hyperlane".as_slice(), b"-", b"inbox"],
        vec![],
        vec![b"test"],
    ] {
        let (pda, bump) = Address::find_program_address(&seeds, &pda_program);
        pdas.push(json!({"seeds":seeds.iter().map(hex).collect::<Vec<_>>(),"key":hex(pda.to_bytes()),"bump":bump}));
    }

    let secret = k256::ecdsa::SigningKey::from_slice(&[0x11u8; 32])?;
    let public_key = secret.verifying_key().to_encoded_point(true);
    let public_key_proto = cosmos_sdk_proto::cosmos::crypto::secp256k1::PubKey {
        key: public_key.as_bytes().to_vec(),
    }
    .encode_to_vec();
    let body = tx::TxBody {
        messages: vec![Any {
            type_url: "/test.Msg".into(),
            value: vec![8, 1],
        }],
        memo: "memo".into(),
        timeout_height: 500,
        extension_options: vec![],
        non_critical_extension_options: vec![],
    }
    .encode_to_vec();
    #[allow(deprecated)]
    let auth = tx::AuthInfo {
        signer_infos: vec![tx::SignerInfo {
            public_key: Some(Any {
                type_url: "/cosmos.crypto.secp256k1.PubKey".into(),
                value: public_key_proto,
            }),
            mode_info: Some(tx::ModeInfo {
                sum: Some(tx::mode_info::Sum::Single(tx::mode_info::Single {
                    mode: 1,
                })),
            }),
            sequence: 7,
        }],
        fee: Some(tx::Fee {
            amount: vec![Coin {
                denom: "uatom".into(),
                amount: "123".into(),
            }],
            gas_limit: 200000,
            payer: "".into(),
            granter: "".into(),
        }),
        tip: None,
    }
    .encode_to_vec();
    let doc = tx::SignDoc {
        body_bytes: body.clone(),
        auth_info_bytes: auth.clone(),
        chain_id: "cosmoshub-4".into(),
        account_number: 12,
    }
    .encode_to_vec();
    let digest = Sha256::digest(&doc);
    let (signature, _) = secret.sign_prehash_recoverable(&digest)?;
    let raw = tx::TxRaw {
        body_bytes: body.clone(),
        auth_info_bytes: auth.clone(),
        signatures: vec![signature.to_bytes().to_vec()],
    }
    .encode_to_vec();
    let bitcoin_address = ripemd::Ripemd160::digest(Sha256::digest(public_key.as_bytes()));
    let bitcoin_bech32 =
        bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("cosmos")?, &bitcoin_address)?;

    use tron_rs::tron::protocol::{self, transaction};
    // Test owner is the Ethereum address for secret 0x11..11, with Tron prefix.
    let owner = hex::decode("4119e7e376e7c213b7e7e7e46cc70a5dd086daff2a")?;
    let mut contract_address = vec![0x41];
    contract_address.extend([0x22; 20]);
    let trigger = protocol::TriggerSmartContract {
        owner_address: owner,
        contract_address,
        call_value: 0,
        data: vec![1, 2, 3],
        call_token_value: 0,
        token_id: 0,
    };
    let tron_raw = transaction::Raw {
        ref_block_bytes: vec![0x34, 0x56],
        ref_block_num: 0x123456,
        ref_block_hash: vec![0x33; 8],
        timestamp: 1700000000000,
        expiration: 1700000060000,
        auths: vec![],
        data: vec![],
        scripts: vec![],
        contract: vec![transaction::Contract {
            r#type: 31,
            parameter: Some(prost_types_compat(&trigger.encode_to_vec())),
            provider: vec![],
            contract_name: vec![],
            permission_id: 0,
        }],
        fee_limit: 100000000,
    }
    .encode_to_vec();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "source":"Independent pinned Solana SDK 3.x, cosmos-sdk-proto 0.26.1, tron-rs 0.1.0",
            "sealevel":sealevel,
            "solana":{"payer":hex(payer.to_bytes()),"message":hex(message_bytes),"transaction":hex(transaction),"pdas":pdas,"v0":hex(v0),"v0_transaction":hex(v0_transaction),"lookup_table":hex(alt)},
            "cosmos":{"public_key":hex(public_key.as_bytes()),"address":hex(bitcoin_address),"bech32":bitcoin_bech32,"body":hex(body),"auth":hex(auth),"sign_doc":hex(doc),"digest":hex(digest),"signature":hex(signature.to_bytes()),"raw":hex(raw)},
            "tron":{"raw":hex(&tron_raw),"txid":hex(Sha256::digest(tron_raw))}
        }))?
    );
    Ok(())
}

fn cosmos_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use cosmos_sdk_proto::cosmos::auth::v1beta1::{BaseAccount, QueryAccountResponse};
    use cosmos_sdk_proto::cosmwasm::wasm::v1::{
        QuerySmartContractStateRequest, QuerySmartContractStateResponse,
    };
    use hyperlane_core::{
        accumulator::incremental::IncrementalMerkle, Encode, HyperlaneMessage, H256,
    };
    use hyperlane_cosmos_rs::hyperlane::core::{
        interchain_security::v1 as ism, post_dispatch::v1 as hook, v1 as native,
    };
    use hyperlane_cosmos_rs::prost::Name;
    let mailbox_id = hex([0x11; 32]);
    let hook_id = hex([0x22; 32]);
    let ism_id = hex([0x33; 32]);
    let address = bech32::encode::<bech32::Bech32>(bech32::Hrp::parse("cosmos")?, &[0x11; 32])?;
    let relayer = "cosmos1l3e9pgs3mmwuwrh95fecme0s0qtn2880f2jmfe";
    let message = HyperlaneMessage {
        version: 3,
        nonce: 4,
        origin: 1000,
        sender: H256::repeat_byte(0x44),
        destination: 2000,
        recipient: H256::repeat_byte(0x55),
        body: b"payload".to_vec(),
    };
    let mut tree = IncrementalMerkle::default();
    tree.ingest(message.id());
    let native_mailbox = native::QueryMailboxResponse {
        mailbox: Some(native::Mailbox {
            id: mailbox_id.clone(),
            owner: relayer.into(),
            message_sent: 5,
            message_received: 3,
            default_ism: ism_id.clone(),
            default_hook: hook_id.clone(),
            required_hook: hook_id.clone(),
            local_domain: 2000,
        }),
    };
    let tree_response = hook::QueryMerkleTreeHookResponse {
        merkle_tree_hook: Some(hook::WrappedMerkleTreeHookResponse {
            id: hook_id.clone(),
            owner: relayer.into(),
            mailbox_id: mailbox_id.clone(),
            merkle_tree: Some(hook::TreeResponse {
                leafs: tree
                    .branch()
                    .iter()
                    .map(|hash| hash.as_bytes().to_vec())
                    .collect(),
                count: tree.count() as u32,
                root: tree.root().as_bytes().to_vec(),
            }),
        }),
    };
    let native_ism = ism::MessageIdMultisigIsm {
        id: ism_id.clone(),
        owner: relayer.into(),
        validators: vec![hex([0x66; 20]), hex([0x77; 20])],
        threshold: 2,
    };
    let ism_response = ism::QueryIsmResponse {
        ism: Some(Any {
            type_url: ism::MessageIdMultisigIsm::type_url(),
            value: native_ism.encode_to_vec(),
        }),
    };
    let account = QueryAccountResponse {
        account: Some(Any {
            type_url: "/cosmos.auth.v1beta1.BaseAccount".into(),
            value: BaseAccount {
                address: relayer.into(),
                pub_key: None,
                account_number: 12,
                sequence: 7,
            }
            .encode_to_vec(),
        }),
    };
    let cw_nonce = hyperlane_cosmwasm_interface::core::mailbox::MailboxQueryMsg::Nonce {}.wrap();
    let cw_nonce_json = serde_json::to_vec(&cw_nonce)?;
    let smart_request = QuerySmartContractStateRequest {
        address: address.clone(),
        query_data: cw_nonce_json,
    };
    let smart_response = QuerySmartContractStateResponse {
        data: serde_json::to_vec(
            &hyperlane_cosmwasm_interface::core::mailbox::NonceResponse { nonce: 5 },
        )?,
    };
    let process = native::MsgProcessMessage {
        mailbox_id: format!("0x{mailbox_id}"),
        relayer: relayer.into(),
        metadata: hex([1, 2, 3]),
        message: hex(message.to_vec()),
    };
    let cw_process = hyperlane_cosmwasm_interface::core::mailbox::ExecuteMsg::Process {
        metadata: vec![1, 2, 3].into(),
        message: message.to_vec().into(),
    };
    let module_type = hyperlane_cosmwasm_interface::ism::ModuleTypeResponse {
        typ: hyperlane_cosmwasm_interface::ism::IsmType::MessageIdMultisig,
    };
    #[allow(deprecated)]
    let simulate_request = tx::SimulateRequest {
        tx: None,
        tx_bytes: vec![1, 2, 3],
    };
    let simulate_response = tx::SimulateResponse {
        gas_info: Some(cosmos_sdk_proto::cosmos::base::abci::v1beta1::GasInfo {
            gas_wanted: 0,
            gas_used: 123456,
        }),
        result: None,
    };
    let latest =
        cosmos_sdk_proto::cosmos::base::tendermint::v1beta1::GetLatestValidatorSetResponse {
            block_height: 200,
            validators: vec![],
            pagination: None,
        };
    let public_key = k256::ecdsa::SigningKey::from_slice(&[0x11; 32])?
        .verifying_key()
        .to_encoded_point(true)
        .as_bytes()
        .to_vec();
    let locations_request = ism::QueryAnnouncedStorageLocationsRequest {
        mailbox_id: mailbox_id.clone(),
        validator_address: "66".repeat(20),
    };
    let locations_response = ism::QueryAnnouncedStorageLocationsResponse {
        storage_locations: vec![
            "s3://fixture/region".into(),
            "https://example.invalid/checkpoints".into(),
        ],
    };
    let prepared_body = tx::TxBody {
        messages: vec![Any {
            type_url: "/test.Msg".into(),
            value: vec![8, 1],
        }],
        memo: "".into(),
        timeout_height: 200,
        extension_options: vec![],
        non_critical_extension_options: vec![],
    }
    .encode_to_vec();
    #[allow(deprecated)]
    let prepared_auth = tx::AuthInfo {
        signer_infos: vec![tx::SignerInfo {
            public_key: Some(Any {
                type_url: "/cosmos.crypto.secp256k1.PubKey".into(),
                value: cosmos_sdk_proto::cosmos::crypto::secp256k1::PubKey { key: public_key }
                    .encode_to_vec(),
            }),
            mode_info: Some(tx::ModeInfo {
                sum: Some(tx::mode_info::Sum::Single(tx::mode_info::Single {
                    mode: 1,
                })),
            }),
            sequence: 7,
        }],
        fee: Some(tx::Fee {
            amount: vec![Coin {
                denom: "uatom".into(),
                amount: "5000".into(),
            }],
            gas_limit: 200000,
            payer: "".into(),
            granter: "".into(),
        }),
        tip: None,
    }
    .encode_to_vec();
    let prepared_doc = tx::SignDoc {
        body_bytes: prepared_body.clone(),
        auth_info_bytes: prepared_auth.clone(),
        chain_id: "test-1".into(),
        account_number: 12,
    }
    .encode_to_vec();
    Ok(
        json!({"source":"hyperlane-cosmos-rs 0.1.4 + hyperlane-cosmwasm-interface 0.0.6-rc6 + cosmos-sdk-proto 0.26.1","mailbox_id":mailbox_id,"hook_id":hook_id,"ism_id":ism_id,"relayer":relayer,"address":address,"message":hex(message.to_vec()),"mailbox_request":hex(native::QueryMailboxRequest{id:mailbox_id.clone()}.encode_to_vec()),"mailbox_response":hex(native_mailbox.encode_to_vec()),"tree_request":hex(hook::QueryMerkleTreeHookRequest{id:hook_id}.encode_to_vec()),"tree_response":hex(tree_response.encode_to_vec()),"ism_request":hex(ism::QueryIsmRequest{id:ism_id}.encode_to_vec()),"ism_response":hex(ism_response.encode_to_vec()),"account_response":hex(account.encode_to_vec()),"smart_request":hex(smart_request.encode_to_vec()),"smart_response":hex(smart_response.encode_to_vec()),"native_process":hex(process.encode_to_vec()),"cw_process_json":serde_json::to_string(&cw_process)?,"module_type_json":serde_json::to_string(&module_type)?,"simulate_request":hex(simulate_request.encode_to_vec()),"simulate_response":hex(simulate_response.encode_to_vec()),"latest_response":hex(latest.encode_to_vec()),"locations_request":hex(locations_request.encode_to_vec()),"locations_response":hex(locations_response.encode_to_vec()),"prepared_body":hex(prepared_body),"prepared_auth":hex(prepared_auth),"prepared_doc":hex(prepared_doc)}),
    )
}

fn compiler_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    let mut seed = 0x526574687a696767u64;
    fn random(seed: &mut u64) -> u64 {
        *seed ^= *seed << 13;
        *seed ^= *seed >> 7;
        *seed ^= *seed << 17;
        *seed
    }
    let pk = |byte| Address::new_from_array([byte; 32]);
    let mut cases = vec![];
    for index in 0..128 {
        let mut input_instructions = vec![];
        let mut instructions = vec![];
        let instruction_count = if index == 0 {
            0
        } else {
            1 + (random(&mut seed) % 5) as usize
        };
        for position in 0..instruction_count {
            let nonce = index % 11 == 0 && position == 0;
            let program = if nonce { 0 } else { 200 + position as u8 };
            let account_count = if nonce {
                2
            } else {
                (random(&mut seed) % 12) as usize
            };
            let mut input_accounts = vec![];
            let mut accounts = vec![];
            for account in 0..account_count {
                let key = if nonce && account == 0 {
                    1
                } else {
                    1 + (random(&mut seed) % 14) as u8
                };
                let signer = random(&mut seed).is_multiple_of(4);
                let writable = nonce && account == 0 || random(&mut seed).is_multiple_of(2);
                input_accounts.push(json!({"key":key,"is_signer":signer,"is_writable":writable}));
                accounts.push(AccountMeta {
                    pubkey: pk(key),
                    is_signer: signer,
                    is_writable: writable,
                });
            }
            let data = if nonce {
                vec![4, 0, 0, 0, 99]
            } else {
                (0..random(&mut seed) % 137)
                    .map(|_| random(&mut seed) as u8)
                    .collect::<Vec<_>>()
            };
            input_instructions
                .push(json!({"program":program,"accounts":input_accounts,"data":hex(&data)}));
            instructions.push(Instruction {
                program_id: pk(program),
                accounts,
                data,
            });
        }
        let mut input_tables = vec![];
        let mut tables = vec![];
        for table_index in 0..3 {
            let mut addresses = vec![50, 200, 201, 202, 203, 204];
            for _ in 0..18 {
                addresses.push(1 + (random(&mut seed) % 14) as u8);
            }
            if index % 7 == 0 && table_index == 0 {
                addresses.clear();
            }
            let key = 220 + table_index;
            input_tables.push(json!({"key":key,"addresses":addresses}));
            tables.push(solana_message::AddressLookupTableAccount {
                key: pk(key),
                addresses: addresses.into_iter().map(pk).collect(),
            });
        }
        let blockhash = solana_hash::Hash::new_from_array([70; 32]);
        let legacy =
            SolanaMessage::new_with_blockhash(&instructions, Some(&pk(50)), &blockhash).serialize();
        let v0 =
            solana_message::v0::Message::try_compile(&pk(50), &instructions, &tables, blockhash)?
                .serialize();
        cases.push(json!({"case":index,"payer":50,"blockhash":70,"instructions":input_instructions,"tables":input_tables,"legacy":hex(legacy),"v0":hex(v0)}));
    }
    Ok(
        json!({"source":"Pinned Rust Solana SDK 3.0.1 compiler oracle","seed":"0x526574687a696767","cases":cases}),
    )
}

fn sealevel_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use account_utils::SizedData;
    use hyperlane_core::{
        accumulator::incremental::IncrementalMerkle, Encode, HyperlaneMessage, H256,
    };
    use hyperlane_sealevel_igp::accounts::{GasPayment, GasPaymentData};
    use hyperlane_sealevel_interchain_security_module_interface::{
        MetadataSpec, MetadataSpecResult,
    };
    use hyperlane_sealevel_mailbox::{
        accounts::*,
        instruction::{InboxProcess, Instruction},
        protocol_fee::ProtocolFee,
    };
    use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
    fn account<T: account_utils::Data + SizedData>(
        data: T,
    ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
        let account = account_utils::AccountData::from(data);
        let mut out = vec![0; account.size()];
        account.store_in_slice(&mut out)?;
        Ok(out)
    }
    let pk = |byte| solana_message::Address::new_from_array([byte; 32]);
    let message = HyperlaneMessage {
        version: 3,
        nonce: 4,
        origin: 1000,
        sender: H256::repeat_byte(0x11),
        destination: 2000,
        recipient: H256::repeat_byte(0x22),
        body: b"body".to_vec(),
    };
    let raw_message = message.to_vec();
    let mut tree = IncrementalMerkle::default();
    tree.ingest(message.id());
    let inbox = account(Inbox {
        local_domain: 2000,
        inbox_bump_seed: 255,
        default_ism: pk(2),
        processed_count: 7,
    })?;
    let outbox = account(Outbox {
        local_domain: 1000,
        outbox_bump_seed: 254,
        owner: Some(pk(3)),
        tree,
        max_protocol_fee: 100,
        protocol_fee: ProtocolFee {
            fee: 5,
            beneficiary: pk(4),
        },
    })?;
    let dispatched = account(DispatchedMessage::new(4, 20, pk(5), raw_message.clone()))?;
    let processed = account(ProcessedMessage::new(7, message.id(), 21))?;
    let payment = GasPayment::from(GasPaymentData {
        sequence_number: 3,
        igp: pk(6),
        destination_domain: 2000,
        message_id: message.id(),
        gas_amount: 150000,
        payment: 90000,
        unique_gas_payment_pubkey: pk(7),
        slot: 22,
    });
    let gas_payment = account(payment)?;
    let process = Instruction::InboxProcess(InboxProcess {
        metadata: vec![1, 2, 3],
        message: raw_message,
    })
    .into_instruction_data()?;
    let metas = SimulationReturnData::new(vec![
        SerializableAccountMeta {
            pubkey: pk(8),
            is_signer: true,
            is_writable: false,
        },
        SerializableAccountMeta {
            pubkey: pk(9),
            is_signer: false,
            is_writable: true,
        },
    ]);
    let spec = SimulationReturnData::new(MetadataSpecResult {
        spec: Some(MetadataSpec::Aggregation {
            threshold: 1,
            sub_specs: vec![MetadataSpec::Null, MetadataSpec::CannotVerify],
        }),
        accounts: vec![],
    });
    Ok(
        json!({"inbox":hex(inbox),"outbox":hex(outbox),"dispatched":hex(dispatched),"processed":hex(processed),"gas_payment":hex(gas_payment),"process_data":hex(process),"account_metas":hex(borsh::to_vec(&metas)?),"metadata_spec":hex(borsh::to_vec(&spec)?),"message_id":hex(message.id().as_bytes())}),
    )
}

fn prost_types_compat(value: &[u8]) -> tron_rs::prost_types::Any {
    tron_rs::prost_types::Any {
        type_url: "/protocol.TriggerSmartContract".into(),
        value: value.to_vec(),
    }
}

fn announcement_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use hyperlane_cosmos_rs::hyperlane::core::interchain_security::v1::MsgAnnounceValidator;
    use hyperlane_sealevel_validator_announce::{
        accounts::{ValidatorStorageLocations, ValidatorStorageLocationsAccount},
        instruction::{AnnounceInstruction, Instruction as Announce},
    };
    let program = Address::from([3u8; 32]);
    let validator = hyperlane_core::H160::from([5u8; 20]);
    let location = "s3://fixture/region";
    let signature = vec![6u8; 65];
    let announcement = AnnounceInstruction {
        validator,
        storage_location: location.into(),
        signature: signature.clone(),
    };
    let replay = announcement.replay_id();
    let (state, state_bump) = Address::find_program_address(
        &[b"hyperlane_validator_announce", b"-", b"validator_announce"],
        &program,
    );
    let (storage, storage_bump) = Address::find_program_address(
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"storage_locations",
            b"-",
            validator.as_bytes(),
        ],
        &program,
    );
    let (replay_key, replay_bump) = Address::find_program_address(
        &[
            b"hyperlane_validator_announce",
            b"-",
            b"replay_protection",
            b"-",
            &replay,
        ],
        &program,
    );
    let account = ValidatorStorageLocationsAccount::from(ValidatorStorageLocations {
        bump_seed: storage_bump,
        storage_locations: vec![location.into(), "gs://fixture/folder".into()],
    });
    use account_utils::SizedData;
    let mut account_bytes = vec![0u8; account.size()];
    account.store_in_slice(&mut account_bytes)?;
    let creator = "cosmos1l3e9pgs3mmwuwrh95fecme0s0qtn2880f2jmfe";
    let native = MsgAnnounceValidator {
        validator: hex(validator.as_bytes()),
        storage_location: location.into(),
        signature: hex(&signature),
        mailbox_id: format!("0x{}", hex([2u8; 32])),
        creator: creator.into(),
    };
    let request = source_announcement::validator_announce::AnnouncementRequest {
        announce: source_announcement::validator_announce::AnnouncementRequestInner {
            validator: hex(validator.as_bytes()),
            storage_location: location.into(),
            signature: hex(&signature),
        },
    };
    let cw = cosmos_sdk_proto::cosmwasm::wasm::v1::MsgExecuteContract {
        sender: creator.into(),
        contract: creator.into(),
        msg: serde_json::to_vec(&request)?,
        funds: vec![],
    };
    Ok(
        json!({"source":"actual production Sealevel ValidatorAnnounce Borsh; hyperlane-cosmos-rs0.1.4; cosmos-sdk-proto0.26.1", "location":location,"creator":creator,"validator":hex(validator.as_bytes()),"signature":hex(&signature),"svm_instruction":hex(Announce::Announce(announcement).into_instruction_data()?),"svm_account":hex(&account_bytes),"state":hex(state.as_ref()),"state_bump":state_bump,"storage":hex(storage.as_ref()),"storage_bump":storage_bump,"replay_id":hex(replay),"replay":hex(replay_key.as_ref()),"replay_bump":replay_bump,"native":hex(native.encode_to_vec()),"cw":hex(cw.encode_to_vec())}),
    )
}

#[allow(dead_code)]
mod source_announcement {
    mod general {
        #[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
        pub struct EmptyStruct {}
    }
    pub mod validator_announce {
        include!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../../../rust/main/chains/hyperlane-cosmos/src/cw/payloads/validator_announce.rs"
        ));
    }
}

fn svm_destination_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use solana_compute_budget_interface::ComputeBudgetInstruction;
    let signing = ed25519_dalek::SigningKey::from_bytes(&[7; 32]);
    let payer = Address::new_from_array(signing.verifying_key().to_bytes());
    let process = Instruction {
        program_id: Address::new_from_array([9; 32]),
        accounts: vec![
            AccountMeta::new(payer, true),
            AccountMeta::new(Address::new_from_array([1; 32]), false),
        ],
        data: b"test".to_vec(),
    };
    let tip = "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh".parse()?;
    let mut cases = vec![];
    for jito in [false, true] {
        for versioned in [false, true] {
            for (units, price) in [(110_000u32, 330u64), (1_400_000, u64::MAX)] {
                let fee = if jito {
                    solana_system_interface::instruction::transfer(
                        &payer,
                        &tip,
                        (u64::from(units).saturating_mul(price) / 1_000_000).max(1000),
                    )
                } else {
                    ComputeBudgetInstruction::set_compute_unit_price(price)
                };
                let instructions = [
                    ComputeBudgetInstruction::set_compute_unit_limit(units),
                    fee,
                    process.clone(),
                ];
                let hash = solana_hash::Hash::new_from_array([8; 32]);
                let message = if versioned {
                    solana_message::v0::Message::try_compile(
                        &payer,
                        &instructions,
                        &[solana_message::AddressLookupTableAccount {
                            key: Address::new_from_array([6; 32]),
                            addresses: vec![Address::new_from_array([1; 32])],
                        }],
                        hash,
                    )?
                    .serialize()
                } else {
                    SolanaMessage::new_with_blockhash(&instructions, Some(&payer), &hash)
                        .serialize()
                };
                let mut wire = vec![1];
                wire.extend(signing.sign(&message).to_bytes());
                wire.extend(&message);
                cases.push(json!({"jito":jito,"versioned":versioned,"units":units,"price":price.to_string(),"message":hex(&message),"wire":hex(wire)}));
            }
        }
    }
    Ok(
        json!({"source":"solana-compute-budget-interface3.0.0+solana-system-interface2.0.0+solana-message3.0.1","cases":cases}),
    )
}

fn svm_ism_fixtures() -> Result<serde_json::Value, Box<dyn std::error::Error>> {
    use hyperlane_core::{Encode, HyperlaneMessage, H160};
    use hyperlane_sealevel_composite_ism::{
        accounts::derive_domain_pda, instruction::verify_metadata_spec_instruction,
    };
    use hyperlane_sealevel_interchain_security_module_interface::{
        MetadataSpec, MetadataSpecResult,
    };
    use multisig_ism::{interface::MultisigIsmInstruction, ValidatorsAndThreshold};
    use serializable_account_meta::{SerializableAccountMeta, SimulationReturnData};
    let program = Address::from([9u8; 32]);
    let message = HyperlaneMessage {
        origin: 1000,
        destination: 2000,
        body: b"body".to_vec(),
        ..Default::default()
    };
    let (domain, bump) = derive_domain_pda(&program, message.origin);
    let spec_ix = verify_metadata_spec_instruction(program, message.to_vec(), vec![domain])?;
    let getter =
        MultisigIsmInstruction::ValidatorsAndThresholdAccountMetas(message.to_vec()).encode()?;
    let validators_ix =
        MultisigIsmInstruction::ValidatorsAndThreshold(message.to_vec()).encode()?;
    let validators = SimulationReturnData::new(ValidatorsAndThreshold {
        validators: vec![H160::repeat_byte(1), H160::repeat_byte(2)],
        threshold: 1,
    });
    let metas = SimulationReturnData::new(vec![SerializableAccountMeta {
        pubkey: domain,
        is_signer: false,
        is_writable: false,
    }]);
    let spec = SimulationReturnData::new(MetadataSpecResult {
        spec: Some(MetadataSpec::Aggregation {
            threshold: 1,
            sub_specs: vec![
                MetadataSpec::Null,
                MetadataSpec::TrustedRelayer {
                    relayer: Address::from([4; 32]),
                },
                MetadataSpec::MultisigMessageId {
                    validators: vec![H160::repeat_byte(1), H160::repeat_byte(2)],
                    threshold: 1,
                },
                MetadataSpec::CannotVerify,
            ],
        }),
        accounts: vec![],
    });
    let again = SimulationReturnData::new(MetadataSpecResult {
        spec: None,
        accounts: vec![spec_ix.accounts[0].pubkey, domain],
    });
    Ok(
        json!({"source":"actual production composite-ism and multisig-ism instructions/Borsh", "domain":hex(domain.to_bytes()),"domain_bump":bump,"message":hex(message.to_vec()),"spec_ix":hex(spec_ix.data),"spec_metas":spec_ix.accounts.iter().map(|m|json!({"key":hex(m.pubkey.to_bytes()),"signer":m.is_signer,"writable":m.is_writable})).collect::<Vec<_>>(),"getter_ix":hex(getter),"validators_ix":hex(validators_ix),"validators":hex(borsh::to_vec(&validators)?),"metas":hex(borsh::to_vec(&metas)?),"spec":hex(borsh::to_vec(&spec)?),"again":hex(borsh::to_vec(&again)?)}),
    )
}
