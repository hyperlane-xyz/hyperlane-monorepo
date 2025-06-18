use crate::contract_sync::cursors::Indexable;
use hyperlane_core::{HyperlaneDomain, HyperlaneLogStore, HyperlaneMessage, KnownHyperlaneDomain};
use tokio::{
    sync::{
        broadcast::Sender as BroadcastSender,
        mpsc::{self, Receiver as MpscReceiver, UnboundedSender},
        RwLock,
    },
    task::JoinHandle,
};
use tokio_metrics::TaskMonitor;
use tracing::{info_span, warn, Instrument};

use dymension_kaspa::{Deposit, RestProvider};

use crate::db::HyperlaneRocksDB;

use hyperlane_core::{Indexed, LogMeta};

use std::{collections::HashSet, fmt::Debug, hash::Hash};

/// is it a kaspa domain?
pub fn is_kas(d: &HyperlaneDomain) -> bool {
    match d {
        HyperlaneDomain::Known(domain) => matches!(
            domain,
            KnownHyperlaneDomain::Kaspa
                | KnownHyperlaneDomain::KaspaTest10
                | KnownHyperlaneDomain::KaspaLocal
        ),
        HyperlaneDomain::Unknown { .. } => false,
    }
}
