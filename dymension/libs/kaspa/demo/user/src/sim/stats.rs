use crate::sim::util::som_to_kas;
use cometbft::Hash as TendermintHash;
use eyre::Error;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use serde::Serialize;
use std::fs::File;
use std::time::Duration;
use std::time::{Instant, SystemTime};
use tracing::info;

pub fn render_stats(stats: Vec<RoundTripStats>, total_spend: u64, total_ops: u64) {
    info!("Total spend: {}", som_to_kas(total_spend));
    info!("Total ops: {}", total_ops);
    for s in stats {
        info!("{:#?}", s);
        info!("stage: {:?}", s.stage());
        if s.deposit_credit_time.is_some() {
            info!("deposit credit time: {:?}", s.deposit_time());
        }
        if s.withdraw_credit_time.is_some() {
            info!("withdraw credit time: {:?}", s.withdraw_time());
        }
    }
}

pub fn write_stats(file_path: &str, stats: Vec<RoundTripStats>, total_spend: u64, total_ops: u64) {
    let mut file = File::create(file_path).unwrap();
    serde_json::to_writer_pretty(&mut file, &stats).unwrap();
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RoundTripStats {
    pub op_id: u64,
    pub value: u64,
    pub kaspa_deposit_tx_id: Option<TransactionId>,
    pub kaspa_deposit_tx_time: Option<SystemTime>,
    pub deposit_credit_time: Option<SystemTime>,
    pub deposit_credit_error: Option<String>,
    pub hub_withdraw_tx_id: Option<TendermintHash>,
    pub hub_withdraw_tx_time: Option<SystemTime>,
    pub withdraw_credit_time: Option<SystemTime>,
    pub withdraw_credit_error: Option<String>,
    pub deposit_addr_hub: Option<String>,
    pub withdraw_addr_kaspa: Option<Address>,
}

#[derive(Debug, Clone, Copy)]
enum Stage {
    PreDeposit,
    PostDepositNotCredited,
    PreWithdrawal,
    PostWithdrawalNotCredited,
    Complete,
}

impl RoundTripStats {
    pub fn new(op_id: u64, value: u64) -> Self {
        let mut d = RoundTripStats::default();
        d.op_id = op_id;
        d.value = value;
        d
    }
    pub fn deposit_time(&self) -> Duration {
        self.kaspa_deposit_tx_time
            .unwrap()
            .duration_since(self.kaspa_deposit_tx_time.unwrap())
            .unwrap()
    }
    pub fn withdraw_time(&self) -> Duration {
        self.hub_withdraw_tx_time
            .unwrap()
            .duration_since(self.hub_withdraw_tx_time.unwrap())
            .unwrap()
    }
    pub fn stage(&self) -> Stage {
        if !self.kaspa_deposit_tx_time.is_some() {
            return Stage::PreDeposit;
        }
        if self.deposit_credit_error.is_some() {
            return Stage::PostDepositNotCredited;
        }
        if !self.hub_withdraw_tx_time.is_some() {
            return Stage::PreWithdrawal;
        }
        if self.withdraw_credit_error.is_some() {
            return Stage::PostWithdrawalNotCredited;
        }
        Stage::Complete
    }
}
