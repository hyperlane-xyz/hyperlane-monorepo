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

#[cfg(test)]
mod tests {
    use std::str::FromStr;

    use snarkvm_console_account::Address;

    use super::*;
    use crate::CurrentNetwork;

    #[test]
    fn test_get_tx_id() {
        let hash = H256::zero();
        let tx_id = super::get_tx_id(hash).unwrap();

        let bytes = tx_id.to_bytes_le().unwrap();
        assert_eq!(bytes.as_slice(), &[0u8; 32]);
    }

    #[test]
    fn test_to_h256() {
        let address = Address::<CurrentNetwork>::from_str(
            "aleo12tf856xd9we5ay090zkep0s3q5e8srzwqr37ds0ppvv5kkzad5fqvwndmx",
        )
        .unwrap();
        let h256 = super::to_h256(address).unwrap();

        let expected_bytes =
            hex::decode("52d27a68cd2bb34e91e578ad90be110532780c4e00e3e6c1e10b194b585d6d12")
                .unwrap();
        assert_eq!(h256.as_bytes(), expected_bytes.as_slice());
    }
}
