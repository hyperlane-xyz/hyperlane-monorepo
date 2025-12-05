use super::hub_whale_pool::HubWhale;
use super::kaspa_whale_pool::KaspaWhale;
use super::key_cosmos::EasyHubKey;
use super::key_kaspa::get_kaspa_keypair;
use super::stats::RoundTripStats;
use crate::x;
use cometbft_rpc::endpoint::broadcast::tx_commit::Response as HubResponse;
use corelib::api::client::HttpClient;
use dymension_kaspa::kas_bridge::user::payload::make_deposit_payload_easy;
use corelib::wallet::Network;
use cosmos_sdk_proto::cosmos::bank::v1beta1::MsgSend;
use cosmos_sdk_proto::cosmos::base::v1beta1::Coin;
use cosmrs::Any;
use eyre::Result;
use hex::ToHex;
use hyperlane_core::H256;
use hyperlane_core::U256;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use hyperlane_cosmos_rs::hyperlane::warp::v1::MsgRemoteTransfer;
use hyperlane_cosmos_rs::prost::{Message, Name};
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use tracing::error;
use tracing::info;
use tracing::warn;

const MAX_RETRIES: usize = 3;
const RETRY_DELAY_MS: u64 = 2000;
const HUB_FUND_AMOUNT: u64 = 50_000_000_000_000_000; // 0.05 dym to pay gas

fn now_millis() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis()
}

fn is_retryable(error: &eyre::Error) -> bool {
    let err_str = error.to_string().to_lowercase();
    err_str.contains("account sequence mismatch")
}

async fn retry_with_backoff<F, Fut, T>(operation_name: &str, task_id: u64, mut f: F) -> Result<T>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut last_error = None;

    for attempt in 1..=MAX_RETRIES {
        match f().await {
            Ok(result) => {
                if attempt > 1 {
                    info!(
                        "{}: succeeded after {} attempts: task_id={}",
                        operation_name, attempt, task_id
                    );
                }
                return Ok(result);
            }
            Err(e) => {
                if is_retryable(&e) && attempt < MAX_RETRIES {
                    warn!(
                        "{} failed (attempt {}/{}): task_id={} error={:?}",
                        operation_name, attempt, MAX_RETRIES, task_id, e
                    );
                    tokio::time::sleep(Duration::from_millis(RETRY_DELAY_MS)).await;
                    last_error = Some(e);
                } else {
                    return Err(e);
                }
            }
        }
    }

    Err(last_error
        .unwrap_or_else(|| eyre::eyre!("{} failed after {} retries", operation_name, MAX_RETRIES)))
}

async fn fund_hub_addr(hub_key: &EasyHubKey, hub_whale: &HubWhale, amount: u64) -> Result<()> {
    let _lock = hub_whale.lock_for_tx().await;
    let hub_addr = hub_key.signer().address_string.clone();
    debug!("funding hub address: addr={} amount={}", hub_addr, amount);
    let rpc = hub_whale.provider.rpc();
    let msg = MsgSend {
        from_address: rpc.get_signer()?.address_string.clone(),
        to_address: hub_addr.clone(),
        amount: vec![Coin {
            amount: amount.to_string(),
            denom: "adym".to_string(),
        }],
    };
    let a = Any {
        type_url: "/cosmos.bank.v1beta1.MsgSend".to_string(),
        value: msg.encode_to_vec(),
    };
    let gas_limit = None;
    let response = rpc.send(vec![a], gas_limit).await?;
    if !response.tx_result.code.is_ok() || !response.check_tx.code.is_ok() {
        return Err(eyre::eyre!(
            "funding failed: tx_result_code={:?} check_tx_code={:?}",
            response.tx_result.code,
            response.check_tx.code
        ));
    }
    info!("hub address funded: addr={} amount={}", hub_addr, amount);
    Ok(())
}

#[derive(Debug, Clone)]
pub struct TaskResources {
    pub hub: CosmosProvider<ModuleQueryClient>,
    pub args: TaskArgs,
    pub kas_rest: HttpClient,
    pub kaspa_network: Network,
}

