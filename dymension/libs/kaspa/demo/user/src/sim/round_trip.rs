use super::key_cosmos::EasyHubKey;
use super::key_kaspa::get_kaspa_keypair;
use super::stats::RoundTripStats;
use crate::x;
use cometbft::abci::Code;
use cometbft::Hash as TendermintHash;
use corelib::api::client::HttpClient;
use corelib::user::deposit::deposit_with_payload;
use corelib::user::payload::make_deposit_payload_easy;
use corelib::wallet::EasyKaspaWallet;
use cosmos_sdk_proto::cosmos::base::v1beta1::Coin;
use cosmrs::Any;
use eyre::Result;
use hyperlane_core::H256;
use hyperlane_core::U256;
use hyperlane_cosmos::{native::ModuleQueryClient, CosmosProvider};
use hyperlane_cosmos_rs::hyperlane::warp::v1::MsgRemoteTransfer;
use hyperlane_cosmos_rs::prost::{Message, Name};
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use std::str::FromStr;
use std::time::Duration;
use std::time::{Instant, SystemTime};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use tracing::debug;
use tracing::error;

#[derive(Debug, Clone)]
pub struct TaskResources {
    pub hub: CosmosProvider<ModuleQueryClient>,
    pub w: EasyKaspaWallet,
    pub args: TaskArgs,
    pub kas_rest: HttpClient,
}

#[derive(Debug, Clone)]
pub struct TaskArgs {
    pub domain_kas: u32,
    pub token_kas_placeholder: H256,
    pub domain_hub: u32,
    pub token_hub: H256,
    pub escrow_address: Address,
}

impl TaskArgs {
    pub fn token_hub_str(&self) -> String {
        format!("0x{}", hex::encode(self.token_hub.as_bytes()))
    }
    pub fn hub_denom(&self) -> String {
        format!("hyperlane/{}", self.token_hub_str())
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
    value: u64,
    tx: &mpsc::Sender<RoundTripStats>,
    task_id: u64,
    hub_key: EasyHubKey,
    cancel_token: CancellationToken,
) {
    let mut rt = RoundTrip::new(res, value, task_id, hub_key.clone(), cancel_token);
    do_round_trip_inner(hub_key.clone(), &mut rt).await;
    tx.send(rt.stats).await.unwrap();
}

async fn do_round_trip_inner(hub_key: EasyHubKey, rt: &mut RoundTrip) {
    rt.stats.deposit_addr_hub = Some(hub_key.signer().address_string.clone());
    match rt.deposit().await {
        Ok((tx_id, deposit_time)) => {
            rt.stats.kaspa_deposit_tx_id = Some(tx_id);
            rt.stats.kaspa_deposit_tx_time = Some(deposit_time);
        }
        Err(e) => {
            error!("deposit failed: {:?}", e);
            return;
        }
    };
    match rt.await_hub_credit().await {
        Ok(()) => {
            rt.stats.deposit_credit_time = Some(SystemTime::now());
        }
        Err(e) => {
            rt.stats.deposit_credit_error = Some(e.to_string());
            return;
        }
    };
    let withdraw_res = rt.withdraw().await;
    if !withdraw_res.is_ok() {
        let e = withdraw_res.err().unwrap();
        error!("withdrawal failed: {:?}", e);
        return;
    }
    let (kaspa_addr, tx_id, withdrawal_time) = withdraw_res.unwrap();
    rt.stats.hub_withdraw_tx_id = Some(tx_id);
    rt.stats.hub_withdraw_tx_time = Some(withdrawal_time);
    rt.stats.withdraw_addr_kaspa = Some(kaspa_addr.clone());
    match rt.await_kaspa_credit(kaspa_addr.clone()).await {
        Ok(()) => {
            rt.stats.withdraw_credit_time = Some(SystemTime::now());
        }
        Err(e) => {
            rt.stats.withdraw_credit_error = Some(e.to_string());
            return;
        }
    };
}

struct RoundTrip {
    res: TaskResources,
    value: u64,
    task_id: u64,
    stats: RoundTripStats,
    hub_key: EasyHubKey,
    cancel: CancellationToken,
}

impl RoundTrip {
    pub fn new(
        res: TaskResources,
        value: u64,
        task_id: u64,
        hub_k: EasyHubKey,
        cancel_token: CancellationToken,
    ) -> Self {
        let mut res = res.clone();
        res.hub.rpc = res.hub.rpc().with_signer(hub_k.signer());
        Self {
            res,
            value,
            stats: RoundTripStats::new(task_id, value),
            hub_key: hub_k,
            task_id,
            cancel: cancel_token,
        }
    }

