use corelib::user::deposit::deposit_with_payload;
use corelib::wallet::get_wallet;
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::network::NetworkId;
use kaspa_wallet_keys::secret::Secret;

pub struct DepositArgs {
    pub wallet_secret: String,
    pub wallet_dir: Option<String>,
    pub amount: String,
    pub payload: String,
    pub escrow_address: String,
    pub network_id: NetworkId,
    pub rpc_url: String,
}

pub async fn do_deposit(args: DepositArgs) -> Result<()> {
    let s = Secret::from(args.wallet_secret);
    let w = get_wallet(&s, args.network_id, args.rpc_url, args.wallet_dir).await?;
    let a = Address::try_from(args.escrow_address)?;
    let amt = args.amount.parse::<u64>().unwrap();
    // TODO: check amt and payload

    let payload = match args.payload.is_empty() {
        true => vec![],
        false => hex::decode(&args.payload)?,
    };

    let res = deposit_with_payload(&w, &s, a, amt, payload);

    println!("Deposit sent: {:?}", res.await);

    Ok(())
}
