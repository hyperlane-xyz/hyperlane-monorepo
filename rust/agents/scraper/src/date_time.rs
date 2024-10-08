//! A set of tools for working with the sea_orm date/time types.

use sea_orm::prelude::TimeDateTime;
use time::OffsetDateTime;

/// Convert from a unix timestamp in seconds to a TimeDateTime object.
pub fn from_unix_timestamp_s(timestamp: u64) -> TimeDateTime {
    let offset = OffsetDateTime::from_unix_timestamp(timestamp as i64).unwrap();
    TimeDateTime::new(offset.date(), offset.time())
}

/// Get the current time as a sql date time object
pub fn now() -> TimeDateTime {
    let offset = OffsetDateTime::now_utc();
    TimeDateTime::new(offset.date(), offset.time())
}
