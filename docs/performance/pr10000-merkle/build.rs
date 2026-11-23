use std::{env, error::Error, fs, io, path::Path, path::PathBuf, process::Command};

const BASE: &str = "e8689117d985dd27bdf83163d7a2883f88b57579";
const RELAYER: &str = "rust/main/agents/relayer/src";

fn source(root: &Path, path: &str, baseline: bool) -> Result<String, Box<dyn Error>> {
    if !baseline {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
        return Ok(fs::read_to_string(root.join(path))?);
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["show", &format!("{BASE}:{path}")])
        .output()?;
    if !output.status.success() {
        return Err(io::Error::other(format!("could not read {BASE}:{path}")).into());
    }
    Ok(String::from_utf8(output.stdout)?)
}

fn production(source: &str) -> String {
    source
        .split("#[cfg(test)]")
        .next()
        .unwrap_or(source)
        .replace("//!", "//")
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR")?)
        .join("../../..")
        .canonicalize()?;
    let output = PathBuf::from(env::var("OUT_DIR")?);
    let packed_path = root.join(format!("{RELAYER}/prover/packed.rs"));
    println!("cargo:rerun-if-changed={}", packed_path.display());
    let prover = production(&source(&root, &format!("{RELAYER}/prover.rs"), false)?);
    fs::write(
        output.join("prover.rs"),
        prover.replace(
            "mod packed;",
            &format!("#[path = {packed_path:?}]\nmod packed;"),
        ),
    )?;

    // Compile the original production source alongside the candidate. Only
    // test modules, leading comments, and module/import paths are changed.
    let baseline_packed = output.join("baseline_packed.rs");
    fs::write(
        &baseline_packed,
        production(&source(
            &root,
            &format!("{RELAYER}/prover/packed.rs"),
            true,
        )?),
    )?;
    let baseline_prover = production(&source(&root, &format!("{RELAYER}/prover.rs"), true)?);
    fs::write(
        output.join("baseline_prover.rs"),
        baseline_prover.replace(
            "mod packed;",
            &format!("#[path = {baseline_packed:?}]\nmod packed;"),
        ),
    )?;
    let baseline_builder = production(&source(
        &root,
        &format!("{RELAYER}/merkle_tree/builder.rs"),
        true,
    )?);
    fs::write(
        output.join("baseline_builder.rs"),
        baseline_builder.replace("crate::prover::", "crate::baseline_prover::"),
    )?;
    Ok(())
}
