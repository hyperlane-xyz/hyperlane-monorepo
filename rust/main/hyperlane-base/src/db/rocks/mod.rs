use std::{path::Path, sync::Arc};

use super::error::DbError;
use rocksdb::{Direction, IteratorMode, Options, WriteBatch, WriteBatchIterator, DB as Rocks};
use tracing::info;

pub use hyperlane_db::*;
pub use typed_db::*;

/// Shared functionality surrounding use of rocksdb
pub mod iterator;

/// DB operations tied to specific Mailbox
mod hyperlane_db;
/// Type-specific db operations
mod typed_db;

/// Database test utilities.
#[cfg(any(test, feature = "test-utils"))]
pub mod test_utils;

// Keep enough archived WAL to make rollback detection cheap during the normal
// deployment rollback window. Sequence continuity checks below make expiration
// safe by forcing a full derived-index rebuild when history is unavailable.
const ROLLBACK_WAL_RETENTION_SECONDS: u64 = 7 * 24 * 60 * 60;
// Cap the retained fast path so a high-write database cannot grow without bound.
const ROLLBACK_WAL_SIZE_LIMIT_MB: u64 = 1_024;

#[derive(Debug, Clone)]
/// A KV Store
pub struct DB(Arc<Rocks>);

/// A set of writes committed atomically to RocksDB.
pub struct DbBatch {
    db: DB,
    writes: WriteBatch,
}

struct PrefixWriteDetector<'a> {
    source_prefix: &'a [u8],
    marker_prefix: &'a [u8],
    source_written: bool,
    marker_written: bool,
}

impl PrefixWriteDetector<'_> {
    fn record(&mut self, key: &[u8]) {
        self.source_written |= key.starts_with(self.source_prefix);
        self.marker_written |= key.starts_with(self.marker_prefix);
    }
}

impl WriteBatchIterator for PrefixWriteDetector<'_> {
    fn put(&mut self, key: &[u8], _value: &[u8]) {
        self.record(key);
    }

    fn delete(&mut self, key: &[u8]) {
        self.record(key);
    }
}

impl From<Rocks> for DB {
    fn from(rocks: Rocks) -> Self {
        Self(Arc::new(rocks))
    }
}

type Result<T> = std::result::Result<T, DbError>;

impl DB {
    /// Opens db at `db_path` and creates if missing
    #[tracing::instrument(err)]
    pub fn from_path(db_path: &Path) -> Result<DB> {
        let path = {
            let mut path = db_path
                .parent()
                .unwrap_or(Path::new("."))
                .canonicalize()
                .map_err(|e| DbError::InvalidDbPath(e, db_path.to_string_lossy().into()))?;
            if let Some(file_name) = db_path.file_name() {
                path.push(file_name);
            }
            path
        };

        if path.is_dir() {
            info!(path=%path.to_string_lossy(), "Opening existing db")
        } else {
            info!(path=%path.to_string_lossy(), "Creating db")
        }

        let mut opts = Options::default();
        opts.create_if_missing(true);
        opts.set_wal_ttl_seconds(ROLLBACK_WAL_RETENTION_SECONDS);
        opts.set_wal_size_limit_mb(ROLLBACK_WAL_SIZE_LIMIT_MB);

        Rocks::open(&opts, &path)
            .map_err(|e| DbError::OpeningError {
                source: Box::new(e),
                path: db_path.into(),
                canonicalized: path,
            })
            .map(Into::into)
    }

    /// Store a value in the DB
    pub fn store(&self, key: &[u8], value: &[u8]) -> Result<()> {
        Ok(self.0.put(key, value)?)
    }

