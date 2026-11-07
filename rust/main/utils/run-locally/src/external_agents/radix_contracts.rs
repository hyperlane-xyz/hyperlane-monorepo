//! Approved data-only Radix release inputs. Never downloads or authorizes tools.
use super::{
    checked_owned_path, verified_contract_text, verify_owned_contract_data, Artifact, Manifest,
    UniqueCaseJson,
};
use eyre::{ensure, Result};
use serde::Deserialize;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::PathBuf,
};

const RELEASE: &str = "1.0.0";
const RELEASE_URL: &str = "https://github.com/hyperlane-xyz/hyperlane-radix/releases/tag/v1.0.0";
const DOWNLOAD: &str = "https://github.com/hyperlane-xyz/hyperlane-radix/releases/download/v1.0.0/";
const NAMES: [&str; 2] = ["hyperlane_radix.rpd", "hyperlane_radix.wasm"];
const MAX_FILE: u64 = 32 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Inputs {
    schema: u32,
    scenario: String,
    source_release: String,
    root: PathBuf,
    release_metadata: Artifact,
    files: BTreeMap<String, Artifact>,
}

fn validate_metadata(inputs: &Inputs) -> Result<()> {
    let text = verified_contract_text(&inputs.release_metadata, 1024 * 1024)?;
    let release = serde_json::from_str::<UniqueCaseJson>(&text)?.0;
    ensure!(
        release["tag_name"] == "v1.0.0"
            && release["html_url"] == RELEASE_URL
            && release["draft"] == false
            && release["prerelease"] == false
            && release["id"].as_u64().is_some_and(|id| id > 0),
        "wrong official Source release metadata"
    );
    let assets = release["assets"]
        .as_array()
        .ok_or_else(|| eyre::eyre!("release assets missing"))?;
    ensure!(assets.len() <= 64, "release metadata asset bound");
    for name in NAMES {
        let matching: Vec<_> = assets
            .iter()
            .filter(|asset| asset["name"].as_str() == Some(name))
            .collect();
        ensure!(matching.len() == 1, "release asset missing or duplicated");
        let asset = matching[0];
        let file = &inputs.files[name];
        ensure!(
            asset["id"].as_u64().is_some_and(|id| id > 0)
                && asset["state"] == "uploaded"
                && asset["size"].as_u64() == Some(file.bytes)
                && asset["browser_download_url"].as_str()
                    == Some(format!("{DOWNLOAD}{name}").as_str()),
            "release asset identity/Source URL/size differs"
        );
        // GitHub did not always publish asset digests. An absent digest is not
        // publisher integrity; the pinned metadata and file bytes still need
        // explicit Root approval. Never invent a publisher checksum.
        if !asset["digest"].is_null() {
            ensure!(
                asset["digest"].as_str() == Some(format!("sha256:{}", file.sha256).as_str()),
                "published release digest differs"
            );
        }
    }
    Ok(())
}

pub(super) fn validate(manifest: &Manifest, value: &serde_json::Value) -> Result<PathBuf> {
    let inputs: Inputs = serde_json::from_value(value.clone())?;
    ensure!(
        manifest.scenario == "radix"
            && inputs.schema == 1
            && inputs.scenario == "radix"
            && inputs.source_release == RELEASE,
        "wrong Radix contract schema/scenario/release"
    );
    ensure!(
        inputs.files.keys().map(String::as_str).collect::<Vec<_>>() == NAMES,
        "exact Radix WASM/RPD pair required"
    );
    let approval_text =
        verified_contract_text(&manifest.execution_approval, super::MAX_CONTRACT_CASE_BYTES)?;
    let approval = serde_json::from_str::<UniqueCaseJson>(&approval_text)?.0;
    ensure!(
        approval["root_approved"] == true
            && approval["scenario"] == "radix"
            && approval["mode"] == manifest.mode
            && approval["runtime_source_commit"] == manifest.runtime_source_commit
            && approval["case_inputs"] == serde_json::to_value(&manifest.case_inputs)?
            && approval["fixture_contracts"] == *value,
        "Radix contract data approval differs"
    );
    let root = checked_owned_path(
        &manifest.task_root,
        inputs.root.strip_prefix(&manifest.task_root)?,
    )?;
    ensure!(
        root.is_dir() && root == inputs.root.canonicalize()?,
        "Radix contract root differs/escaped"
    );
    verify_owned_contract_data(manifest, &inputs.release_metadata)?;
    let mut actual = BTreeSet::new();
    for item in fs::read_dir(&root)? {
        let item = item?;
        ensure!(
            item.file_type()?.is_file() && !item.file_type()?.is_symlink(),
            "Radix contract directory contains non-file"
        );
        ensure!(
            actual.insert(
                item.file_name()
                    .into_string()
                    .map_err(|_| eyre::eyre!("non-UTF8 contract name"))?
            ) && actual.len() <= 2,
            "extra/duplicate Radix contract member"
        );
    }
    ensure!(
        actual == NAMES.into_iter().map(str::to_owned).collect(),
        "Radix contract directory differs"
    );
    for (name, file) in &inputs.files {
        ensure!(
            file.path == root.join(name) && file.bytes > 0 && file.bytes <= MAX_FILE,
            "Radix contract path/byte bound differs"
        );
        verify_owned_contract_data(manifest, file)?;
    }
    let mut header = [0u8; 8];
    fs::File::open(&inputs.files["hyperlane_radix.wasm"].path)?.read_exact(&mut header)?;
    ensure!(
        header == *b"\0asm\x01\0\0\0",
        "Radix module is not WASM1 data"
    );
    validate_metadata(&inputs)?;
    Ok(root)
}

