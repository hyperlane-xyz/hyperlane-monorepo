//! A set of tools for working with the sea_orm date/time types.

use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{Datelike, NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use sea_orm::prelude::{TimeDate, TimeDateTime, TimeTime};

pub fn from_date_time_like(dt: &(impl Datelike + Timelike)) -> TimeDateTime {
    let date = TimeDate::from_ordinal_date(dt.year(), dt.ordinal() as u16).unwrap();
    let time = TimeTime::from_hms_nano(
        dt.hour() as u8,
        dt.minute() as u8,
        dt.second() as u8,
        dt.nanosecond(),
    )
    .unwrap();
    TimeDateTime::new(date, time)
}

/// Convert a std `SystemTime` to a sea_orm `TimeDateTime` object.
///
/// Can I just say: This should not need to exist.
/// TODO: raise a PR for `impl From<SystemTime> for TimeDateTime` because WTF.
/// TODO: raise a PR for `impl From<chrono::DateTime> for TimeDateTime` also
/// because WTF.
pub fn from_system_time(sys: &SystemTime) -> TimeDateTime {
    let dur = sys.duration_since(UNIX_EPOCH).unwrap();
    let naive =
        NaiveDateTime::from_timestamp_opt(dur.as_secs() as i64, dur.subsec_nanos()).unwrap();
    from_date_time_like(&naive)
}

/// Convert from a unix timestamp in seconds to a TimeDateTime object.
pub fn from_unix_timestamp_s(timestamp: u64) -> TimeDateTime {
    let naive = NaiveDateTime::from_timestamp_opt(timestamp as i64, 0).unwrap();
    from_date_time_like(&naive)
}

/// Convert a sql date time object to a more generic date time format
#[allow(dead_code)]
pub fn to_date_time_like(datetime: &TimeDateTime) -> NaiveDateTime {
    let hms = datetime.time().as_hms();
    let time = NaiveTime::from_hms_opt(hms.0 as u32, hms.1 as u32, hms.2 as u32).unwrap();
    let yord = datetime.date().to_ordinal_date();
    let date = NaiveDate::from_yo_opt(yord.0, yord.1 as u32).unwrap();
    NaiveDateTime::new(date, time)
}

/// Convert a sql date time object to a unix timestamp
#[allow(dead_code)]
pub fn to_unix_timestamp_s(datetime: &TimeDateTime) -> u64 {
    to_date_time_like(datetime).timestamp() as u64
}

/// Get the current time as a sql date time object
pub fn now() -> TimeDateTime {
    from_system_time(&SystemTime::now())
}