    async fn deposit(&self) -> Result<(TransactionId, SystemTime)> {
        debug!(
            "start deposit, task_id: {}, hub_addr: {}",
            self.task_id,
            self.hub_key.signer().address_string
        );
        let w = &self.res.w;
        let s = &w.secret;
        let a = self.res.args.escrow_address.clone();
        let amt = self.value;
        let payload = make_deposit_payload_easy(
            self.res.args.domain_kas,
            self.res.args.token_kas_placeholder,
            self.res.args.domain_hub,
            self.res.args.token_hub,
            amt,
            &self.hub_key.signer(),
        );
        let tx_id = deposit_with_payload(&w.wallet, &s, a, amt, payload).await?;
        Ok((tx_id, SystemTime::now()))
    }

    async fn await_hub_credit(&self) -> Result<()> {
        let a = self.hub_key.signer().address_string;
        debug!(
            "start await_hub_credit, task_id: {}, addr: {}",
            self.task_id, a
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
                tokio::time::sleep(Duration::from_millis(1000)).await;
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
                tokio::time::sleep(Duration::from_millis(1000)).await;
                continue;
            }
            if balance != U256::from(self.value) {
                let e = RoundTripError::HubBalanceMismatch {
                    balance: balance.as_u64() as i64,
                    expected: self.value as i64,
                };
                return Err(e.into());
            }
            break;
        }

        Ok(())
    }

    async fn withdraw(&self) -> Result<(Address, TendermintHash, SystemTime)> {
        let kaspa_recipient = get_kaspa_keypair();
        debug!(
            "start withdraw, task_id: {}, kaspa_addr: {}",
            self.task_id, kaspa_recipient.address
        );

        let rpc = self.res.hub.rpc();

        let amount = self.value.to_string();
        let recipient = x::addr::hl_recipient(&kaspa_recipient.address.to_string());
        let token_id = self.res.args.token_hub_str();
        debug!("withdraw token_id: {}, recipient: {}", token_id, recipient);

        let req = MsgRemoteTransfer {
            sender: rpc.get_signer()?.address_string.clone(),
            token_id,
            destination_domain: self.res.args.domain_kas,
            recipient,
            amount,
            custom_hook_id: "".to_string(),
            gas_limit: "0".to_string(),
            max_fee: Some(Coin {
                denom: "adym".to_string(),
                amount: "1000".to_string(),
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
                if response.tx_result.code.is_ok() {
                    let tx_id = response.hash.clone();
                    Ok((kaspa_recipient.address, tx_id, SystemTime::now()))
                } else {
                    Err(RoundTripError::WithdrawalTxFailed.into())
                }
            }
            Err(e) => Err(eyre::eyre!("Failed to withdraw: {:?}", e)),
        }
    }

    async fn await_kaspa_credit(&self, kaspa_addr: Address) -> Result<()> {
        debug!("start await_kaspa_credit, task_id: {}", self.task_id);
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
                tokio::time::sleep(Duration::from_millis(1000)).await;
                continue;
            }
            if balance != self.value as i64 {
                let e = RoundTripError::KaspaBalanceMismatch {
                    balance,
                    expected: self.value as i64,
                };
                return Err(e.into());
            }
            break;
        }

        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RoundTripError {
    #[error("hub balance mismatch: {balance} != {expected}")]
    HubBalanceMismatch { balance: i64, expected: i64 },
    #[error("kaspa balance mismatch: {balance} != {expected}")]
    KaspaBalanceMismatch { balance: i64, expected: i64 },
    #[error("withdrawal tx fail")]
    WithdrawalTxFailed,
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
        };
        let denom = args.hub_denom();
        assert_eq!(
            denom,
            "hyperlane/0x726f757465725f61707000000000000000000000000000020000000000000000"
        );
    }
}