#[derive(Debug, Clone)]
pub struct TaskArgs {
    pub domain_kas: u32,
    pub token_kas_placeholder: H256,
    pub domain_hub: u32,
    pub token_hub: H256,
    pub escrow_address: Address,
    pub deposit_amount: u64,
    pub withdrawal_fee_pct: f64,
}

impl TaskArgs {
    pub fn token_hub_str(&self) -> String {
        format!("0x{}", hex::encode(self.token_hub.as_bytes()))
    }
    pub fn hub_denom(&self) -> String {
        format!("hyperlane/{}", self.token_hub_str())
    }
    /// Net amount to withdraw such that withdrawal + fee < deposit_amount
    pub fn net_withdrawal_amount(&self) -> u64 {
        (self.deposit_amount as f64 / (1.0 + self.withdrawal_fee_pct)) as u64 - 1
    }
}

/*
Stages
    1. Deposit using whale, to new hub user
    2. Poll for hub user balance to be credited
    3. Withdraw from hub user to a kaspa user
    4. Poll for kaspa user balance to be credited

    Measure the time gaps, and record failures
 */
pub async fn do_round_trip(
    res: TaskResources,
    kaspa_whale: Arc<KaspaWhale>,
    hub_whale: Arc<HubWhale>,
    tx: &mpsc::Sender<RoundTripStats>,
    task_id: u64,
    cancel_token: CancellationToken,
) {
    let mut rt = RoundTrip::new(
        res,
        kaspa_whale.clone(),
        hub_whale.clone(),
        task_id,
        cancel_token,
        tx,
    );
    do_round_trip_inner(&mut rt).await;
}

async fn do_round_trip_inner(rt: &mut RoundTrip<'_>) {
    let hub_user_key = EasyHubKey::new();
    info!("hub_user_key: {:?}", hub_user_key.private.to_bytes());
    let hub_user_addr = hub_user_key.signer().address_string.clone();

    rt.stats.deposit_addr_hub = Some(hub_user_addr.clone());
    rt.stats.kaspa_whale_id = Some(rt.kaspa_whale.id);
    rt.stats.hub_whale_id = Some(rt.hub_whale.id);

    debug!(
        "round trip started: task_id={} kaspa_whale_id={} hub_whale_id={} hub_user_addr={}",
        rt.task_id, rt.kaspa_whale.id, rt.hub_whale.id, hub_user_addr
    );

    match fund_hub_addr(&hub_user_key, &rt.hub_whale, HUB_FUND_AMOUNT).await {
        Ok(()) => {
            info!(
                "hub user funded: task_id={} hub_whale_id={} hub_user_addr={}",
                rt.task_id, rt.hub_whale.id, hub_user_addr
            );
        }
        Err(e) => {
            error!(
                "hub funding error: task_id={} hub_whale_id={} error={:?}",
                rt.task_id, rt.hub_whale.id, e
            );
            rt.send_stats().await;
            return;
        }
    };

    rt.hub_user_key = Some(hub_user_key.clone());

    match rt.deposit(&hub_user_key).await {
        Ok((tx_id, deposit_time_millis)) => {
            rt.stats.kaspa_deposit_tx_id = Some(tx_id);
            rt.stats.kaspa_deposit_tx_time_millis = Some(deposit_time_millis);
            info!(
                "deposit completed: task_id={} kaspa_whale_id={} hub_whale_id={} hub_user_addr={} tx_id={:?}",
                rt.task_id,
                rt.kaspa_whale.id,
                rt.hub_whale.id,
                hub_user_addr,
                tx_id
            );
            rt.send_stats().await;
        }
        Err(e) => {
            rt.stats.deposit_error = Some(e.to_string());
            error!(
                "deposit error: task_id={} kaspa_whale_id={} error={:?}",
                rt.task_id, rt.kaspa_whale.id, e
            );
            rt.send_stats().await;
            return;
        }
    };
    match rt.await_hub_credit(&hub_user_key).await {
        Ok(()) => {
            rt.stats.deposit_credit_time_millis = Some(now_millis());
            info!(
                "hub credit received: task_id={} hub_whale_id={} hub_user_addr={}",
                rt.task_id, rt.hub_whale.id, hub_user_addr
            );
            rt.send_stats().await;
        }
        Err(e) => {
            rt.stats.deposit_credit_error = Some(e.to_string());
            error!(
                "hub credit error: task_id={} hub_whale_id={} error={}",
                rt.task_id, rt.hub_whale.id, e
            );
            rt.send_stats().await;
            return;
        }
    };

    let withdraw_res = rt.withdraw(&hub_user_key).await;
    if !withdraw_res.is_ok() {
        let e = withdraw_res.err().unwrap();
        rt.stats.withdrawal_error = Some(e.to_string());
        error!(
            "withdrawal error: task_id={} hub_whale_id={} hub_user_addr={} error={:?}",
            rt.task_id, rt.hub_whale.id, hub_user_addr, e
        );
        rt.send_stats().await;
        return;
    }
    let (kaspa_addr, tx_id, withdrawal_time_millis) = withdraw_res.unwrap();
    rt.stats.hub_withdraw_tx_id = Some(tx_id.clone());
    rt.stats.hub_withdraw_tx_time_millis = Some(withdrawal_time_millis);
    rt.stats.withdraw_addr_kaspa = Some(kaspa_addr.clone());
    rt.send_stats().await;

    match rt.await_kaspa_credit(kaspa_addr.clone()).await {
        Ok(()) => {
            rt.stats.withdraw_credit_time_millis = Some(now_millis());
            info!(
                "kaspa credit received: task_id={} hub_whale_id={} hub_user_addr={} kaspa_addr={}",
                rt.task_id, rt.hub_whale.id, hub_user_addr, kaspa_addr
            );
            rt.send_stats().await;
        }
        Err(e) => {
            rt.stats.withdraw_credit_error = Some(e.to_string());
            error!(
                "kaspa credit error: task_id={} hub_whale_id={} error={}",
                rt.task_id, rt.hub_whale.id, e
            );
            rt.send_stats().await;
            return;
        }
    };
}

