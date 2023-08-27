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
        written += self.schema_version.write_to(writer)?;
        Ok(written)
    }
}

impl Decode for NewInterchainGasPaymentMeta {
    fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
    where
        R: Read,
        Self: Sized,
    {
        Ok(Self {
            transaction_id: H512::read_from(reader)?,
            log_index: u64::read_from(reader)?,
            block_number: u64::read_from(reader)?,
            schema_version: u32::read_from(reader)?,
        })
    }
}

pub struct InterchainGasPaymentMetaMigrationV0;

impl Migration for InterchainGasPaymentMetaMigrationV0 {
    fn migrate(&self, key: Vec<u8>, value: Vec<u8>) -> Result<(Vec<u8>, Vec<u8>)> {
        if let Ok(x) = NewInterchainGasPaymentMeta::read_from(&mut key.as_slice()) {
            println!("Already migrated: {:?}", x);
            // Already migrated
            return Err(eyre::eyre!("Already migrated"));
        }
        let old_key = OldInterchainGasPaymentMeta::read_from(&mut key.as_slice())?;
        println!("Successfully decoded old key: {:?}", old_key);

        // No need to check if the old key matches the migration version, since the old type has no schema version

        let new_key = NewInterchainGasPaymentMeta {
            transaction_id: old_key.transaction_id,
            log_index: old_key.log_index,
            // Set the block number of previous entry to zero
            block_number: 0,
            schema_version: 1,
        };
        let encoded_new_key = new_key.to_vec();
        Ok((encoded_new_key, value))
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

#[cfg(test)]
mod test {
    // TODO: add test that stores the kv pair in the old format in a db,
    // runs the migration, checks that the new format is stored in the db,
    // checks that the old format is not stored in the db, and runs the migration
    // again to check that it fails

    // Old format data:
    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 238, 187, 137, 58, 100, 37, 77, 117, 170, 199, 230, 149, 154, 141, 234, 63, 17, 195, 251, 21, 84, 136, 36, 116, 69, 27, 117, 32, 9, 112, 123, 8, 0, 0, 0, 0, 0, 0, 0, 7], value: [1]
    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 238, 197, 238, 148, 150, 23, 200, 41, 17, 42, 250, 54, 69, 70, 62, 97, 126, 82, 120, 90, 107, 98, 57, 188, 90, 173, 87, 1, 162, 140, 174, 238, 0, 0, 0, 0, 0, 0, 0, 8], value: [1]
    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 238, 205, 72, 88, 225, 26, 234, 175, 9, 196, 43, 158, 49, 48, 35, 200, 95, 197, 53, 253, 242, 181, 244, 40, 153, 83, 65, 38, 157, 109, 211, 124, 0, 0, 0, 0, 0, 0, 0, 2], value: [1]
}
