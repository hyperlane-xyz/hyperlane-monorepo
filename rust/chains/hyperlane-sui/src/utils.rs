use crate::{SuiRpcClient, TxSpecificData};
use hyperlane_core::{ChainCommunicationError, ChainResult, LogMeta};
use sui_sdk::{types::digests::TransactionDigest, rpc_types::SuiEvent};
use std::ops::RangeInclusive;