struct RoundTrip<'a> {
    res: TaskResources,
    kaspa_whale: Arc<KaspaWhale>,
    hub_whale: Arc<HubWhale>,
    task_id: u64,
    stats: RoundTripStats,
    cancel: CancellationToken,
    tx: &'a mpsc::Sender<RoundTripStats>,
    hub_user_key: Option<EasyHubKey>,
}

impl<'a> RoundTrip<'a> {
    pub fn new(
        res: TaskResources,
        kaspa_whale: Arc<KaspaWhale>,
        hub_whale: Arc<HubWhale>,
        task_id: u64,
        cancel_token: CancellationToken,
        tx: &'a mpsc::Sender<RoundTripStats>,
    ) -> Self {
        Self {
            res,
            kaspa_whale,
            hub_whale,
            stats: RoundTripStats::new(task_id),
            task_id,
            cancel: cancel_token,
            tx,
            hub_user_key: None,
        }
    }

    async fn send_stats(&mut self) {
        self.stats.update_stage();
        if let Err(e) = self.tx.send(self.stats.clone()).await {
            error!(
                "stat send error: task_id={} kaspa_whale_id={} error={:?}",
                self.task_id, self.kaspa_whale.id, e
            );
        }
    }

    async fn deposit(&self, hub_user_key: &EasyHubKey) -> Result<(TransactionId, u128)> {
        let a = self.res.args.escrow_address.clone();
        let amt = self.res.args.deposit_amount;
        debug!(
            "deposit starting: task_id={} kaspa_whale_id={} escrow_addr={} amount={}",
            self.task_id, self.kaspa_whale.id, a, amt
        );

        let payload = make_deposit_payload_easy(
            self.res.args.domain_kas,
            self.res.args.token_kas_placeholder,
            self.res.args.domain_hub,
            self.res.args.token_hub,
            amt,
            &hub_user_key.signer(),
        );

        let kaspa_whale = self.kaspa_whale.clone();
        let task_id = self.task_id;
        let tx_id = retry_with_backoff("kaspa_deposit", task_id, || {
            let kaspa_whale = kaspa_whale.clone();
            let a = a.clone();
            let payload = payload.clone();
            async move { kaspa_whale.deposit_with_payload(a, amt, payload).await }
        })
        .await?;

        Ok((tx_id, now_millis()))
    }

