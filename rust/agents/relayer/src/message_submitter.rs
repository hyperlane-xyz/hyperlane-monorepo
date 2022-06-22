use std::sync::Arc;
use std::{
    cmp::Reverse,
    collections::BinaryHeap,
    time::{Duration, Instant},
};

use eyre::{bail, Result};
use prometheus::IntGauge;
use tokio::{
    sync::{mpsc, watch},
    task::JoinHandle,
    time::sleep,
};
use tracing::{
    debug, error, info, info_span, instrument, instrument::Instrumented, warn, Instrument,
};

use abacus_base::{CoreMetrics, InboxContracts, Outboxes};
use abacus_core::{
    db::AbacusDB, AbacusCommon, AbacusContract, ChainCommunicationError, CommittedMessage, Inbox,
    InboxValidatorManager, MessageStatus, MultisigSignedCheckpoint, Outbox, OutboxState,
};
use loop_control::LoopControl::{Continue, Flow};
use loop_control::{loop_ctrl, LoopControl};

use crate::merkle_tree_builder::MerkleTreeBuilder;
use crate::relayer::{MessageSubmitter, SubmitMessageOp};
use crate::settings::whitelist::Whitelist;