pub(super) fn paths(manifest: &Manifest) -> Result<(PathBuf, PathBuf)> {
    let text = verified_contract_text(&manifest.case_inputs, super::MAX_CONTRACT_CASE_BYTES)?;
    let case = serde_json::from_str::<UniqueCaseJson>(&text)?.0;
    ensure!(
        case["schema"] == 1 && case["scenario"] == "radix",
        "Radix contract case family/schema differs"
    );
    let root = validate(
        manifest,
        case.get("fixture_contracts")
            .ok_or_else(|| eyre::eyre!("external Radix contracts absent"))?,
    )?;
    Ok((
        root.join("hyperlane_radix.wasm"),
        root.join("hyperlane_radix.rpd"),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use sha2::Digest;
    fn write(path: PathBuf, bytes: &[u8]) -> Artifact {
        fs::write(&path, bytes).expect("fixture write");
        Artifact {
            bytes: bytes.len() as u64,
            sha256: hex::encode(sha2::Sha256::digest(bytes)),
            path,
        }
    }
    fn fixture() -> (tempfile::TempDir, Manifest, Value) {
        let temp = tempfile::tempdir().expect("fixture root");
        let root = temp.path().canonicalize().expect("canonical root");
        fs::create_dir(root.join("contracts")).expect("contract root");
        let files = BTreeMap::from([
            (
                NAMES[0],
                write(root.join("contracts").join(NAMES[0]), b"rpd fixture bytes"),
            ),
            (
                NAMES[1],
                write(
                    root.join("contracts").join(NAMES[1]),
                    b"\0asm\x01\0\0\0fixture",
                ),
            ),
        ]);
        let metadata = json!({"id":1,"tag_name":"v1.0.0","html_url":RELEASE_URL,"draft":false,"prerelease":false,"assets":NAMES.iter().enumerate().map(|(i,name)|json!({"id":i+1,"name":name,"state":"uploaded","size":files[name].bytes,"browser_download_url":format!("{DOWNLOAD}{name}"),"digest":null})).collect::<Vec<_>>()});
        let metadata = write(
            root.join("release.json"),
            &serde_json::to_vec(&metadata).expect("metadata JSON"),
        );
        let bundle = json!({"schema":1,"scenario":"radix","source_release":RELEASE,"root":root.join("contracts"),"release_metadata":metadata,"files":files});
        let case_inputs = write(
            root.join("case.json"),
            &serde_json::to_vec(&json!({"schema":1,"scenario":"radix","fixture_contracts":bundle}))
                .expect("case JSON"),
        );
        let placeholder = write(root.join("placeholder"), b"unused");
        let mut manifest = Manifest {
            schema: 3,
            implementation: "zig".into(),
            scenario: "radix".into(),
            runtime_source_commit: "a".repeat(40),
            mode: "ReleaseSafe".into(),
            task_root: root.clone(),
            artifacts: BTreeMap::new(),
            environment: BTreeMap::new(),
            verifier: super::super::Verifier {
                python: placeholder.clone(),
                script: placeholder.clone(),
                evidence_root: root.clone(),
            },
            execution_approval: placeholder,
            case_inputs,
            verifier_tools: BTreeMap::new(),
            harness_deadline_seconds: 3600,
            tool_overrides: BTreeMap::new(),
        };
        approve(&mut manifest, &bundle);
        (temp, manifest, bundle)
    }
    fn approve(manifest: &mut Manifest, bundle: &Value) {
        let approval = json!({"root_approved":true,"scenario":"radix","mode":manifest.mode,"runtime_source_commit":manifest.runtime_source_commit,"case_inputs":manifest.case_inputs,"fixture_contracts":bundle});
        manifest.execution_approval = write(
            manifest.task_root.join("approval.json"),
            &serde_json::to_vec(&approval).expect("approval JSON"),
        );
    }
    #[test]
    fn approved_pair_is_owned_data_and_default_path_remains_none() {
        let (_temp, manifest, bundle) = fixture();
        assert!(validate(&manifest, &bundle).is_ok());
        assert_eq!(
            paths(&manifest)
                .expect("approved paths")
                .0
                .file_name()
                .expect("name"),
            "hyperlane_radix.wasm"
        );
        assert!(super::super::radix_contract_paths_with(None)
            .expect("default path")
            .is_none());
    }
    #[test]
    fn missing_changed_extra_and_foreign_release_fail_before_download() {
        let (_temp, mut manifest, bundle) = fixture();
        for key in ["source_release", "scenario"] {
            let mut changed = bundle.clone();
            changed[key] = json!("foreign");
            approve(&mut manifest, &changed);
            assert!(validate(&manifest, &changed).is_err());
        }
        approve(&mut manifest, &bundle);
        fs::write(manifest.task_root.join("contracts/extra"), b"extra").expect("extra");
        assert!(validate(&manifest, &bundle).is_err());
        fs::remove_file(manifest.task_root.join("contracts/extra")).expect("remove extra");
        fs::write(
            manifest.task_root.join("contracts/hyperlane_radix.rpd"),
            b"changed",
        )
        .expect("changed");
        assert!(validate(&manifest, &bundle).is_err());
        fs::remove_file(manifest.task_root.join("contracts/hyperlane_radix.rpd")).expect("remove");
        assert!(validate(&manifest, &bundle).is_err());
    }
    #[test]
    fn unapproved_crossed_case_and_duplicate_json_never_authorize_pair() {
        let (_temp, mut manifest, bundle) = fixture();
        let mut approval: Value =
            serde_json::from_slice(&fs::read(&manifest.execution_approval.path).expect("read"))
                .expect("JSON");
        approval["root_approved"] = json!(false);
        manifest.execution_approval = write(
            manifest.execution_approval.path.clone(),
            &serde_json::to_vec(&approval).expect("JSON"),
        );
        assert!(validate(&manifest, &bundle).is_err());
        approve(&mut manifest, &bundle);
        manifest.scenario = "sealevel".into();
        assert!(validate(&manifest, &bundle).is_err());
        manifest.scenario = "radix".into();
        manifest.case_inputs = write(
            manifest.case_inputs.path.clone(),
            br#"{"fixture_contracts":{},"fixture_contracts":{}}"#,
        );
        assert!(paths(&manifest).is_err());
    }
    #[test]
    fn metadata_source_url_size_digest_and_duplicates_are_strict() {
        let (_temp, manifest, bundle) = fixture();
        let mut inputs: Inputs = serde_json::from_value(bundle).expect("inputs");
        let original: Value =
            serde_json::from_slice(&fs::read(&inputs.release_metadata.path).expect("read"))
                .expect("metadata JSON");
        for field in ["tag_name", "url", "size", "digest", "duplicate"] {
            let mut metadata = original.clone();
            match field {
                "tag_name" => metadata["tag_name"] = json!("latest"),
                "url" => {
                    metadata["assets"][0]["browser_download_url"] =
                        json!("https://foreign.invalid/file")
                }
                "size" => metadata["assets"][0]["size"] = json!(1),
                "digest" => {
                    metadata["assets"][0]["digest"] = json!(format!("sha256:{}", "0".repeat(64)))
                }
                _ => {
                    let duplicate = metadata["assets"][0].clone();
                    metadata["assets"]
                        .as_array_mut()
                        .expect("assets")
                        .push(duplicate);
                }
            }
            inputs.release_metadata = write(
                inputs.release_metadata.path.clone(),
                &serde_json::to_vec(&metadata).expect("metadata JSON"),
            );
            assert!(validate_metadata(&inputs).is_err(), "{field}");
        }
        assert_eq!(manifest.scenario, "radix");
    }
    #[test]
    fn present_publisher_digest_must_match_and_absence_is_explicit() {
        let (_temp, _manifest, bundle) = fixture();
        let mut inputs: Inputs = serde_json::from_value(bundle).expect("inputs");
        assert!(validate_metadata(&inputs).is_ok());
        let mut metadata: Value =
            serde_json::from_slice(&fs::read(&inputs.release_metadata.path).expect("read"))
                .expect("metadata JSON");
        for asset in metadata["assets"].as_array_mut().expect("assets") {
            let name = asset["name"].as_str().expect("name");
            asset["digest"] = json!(format!("sha256:{}", inputs.files[name].sha256));
        }
        inputs.release_metadata = write(
            inputs.release_metadata.path.clone(),
            &serde_json::to_vec(&metadata).expect("metadata JSON"),
        );
        assert!(validate_metadata(&inputs).is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn executable_symlink_and_hardlink_data_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let (_temp, mut manifest, mut bundle) = fixture();
        let path = manifest.task_root.join("contracts/hyperlane_radix.rpd");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).expect("mode");
        assert!(validate(&manifest, &bundle).is_err());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).expect("mode");
        fs::hard_link(&path, manifest.task_root.join("hardlink")).expect("hardlink");
        assert!(validate(&manifest, &bundle).is_err());
        fs::remove_file(manifest.task_root.join("hardlink")).expect("remove hardlink");
        let foreign = manifest.task_root.join("foreign");
        fs::rename(&path, &foreign).expect("rename");
        symlink(&foreign, &path).expect("symlink");
        assert!(validate(&manifest, &bundle).is_err());
        fs::remove_file(&path).expect("remove link");
        fs::rename(&foreign, &path).expect("restore");
        bundle["files"]["hyperlane_radix.rpd"]["path"] =
            json!(manifest.task_root.join("../foreign"));
        approve(&mut manifest, &bundle);
        assert!(validate(&manifest, &bundle).is_err());
    }
}