    async fn await_hub_credit(&self, hub_user_key: &EasyHubKey) -> Result<()> {
        let expected_amount = self.res.args.deposit_amount;
        let a = hub_user_key.signer().address_string;
        debug!(
            "await hub credit starting: task_id={} hub_whale_id={} hub_user_addr={} expected_value={}",
            self.task_id, self.hub_whale.id, a, expected_amount
        );
        loop {
            let balance = self
                .res
                .hub
                .rpc()
                .get_balance_denom(a.clone(), "adym".to_string())
                .await?;
            if balance == U256::from(0) {
                if self.cancel.is_cancelled() {
                    return Err(RoundTripError::Cancelled.into());
                }
                tokio::time::sleep(Duration::from_millis(3000)).await;
                continue;
            }
            break;
        }
        loop {
            let balance = self
                .res
                .hub
                .rpc()
                .get_balance_denom(a.clone(), self.res.args.hub_denom())
                .await?;
            if balance == U256::from(0) {
                if self.cancel.is_cancelled() {
                    return Err(RoundTripError::Cancelled.into());
                }
                tokio::time::sleep(Duration::from_millis(3000)).await;
                continue;
            }
            if balance != U256::from(expected_amount) {
                let e = RoundTripError::HubBalanceMismatch {
                    balance: balance.as_u64() as i64,
                    expected: expected_amount as i64,
                };
                return Err(e.into());
            }
            break;
        }

        Ok(())
    }

    async fn withdraw(&self, hub_user_key: &EasyHubKey) -> Result<(Address, String, u128)> {
        let withdrawal_amount = self.res.args.net_withdrawal_amount();
        let fee_amount = self.res.args.deposit_amount - withdrawal_amount;
        let fee_denom = self.res.args.hub_denom();

        let kaspa_prefix = match self.res.kaspa_network {
            Network::KaspaTest10 => kaspa_addresses::Prefix::Testnet,
            Network::KaspaMainnet => kaspa_addresses::Prefix::Mainnet,
        };
        let kaspa_recipient = get_kaspa_keypair(kaspa_prefix);
        let hub_user_addr = hub_user_key.signer().address_string.clone();
        info!(
            "kaspa_recipient_key: {:?}",
            kaspa_recipient.private_key.secret_bytes()
        );
        debug!(
            "withdraw starting: task_id={} hub_whale_id={} hub_user_addr={} kaspa_recipient_addr={} amount={} fee_amount={} fee_denom={}",
            self.task_id, self.hub_whale.id, hub_user_addr, kaspa_recipient.address, withdrawal_amount, fee_amount, fee_denom
        );

        let mut res_hub = self.res.hub.clone();
        res_hub.rpc = res_hub.rpc().with_signer(hub_user_key.signer());
        let domain_kas = self.res.args.domain_kas;
        let token_hub_str = self.res.args.token_hub_str();
        let kaspa_addr = kaspa_recipient.address.clone();
        let task_id = self.task_id;

        let (response, timestamp) = retry_with_backoff("hub_withdrawal", task_id, || {
            let res_hub = res_hub.clone();
            let token_hub_str = token_hub_str.clone();
            let kaspa_addr = kaspa_addr.clone();
            let fee_denom = fee_denom.clone();
            async move {
                let rpc = res_hub.rpc();
                let amount = withdrawal_amount.to_string();
                let recipient = x::addr::hl_recipient(&kaspa_addr.to_string());
                let sender = rpc.get_signer()?.address_string.clone();

                let req = MsgRemoteTransfer {
                    sender: sender.clone(),
                    token_id: token_hub_str,
                    destination_domain: domain_kas,
                    recipient,
                    amount,
                    custom_hook_id: "".to_string(),
                    gas_limit: "0".to_string(),
                    max_fee: Some(Coin {
                        denom: fee_denom,
                        amount: fee_amount.to_string(),
                    }),
                    custom_hook_metadata: "".to_string(),
                };
                let a = Any {
                    type_url: MsgRemoteTransfer::type_url(),
                    value: req.encode_to_vec(),
                };
                let gas_limit = None;
                let response = rpc.send(vec![a], gas_limit).await;

                match response {
                    Ok(response) => {
                        if response.tx_result.code.is_ok() & response.check_tx.code.is_ok() {
                            Ok((response, now_millis()))
                        } else {
                            Err(RoundTripError::WithdrawalTxFailed { response }.into())
                        }
                    }
                    Err(e) => Err(eyre::eyre!(
                        "hub send error: sender={} error={:?}",
                        sender,
                        e
                    )),
                }
            }
        })
        .await?;

        Ok((kaspa_addr, hub_tx_query_id(&response), timestamp))
    }

