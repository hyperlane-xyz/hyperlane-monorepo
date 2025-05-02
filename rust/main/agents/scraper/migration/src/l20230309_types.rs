use sea_orm_migration::prelude::*;

/// Hashes are to be stored as binary.
#[allow(non_upper_case_globals)]
pub const Hash: ColumnType = ColumnType::Blob;
/// Addresses are to be stored as binary.
#[allow(non_upper_case_globals)]
pub const Address: ColumnType = ColumnType::Blob;

/// 256-bit integer as base-10 digits: ceil(log_10(2^256))
const SIGNIFICANT_DIGITS_IN_256_BIT_INTEGER: u32 = 78;
/// A type to represent a U256 crypto currency Wei value.
#[allow(non_upper_case_globals)]
pub const Wei: ColumnType = ColumnType::Decimal(Some((SIGNIFICANT_DIGITS_IN_256_BIT_INTEGER, 0)));
