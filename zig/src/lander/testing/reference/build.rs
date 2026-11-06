use std::{env, fs, path::PathBuf};

fn main() {
    let manifest =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"));
    let root = manifest
        .ancestors()
        .nth(5)
        .expect("helper lives under zig/src/lander/testing/reference");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    for (generated, module, relative) in [
        (
            "payload_module.rs",
            "types",
            "rust/main/lander/src/payload/types.rs",
        ),
        (
            "transaction_module.rs",
            "types",
            "rust/main/lander/src/transaction/types.rs",
        ),
        (
            "precursor_module.rs",
            "precursor",
            "rust/main/lander/src/adapter/chains/ethereum/precursor.rs",
        ),
        (
            "escalator_module.rs",
            "escalator",
            "rust/main/lander/src/adapter/chains/ethereum/adapter/gas_price/escalator.rs",
        ),
    ] {
        let source = root.join(relative);
        assert!(
            source.is_file(),
            "production source missing: {}",
            source.display()
        );
        println!("cargo:rerun-if-changed={}", source.display());
        // The path module reads the original bytes, including inner attributes;
        // no extracted or rewritten production implementation is compiled.
        fs::write(
            output.join(generated),
            format!("#[path = {:?}] pub mod {};\n", source, module),
        )
        .expect("write source path declaration");
    }
    println!("cargo:rerun-if-changed=build.rs");
}
