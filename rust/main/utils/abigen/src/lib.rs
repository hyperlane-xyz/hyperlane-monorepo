#[cfg(feature = "fuels")]
use fuels_code_gen::ProgramType;
use std::collections::BTreeSet;
#[cfg(feature = "starknet")]
use std::collections::HashMap;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::Write;
use std::path::Path;

use inflector::Inflector;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum BuildType {
    Ethers,
    Fuels,
    Starknet,
}

/// A `build.rs` tool for building a directory of ABIs. This will parse the
/// `abi_dir` for ABI files ending in `.json` and write the generated rust code
/// to `output_dir` and create an appropriate `mod.rs` file to.
pub fn generate_bindings_for_dir(
    abi_dir: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    build_type: BuildType,
) {
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
            let ending_str = ".abi.json";
            path.to_str()
                .map(|p| p.ends_with(ending_str))
                .unwrap_or_default()
        })
        .map(|contract_path| {
            println!("Generating bindings for {:?}", &contract_path);
            generate_bindings(&contract_path, &output_dir, build_type)
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
    writeln!(mod_file, "#![allow(warnings)]").unwrap();
    writeln!(mod_file, "#![allow(clippy::all)]").unwrap();
    write!(mod_file, "#![allow(missing_docs)]\n\n").unwrap();
    for m in modules {
        writeln!(mod_file, "pub(crate) mod {};", m).expect("failed to write to modfile");
    }
    drop(mod_file);
}

/// Generate the bindings for a given ABI and return the new module name. Will
/// create a file within the designated path with the correct `{module_name}.rs`
/// format.
// We allow unused variables due to some feature flagging.
#[allow(unused_variables)]
pub fn generate_bindings(
    contract_path: impl AsRef<Path>,
    output_dir: impl AsRef<Path>,
    build_type: BuildType,
) -> String {
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

    let output_file = {
        let mut p = output_dir.as_ref().to_path_buf();
        p.push(format!("{module_name}.rs"));
        p
    };

    let abi_source = contract_path.as_ref().to_str().expect("valid utf8 path");
    #[cfg(feature = "ethers")]
    if build_type == BuildType::Ethers {
        ethers::contract::Abigen::new(contract_name, abi_source)
            .expect("could not instantiate Abigen")
            .generate()
            .expect("could not generate bindings")
            .write_to_file(&output_file)
            .expect("Could not write bindings to file");
    }
    #[cfg(feature = "fuels")]
    if build_type == BuildType::Fuels {
        let abi =
            fuels_code_gen::Abi::load_from(contract_path.as_ref()).expect("could not load abi");
        let tokens = fuels_code_gen::Abigen::generate(
            vec![fuels_code_gen::AbigenTarget::new(
                contract_name.into(),
                abi,
                ProgramType::Contract,
            )],
            false,
        )
        .expect("could not generate bindings")
        .to_string();
        let mut outfile = File::create(&output_file).expect("Could not open output file");
        outfile
            .write_all(tokens.as_bytes())
            .expect("Could not write bindings to file");

        fmt_file(&output_file);
    }
    #[cfg(feature = "starknet")]
    if build_type == BuildType::Starknet {
        let mut aliases = HashMap::new();
        aliases.insert(
            String::from("openzeppelin::access::ownable::ownable::OwnableComponent::Event"),
            String::from("OwnableCptEvent"),
        );
        aliases.insert(
            String::from("openzeppelin::upgrades::upgradeable::UpgradeableComponent::Event"),
            String::from("UpgradeableCptEvent"),
        );
        aliases.insert(
            String::from("hyperlane_starknet::contracts::client::mailboxclient_component::MailboxclientComponent::Event"),
            String::from("MailboxclientCptEvent")
        );

        let abigen = cainome::rs::Abigen::new(contract_name, abi_source)
            .with_types_aliases(aliases)
            .with_execution_version(cainome::rs::ExecutionVersion::V3)
            .with_derives(vec![
                "Debug".to_owned(),
                "PartialEq".to_owned(),
                "serde::Serialize".to_owned(),
                "serde::Deserialize".to_owned(),
            ])
            .with_contract_derives(vec![
                "Debug".to_owned(),
                "Clone".to_owned(),
                "serde::Serialize".to_owned(),
                "serde::Deserialize".to_owned(),
            ]);

        abigen
            .generate()
            .expect("Fail to generate bindings")
            .write_to_file(output_file.to_str().expect("valid utf8 path"))
            .expect("Fail to write bindings to file");
    }

    module_name
}

#[cfg(feature = "fmt")]
fn fmt_file(path: &Path) {
    if let Err(err) = std::process::Command::new(rustfmt_path())
        .args(["--edition", "2021"])
        .arg(path)
        .output()
    {
        println!("cargo:warning=Failed to run rustfmt for {path:?}, ignoring ({err})");
    }
}

/// Get the rustfmt binary path.
#[cfg(feature = "fmt")]
fn rustfmt_path() -> &'static Path {
    use std::path::PathBuf;

    // lazy static var
    static mut PATH: Option<PathBuf> = None;

    if let Some(path) = unsafe { PATH.as_ref() } {
        return path;
    }

    if let Ok(path) = std::env::var("RUSTFMT") {
        unsafe {
            PATH = Some(PathBuf::from(path));
            PATH.as_ref().unwrap()
        }
    } else {
        // assume it is in PATH
        unsafe {
            PATH = Some(which::which("rustmft").unwrap_or_else(|_| "rustfmt".into()));
            PATH.as_ref().unwrap()
        }
    }
}
