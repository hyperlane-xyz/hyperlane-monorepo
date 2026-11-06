use std::{env, fs, path::PathBuf};
fn main() {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../../../../..");
    let file = root.join("rust/main/agents/relayer/src/msg/runtime_denylist.rs");
    println!("cargo:rerun-if-changed={}", file.display());
    let source = fs::read_to_string(file).unwrap();
    let start = source
        .find("#[derive(Debug, Clone)]\nstruct MessageRule")
        .unwrap();
    let end = source
        .find("/// Shared, hot-swappable view of the runtime denylist.")
        .unwrap();
    assert!(end > start);
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("source.rs"),
        &source[start..end],
    )
    .unwrap();
}
