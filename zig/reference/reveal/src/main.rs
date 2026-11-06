//! Exact production function bodies with only RPC/account and RevealContext fixture adapters.
use eyre::{bail, eyre, Result};
use hyperlane_core::{Signable, H160, H256};
use serde::Deserialize;
use serde_json::{json, Value};
use solana_commitment_config::CommitmentConfig;
use solana_sdk::{
    hash::Hash,
    instruction::{AccountMeta, Instruction},
    message::Message,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};
use std::{
    io::{self, BufRead},
    str::FromStr,
};
use tracing::{debug, warn};
struct SealevelFallbackRpcClient {
    data: Option<Vec<u8>>,
}
struct FixtureAccount {
    data: Vec<u8>,
}
impl SealevelFallbackRpcClient {
    async fn get_account_option_with_commitment(
        &self,
        _key: Pubkey,
        _commitment: CommitmentConfig,
    ) -> Result<Option<FixtureAccount>> {
        Ok(self.data.clone().map(|data| FixtureAccount { data }))
    }
}
struct RevealContext<'a> {
    program_id: Pubkey,
    commitment: [u8; 32],
    origin: u32,
    sender: [u8; 32],
    user_salt: [u8; 32],
    recipient: [u8; 32],
    rpc_client: &'a SealevelFallbackRpcClient,
    fee_payer: &'a Keypair,
}
include!(concat!(env!("OUT_DIR"), "/production.rs"));
fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(text).collect(),
        _ => panic!("expected chunks or string"),
    }
}
fn bytes(v: &Value) -> Vec<u8> {
    hex::decode(text(v).trim_start_matches("0x")).unwrap()
}
fn key(v: &Value) -> Pubkey {
    Pubkey::new_from_array(bytes(v).try_into().unwrap())
}
fn fixed(v: &Value) -> [u8; 32] {
    bytes(v).try_into().unwrap()
}
fn chunk(v: &[u8]) -> Value {
    let s = hex::encode(v);
    json!(s
        .as_bytes()
        .chunks(32)
        .map(|v| std::str::from_utf8(v).unwrap())
        .collect::<Vec<_>>())
}
fn instruction(v: &Instruction) -> Value {
    json!({"program_id":chunk(v.program_id.as_ref()),"data":chunk(&v.data),"accounts":v.accounts.iter().map(|a|json!({"pubkey":chunk(a.pubkey.as_ref()),"is_signer":a.is_signer,"is_writable":a.is_writable})).collect::<Vec<_>>()})
}
fn number(v: &Value) -> u32 {
    text(v).parse().unwrap()
}
struct Eip191(H256);
impl Signable for Eip191 {
    fn signing_hash(&self) -> H256 {
        self.0
    }
}
#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    for line in io::stdin().lock().lines() {
        let case: Value = serde_json::from_str(&line?)?;
        let v = &case["input"];
        let kind = case["kind"].as_str().unwrap();
        let result:Result<Value>=async{Ok(match kind{
"tick"=>{let current:i32=text(&v["current"]).parse()?;let spacing:i16=text(&v["spacing"]).parse()?;let start=get_tick_array_start_index(current,spacing)?;json!({"start":start.to_string(),"address":chunk(compute_tick_array_address(&key(&v["pool"]),start).as_ref())})},
"pda"=>{let p=key(&v["program"]);let origin=number(&v["origin"]);let sender=fixed(&v["sender"]);let user=fixed(&v["user_salt"]);let commitment=fixed(&v["commitment"]);json!({"pending":chunk(derive_pending_swap_pda(&p,origin,&sender,&user,&commitment).as_ref()),"fee_payer":chunk(derive_fee_payer_pda(&p).as_ref()),"ata":chunk(derive_ata(&key(&v["owner"]),&key(&v["mint"]),&key(&v["token_program"])).as_ref())})},
"ccs"=>{use k256::ecdsa::SigningKey;let secret=SigningKey::from_bytes((&[0x11u8;32]).into())?;let sender=H160::from_slice(&bytes(&v["sender"]));let pre=hyperlane_core::offchain_lookup::offchain_lookup_request_message_hash(sender,&bytes(&v["commitment"]),text(&v["url"]).as_bytes());let digest=Eip191(pre).eth_signed_message_hash();let(sig,recovery)=secret.sign_prehash_recoverable(digest.as_bytes())?;let mut wire=sig.to_bytes().to_vec();wire.push(recovery.to_byte()+27);json!({"signing_hash":chunk(pre.as_bytes()),"digest":chunk(digest.as_bytes()),"signature":chunk(&wire)})},
"build"|"close"=>{let payer=Keypair::new_from_array([7;32]);let rpc=SealevelFallbackRpcClient{data:if v["pool_data"].is_null(){None}else{Some(bytes(&v["pool_data"]))}};let salt=fixed(&v["salt"]);let data=bytes(&v["data"]);let commitment=solana_program::keccak::hashv(&[&salt,&data]).to_bytes();let ctx=RevealContext{program_id:key(&v["program"]),commitment,origin:number(&v["origin"]),sender:fixed(&v["sender"]),user_salt:fixed(&v["user_salt"]),recipient:fixed(&v["recipient"]),rpc_client:&rpc,fee_payer:&payer};let accounts=v["accounts"].as_array().unwrap().iter().map(|a|CcsRevealAccount{pubkey:key(&a["pubkey"]).to_string(),is_signer:a["is_signer"].as_bool().unwrap(),is_writable:a["is_writable"].as_bool().unwrap()}).collect();let ccs=CcsGetResponse{data:hex::encode(data),salt:hex::encode(salt),reveal_accounts:Some(accounts)};let(built,close)=build_instruction(&ctx,&ccs).await?;let ixs=if kind=="close"{let c=close.ok_or_else(||eyre!("no close accounts"))?;make_close_pending_swap_ixs(ctx.program_id,ctx.origin,ctx.sender,ctx.user_salt,ctx.commitment,derive_pending_swap_pda(&ctx.program_id,ctx.origin,&ctx.sender,&ctx.user_salt,&ctx.commitment),payer.pubkey(),c.input_token_prog,c.input_mint,Pubkey::new_from_array(ctx.recipient))}else{built};let units=if kind=="close"{200000}else{600000};let mut compiled=vec![solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_limit(units),solana_compute_budget_interface::ComputeBudgetInstruction::set_compute_unit_price(0)];compiled.extend(ixs.clone());let message=Message::new_with_blockhash(&compiled,Some(&payer.pubkey()),&Hash::new_from_array([8;32]));let transaction=Transaction::new(&[&payer],message.clone(),Hash::new_from_array([8;32]));json!({"commitment":chunk(&commitment),"payer":chunk(payer.pubkey().as_ref()),"instructions":ixs.iter().map(instruction).collect::<Vec<_>>(),"message":chunk(&message.serialize()),"signed_transaction":chunk(&bincode::serialize(&transaction)?),"signature":chunk(transaction.signatures[0].as_ref()),"compute_units":units.to_string()})},
_=>bail!("unknown fixture kind")})}.await;
        match result {
            Ok(expected) => println!(
                "{}",
                json!({"kind":case["kind"],"name":case["name"],"input":v,"expected":expected})
            ),
            Err(error) => println!(
                "{}",
                json!({"kind":case["kind"],"name":case["name"],"input":v,"expected":{"error":error.to_string()}})
            ),
        }
    }
    Ok(())
}