    async fn await_kaspa_credit(&self, kaspa_addr: Address) -> Result<()> {
        let expected_credit = self.res.args.net_withdrawal_amount();

        debug!(
            "await kaspa credit starting: task_id={} hub_whale_id={} kaspa_addr={} expected_value={}",
            self.task_id, self.hub_whale.id, kaspa_addr, expected_credit
        );
        loop {
            let balance = self
                .res
                .kas_rest
                .get_balance_by_address(&kaspa_addr.to_string())
                .await?;
            if balance == 0 {
                if self.cancel.is_cancelled() {
                    return Err(RoundTripError::Cancelled.into());
                }
                tokio::time::sleep(Duration::from_millis(3000)).await;
                continue;
            }
            if balance != expected_credit as i64 {
                let e = RoundTripError::KaspaBalanceMismatch {
                    balance,
                    expected: expected_credit as i64,
                };
                return Err(e.into());
            }
            break;
        }

        Ok(())
    }
}

fn hub_tx_query_id(response: &HubResponse) -> String {
    let as_h256 = H256::from_slice(response.hash.as_bytes()).into();
    let tx_hash = hyperlane_cosmos::native::h512_to_h256(as_h256).encode_hex_upper::<String>();
    tx_hash
}

#[derive(Debug, thiserror::Error)]
pub enum RoundTripError {
    #[error("hub balance mismatch: {balance} != {expected}")]
    HubBalanceMismatch { balance: i64, expected: i64 },
    #[error("kaspa balance mismatch: {balance} != {expected}")]
    KaspaBalanceMismatch { balance: i64, expected: i64 },
    #[error("withdrawal tx failed: {response:?}")]
    WithdrawalTxFailed { response: HubResponse },
    #[error("cancelled")]
    Cancelled,
}

#[cfg(test)]
mod tests {
    use super::TaskArgs;
    use hyperlane_core::H256;
    use kaspa_addresses::Address;
    use std::str::FromStr;

    #[test]
    fn test_hub_denom() {
        let token_hub =
            H256::from_str("0x726f757465725f61707000000000000000000000000000020000000000000000")
                .unwrap();
        let args = TaskArgs {
            domain_kas: 0,
            token_kas_placeholder: H256::zero(),
            domain_hub: 0,
            token_hub,
            escrow_address: Address::try_from(
                "kaspatest:pzlq49spp66vkjjex0w7z8708f6zteqwr6swy33fmy4za866ne90v7e6pyrfr",
            )
            .unwrap(),
            deposit_amount: 4_100_000_000,
            withdrawal_fee_pct: 0.01,
        };
        let denom = args.hub_denom();
        assert_eq!(
            denom,
            "hyperlane/0x726f757465725f61707000000000000000000000000000020000000000000000"
        );
    }
}
