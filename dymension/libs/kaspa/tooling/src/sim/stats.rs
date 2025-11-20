use crate::sim::util::som_to_kas;
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use tracing::info;

/// Continuous stats writer that appends to JSONL file immediately
pub struct StatsWriter {
    file: Arc<Mutex<std::fs::File>>,
}

impl StatsWriter {
    pub fn new(stats_file_path: String) -> Result<Self> {
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stats_file_path)?;

        Ok(Self {
            file: Arc::new(Mutex::new(file)),
        })
    }

    pub fn write_stat(&self, stat: &RoundTripStats) -> Result<()> {
        let mut file = self.file.lock().unwrap();
        let json = serde_json::to_string(stat)?;
        writeln!(file, "{}", json)?;
        file.flush()?;
        Ok(())
    }

    pub fn log_stat(&self, stat: &RoundTripStats) {
        info!("{:#?}", stat);
        if let Some(deposit_time_ms) = stat.deposit_time_ms() {
            info!("deposit credit time: ms={}", deposit_time_ms);
        }
        if let Some(withdraw_time_ms) = stat.withdraw_time_ms() {
            info!("withdraw credit time: ms={}", withdraw_time_ms);
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MetadataStats {
    pub total_spend: u64,
    pub total_ops: u64,
    pub total_spend_kas: String,
}

pub fn write_metadata(file_path: &str, total_spend: u64, total_ops: u64) -> Result<()> {
    let metadata = MetadataStats {
        total_spend,
        total_ops,
        total_spend_kas: som_to_kas(total_spend),
    };
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(file_path)?;
    serde_json::to_writer_pretty(file, &metadata)?;
    Ok(())
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct RoundTripStats {
    pub op_id: u64,
    pub stage: String,
    pub kaspa_whale_id: Option<usize>,
    pub hub_whale_id: Option<usize>,
    pub kaspa_deposit_tx_id: Option<TransactionId>,
    pub kaspa_deposit_tx_time_millis: Option<u128>,
    pub deposit_error: Option<String>,
    pub deposit_credit_time_millis: Option<u128>,
    pub deposit_credit_error: Option<String>,
    pub hub_withdraw_tx_id: Option<String>,
    pub hub_withdraw_tx_time_millis: Option<u128>,
    pub withdrawal_error: Option<String>,
    pub withdraw_credit_time_millis: Option<u128>,
    pub withdraw_credit_error: Option<String>,
    pub deposit_addr_hub: Option<String>,
    pub withdraw_addr_kaspa: Option<Address>,
}

impl RoundTripStats {
    pub fn new(op_id: u64) -> Self {
        let mut d = RoundTripStats::default();
        d.op_id = op_id;
        d.update_stage();
        d
    }

    pub fn update_stage(&mut self) {
        self.stage = self.compute_stage().to_string();
    }

    fn compute_stage(&self) -> &'static str {
        if self.kaspa_deposit_tx_time_millis.is_none() {
            return "PreDeposit";
        }
        if self.deposit_credit_error.is_some() {
            return "PostDepositNotCredited";
        }
        if self.deposit_credit_time_millis.is_none() {
            return "AwaitingDepositCredit";
        }
        if self.hub_withdraw_tx_time_millis.is_none() {
            return "PreWithdrawal";
        }
        if self.withdraw_credit_error.is_some() {
            return "PostWithdrawalNotCredited";
        }
        if self.withdraw_credit_time_millis.is_none() {
            return "AwaitingWithdrawalCredit";
        }
        "Complete"
    }

    pub fn deposit_time_ms(&self) -> Option<u128> {
        match (
            self.kaspa_deposit_tx_time_millis,
            self.deposit_credit_time_millis,
        ) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        }
    }

    pub fn withdraw_time_ms(&self) -> Option<u128> {
        match (
            self.hub_withdraw_tx_time_millis,
            self.withdraw_credit_time_millis,
        ) {
            (Some(start), Some(end)) => Some(end.saturating_sub(start)),
            _ => None,
        }
    }
}
