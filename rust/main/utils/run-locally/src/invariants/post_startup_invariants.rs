use std::fs::File;
use std::io::BufReader;

use hyperlane_base::AgentMetadata;

use crate::{log, DynPath};

pub fn post_startup_invariants(checkpoints_dirs: &[DynPath]) -> bool {
    post_startup_validator_metadata_written(checkpoints_dirs)
}

fn post_startup_validator_metadata_written(checkpoints_dirs: &[DynPath]) -> bool {
    let expected_git_sha = env!("VERGEN_GIT_SHA");

    let failed_metadata = checkpoints_dirs
        .iter()
        .map(|path| metadata_file_check(expected_git_sha, path))
        .any(|b| !b);

    !failed_metadata
}

fn metadata_file_check(expected_git_sha: &str, path: &DynPath) -> bool {
    let path = (*path).as_ref().as_ref();
    if !path.exists() {
        return false;
    }

    let file = path.join("metadata_latest.json");
    if !file.exists() {
        return false;
    }

    let open = File::open(&file);
    let mut reader = if let Ok(file) = open {
        BufReader::new(file)
    } else {
        return false;
    };

    let deserialized = serde_json::from_reader(&mut reader);

    let metadata: AgentMetadata = if let Ok(metadata) = deserialized {
        metadata
    } else {
        return false;
    };

    if metadata.git_sha != expected_git_sha {
        log!("Error: Metadata git hash mismatch, maybe try `cargo clean` and try again");
        return false;
    }

    true
}
