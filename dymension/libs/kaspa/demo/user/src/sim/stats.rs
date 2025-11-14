use crate::sim::util::som_to_kas;
use cometbft::Hash as TendermintHash;
use eyre::Result;
use kaspa_addresses::Address;
use kaspa_consensus_core::tx::TransactionId;
use serde::Serialize;
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::SystemTime;
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
        info!("stage: {:?}", stat.stage());
        if stat.deposit_credit_time.is_some() {
            info!("deposit credit time: {:?}", stat.deposit_time());
        }
        if stat.withdraw_credit_time.is_some() {
            info!("withdraw credit time: {:?}", stat.withdraw_time());
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
    pub fn stage(&self) -> &'static str {
        if !self.kaspa_deposit_tx_time.is_some() {
            return "PreDeposit";
        }
        if self.deposit_credit_error.is_some() {
            return "PostDepositNotCredited";
        }
        if !self.hub_withdraw_tx_time.is_some() {
            return "PreWithdrawal";
        }
        if self.withdraw_credit_error.is_some() {
            return "PostWithdrawalNotCredited";
        }
        "Complete"
    }
}
