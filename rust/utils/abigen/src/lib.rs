use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use ethers::contract::Abigen;
use inflector::Inflector;

/// A `build.rs` tool for building a directory of ABIs. This will parse the `abi_dir` for ABI files
/// ending in `.json` and write the generated rust code to `output_dir` and create an appropriate
/// `mod.rs` file to.
pub fn generate_bindings_for_dir(abi_dir: impl AsRef<Path>, output_dir: impl AsRef<Path>) {
    println!("cargo:rerun-if-changed={}", abi_dir.as_ref().display());

    // clean old bindings
    if let Err(e) = fs::remove_dir_all(&output_dir) {
        println!("cargo:warning=Could not delete old bindings dir: {}", e);
    };
    fs::create_dir_all(&output_dir).expect("could not create bindings dir");

    // generate bindings and get a list of the module names
    let modules: BTreeSet<String> = fs::read_dir(abi_dir)
        .expect("could not read ABI folder")
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.to_str()
                .map(|p| p.ends_with(".abi.json"))
                .unwrap_or_default()
        })
        .map(|contract_path| {
            println!("Generating bindings for {:?}", &contract_path);
            generate_bindings(&contract_path, &output_dir)
        })
        .collect();

    // create mod.rs file
    let mod_file_path = {
        let mut p = output_dir.as_ref().to_path_buf();
        p.push("mod.rs");
        p
    };

    println!("Creating module file at {}", mod_file_path.display());
    let mut mod_file = File::create(&mod_file_path).expect("could not create modfile");
    writeln!(mod_file, "#![allow(clippy::all)]").unwrap();
    write!(mod_file, "#![allow(missing_docs)]\n\n").unwrap();
    for m in modules {
        writeln!(mod_file, "pub(crate) mod {};", m).expect("failed to write to modfile");
    }
    drop(mod_file);
}

/// Generate the bindings for a given ABI and return the new module name. Will create a file within
/// the designated path with the correct `{module_name}.rs` format.
pub fn generate_bindings(contract_path: impl AsRef<Path>, output_dir: impl AsRef<Path>) -> String {
    println!("path {:?}", contract_path.as_ref().display());
    // contract name is the first
    let contract_name = contract_path
        .as_ref()
        .file_name()
        .and_then(OsStr::to_str)
        .expect("contract filename not is not valid unicode.")
        .split('.')
        .next()
        .expect("missing extension in path");

    let module_name = contract_name.to_snake_case();

    let bindings = Abigen::new(
        contract_name,
        contract_path.as_ref().to_str().expect("valid utf8 path"),
    )
    .expect("could not instantiate Abigen")
    .generate()
    .expect("could not generate bindings");

    let output_file = {
        let mut p = output_dir.as_ref().to_path_buf();
        p.push(format!("{module_name}.rs"));
        p
    };
    bindings
        .write_to_file(&output_file)
        .expect("Could not write bidings to file");

    module_name
}
