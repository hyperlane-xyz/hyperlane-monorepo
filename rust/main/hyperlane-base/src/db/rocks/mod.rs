use std::{path::Path, sync::Arc};

use super::error::DbError;
use rocksdb::{Options, DB as Rocks};
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

#[derive(Debug, Clone)]
/// A KV Store
pub struct DB(Arc<Rocks>);

impl From<Rocks> for DB {
    fn from(rocks: Rocks) -> Self {
        Self(Arc::new(rocks))
    }
}

type Result<T> = std::result::Result<T, DbError>;

// RocksDB keeps 1,000 archived info logs by default and does not roll the current
// log by size. Agent databases live on persistent volumes, so routine restarts can
// otherwise retain years of diagnostics alongside a comparatively small database.
const ROCKSDB_INFO_LOG_FILE_COUNT: usize = 10;
const ROCKSDB_INFO_LOG_FILE_SIZE: usize = 16 * 1024 * 1024;

impl DB {
    /// Opens db at `db_path` and creates if missing
    #[tracing::instrument(err)]
    pub fn from_path(db_path: &Path) -> Result<DB> {
        Self::from_path_with_info_log_limits(
            db_path,
            ROCKSDB_INFO_LOG_FILE_COUNT,
            ROCKSDB_INFO_LOG_FILE_SIZE,
        )
    }

    fn from_path_with_info_log_limits(
        db_path: &Path,
        info_log_file_count: usize,
        info_log_file_size: usize,
    ) -> Result<DB> {
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
        opts.set_keep_log_file_num(info_log_file_count);
        opts.set_max_log_file_size(info_log_file_size);

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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounds_info_logs() {
        const TEST_INFO_LOG_FILE_SIZE: usize = 4 * 1024;

        let temp_dir = tempfile::tempdir().unwrap();
        let db_path = temp_dir.path().join("db");

        let db = DB::from_path_with_info_log_limits(
            &db_path,
            ROCKSDB_INFO_LOG_FILE_COUNT,
            TEST_INFO_LOG_FILE_SIZE,
        )
        .unwrap();
        for iteration in 0_u64..128 {
            db.store(&iteration.to_be_bytes(), &iteration.to_be_bytes())
                .unwrap();
            db.0.flush().unwrap();
        }
        assert_eq!(
            db.retrieve(&127_u64.to_be_bytes()).unwrap(),
            Some(127_u64.to_be_bytes().to_vec())
        );
        drop(db);

        let info_logs = std::fs::read_dir(db_path)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("LOG"))
            .collect::<Vec<_>>();

        assert_eq!(
            info_logs.len(),
            ROCKSDB_INFO_LOG_FILE_COUNT,
            "expected enough rotations to exercise the {ROCKSDB_INFO_LOG_FILE_COUNT}-file retention limit"
        );

        let rotated_log_sizes = info_logs
            .iter()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("LOG.old."))
            .map(|entry| entry.metadata().unwrap().len())
            .collect::<Vec<_>>();
        assert!(
            !rotated_log_sizes.is_empty(),
            "expected the {TEST_INFO_LOG_FILE_SIZE}-byte test limit to rotate the info log"
        );
        let test_info_log_file_size = u64::try_from(TEST_INFO_LOG_FILE_SIZE)
            .expect("TEST_INFO_LOG_FILE_SIZE must fit in u64");
        assert!(
            rotated_log_sizes
                .iter()
                .all(|size| *size >= test_info_log_file_size),
            "expected rotated logs to reach the configured {TEST_INFO_LOG_FILE_SIZE}-byte limit; sizes: {rotated_log_sizes:?}"
        );
    }
}
