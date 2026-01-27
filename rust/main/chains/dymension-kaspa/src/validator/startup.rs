//! Startup verification for Kaspa validators using local lock files.
//!
//! When a validator enters migration mode, it writes a lock file containing
//! the new escrow address. When it later starts in normal mode, it verifies
//! the configured escrow matches what was written, ensuring operators update
//! their config after migration.

use std::fs;
use std::path::Path;
use tracing::info;

const MIGRATION_LOCK_FILENAME: &str = "kaspa_migration.lock";

/// Write a migration lock file when entering migration mode.
///
/// The lock file contains the new escrow address (migration target).
/// This file must be resolved before the validator can start in normal mode.
pub fn write_migration_lock(data_dir: &Path, new_escrow_address: &str) -> std::io::Result<()> {
    let lock_path = data_dir.join(MIGRATION_LOCK_FILENAME);
    fs::write(&lock_path, new_escrow_address)?;
    info!(
        lock_file = %lock_path.display(),
        new_escrow = %new_escrow_address,
        "Migration lock file written. After migration completes, update \
         kaspaValidatorsEscrow config to match this address and restart in normal mode."
    );
    Ok(())
}

/// Check migration lock file when starting in normal mode.
///
/// - If lock file exists and configured escrow matches: delete file, return Ok
/// - If lock file exists and configured escrow mismatches: return Err (should panic)
/// - If no lock file: return Ok (operator deleted it or never was in migration mode)
pub fn check_migration_lock(
    data_dir: &Path,
    configured_escrow: &str,
) -> Result<(), MigrationLockError> {
    let lock_path = data_dir.join(MIGRATION_LOCK_FILENAME);

    if !lock_path.exists() {
        // No lock file - either never migrated or operator manually cleared it
        return Ok(());
    }

    let expected_escrow =
        fs::read_to_string(&lock_path).map_err(|e| MigrationLockError::ReadError {
            path: lock_path.display().to_string(),
            reason: e.to_string(),
        })?;

    let expected_escrow = expected_escrow.trim();

    if configured_escrow == expected_escrow {
        // Config matches - delete the lock file and continue
        fs::remove_file(&lock_path).map_err(|e| MigrationLockError::DeleteError {
            path: lock_path.display().to_string(),
            reason: e.to_string(),
        })?;
        info!(
            escrow = %configured_escrow,
            "Migration lock file validated and removed. Escrow config is correct."
        );
        Ok(())
    } else {
        Err(MigrationLockError::EscrowMismatch {
            lock_file: lock_path.display().to_string(),
            expected: expected_escrow.to_string(),
            configured: configured_escrow.to_string(),
        })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum MigrationLockError {
    #[error(
        "Escrow configuration mismatch after migration!\n\
         Lock file: {lock_file}\n\
         Expected escrow (from migration): {expected}\n\
         Configured escrow: {configured}\n\n\
         Please update kaspaValidatorsEscrow in your config to: {expected}\n\
         Or if you're sure your config is correct, delete the lock file manually."
    )]
    EscrowMismatch {
        lock_file: String,
        expected: String,
        configured: String,
    },

    #[error("Failed to read migration lock file {path}: {reason}")]
    ReadError { path: String, reason: String },

    #[error("Failed to delete migration lock file {path}: {reason}")]
    DeleteError { path: String, reason: String },
}
