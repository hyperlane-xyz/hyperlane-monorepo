use std::path::PathBuf;
use std::{io, path::Path, sync::Arc};

use hyperlane_core::HyperlaneProtocolError;
use rocksdb::{DBIterator, Options, DB as Rocks};
use tracing::info;

pub use hyperlane_db::*;
pub use typed_db::*;

/// Shared functionality surrounding use of rocksdb
pub mod iterator;

/// DB operations tied to specific Mailbox
mod hyperlane_db;
/// Type-specific db operations
mod typed_db;

/// Internal-use storage types.
mod storage_types;

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

/// DB Error type
#[derive(thiserror::Error, Debug)]
pub enum DbError {
    /// Rocks DB Error
    #[error("{0}")]
    RockError(#[from] rocksdb::Error),
    #[error("Failed to open {path}, canonicalized as {canonicalized}: {source}")]
    /// Error opening the database
    OpeningError {
        /// Rocksdb error during opening
        #[source]
        source: rocksdb::Error,
        /// Raw database path provided
        path: PathBuf,
        /// Parsed path used
        canonicalized: PathBuf,
    },
    /// Could not parse the provided database path string
    #[error("Invalid database path supplied {1:?}; {0}")]
    InvalidDbPath(#[source] io::Error, String),
    /// Hyperlane Error
    #[error("{0}")]
    HyperlaneError(#[from] HyperlaneProtocolError),
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

        Rocks::open(&opts, &path)
            .map_err(|e| DbError::OpeningError {
                source: e,
                path: db_path.into(),
                canonicalized: path,
            })
            .map(Into::into)
    }

    /// Store a value in the DB
    pub fn store(&self, key: &[u8], value: &[u8]) -> Result<()> {
        Ok(self.0.put(key, value.to_vec())?)
    }

    /// Retrieve a value from the DB
    pub fn retrieve(&self, key: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self.0.get(key)?)
    }

    /// Get prefix db iterator for `prefix`
    pub fn prefix_iterator(&self, prefix: &[u8]) -> DBIterator {
        self.0.prefix_iterator(prefix)
    }
}
