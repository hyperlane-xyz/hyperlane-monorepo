extern crate ethers_core;
extern crate serde_json;

use ethers_core::k256::ecdsa::{
    recoverable::Signature as RecoverableSignature,
    signature::{hazmat::PrehashSigner, Signature as _},
    Signature as EcdsaSignature, SigningKey,
};
use ethers_core::types::{
    transaction::{
        eip2718::TypedTransaction,
        eip2930::{AccessList, AccessListItem, Eip2930TransactionRequest},
    },
    Bytes, NameOrAddress, Signature, TransactionRequest, H160, H256, U256, U64,
};
use serde_json::{json, Value};
use std::error::Error;

fn hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn vector(tx: Eip2930TransactionRequest, key: &SigningKey) -> Result<Value, Box<dyn Error>> {
    let tx = TypedTransaction::Eip2930(tx);
    let unsigned = tx.rlp();
    let signing_hash = tx.sighash();
    let recoverable: RecoverableSignature = key.sign_prehash(signing_hash.as_bytes())?;
    let mut recovery = u8::from(recoverable.recovery_id());
    let mut canonical = recoverable.as_ref()[..64].to_vec();
    if let Some(normalized) = EcdsaSignature::from_bytes(&canonical)?.normalize_s() {
        canonical[32..64].copy_from_slice(normalized.as_ref());
        recovery ^= 1;
    }
    canonical.push(27 + recovery);
    assert!(EcdsaSignature::from_bytes(&canonical[..64])?
        .normalize_s()
        .is_none());
    let signature = Signature {
        r: U256::from_big_endian(&canonical[..32]),
        s: U256::from_big_endian(&canonical[32..64]),
        v: u64::from(recovery),
    };
    let signed = tx.rlp_signed(&signature);
    let signer = Signature {
        v: 27 + signature.v,
        ..signature
    }
    .recover(signing_hash)?;
    Ok(json!({
        "unsigned": hex(&unsigned),
        "signing_hash": hex(signing_hash.as_bytes()),
        "signature": hex(&canonical),
        "signed": hex(&signed),
        "hash": hex(tx.hash(&signature).as_bytes()),
        "signer": hex(signer.as_bytes()),
    }))
}

fn request(
    chain_id: u64,
    nonce: u64,
    gas_price: u64,
    gas_limit: u64,
    to: Option<H160>,
    value: u64,
    data: Vec<u8>,
    access_list: Vec<AccessListItem>,
) -> Eip2930TransactionRequest {
    TransactionRequest {
        from: None,
        to: to.map(NameOrAddress::Address),
        gas: Some(gas_limit.into()),
        gas_price: Some(gas_price.into()),
        value: Some(value.into()),
        data: Some(Bytes::from(data)),
        nonce: Some(nonce.into()),
        chain_id: Some(U64::from(chain_id)),
    }
    .with_access_list(AccessList(access_list))
}

fn main() -> Result<(), Box<dyn Error>> {
    let key = SigningKey::from_bytes(&[0x46; 32])?;
    let populated = request(
        1,
        9,
        20_000_000_000,
        60_000,
        Some(H160::repeat_byte(0x35)),
        1_000_000_000_000_000_000,
        (0..60).collect(),
        vec![
            AccessListItem {
                address: H160::repeat_byte(0x11),
                storage_keys: vec![H256::repeat_byte(0x22), H256::repeat_byte(0x33)],
            },
            AccessListItem {
                address: H160::repeat_byte(0x44),
                storage_keys: vec![],
            },
        ],
    );
    let contract_creation = request(5, 0, 1, 53_000, None, 0, vec![], vec![]);
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "populated": vector(populated, &key)?,
            "contract_creation": vector(contract_creation, &key)?,
        }))?
    );
    Ok(())
}
