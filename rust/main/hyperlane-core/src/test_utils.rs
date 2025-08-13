use std::fs::File;
use std::io::Read;
use std::path::PathBuf;

use crate::accumulator::merkle::Proof;
use crate::{HyperlaneDomain, H256};

/// Struct representing a single merkle test case
#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MerkleTestCase {
    /// Test case name
    pub test_name: String,
    /// Leaves of merkle tree
    pub leaves: Vec<String>,
    /// Proofs for leaves in tree
    pub proofs: Vec<Proof>,
    /// Root of tree
    pub expected_root: H256,
}

/// Reads merkle test case json file and returns a vector of `MerkleTestCase`s
pub fn load_merkle_test_json() -> Vec<MerkleTestCase> {
    let mut file = File::open(find_vector("merkle.json")).expect("merkle.json missing");
    let mut data = String::new();
    file.read_to_string(&mut data)
        .expect("Failed to read merkle.json");
    serde_json::from_str(&data).expect("Failed to parse merkle.json")
}

/// Find a vector file assuming that a git checkout exists
// TODO: look instead for the workspace `Cargo.toml`? use a cargo env var?
pub fn find_vector(final_component: &str) -> PathBuf {
    let cwd = std::env::current_dir().expect("no cwd?");
    let git_dir = cwd
        .ancestors() // . ; ../ ; ../../ ; ...
        .find(|d| d.join(".git").is_dir())
        .expect("could not find .git somewhere! confused about workspace layout");

    git_dir.join("vectors").join(final_component)
}

/// Create a dummy domain for testing purposes
pub fn dummy_domain(domain_id: u32, name: &str) -> HyperlaneDomain {
    let test_domain = HyperlaneDomain::new_test_domain(name);
    HyperlaneDomain::Unknown {
        domain_id,
        domain_name: name.to_owned(),
        domain_type: test_domain.domain_type(),
        domain_protocol: test_domain.domain_protocol(),
        domain_technical_stack: test_domain.domain_technical_stack(),
    }
}
