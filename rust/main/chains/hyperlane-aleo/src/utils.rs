use hyperlane_core::{ChainResult, H256};
use snarkvm_console_account::{FromBytes, ToBytes};

use crate::{HyperlaneAleoError, TxID};

/// Convert a H256 into a TxID
pub(crate) fn get_tx_id(hash: impl Into<H256>) -> ChainResult<TxID> {
    Ok(TxID::from_bytes_le(hash.into().as_bytes()).map_err(HyperlaneAleoError::from)?)
}

/// Convert a TxID or any other struct that implements ToBytes to H256
pub(crate) fn to_h256<T: ToBytes>(id: T) -> ChainResult<H256> {
    let bytes = id.to_bytes_le().map_err(HyperlaneAleoError::from)?;
    Ok(H256::from_slice(&bytes))
}
