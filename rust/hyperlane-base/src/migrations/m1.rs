use std::{
    fmt::{Display, Formatter},
    io::Read,
    io::Write,
};

use derive_new::new;
use hyperlane_core::{Decode, Encode, HyperlaneDomain, HyperlaneProtocolError, H512};

use eyre::Result;

use crate::db::{domain_name_to_prefix, GAS_PAYMENT_META_PROCESSED};

use super::Migration;

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug, new)]
pub struct OldInterchainGasPaymentMeta {
    /// The transaction id/hash in which the GasPayment log was emitted
    pub transaction_id: H512,
    /// The index of the GasPayment log within the transaction's logs
    pub log_index: u64,
}

/// Uniquely identifying metadata for an InterchainGasPayment
#[derive(Debug, new)]
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

// impl Decode for OldInterchainGasPaymentMeta {
//     fn read_from<R>(reader: &mut R) -> Result<Self, HyperlaneProtocolError>
//     where
//         R: Read,
//         Self: Sized,
//     {
//         Ok(Self {
//             transaction_id: H512::read_from(reader)?,
//             log_index: u64::read_from(reader)?,
//         })
//     }
// }

impl Encode for OldInterchainGasPaymentMeta {
    fn write_to<W>(&self, writer: &mut W) -> std::io::Result<usize>
    where
        W: Write,
    {
        let mut written = 0;
        written += self.transaction_id.write_to(writer)?;
        written += self.log_index.write_to(writer)?;
        // written += self.block_number.write_to(writer)?;
        // written += self.schema_version.write_to(writer)?;
        Ok(written)
    }
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
            // block_number: u64::read_from(reader)?,
            // schema_version: u32::read_from(reader)?,
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
    fn migrate(
        &self,
        key: Vec<u8>,
        value: Vec<u8>,
        domain: &HyperlaneDomain,
    ) -> Result<(Vec<u8>, Vec<u8>)> {
        // Need to include the prefix, so it is stripped from the key
        // if let Ok(x) = NewInterchainGasPaymentMeta::read_from(&mut key.as_slice()) {
        //     println!("Already migrated key: {:?}, new value: {:?}", key, x);
        //     // Already migrated
        //     return Err(eyre::eyre!("Already migrated"));
        // }

        let domain_as_prefix = domain_name_to_prefix(domain);
        let domain_as_ref: &[u8] = domain_as_prefix.as_ref();
        println!("domain prefix_as_ref: {:?}", domain_as_ref);
        let key_without_domain_prefix = key.strip_prefix(domain_as_ref).unwrap();
        let prefix = self.prefix_key();
        let prefix_as_ref: &[u8] = prefix.as_ref();
        println!("prefix_as_ref: {:?}", prefix_as_ref);
        let mut key_without_prefix = key_without_domain_prefix
            .strip_prefix(prefix_as_ref)
            .unwrap();
        let old_key = OldInterchainGasPaymentMeta::read_from(&mut key_without_prefix)?;
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
    /*
    TODO:
    - encodes the old format to make sure decoding the new one fails
    - add test that stores the kv pair in the old format in a db
    - runs the migration
    - checks that the new format is stored in the db
    - checks that the old format is not stored in the db
    - runs the migration again to check that it fails
    */

    // Old format data:

    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 47, 115, 0, 237, 23, 87, 79, 178, 145, 223, 166, 244, 165, 251, 54, 88, 185, 17, 32, 123, 172, 115, 161, 225, 45, 84, 236, 221, 11, 229, 100, 0, 0, 0, 0, 0, 0, 0, 6], value: [1],
    // Prefixed key:  [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 102, 111, 114, 95, 109, 101, 115, 115, 97, 103, 101, 95, 105, 100, 95, 118, 50, 95, 122, 154, 96, 216, 124, 2, 112, 19, 66, 223, 104, 134, 10, 143, 93, 15, 134, 204, 21, 147, 23, 127, 120, 16, 247, 96, 211, 130, 89, 5, 190, 63]
    // new key:       [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 47, 115, 0, 237, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], new value: [1]
    // Successfully decoded old key: OldInterchainGasPaymentMeta { transaction_id: 0x66756a695f6761735f7061796d656e745f6d6574615f70726f6365737365645f76335f0000000000000000000000000000000000000000000000000000000000, log_index: 906097332 }

