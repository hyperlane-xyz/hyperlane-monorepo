use std::{
    fmt::{Display, Formatter},
    io::Read,
    io::Write,
};

use hyperlane_core::{Decode, Encode, HyperlaneProtocolError, H512};

use eyre::Result;

use crate::db::GAS_PAYMENT_META_PROCESSED;

use super::Migration;

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug)]
pub struct OldInterchainGasPaymentMeta {
    /// The transaction id/hash in which the GasPayment log was emitted
    pub transaction_id: H512,
    /// The index of the GasPayment log within the transaction's logs
    pub log_index: u64,
}

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug)]
pub struct NewInterchainGasPaymentMeta {
    /// The transaction id/hash in which the GasPayment log was emitted
    pub transaction_id: H512,
    /// The index of the GasPayment log within the transaction's logs
    pub log_index: u64,
    /// The block number in which the GasPayment log was emitted
    pub block_number: u64,
    /// The storage schema version of this struct
    pub schema_version: u32,
}

impl Decode for OldInterchainGasPaymentMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            transaction_id: H512::read_from(reader)?,
            log_index: u64::read_from(reader)?,
        })
    }
}

impl Encode for NewInterchainGasPaymentMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let mut written = 0;
        written += self.transaction_id.write_to(writer)?;
        written += self.log_index.write_to(writer)?;
        written += self.block_number.write_to(writer)?;
        Ok(written)
    }
}

pub struct InterchainGasPaymentMetaMigrationV0;

impl Migration for InterchainGasPaymentMetaMigrationV0 {
    fn migrate(&self, key: Vec<u8>, value: Vec<u8>) -> Result<(Vec<u8>, Vec<u8>)> {
        let old_value = OldInterchainGasPaymentMeta::read_from(&mut value.as_slice())?;

        // No need to check if the old value matches the migration version, since the old type has no schema version

        let new_value = NewInterchainGasPaymentMeta {
            transaction_id: old_value.transaction_id,
            log_index: old_value.log_index,
            // Set the block number of previous entry to zero
            block_number: 0,
            schema_version: 1,
        };
        let encoded_new_value = new_value.to_vec();
        Ok((key, encoded_new_value))
    }

    fn prefix_key(&self) -> String {
        GAS_PAYMENT_META_PROCESSED.to_string()
    }
}

impl Display for InterchainGasPaymentMetaMigrationV0 {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        write!(f, "InterchainGasPaymentMetaMigrationV0")
    }
}
