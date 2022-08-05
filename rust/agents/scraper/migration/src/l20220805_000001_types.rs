use sea_orm_migration::prelude::*;

pub const Hash: ColumnType = ColumnType::Binary(BlobSize::Blob(Some(256 / 8)));
pub const Address: ColumnType = ColumnType::Binary(BlobSize::Blob(Some(256 / 8)));

/// 256-bit integer as base-10 digits: ceil(log_10(2^256))
const significant_digits_in_256_bit_integer: u32 = 78;
/// At least right now all of the native tokens are scaled as 10^18
const decimal_digits_in_crypto_numeric: u32 = 18;
/// A type to represent a U256 crypto currency scaled integer value with 2^18 scaling
pub const CryptoCurrency: ColumnType = ColumnType::Decimal(Some((
    significant_digits_in_256_bit_integer,
    decimal_digits_in_crypto_numeric,
)));
