//! Independent transaction oracle using the production ethers fork and RLP implementation.
use ethers_core::types::{
    transaction::{
        eip1559::Eip1559TransactionRequest,
        eip2718::TypedTransaction,
        eip2930::{AccessList, AccessListItem},
    },
    Bytes, NameOrAddress, Signature, TransactionRequest, H160, H256, U256, U64,
};
use k256::ecdsa::SigningKey;
use serde_json::Value;
use std::{
    error::Error,
    io::{self, BufRead},
};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

fn text(value: &Value) -> Result<String> {
    if let Some(value) = value.as_str() {
        return Ok(value.into());
    }
    if let Some(parts) = value.as_array() {
        return parts
            .iter()
            .map(|part| Ok(part.as_str().ok_or("expected string chunk")?.to_owned()))
            .collect();
    }
    Err("expected string or string chunks".into())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn chunks(bytes: &[u8]) -> Vec<String> {
    hex(bytes)
        .as_bytes()
        .chunks(32)
        .map(|part| String::from_utf8_lossy(part).into_owned())
        .collect()
}

fn bytes(value: &Value) -> Result<Vec<u8>> {
    let value = text(value)?;
    let value = value.strip_prefix("0x").unwrap_or(&value);
    if value.len() % 2 != 0 {
        return Err("odd byte encoding".into());
    }
    (0..value.len())
        .step_by(2)
        .map(|i| Ok(u8::from_str_radix(&value[i..i + 2], 16)?))
        .collect()
}

fn quantity(value: &Value) -> Result<U256> {
    let value = text(value)?;
    Ok(if let Some(value) = value.strip_prefix("0x") {
        U256::from_str_radix(value, 16)?
    } else {
        U256::from_dec_str(&value)?
    })
}

fn oracle(input: Value) -> Result<Value> {
    if input["operation"].as_str() == Some("public_fixture_kms") {
        use k256::pkcs8::EncodePublicKey;
        let key = SigningKey::from_slice(&[0x11; 32])?;
        let public = k256::PublicKey::from_sec1_bytes(
            key.verifying_key().to_encoded_point(false).as_bytes(),
        )?
        .to_public_key_der()?;
        let digest = bytes(&input["digest"])?;
        let (signature, _) = key.sign_prehash_recoverable(&digest)?;
        return Ok(
            serde_json::json!({"expected":{"public_key_der":chunks(public.as_bytes()),"signature_der":chunks(signature.to_der().as_bytes())}}),
        );
    }
    if input["operation"].as_str() == Some("recover") {
        let digest = bytes(&input["digest"])?;
        let r = bytes(&input["r"])?;
        let s = bytes(&input["s"])?;
        if digest.len() != 32 || r.len() != 32 || s.len() != 32 {
            return Err("expected fixed-size recovery fields".into());
        }
        let v = quantity(&input["v"])?;
        if v > U256::from(u64::MAX) {
            return Err("v exceeds u64".into());
        }
        let signature = Signature {
            r: U256::from_big_endian(&r),
            s: U256::from_big_endian(&s),
            v: v.as_u64(),
        };
        let recovered = signature
            .recover(H256::from_slice(&digest))
            .ok()
            .map(|address| hex(address.as_bytes()));
        return Ok(serde_json::json!({"input":input,"expected":{"signer":recovered}}));
    }
    let chain = if input["chain_id"].is_null() {
        None
    } else {
        Some(quantity(&input["chain_id"])?)
    };
    if chain.is_some_and(|chain| chain > U256::from(u64::MAX / 2 - 35)) {
        return Err("fixture chain ID outside ethers u64 domain".into());
    }
    let chain = chain.map(|value| U64::from(value.as_u64()));
    let to = if input["to"].is_null() {
        None
    } else {
        let address = bytes(&input["to"])?;
        if address.len() != 20 {
            return Err("expected 20-byte recipient".into());
        }
        Some(NameOrAddress::Address(H160::from_slice(&address)))
    };
    let nonce = Some(quantity(&input["nonce"])?);
    let gas = Some(quantity(&input["gas_limit"])?);
    let value = Some(quantity(&input["value"])?);
    let data = Some(Bytes::from(bytes(&input["data"])?));
    let tx: TypedTransaction = match input["type"].as_str() {
        Some("legacy") => TransactionRequest {
            from: None,
            to,
            gas,
            gas_price: Some(quantity(&input["gas_price"])?),
            value,
            data,
            nonce,
            chain_id: chain,
        }
        .into(),
        Some("eip1559") => {
            let items = input["access_list"]
                .as_array()
                .ok_or("access_list must be array")?;
            let access_list = AccessList(
                items
                    .iter()
                    .map(|item| {
                        let address = bytes(&item["address"])?;
                        if address.len() != 20 {
                            return Err("expected 20-byte access-list address".into());
                        }
                        let keys = item["storage_keys"]
                            .as_array()
                            .ok_or("storage_keys must be array")?;
                        let storage_keys = keys
                            .iter()
                            .map(|key| {
                                let key = bytes(key)?;
                                if key.len() != 32 {
                                    return Err("expected 32-byte storage key".into());
                                }
                                Ok(H256::from_slice(&key))
                            })
                            .collect::<Result<_>>()?;
                        Ok(AccessListItem {
                            address: H160::from_slice(&address),
                            storage_keys,
                        })
                    })
                    .collect::<Result<_>>()?,
            );
            Eip1559TransactionRequest {
                from: None,
                to,
                gas,
                value,
                data,
                nonce,
                access_list,
                max_priority_fee_per_gas: Some(quantity(&input["max_priority_fee_per_gas"])?),
                max_fee_per_gas: Some(quantity(&input["max_fee_per_gas"])?),
                chain_id: chain,
            }
            .into()
        }
        _ => return Err("unknown transaction type".into()),
    };
    let signing_hash = tx.sighash();
    // Public fixture key only; fixed key keeps the oracle deterministic.
    let key = SigningKey::from_bytes((&[0x11; 32]).into())?;
    let (signature, recovery) = key.sign_prehash_recoverable(signing_hash.as_bytes())?;
    if recovery.to_byte() > 1 {
        return Err("unrepresentable Ethereum recovery ID".into());
    }
    let mut canonical = signature.to_bytes().to_vec();
    canonical.push(27 + recovery.to_byte());
    let v = if matches!(tx, TypedTransaction::Legacy(_)) {
        match chain {
            Some(chain) => 35 + 2 * chain.as_u64() + u64::from(recovery.to_byte()),
            None => 27 + u64::from(recovery.to_byte()),
        }
    } else {
        u64::from(recovery.to_byte())
    };
    let signature = Signature {
        r: U256::from_big_endian(&canonical[..32]),
        s: U256::from_big_endian(&canonical[32..64]),
        v,
    };
    let signed = tx.rlp_signed(&signature);
    let signer = signature.recover(signing_hash)?;
    Ok(
        serde_json::json!({"input":input,"expected":{"unsigned":chunks(&tx.rlp()),"signing_hash":chunks(signing_hash.as_bytes()),"signature":chunks(&canonical),"signed":chunks(&signed),"hash":chunks(tx.hash(&signature).as_bytes()),"signer":hex(signer.as_bytes())}}),
    )
}

fn main() -> Result<()> {
    for line in io::stdin().lock().lines() {
        let input = serde_json::from_str(&line?)?;
        println!("{}", oracle(input)?);
    }
    Ok(())
}
