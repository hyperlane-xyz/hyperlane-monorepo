use std::fs;

fn main() {
    // TODO: build the cosmos contracts/bindings
    fs::create_dir_all("src/contracts").expect("failed to create contracts dir");
    fs::write("src/contracts/mod.rs", "// TODO: this should be generated")
        .expect("failed to write contracts/mod.rs");
}