    /// Retrieve a value from the DB
    pub fn retrieve(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self.0.get(key)?)
    }

    /// Retrieve all values stored under a key prefix.
    pub fn retrieve_values_by_prefix(&self, prefix: &[u8]) -> Result<Vec<Vec<u8>>> {
        let mut values = Vec::new();
        for item in self
            .0
            .iterator(IteratorMode::From(prefix, Direction::Forward))
        {
            let (key, value) = item?;
            if !key.starts_with(prefix) {
                break;
            }
            values.push(value.to_vec());
        }
        Ok(values)
    }

    /// Return the latest RocksDB sequence number.
    pub fn latest_sequence_number(&self) -> u64 {
        self.0.latest_sequence_number()
    }

    /// Detect source-prefix writes not accompanied by a marker-prefix write in
    /// the same atomic batch. This lets derived indexes detect writes from an
    /// older binary which does not maintain them.
    pub fn has_unmarked_writes_since(
        &self,
        sequence: u64,
        source_prefix: &[u8],
        marker_prefix: &[u8],
    ) -> Result<bool> {
        let latest_sequence = self.0.latest_sequence_number();
        let mut expected_sequence = sequence
            .checked_add(1)
            .ok_or_else(|| DbError::Other("RocksDB sequence number overflowed".to_string()))?;

        for update in self.0.get_updates_since(sequence)? {
            let (batch_sequence, batch) = update?;
            if batch_sequence != expected_sequence {
                return Err(DbError::Other(format!(
                    "RocksDB WAL history is incomplete: expected sequence {expected_sequence}, found {batch_sequence}"
                )));
            }
            expected_sequence = batch_sequence
                .checked_add(batch.len() as u64)
                .ok_or_else(|| DbError::Other("RocksDB sequence number overflowed".to_string()))?;
            let mut detector = PrefixWriteDetector {
                source_prefix,
                marker_prefix,
                source_written: false,
                marker_written: false,
            };
            batch.iterate(&mut detector);
            if detector.source_written && !detector.marker_written {
                return Ok(true);
            }
        }

        let sequence_after_latest = latest_sequence
            .checked_add(1)
            .ok_or_else(|| DbError::Other("RocksDB sequence number overflowed".to_string()))?;
        if expected_sequence < sequence_after_latest {
            return Err(DbError::Other(format!(
                "RocksDB WAL history ended at sequence {}, before latest sequence {latest_sequence}",
                expected_sequence.saturating_sub(1)
            )));
        }
        Ok(false)
    }

    /// Start an atomic write batch.
    pub fn batch(&self) -> DbBatch {
        DbBatch {
            db: self.clone(),
            writes: WriteBatch::default(),
        }
    }
}

impl DbBatch {
    /// Store a raw key/value pair in this batch.
    pub fn store(&mut self, key: &[u8], value: &[u8]) {
        self.writes.put(key, value);
    }

    /// Delete a raw key in this batch.
    pub fn delete(&mut self, key: &[u8]) {
        self.writes.delete(key);
    }

    /// Delete a raw key range in this batch.
    pub fn delete_range(&mut self, start: &[u8], end: &[u8]) {
        self.writes.delete_range(start, end);
    }

    /// Atomically commit this batch.
    pub fn commit(self) -> Result<()> {
        Ok(self.db.0.write(self.writes)?)
    }
}

#[cfg(test)]
mod tests {
    use rocksdb::{Options, WriteBatch, DB as Rocks};

    use super::DB;

    #[test]
    fn rejects_incomplete_wal_history() {
        let temp_dir = tempfile::tempdir().unwrap();
        let mut options = Options::default();
        options.create_if_missing(true);

        let checkpoint;
        {
            let db = Rocks::open(&options, temp_dir.path()).unwrap();
            db.put(b"checkpoint", b"1").unwrap();
            checkpoint = db.latest_sequence_number();
            db.put(b"source_old", b"ready").unwrap();
            db.flush().unwrap();

            let mut batch = WriteBatch::default();
            batch.put(b"source_new", b"ready");
            batch.put(b"marker", b"1");
            db.write(batch).unwrap();
        }

        let db = DB::from(Rocks::open(&options, temp_dir.path()).unwrap());
        assert!(db
            .has_unmarked_writes_since(checkpoint, b"source_", b"marker")
            .is_err());
    }

    #[test]
    fn accepts_contiguous_marked_batches() {
        let temp_dir = tempfile::tempdir().unwrap();
        let db = DB::from(Rocks::open_default(temp_dir.path()).unwrap());
        db.store(b"checkpoint", b"1").unwrap();
        let checkpoint = db.latest_sequence_number();

        let mut batch = db.batch();
        batch.store(b"source_one", b"ready");
        batch.store(b"marker", b"1");
        batch.commit().unwrap();
        let mut batch = db.batch();
        batch.store(b"source_two", b"ready");
        batch.store(b"marker", b"1");
        batch.commit().unwrap();

        assert!(!db
            .has_unmarked_writes_since(checkpoint, b"source_", b"marker")
            .unwrap());
    }
}