    // KV #2
    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 54, 1, 242, 180, 40, 39, 197, 126, 184, 139, 219, 52, 161, 186, 7, 118, 219, 57, 174, 45, 199, 184, 143, 215, 27, 245, 222, 196, 119, 46, 205, 0, 0, 0, 0, 0, 0, 0, 2], value: [1],
    // key: InterchainGasPaymentMeta { transaction_id: 0x0000000000000000000000000000000000000000000000000000000000000000003601f2b42827c57eb88bdb34a1ba0776db39ae2dc7b88fd71bf5dec4772ecd, log_index: 2 }
    // new key:       [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 54, 1, 242, 180, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], new value: [1]
    // Successfully decoded old key: OldInterchainGasPaymentMeta { transaction_id: 0x66756a695f6761735f7061796d656e745f6d6574615f70726f6365737365645f76335f0000000000000000000000000000000000000000000000000000000000, log_index: 2376419445 }

    // Migrating key: [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 141, 165, 72, 117, 188, 124, 122, 121, 247, 236, 39, 70, 198, 231, 221, 131, 62, 174, 67, 111, 217, 125, 64, 21, 20, 149, 78, 11, 249, 252, 3, 0, 0, 0, 0, 0, 0, 0, 2], value: [1],
    // new key:       [102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109, 101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 141, 165, 72, 117, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1], new value: [1]
    // Successfully decoded old key: OldInterchainGasPaymentMeta { transaction_id: 0x66756a695f6761735f7061796d656e745f6d6574615f70726f6365737365645f76335f0000000000000000000000000000000000000000000000000000000000, log_index: 2563575919 }

    use std::str::FromStr;

    use hyperlane_core::{Decode, Encode, HyperlaneDomain};

    use crate::migrations::m1::{InterchainGasPaymentMetaMigrationV0, NewInterchainGasPaymentMeta};

    use super::{Migration, OldInterchainGasPaymentMeta};

    #[test]
    fn it_cannot_decode_new_type_from_old_type() {
        let old_value = OldInterchainGasPaymentMeta::new(hyperlane_core::H512::from_str("0x0000000000000000000000000000000000000000000000000000000000000000003601f2b42827c57eb88bdb34a1ba0776db39ae2dc7b88fd71bf5dec4772ecd").unwrap(), 2);
        let encoded = old_value.to_vec();
        let old_encoded_value = vec![
            102, 117, 106, 105, 95, 103, 97, 115, 95, 112, 97, 121, 109, 101, 110, 116, 95, 109,
            101, 116, 97, 95, 112, 114, 111, 99, 101, 115, 115, 101, 100, 95, 118, 51, 95, 0, 0, 0,
            0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
            0, 54, 1, 242, 180, 40, 39, 197, 126, 184, 139, 219, 52, 161, 186, 7, 118, 219, 57,
            174, 45, 199, 184, 143, 215, 27, 245, 222, 196, 119, 46, 205, 0, 0, 0, 0, 0, 0, 0, 2,
        ];

        let prefix = InterchainGasPaymentMetaMigrationV0.prefix_key();
        let prefix_as_ref: &[u8] = prefix.as_ref();
        println!("prefix_as_ref: {:?}", prefix_as_ref);

        let new_value =
            NewInterchainGasPaymentMeta::read_from(&mut old_encoded_value.as_slice()).unwrap();
        println!(
            "Erroneously decoded new value from old encoding: {:?}",
            new_value
        );
        println!("encoded version: {:?}", encoded);
        let (migrated_key, migrated_value) = InterchainGasPaymentMetaMigrationV0
            .migrate(
                encoded,
                vec![1],
                &HyperlaneDomain::Known(hyperlane_core::KnownHyperlaneDomain::Fuji),
            )
            .unwrap();
        let new_value =
            NewInterchainGasPaymentMeta::read_from(&mut migrated_key.as_slice()).unwrap();
    }
}
