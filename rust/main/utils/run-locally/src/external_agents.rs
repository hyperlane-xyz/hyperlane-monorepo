//! Explicit test-harness runtime substitution. Never changes production agents.
use crate::utils::TaskHandle;
use eyre::{bail, ensure, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

pub const ENV: &str = "E2E_EXTERNAL_AGENT_MANIFEST";
static EVIDENCE_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
const REQUIRED: [&str; 10] = [
    "relayer",
    "validator",
    "scraper",
    "init-db",
    "worker",
    "starknet",
    "aleo-crypto",
    "aleo-vm",
    "regex",
    "url",
];
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Artifact {
    pub path: PathBuf,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Verifier {
    pub python: Artifact,
    pub script: Artifact,
    pub evidence_root: PathBuf,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub schema: u32,
    pub implementation: String,
    pub scenario: String,
    pub runtime_source_commit: String,
    pub mode: String,
    pub task_root: PathBuf,
    pub artifacts: BTreeMap<String, Artifact>,
    pub environment: BTreeMap<String, String>,
    pub verifier: Verifier,
    pub execution_approval: Artifact,
    pub case_inputs: Artifact,
    pub verifier_tools: BTreeMap<String, Artifact>,
    pub harness_deadline_seconds: u64,
    #[serde(default)]
    pub tool_overrides: BTreeMap<String, Artifact>,
}
// Contract data is not an executable tool capability. The whole case_inputs
// Artifact is already bound by schema3 and its parent execution approval.
const MAX_CONTRACT_CASE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_CONTRACT_BYTES: u64 = 128 * 1024 * 1024;
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct FixtureContracts {
    schema: u32,
    scenario: String,
    source_release: String,
    root: PathBuf,
    archive: Artifact,
    publisher_checksum: Option<Artifact>,
    files: BTreeMap<String, Artifact>,
}
struct ContractRelease<'a> {
    scenario: &'a str,
    release: &'a str,
    archive_name: &'a str,
    archive_bytes: u64,
    archive_sha: &'a str,
    member_count: usize,
    member_digest: &'a str,
    publisher_checksum_sha: Option<&'a str>,
    required: &'a [&'a str],
}
const CW_REQUIRED_CODES: &[&str] = &[
    "hpl_hook_merkle.wasm",
    "hpl_hook_routing.wasm",
    "hpl_igp.wasm",
    "hpl_igp_oracle.wasm",
    "hpl_ism_aggregate.wasm",
    "hpl_ism_multisig.wasm",
    "hpl_ism_pausable.wasm",
    "hpl_ism_routing.wasm",
    "hpl_test_mock_ism.wasm",
    "hpl_test_mock_hook.wasm",
    "hpl_test_mock_msg_receiver.wasm",
    "hpl_mailbox.wasm",
    "hpl_validator_announce.wasm",
];
const STARKNET_REQUIRED_CLASSES: &[&str] = &[
    "contracts_merkle_tree_hook.contract_class.json",
    "contracts_mailbox.contract_class.json",
    "contracts_ism.contract_class.json",
    "contracts_pausable_ism.contract_class.json",
    "contracts_hook.contract_class.json",
    "contracts_aggregation.contract_class.json",
    "contracts_message_recipient.contract_class.json",
    "contracts_messageid_multisig_ism.contract_class.json",
    "contracts_validator_announce.contract_class.json",
    "contracts_domain_routing_ism.contract_class.json",
];
fn contract_release(scenario: &str) -> Option<ContractRelease<'static>> {
    match scenario {
        "cosmwasm" => Some(ContractRelease {
            scenario: "cosmwasm",
            release: "v0.0.6",
            archive_name: "wasm_codes.zip",
            archive_bytes: 1_640_623,
            archive_sha: concat!(
                "5b0b3b76ef5daf8a69cbc4ee1e9762d3",
                "c9108127842343bd59cd68862ed0aa9c"
            ),
            member_count: 21,
            member_digest: concat!(
                "df340d9c357fea6e44a402a68e061ba3",
                "484db11e00e19b11ebb282a8b698b7a7"
            ),
            publisher_checksum_sha: None,
            required: CW_REQUIRED_CODES,
        }),
        "starknet" => Some(ContractRelease {
            scenario: "starknet",
            release: "0.3.9",
            archive_name: "hyperlane-starknet-v0.3.9.zip",
            archive_bytes: 10_829_931,
            archive_sha: concat!(
                "5303a50baf47b5c3cc30274cf4b6dcba",
                "fbeb8425010fc3bf54854f5d1bd38667"
            ),
            member_count: 558,
            member_digest: concat!(
                "594307d5fbc39e65770f4a20429d0b35",
                "e34ec02893580a72e7b1bfaf9aae826e"
            ),
            publisher_checksum_sha: Some(concat!(
                "1c567654967a6e6f58741ae84a3fbe59",
                "d46c0743a397e99c5fb5b6fcd0c7c301"
            )),
            required: STARKNET_REQUIRED_CLASSES,
        }),
        _ => None,
    }
}

// serde_json::Value/BTreeMap normally overwrite repeated keys. Reject them
// recursively BEFORE projecting the closed fixture_contracts object.
struct UniqueCaseJson(serde_json::Value);
impl<'de> Deserialize<'de> for UniqueCaseJson {
    fn deserialize<D: serde::Deserializer<'de>>(
        deserializer: D,
    ) -> std::result::Result<Self, D::Error> {
        struct UniqueVisitor;
        impl<'de> serde::de::Visitor<'de> for UniqueVisitor {
            type Value = UniqueCaseJson;
            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("JSON without repeated object keys")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> std::result::Result<Self::Value, M::Error> {
                let mut output = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if output.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate case-input JSON key"));
                    }
                    output.insert(key, map.next_value::<UniqueCaseJson>()?.0);
                }
                Ok(UniqueCaseJson(serde_json::Value::Object(output)))
            }
            fn visit_seq<S: serde::de::SeqAccess<'de>>(
                self,
                mut sequence: S,
            ) -> std::result::Result<Self::Value, S::Error> {
                let mut output = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueCaseJson>()? {
                    output.push(value.0);
                }
                Ok(UniqueCaseJson(serde_json::Value::Array(output)))
            }
            fn visit_bool<E: serde::de::Error>(
                self,
                value: bool,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(value.into()))
            }
            fn visit_i64<E: serde::de::Error>(
                self,
                value: i64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(value.into()))
            }
            fn visit_u64<E: serde::de::Error>(
                self,
                value: u64,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(value.into()))
            }
            fn visit_f64<E: serde::de::Error>(
                self,
                value: f64,
            ) -> std::result::Result<Self::Value, E> {
                serde_json::Number::from_f64(value)
                    .map(|number| UniqueCaseJson(number.into()))
                    .ok_or_else(|| E::custom("non-finite case-input JSON number"))
            }
            fn visit_str<E: serde::de::Error>(
                self,
                value: &str,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(value.into()))
            }
            fn visit_string<E: serde::de::Error>(
                self,
                value: String,
            ) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(value.into()))
            }
            fn visit_unit<E: serde::de::Error>(self) -> std::result::Result<Self::Value, E> {
                Ok(UniqueCaseJson(serde_json::Value::Null))
            }
        }
        deserializer.deserialize_any(UniqueVisitor)
    }
}
fn verified_contract_text(artifact: &Artifact, maximum: u64) -> Result<String> {
    ensure!(artifact.bytes <= maximum, "contract metadata size bound");
    artifact.verify()?;
    let mut bytes = Vec::new();
    fs::File::open(&artifact.path)?
        .take(maximum + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        u64::try_from(bytes.len())? == artifact.bytes
            && hex::encode(Sha256::digest(&bytes)) == artifact.sha256,
        "contract metadata changed while reading"
    );
    Ok(String::from_utf8(bytes)?)
}
fn flat_contract_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
}
fn contract_member_digest(files: &BTreeMap<String, Artifact>) -> String {
    let mut digest = Sha256::new();
    for (name, artifact) in files {
        digest.update(name.as_bytes());
        digest.update([0]);
        digest.update(artifact.bytes.to_string().as_bytes());
        digest.update([0]);
        digest.update(artifact.sha256.as_bytes());
        digest.update(b"\n");
    }
    hex::encode(digest.finalize())
}
fn verify_owned_contract_data(manifest: &Manifest, artifact: &Artifact) -> Result<()> {
    let relative = artifact.path.strip_prefix(&manifest.task_root)?;
    let checked = checked_owned_path(&manifest.task_root, relative)?;
    ensure!(
        checked.is_file() && checked.canonicalize()? == artifact.path.canonicalize()?,
        "contract data escaped owned root"
    );
    artifact.verify()?;
    #[cfg(unix)]
    {
        let metadata = fs::metadata(&checked)?;
        ensure!(
            metadata.permissions().mode() & 0o111 == 0 && metadata.nlink() == 1,
            "contract data must be non-executable and not hard-linked"
        );
    }
    Ok(())
}
fn verify_contract_bundle(
    manifest: &Manifest,
    bundle: &FixtureContracts,
    release: &ContractRelease<'_>,
) -> Result<PathBuf> {
    ensure!(
        bundle.schema == 1
            && bundle.scenario == manifest.scenario
            && bundle.scenario == release.scenario
            && bundle.source_release == release.release,
        "wrong contract bundle schema/scenario/release"
    );
    ensure!(
        bundle.files.len() == release.member_count && bundle.files.len() <= 1024,
        "wrong contract release member set"
    );
    ensure!(
        contract_member_digest(&bundle.files) == release.member_digest,
        "contract map differs from accepted release bytes"
    );
    let root = checked_owned_path(
        &manifest.task_root,
        bundle.root.strip_prefix(&manifest.task_root)?,
    )?;
    ensure!(
        root.is_dir() && root == bundle.root.canonicalize()?,
        "contract bundle root is not an owned directory"
    );
    ensure!(
        bundle.archive.bytes == release.archive_bytes
            && bundle.archive.sha256 == release.archive_sha
            && bundle.archive.path.file_name().and_then(|n| n.to_str())
                == Some(release.archive_name),
        "contract archive differs from accepted release"
    );
    verify_owned_contract_data(manifest, &bundle.archive)?;
    let mut names = std::collections::BTreeSet::new();
    let mut total = 0u64;
    for (name, artifact) in &bundle.files {
        ensure!(
            flat_contract_name(name) && names.insert(name.to_ascii_lowercase()),
            "unsafe/aliased contract member name"
        );
        ensure!(
            artifact.path == bundle.root.join(name),
            "contract member path differs from closed directory"
        );
        verify_owned_contract_data(manifest, artifact)?;
        total = total
            .checked_add(artifact.bytes)
            .ok_or_else(|| eyre::eyre!("contract bytes overflow"))?;
        ensure!(total <= MAX_CONTRACT_BYTES, "contract bundle byte bound");
    }
    let mut actual = std::collections::BTreeSet::new();
    for item in fs::read_dir(&root)? {
        let item = item?;
        ensure!(
            item.file_type()?.is_file() && !item.file_type()?.is_symlink(),
            "non-regular contract member"
        );
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| eyre::eyre!("non-UTF8 contract member"))?;
        ensure!(
            actual.insert(name) && actual.len() <= release.member_count,
            "extra/duplicate contract directory member"
        );
    }
    ensure!(
        actual
            == bundle
                .files
                .keys()
                .cloned()
                .collect::<std::collections::BTreeSet<_>>(),
        "contract directory has missing/extra members"
    );
    ensure!(
        release
            .required
            .iter()
            .all(|name| bundle.files.contains_key(*name)),
        "Source-required contract code absent"
    );
    match release.publisher_checksum_sha {
        Some(expected) => {
            let checksum = bundle
                .publisher_checksum
                .as_ref()
                .ok_or_else(|| eyre::eyre!("published archive checksum missing"))?;
            ensure!(
                checksum.bytes == 96 && checksum.sha256 == expected,
                "wrong published archive checksum file"
            );
            verify_owned_contract_data(manifest, checksum)?;
            let text = verified_contract_text(checksum, 1024)?;
            let fields: Vec<_> = text.split_whitespace().collect();
            ensure!(
                fields == [release.archive_sha, release.archive_name],
                "published archive checksum mismatch"
            );
        }
        None => {
            ensure!(
                bundle.publisher_checksum.is_none(),
                "unexpected detached archive checksum"
            );
            let checksum = bundle
                .files
                .get("checksums.txt")
                .ok_or_else(|| eyre::eyre!("bundled WASM checksums missing"))?;
            let text = verified_contract_text(checksum, 65536)?;
            let mut declared = std::collections::BTreeSet::new();
            for line in text.lines() {
                let fields: Vec<_> = line.split_whitespace().collect();
                ensure!(
                    fields.len() == 2
                        && flat_contract_name(fields[1])
                        && fields[1].ends_with(".wasm")
                        && declared.insert(fields[1].to_owned()),
                    "invalid/duplicate bundled checksum row"
                );
                let member = bundle
                    .files
                    .get(fields[1])
                    .ok_or_else(|| eyre::eyre!("foreign bundled checksum member"))?;
                ensure!(member.sha256 == fields[0], "bundled WASM checksum mismatch");
            }
            let expected = bundle
                .files
                .keys()
                .filter(|name| name.ends_with(".wasm"))
                .cloned()
                .collect::<std::collections::BTreeSet<_>>();
            ensure!(declared == expected, "incomplete bundled WASM checksums");
        }
    }
    Ok(root)
}
fn validate_contract_inputs(manifest: &Manifest) -> Result<Option<PathBuf>> {
    let text = verified_contract_text(&manifest.case_inputs, MAX_CONTRACT_CASE_BYTES)?;
    let value = serde_json::from_str::<UniqueCaseJson>(&text)?.0;
    let object = value
        .as_object()
        .ok_or_else(|| eyre::eyre!("case inputs must be a JSON object"))?;
    let contracts = object.get("fixture_contracts");
    let Some(release) = contract_release(&manifest.scenario) else {
        ensure!(
            contracts.is_none(),
            "contract bundle on unsupported scenario"
        );
        return Ok(None);
    };
    let bundle: FixtureContracts = serde_json::from_value(
        contracts
            .cloned()
            .ok_or_else(|| eyre::eyre!("external contract bundle required before CLI/node"))?,
    )?;
    verify_contract_bundle(manifest, &bundle, &release).map(Some)
}
fn contract_bundle_with(
    runtime: Option<&Manifest>,
    expected_scenario: &str,
    expected_release: &str,
) -> Result<Option<PathBuf>> {
    let Some(manifest) = runtime else {
        return Ok(None);
    };
    let release = contract_release(expected_scenario)
        .ok_or_else(|| eyre::eyre!("unsupported contract consumer"))?;
    ensure!(
        manifest.scenario == expected_scenario && release.release == expected_release,
        "contract consumer scenario/release mismatch"
    );
    validate_contract_inputs(manifest)
}
/// Only already-admitted CW/Starknet data; never executable/tool or ambient env.
pub fn contract_bundle(expected_scenario: &str, expected_release: &str) -> Option<PathBuf> {
    match get()
        .and_then(|runtime| contract_bundle_with(runtime, expected_scenario, expected_release))
    {
        Ok(path) => path,
        Err(error) => panic!("external contract preflight: {error:#}"),
    }
}

fn sha(path: &Path) -> Result<String> {
    let mut input = fs::File::open(path)?;
    let mut h = Sha256::new();
    let mut buffer = [0u8; 65536];
    loop {
        let n = input.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        h.update(&buffer[..n]);
    }
    Ok(hex::encode(h.finalize()))
}
impl Artifact {
    pub fn verify(&self) -> Result<()> {
        ensure!(
            self.path.is_absolute() && !self.path.components().any(|p| p == Component::ParentDir),
            "artifact path must be absolute without parent traversal"
        );
        let m = fs::symlink_metadata(&self.path)?;
        ensure!(
            m.is_file() && !m.file_type().is_symlink(),
            "artifact must be a regular non-symlink file"
        );
        ensure!(
            self.sha256.len() == 64
                && self
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()),
            "invalid SHA256"
        );
        ensure!(
            m.len() == self.bytes && sha(&self.path)? == self.sha256,
            "artifact bytes changed: {}",
            self.path.display()
        );
        Ok(())
    }
}
impl Manifest {
    pub fn parse(bytes: &[u8]) -> Result<Self> {
        let mut m: Self = serde_json::from_slice(bytes)?;
        m.validate()?;
        let relative = m
            .verifier
            .evidence_root
            .strip_prefix(&m.task_root)?
            .to_path_buf();
        m.task_root = m.task_root.canonicalize()?;
        m.verifier.evidence_root = checked_owned_path(&m.task_root, &relative)?;
        m.validate()?;
        Ok(m)
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            [
                "evm",
                "cosmwasm",
                "cosmosnative",
                "sealevel",
                "sealevel-composite",
                "starknet",
                "radix",
                "tron"
            ]
            .contains(&self.scenario.as_str()),
            "unknown actual-node scenario"
        );
        ensure!(
            self.schema == 3 && self.implementation == "zig",
            "unsupported external runtime schema"
        );
        ensure!(
            self.runtime_source_commit.len() == 40
                && self
                    .runtime_source_commit
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit()),
            "exact runtime commit required"
        );
        ensure!(
            ["ReleaseSafe", "ReleaseFast"].contains(&self.mode.as_str()),
            "unknown native mode"
        );
        ensure!(
            self.task_root.is_absolute()
                && self.task_root.is_dir()
                && !self
                    .task_root
                    .components()
                    .any(|p| p == Component::ParentDir)
                && !fs::symlink_metadata(&self.task_root)?
                    .file_type()
                    .is_symlink(),
            "existing task root required"
        );
        ensure!(
            (1800..=86400).contains(&self.harness_deadline_seconds),
            "external harness deadline must allow production confirmation"
        );
        ensure!(
            self.artifacts.len() == REQUIRED.len()
                && REQUIRED.iter().all(|k| self.artifacts.contains_key(*k)),
            "all three roles, init-db, worker, four SDKs and URL parser required"
        );
        ensure!(
            self.artifacts
                .values()
                .map(|a| &a.path)
                .collect::<std::collections::BTreeSet<_>>()
                .len()
                == REQUIRED.len(),
            "distinct runtime artifact paths required"
        );
        for a in self.artifacts.values() {
            a.verify()?;
        }
        for name in ["relayer", "validator", "scraper", "init-db", "worker"] {
            verify_executable(&self.artifacts[name])?;
        }
        verify_executable(&self.verifier.python)?;
        self.execution_approval.verify()?;
        self.case_inputs.verify()?;
        validate_contract_inputs(self)?;
        ensure!(
            self.verifier_tools.len() == 6
                && ["cast", "oracle", "native_rows", "psql", "docker", "ps"]
                    .iter()
                    .all(|name| self.verifier_tools.contains_key(*name)),
            "exact verifier tool descriptors required"
        );
        for tool in self.verifier_tools.values() {
            verify_executable(tool)?;
        }
        self.verifier.python.verify()?;
        self.verifier.script.verify()?;
        ensure!(
            self.verifier.evidence_root.is_absolute()
                && self.verifier.evidence_root.starts_with(&self.task_root)
                && !self
                    .verifier
                    .evidence_root
                    .components()
                    .any(|p| p == Component::ParentDir),
            "evidence must stay in owned task root"
        );
        for relative in [
            "databases",
            "agent-logs",
            "sealevel-checkpoints",
            "composite-checkpoints",
        ] {
            let path = checked_owned_path(&self.task_root, Path::new(relative))?;
            ensure!(
                !path.exists() || path.is_dir(),
                "owned directory is not a directory"
            );
            if path.is_dir() {
                check_owned_tree(&self.task_root, Path::new(relative))?;
            }
        }
        checked_owned_path(
            &self.task_root,
            self.verifier.evidence_root.strip_prefix(&self.task_root)?,
        )?;
        if self.verifier.evidence_root.is_dir() {
            check_owned_tree(
                &self.task_root,
                self.verifier.evidence_root.strip_prefix(&self.task_root)?,
            )?;
        }
        let aliases = [
            ("HYPERLANE_STARKNET_CRYPTO_LIBRARY", "starknet"),
            ("HYPERLANE_ALEO_CRYPTO_LIBRARY", "aleo-crypto"),
            ("HYPERLANE_ALEO_VM_LIBRARY", "aleo-vm"),
            ("HYPERLANE_REGEX_LIBRARY", "regex"),
            ("ZIGGY_REGEX_LIBRARY", "regex"),
            ("HYPERLANE_ALEO_VM_WORKER", "worker"),
            ("HYPERLANE_URL_LIBRARY", "url"),
        ];
        for (key, name) in aliases {
            ensure!(
                self.environment.get(key).map(PathBuf::from).as_ref()
                    == Some(&self.artifacts[name].path),
                "missing/wrong runtime alias: {key}"
            );
        }
        for (key, value) in &self.environment {
            ensure!(
                aliases.iter().any(|(k, _)| k == key)
                    || [
                        "HYPERLANE_CURL_LIBRARY",
                        "HYPERLANE_CLOUD_CURL_LIBRARY",
                        "HYPERLANE_LIBCRYPTO_LIBRARY",
                        "HYPERLANE_ZIG_DEFAULTS",
                        "HYPERLANE_ALEO_PARAMETER_HOME"
                    ]
                    .contains(&key.as_str()),
                "unknown external environment alias"
            );
            ensure!(
                Path::new(value).is_absolute(),
                "runtime environment paths must be absolute"
            );
        }
        for (key, artifact) in &self.tool_overrides {
            ensure!(
                [
                    "E2E_OSMOSIS_CLI_PATH",
                    "E2E_STARKLI_CLI_PATH",
                    "E2E_HYPD_PATH"
                ]
                .contains(&key.as_str()),
                "unsupported tool override"
            );
            ensure!(
                artifact
                    .path
                    .canonicalize()?
                    .starts_with(self.task_root.canonicalize()?),
                "tool override outside owned root"
            );
            verify_executable(artifact)?;
        }
        Ok(())
    }
}
struct Loaded {
    path: PathBuf,
    manifest: Manifest,
}
static LOADED: Lazy<std::result::Result<Option<Loaded>, String>> = Lazy::new(|| {
    let Some(path) = std::env::var_os(ENV) else {
        return Ok(None);
    };
    let path = PathBuf::from(path);
    (|| -> Result<Option<Loaded>> {
        ensure!(path.is_absolute(), "absolute external manifest required");
        let manifest = Manifest::parse(&fs::read(&path)?)?;
        ensure!(
            std::env::var("CI").as_deref() == Ok("true"),
            "external mode requires CI=true; never global anvil cleanup"
        );
        Ok(Some(Loaded { path, manifest }))
    })()
    .map_err(|e| format!("{e:#}"))
});
fn verify_executable(artifact: &Artifact) -> Result<()> {
    artifact.verify()?;
    #[cfg(unix)]
    ensure!(
        fs::metadata(&artifact.path)?.permissions().mode() & 0o111 != 0,
        "executable permission missing"
    );
    Ok(())
}
pub fn get() -> Result<Option<&'static Manifest>> {
    match &*LOADED {
        Ok(v) => Ok(v.as_ref().map(|v| &v.manifest)),
        Err(e) => bail!("external runtime preflight: {e}"),
    }
}
/// Called before any node/deploy work by every scenario, including test entrypoints.
pub fn initialize_for(scenario: &str) {
    match get() {
        Ok(Some(m)) => {
            assert_eq!(
                m.scenario, scenario,
                "external manifest scenario differs from actual test entrypoint"
            );
            match checker("preflight", 0) {
                Ok(true) => {}
                Ok(false) => panic!("actual family verifier/capacity preflight is not ready"),
                Err(error) => panic!("external evidence preflight: {error:#}"),
            }
        }
        Ok(None) => {}
        Err(error) => panic!("external runtime preflight: {error:#}"),
    }
}
pub fn enabled() -> bool {
    match get() {
        Ok(m) => m.is_some(),
        Err(error) => panic!("external runtime preflight: {error:#}"),
    }
}
pub fn relayer_test_rpc_override(
    program: crate::program::Program,
    external: bool,
) -> crate::program::Program {
    const URLS: &str = "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545";
    if external {
        program.hyp_env("CHAINS_TEST1_CUSTOMRPCURLS", URLS)
    } else {
        program.arg("chains.test1.customRpcUrls", URLS)
    }
}
pub fn deadline(default: u64) -> u64 {
    match get() {
        Ok(Some(m)) => m.harness_deadline_seconds,
        Ok(None) => default,
        Err(e) => panic!("external runtime preflight: {e:#}"),
    }
}
fn normalize(path: &Path) -> Result<PathBuf> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut out = PathBuf::new();
    for part in path.components() {
        match part {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            p => out.push(p.as_os_str()),
        }
    }
    Ok(out)
}
pub fn resolve(path: &Path) -> Result<PathBuf> {
    resolve_with(
        get()?,
        path,
        &normalize(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../.."))?,
    )
}
fn resolve_with(runtime: Option<&Manifest>, path: &Path, workspace: &Path) -> Result<PathBuf> {
    let Some(m) = runtime else {
        return Ok(path.to_path_buf());
    };
    let requested = normalize(path)?;
    for role in ["relayer", "validator", "scraper", "init-db"] {
        if requested == workspace.join("target/debug").join(role) {
            m.artifacts[role].verify()?;
            return Ok(m.artifacts[role].path.clone());
        }
    }
    Ok(path.to_path_buf()) // unrelated tools, even tools with the same basename, stay untouched
}
pub fn apply_environment(command: &mut Command, executable: &Path) -> Result<()> {
    apply_environment_with(get()?, command, executable)
}
fn apply_environment_with(
    runtime: Option<&Manifest>,
    command: &mut Command,
    executable: &Path,
) -> Result<()> {
    let Some(m) = runtime else {
        return Ok(());
    };
    let role = ["relayer", "validator", "scraper", "init-db"]
        .into_iter()
        .find(|role| m.artifacts[*role].path == executable);
    if let Some(role) = role {
        let original: Vec<_> = command
            .get_envs()
            .map(|(key, value)| (key.to_os_string(), value.map(|value| value.to_os_string())))
            .collect();
        // Existing caller configuration is public fixture data. Do not inherit
        // user credentials, proxy URLs or a user DATABASE_URL into test agents.
        command.env_clear();
        if let Some(path) = std::env::var_os("PATH") {
            command.env("PATH", path);
        }
        for (key, value) in &original {
            if let Some(value) = value {
                command.env(key, value);
            }
        }
        if role == "init-db" {
            let url = original
                .iter()
                .find(|(key, _)| key == "DATABASE_URL")
                .and_then(|(_, value)| value.as_ref())
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_else(|| {
                    "postgresql://postgres:47221c18c610@localhost:5432/postgres".to_owned()
                });
            let parsed = url::Url::parse(&url)?;
            ensure!(
                ["postgres", "postgresql"].contains(&parsed.scheme())
                    && matches!(
                        parsed.host_str(),
                        Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                    ),
                "migration endpoint must be local"
            );
            command.env("DATABASE_URL", url);
            return Ok(());
        }
        if role != "scraper" {
            let old = original
                .iter()
                .find(|(key, _)| key == "HYP_DB")
                .and_then(|(_, value)| value.as_ref())
                .ok_or_else(|| {
                    eyre::eyre!("external Rocks role requires explicit fixture HYP_DB")
                })?;
            let path = Path::new(old);
            ensure!(path.is_absolute(), "external Rocks path must be absolute");
            let identity = hex::encode(Sha256::digest(old.as_encoded_bytes()));
            create_owned_directory(&m.task_root, Path::new("databases"))?;
            command.env(
                "HYP_DB",
                create_owned_directory(
                    &m.task_root,
                    &Path::new("databases").join(format!("{role}-{}", &identity[..16])),
                )?,
            );
        }
        for (key, value) in &m.environment {
            if let Some((_, Some(old))) = command.get_envs().find(|(k, _)| *k == key.as_str()) {
                ensure!(
                    old == value.as_str(),
                    "conflicting external runtime alias: {key}"
                );
            }
            command.env(key, value);
        }
    }
    Ok(())
}
pub fn tool(key: &str) -> Option<PathBuf> {
    match get() {
        Ok(Some(m)) => m.tool_overrides.get(key).map(|a| {
            if let Err(e) = a.verify() {
                panic!("external tool changed: {e:#}");
            }
            a.path.clone()
        }),
        Ok(None) => std::env::var(key).ok().map(PathBuf::from),
        Err(e) => panic!("external tool preflight: {e:#}"),
    }
}
pub fn checker(stage: &str, expected: u32) -> Result<bool> {
    let Some(loaded) = (match &*LOADED {
        Ok(v) => v.as_ref(),
        Err(e) => bail!("{e}"),
    }) else {
        bail!("external checker requires opt-in manifest");
    };
    loaded.manifest.verifier.python.verify()?;
    loaded.manifest.verifier.script.verify()?;
    let status = Command::new(&loaded.manifest.verifier.python.path)
        .arg(&loaded.manifest.verifier.script.path)
        .args(["verify", "--manifest"])
        .arg(&loaded.path)
        .args(["--stage", stage, "--expected", &expected.to_string()])
        .status()?;
    Ok(status.success())
}
/// Check each existing relative component before any owned write. The accepted
/// root may have system aliases (e.g. /tmp); only its canonical tree is writable.
pub fn checked_owned_path(root: &Path, relative: &Path) -> Result<PathBuf> {
    ensure!(
        root.is_absolute() && !fs::symlink_metadata(root)?.file_type().is_symlink(),
        "unsafe owned root"
    );
    let canonical = root.canonicalize()?;
    ensure!(canonical.is_dir(), "owned root is not a directory");
    let mut path = canonical.clone();
    let components: Vec<_> = relative.components().collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            bail!("owned path must be a normal relative path");
        };
        path.push(name);
        match fs::symlink_metadata(&path) {
            Ok(metadata) => {
                ensure!(
                    !metadata.file_type().is_symlink(),
                    "symlink in owned writable path: {}",
                    path.display()
                );
                ensure!(
                    path.canonicalize()?.starts_with(&canonical),
                    "owned path escaped root"
                );
                if index + 1 < components.len() {
                    ensure!(metadata.is_dir(), "owned parent is not a directory");
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(path)
}
fn check_owned_tree(root: &Path, relative: &Path) -> Result<()> {
    let path = checked_owned_path(root, relative)?;
    if !path.exists() {
        return Ok(());
    }
    ensure!(path.is_dir(), "owned tree is not a directory");
    for child in fs::read_dir(&path)? {
        let child = child?;
        let next = relative.join(child.file_name());
        checked_owned_path(root, &next)?;
        if child.file_type()?.is_dir() {
            check_owned_tree(root, &next)?;
        }
    }
    Ok(())
}
pub fn check_owned_write(path: &Path) -> Result<()> {
    if let Some(m) = get()? {
        checked_owned_path(&m.task_root, path.strip_prefix(&m.task_root)?)?;
    }
    Ok(())
}
pub fn create_owned_directory(root: &Path, relative: &Path) -> Result<PathBuf> {
    let path = checked_owned_path(root, relative)?;
    if path.is_dir() {
        check_owned_tree(root, relative)?;
    }
    fs::create_dir_all(&path)?;
    let checked = checked_owned_path(root, relative)?;
    check_owned_tree(root, relative)?;
    ensure!(checked.is_dir(), "owned directory missing after creation");
    Ok(checked)
}
fn resource_name_at(default: &str, root: &Path, pid: u32) -> Result<String> {
    let identity = hex::encode(Sha256::digest(
        root.canonicalize()?.as_os_str().as_encoded_bytes(),
    ));
    Ok(format!("ziggy-e2e-{}-{pid}-{default}", &identity[..10]))
}
pub fn resource_name(default: &str) -> String {
    match get() {
        Ok(Some(m)) => resource_name_at(default, &m.task_root, std::process::id())
            .unwrap_or_else(|e| panic!("resource identity: {e:#}")),
        Ok(None) => default.to_owned(),
        Err(e) => panic!("external resources: {e:#}"),
    }
}

pub const POSTGRES_MEMORY_BYTES: u64 = 1024 * 1024 * 1024;
pub const POSTGRES_DATA_BYTES: u64 = 2 * 1024 * 1024 * 1024;
pub const POSTGRES_PIDS: u32 = 256;
pub const POSTGRES_CASE_LABEL: &str = "io.hyperlane.ziggy.case-root";
pub const POSTGRES_HARNESS_LABEL: &str = "io.hyperlane.ziggy.harness-pid";
pub const POSTGRES_TOKEN_LABEL: &str = "io.hyperlane.ziggy.run-token";
const POSTGRES_SOURCE_IMAGE: &str = "postgres:14";

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct PostgresFixture {
    image: String,
    image_id: String,
    canonical_digest: String,
    run_token: String,
}

fn fixture_json(artifact: &Artifact) -> Result<serde_json::Value> {
    ensure!(artifact.bytes <= 1024 * 1024, "fixture JSON exceeds limit");
    artifact.verify()?;
    Ok(serde_json::from_slice(&fs::read(&artifact.path)?)?)
}

fn postgres_fixture(manifest: &Manifest) -> Result<PostgresFixture> {
    let case = fixture_json(&manifest.case_inputs)?;
    let approval = fixture_json(&manifest.execution_approval)?;
    ensure!(
        case["schema"] == 1
            && case["scenario"] == manifest.scenario
            && approval["root_approved"] == true
            && approval["scenario"] == manifest.scenario
            && approval["runtime_source_commit"] == manifest.runtime_source_commit
            && approval["mode"] == manifest.mode
            && approval["case_inputs"] == serde_json::to_value(&manifest.case_inputs)?,
        "PostgreSQL requires the exact approved case"
    );
    let fixture: PostgresFixture = serde_json::from_value(case["postgres"].clone())?;
    let Some(digest) = fixture.image_id.strip_prefix("sha256:") else {
        bail!("invalid PostgreSQL image identity");
    };
    ensure!(
        fixture.image == POSTGRES_SOURCE_IMAGE
            && digest.len() == 64
            && digest
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && fixture.canonical_digest == format!("postgres@{}", fixture.image_id)
            && fixture.run_token.len() == 32
            && fixture
                .run_token
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            && approval["source_PG14_tag"] == fixture.image
            && approval["canonical_PG14_image_id"] == fixture.image_id
            && approval["postgres_run_token"] == fixture.run_token,
        "PostgreSQL image or ownership token differs from approval"
    );
    Ok(fixture)
}

fn postgres_arguments_at(manifest: Option<&Manifest>, pid: u32) -> Result<Option<Vec<String>>> {
    let Some(manifest) = manifest else {
        return Ok(None);
    };
    let fixture = postgres_fixture(manifest)?;
    let root_hash = hex::encode(Sha256::digest(
        manifest
            .task_root
            .canonicalize()?
            .as_os_str()
            .as_encoded_bytes(),
    ));
    Ok(Some(vec![
        "run".into(),
        "--rm".into(),
        format!(
            "--name={}",
            resource_name_at("scraper-testnet-postgres", &manifest.task_root, pid)?
        ),
        format!("--label={POSTGRES_CASE_LABEL}={root_hash}"),
        format!("--label={POSTGRES_HARNESS_LABEL}={pid}"),
        format!("--label={POSTGRES_TOKEN_LABEL}={}", fixture.run_token),
        "--pull=never".into(),
        format!("--memory={POSTGRES_MEMORY_BYTES}"),
        format!("--memory-swap={POSTGRES_MEMORY_BYTES}"),
        "--cpus=2".into(),
        format!("--pids-limit={POSTGRES_PIDS}"),
        format!("--tmpfs=/var/lib/postgresql/data:rw,nosuid,size={POSTGRES_DATA_BYTES}"),
        "--env=POSTGRES_PASSWORD=47221c18c610".into(),
        "--publish=127.0.0.1:5432:5432".into(),
        fixture.image_id,
    ]))
}

fn verify_postgres_inspect(
    fixture: &PostgresFixture,
    success: bool,
    output: &[String],
) -> Result<()> {
    ensure!(
        success,
        "approved local PostgreSQL tag is absent; never pull"
    );
    let image: serde_json::Value = serde_json::from_str(&output.join("\n"))?;
    ensure!(
        image["Id"] == fixture.image_id
            && image["Os"] == "linux"
            && image["Architecture"] == "arm64"
            && image["RepoDigests"].as_array().is_some_and(|values| values
                .iter()
                .any(|value| value == &fixture.canonical_digest)),
        "local PostgreSQL tag differs from approved immutable image"
    );
    Ok(())
}

/// External correctness cases only: exact local image, bounded resources and
/// ownership labels. The ordinary Rust preparation/argv path remains in utils.
pub fn postgres_program() -> Result<Option<crate::program::Program>> {
    let Some(manifest) = get()? else {
        return Ok(None);
    };
    let fixture = postgres_fixture(manifest)?;
    let arguments = postgres_arguments_at(Some(manifest), std::process::id())?
        .ok_or_else(|| eyre::eyre!("external PostgreSQL arguments missing"))?;
    let (success, output) = crate::program::Program::new("docker")
        .cmd("image")
        .cmd("inspect")
        .cmd(POSTGRES_SOURCE_IMAGE)
        .arg("format", "{{json .}}")
        .run_with_status_and_output()
        .join();
    verify_postgres_inspect(&fixture, success, &output)?;
    let mut program = crate::program::Program::new("docker");
    for argument in arguments {
        program = program.raw_arg(argument);
    }
    Ok(Some(program))
}

// Exact external EVM fixtures only. Runtime roles keep their existing receipts.
#[derive(Clone, Debug, Serialize)]
struct FixtureProcess {
    pid: u32,
    parent_pid: u32,
    group_pid: u32,
    start: String,
    executable: Artifact,
}
#[derive(Default)]
struct FixtureProcesses {
    known: BTreeMap<u32, FixtureProcess>,
    failure: Option<String>,
}
struct EvmFixtureOwnership {
    runtime: Manifest,
    kind: String,
    root: OwnedChild,
    processes: std::sync::Arc<std::sync::Mutex<FixtureProcesses>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    monitor: Option<std::thread::JoinHandle<()>>,
}
fn evm_fixture_tools(manifest: &Manifest) -> Result<BTreeMap<String, Artifact>> {
    let case = fixture_json(&manifest.case_inputs)?;
    let approval = fixture_json(&manifest.execution_approval)?;
    ensure!(
        manifest.scenario == "evm"
            && case["schema"] == 1
            && case["scenario"] == "evm"
            && approval["root_approved"] == true
            && approval["scenario"] == "evm"
            && approval["mode"] == manifest.mode
            && approval["runtime_source_commit"] == manifest.runtime_source_commit
            && approval["case_inputs"] == serde_json::to_value(&manifest.case_inputs)?
            && approval["fixture_tools"] == case["fixture_tools"],
        "EVM fixture tool approval differs"
    );
    let tools: BTreeMap<String, Artifact> = serde_json::from_value(case["fixture_tools"].clone())?;
    ensure!(
        tools.len() == 6
            && [
                "anvil",
                "node",
                "pnpm_launcher",
                "pnpm_native",
                "sh",
                "esbuild"
            ]
            .iter()
            .all(|name| tools.contains_key(*name)),
        "exact EVM fixture tools required"
    );
    for tool in tools.values() {
        verify_executable(tool)?;
    }
    Ok(tools)
}
fn evm_fixture_kind(command: &Command, executable: &Path) -> Option<&'static str> {
    let args: Vec<_> = command.get_args().map(|a| a.to_string_lossy()).collect();
    match executable.file_name()?.to_str()? {
        "anvil" => Some("anvil"),
        "docker" if args.first().is_some_and(|a| a == "run") => Some("postgres"),
        "pnpm" | "pnpm-native"
            if args.first().is_some_and(|a| a == "kathy")
                && args.iter().any(|a| a == "--mineforever") =>
        {
            Some("kathy")
        }
        _ => None,
    }
}
fn configure_evm_fixture(
    command: &mut Command,
    executable: &Path,
    manifest: &Manifest,
) -> Result<()> {
    use std::os::unix::process::CommandExt;
    if manifest.scenario != "evm" {
        return Ok(());
    }
    let Some(kind) = evm_fixture_kind(command, executable) else {
        return Ok(());
    };
    let tools = evm_fixture_tools(manifest)?;
    let expected = match kind {
        "anvil" => &tools["anvil"],
        "postgres" => &manifest.verifier_tools["docker"],
        _ => &tools["pnpm_launcher"],
    };
    ensure!(
        executable.canonicalize()? == expected.path.canonicalize()?,
        "fixture launcher differs"
    );
    let args: Vec<_> = command
        .get_args()
        .map(|a| a.to_string_lossy().into_owned())
        .collect();
    match kind {
        "anvil" => ensure!(args == ["--silent"], "Anvil Source arguments differ"),
        "postgres" => ensure!(
            Some(args) == postgres_arguments_at(Some(manifest), std::process::id())?,
            "PG fixture arguments differ"
        ),
        _ => ensure!(
            args == [
                "kathy",
                "--messages",
                "5",
                "--timeout",
                "1000",
                "--mineforever"
            ],
            "Kathy Source20 fixture arguments differ"
        ),
    }
    // A fresh group belongs to this exact Child, not another user's node/name.
    command.process_group(0);
    Ok(())
}
type FixtureSnapshot = (u32, u32, u32, String, PathBuf);
fn fixture_process_snapshot(ps: &Artifact, group: u32) -> Result<Vec<FixtureSnapshot>> {
    use std::io::{Seek, SeekFrom};
    // A monitor must itself stop promptly; a blocked inspection tool cannot
    // turn fixture teardown's bounded wait into an unbounded thread join.
    let mut captured = tempfile::tempfile()?;
    let mut child = Command::new(&ps.path)
        .args(["-ww", "-ax", "-o", "pid=,ppid=,pgid=,lstart=,comm="])
        .stdout(captured.try_clone()?)
        .stderr(Stdio::null())
        .spawn()?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let outcome = (|| -> Result<std::process::ExitStatus> {
        loop {
            ensure!(
                captured.metadata()?.len() <= 4 * 1024 * 1024,
                "fixture process snapshot output limit"
            );
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            ensure!(
                Instant::now() < deadline,
                "fixture process snapshot timeout"
            );
            thread::sleep(Duration::from_millis(10));
        }
    })();
    let status = match outcome {
        Ok(status) => status,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    ensure!(status.success(), "fixture process snapshot failed");
    captured.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    captured.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= 4 * 1024 * 1024,
        "fixture process snapshot output limit"
    );
    let text = String::from_utf8(bytes)?;
    let mut rows = Vec::new();
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 9 {
            continue;
        }
        let pid: u32 = fields[0].parse()?;
        let pgid: u32 = fields[2].parse()?;
        if pgid != group {
            continue;
        }
        let comm = PathBuf::from(fields[8..].join(" "));
        let executable = match actual_fixture_executable(pid, &comm) {
            Ok(path) => path,
            Err(error)
                if error
                    .downcast_ref::<std::io::Error>()
                    .is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) =>
            {
                PathBuf::new()
            }
            Err(error) => return Err(error),
        };
        rows.push((
            pid,
            fields[1].parse()?,
            pgid,
            fields[3..8].join(" "),
            executable,
        ));
    }
    Ok(rows)
}
fn signal_fixture_process(pid: u32, signal: nix::sys::signal::Signal) -> Result<()> {
    match nix::sys::signal::kill(nix::unistd::Pid::from_raw(i32::try_from(pid)?), signal) {
        Ok(()) | Err(nix::errno::Errno::ESRCH) => Ok(()),
        Err(error) => Err(error.into()),
    }
}
fn observe_fixture_processes(
    state: &mut FixtureProcesses,
    rows: &[FixtureSnapshot],
    group: u32,
    allowed: &[Artifact],
) -> Result<()> {
    let mut pending: Vec<_> = rows.iter().filter(|row| row.2 == group).collect();
    // Existing identities must remain the same process. An allowed interpreter
    // exec may change comm while PID/start/parent/group stay exactly unchanged.
    for row in &pending {
        if let Some(old) = state.known.get(&row.0) {
            ensure!(
                old.parent_pid == row.1 && old.group_pid == row.2 && old.start == row.3,
                "fixture PID/start/parent changed"
            );
        }
    }
    while !pending.is_empty() {
        let before = pending.len();
        let mut rest = Vec::new();
        for row in pending {
            let known = state.known.contains_key(&row.0);
            let parent_live = state.known.get(&row.1).is_some_and(|parent| {
                rows.iter().any(|r| {
                    r.0 == parent.pid
                        && r.1 == parent.parent_pid
                        && r.2 == parent.group_pid
                        && r.3 == parent.start
                })
            });
            if !known && !parent_live {
                rest.push(row);
                continue;
            }
            // A zombie may lose its executable name; it grants no new authority.
            if !row.4.is_absolute() {
                continue;
            }
            let actual = row.4.clone();
            let artifact = allowed
                .iter()
                .find(|a| a.path == actual)
                .ok_or_else(|| eyre::eyre!("fixture descendant executable not approved"))?;
            ensure!(
                known || state.known.len() < 256,
                "fixture descendant count exceeds bound"
            );
            state.known.insert(
                row.0,
                FixtureProcess {
                    pid: row.0,
                    parent_pid: row.1,
                    group_pid: row.2,
                    start: row.3.clone(),
                    executable: artifact.clone(),
                },
            );
        }
        ensure!(
            rest.len() < before,
            "unknown fixture group member has no observed parent lineage"
        );
        pending = rest;
    }
    Ok(())
}
impl EvmFixtureOwnership {
    fn start(manifest: &Manifest, child: &mut Child, kind: &str) -> Result<Self> {
        let tools = evm_fixture_tools(manifest)?;
        let mut allowed: Vec<_> = match kind {
            "anvil" => vec![tools["anvil"].clone()],
            "postgres" => vec![manifest.verifier_tools["docker"].clone()],
            "kathy" => ["node", "pnpm_native", "sh", "esbuild"]
                .iter()
                .map(|name| tools[*name].clone())
                .collect(),
            _ => bail!("unknown external EVM fixture kind"),
        };
        for a in &mut allowed {
            a.path = a.path.canonicalize()?;
        }
        let ps = manifest.verifier_tools["ps"].clone();
        verify_executable(&ps)?;
        ensure!(
            child.try_wait()?.is_none(),
            "fixture exited before ownership capture"
        );
        let rows = fixture_process_snapshot(&ps, child.id())?;
        let row = rows
            .iter()
            .find(|row| row.0 == child.id())
            .ok_or_else(|| eyre::eyre!("actual fixture child absent"))?;
        ensure!(
            row.1 == std::process::id() && row.2 == child.id(),
            "fixture parent/group differs"
        );
        let actual = row.4.clone();
        let expected: Vec<_> = match kind {
            "anvil" => vec![&tools["anvil"]],
            "postgres" => vec![&manifest.verifier_tools["docker"]],
            _ => vec![&tools["node"], &tools["pnpm_native"]],
        };
        let artifact = expected
            .into_iter()
            .find(|a| a.path.canonicalize().ok().as_ref() == Some(&actual))
            .ok_or_else(|| {
                eyre::eyre!("actual fixture executable differs from approved interpreter")
            })?
            .clone();
        let root = OwnedChild {
            pid: child.id(),
            role: format!("fixture-{kind}"),
            executable: artifact.clone(),
            parent_pid: std::process::id(),
            os_start_token: child_identity(&ps, child.id())?,
            scope:
                "actual direct external EVM fixture Child; descendants get no parent-wait credit"
                    .into(),
        };
        let mut initial = FixtureProcesses::default();
        initial.known.insert(
            row.0,
            FixtureProcess {
                pid: row.0,
                parent_pid: row.1,
                group_pid: row.2,
                start: row.3.clone(),
                executable: artifact,
            },
        );
        if let Err(error) = observe_fixture_processes(&mut initial, &rows, child.id(), &allowed) {
            // Retain observed ownership even on rejection so teardown can reap
            // this Child and its already-proven descendants before failing.
            initial.failure = Some(format!("{error:#}"));
        }
        let processes = std::sync::Arc::new(std::sync::Mutex::new(initial));
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let shared = processes.clone();
        let done = stop.clone();
        let group = child.id();
        append_fixture_observation(
            manifest,
            "fixture-children.jsonl",
            &serde_json::json!({"root":root,"kind":kind,"observed_processes":processes.lock().map_err(|_|eyre::eyre!("fixture monitor poisoned"))?.known}),
        )?;
        let monitor = thread::spawn(move || {
            while !done.load(std::sync::atomic::Ordering::Acquire) {
                let result = fixture_process_snapshot(&ps, group).and_then(|rows| {
                    let mut state = shared
                        .lock()
                        .map_err(|_| eyre::eyre!("fixture monitor poisoned"))?;
                    observe_fixture_processes(&mut state, &rows, group, &allowed)
                });
                if let Err(error) = result {
                    if let Ok(mut state) = shared.lock() {
                        state.failure = Some(format!("{error:#}"));
                    }
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        Ok(Self {
            runtime: manifest.clone(),
            kind: kind.into(),
            root,
            processes,
            stop,
            monitor: Some(monitor),
        })
    }
    fn stop_monitor(&mut self) -> Result<()> {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        if let Some(monitor) = self.monitor.take() {
            monitor
                .join()
                .map_err(|_| eyre::eyre!("fixture ownership monitor panicked"))?;
        }
        Ok(())
    }
    fn shutdown(&mut self, child: &mut Child, purpose: &str) -> Result<()> {
        self.stop_monitor()?;
        let ps = &self.runtime.verifier_tools["ps"];
        let (known, failure) = {
            let state = self
                .processes
                .lock()
                .map_err(|_| eyre::eyre!("fixture monitor poisoned"))?;
            (state.known.clone(), state.failure.clone())
        };
        let mut stopped = Vec::new();
        let mut errors = Vec::new();
        // Only previously observed descendants; never adopt an orphan/new group
        // member during cleanup. No group-wide signal can hit unknown members.
        let mut descendants: Vec<_> = known.values().filter(|p| p.pid != child.id()).collect();
        descendants.sort_by_key(|p| {
            let mut depth = 0;
            let mut parent = p.parent_pid;
            while let Some(ancestor) = known.get(&parent) {
                depth += 1;
                if depth > known.len() {
                    break;
                }
                parent = ancestor.parent_pid;
            }
            std::cmp::Reverse(depth)
        });
        for identity in descendants {
            let rows = fixture_process_snapshot(ps, self.root.pid)?;
            if let Some(now) = rows.iter().find(|r| r.0 == identity.pid) {
                ensure!(
                    now.2 == identity.group_pid && now.3 == identity.start,
                    "descendant PID reused; no signal"
                );
                if now.4.is_absolute() {
                    ensure!(
                        now.4 == identity.executable.path,
                        "descendant executable changed; no signal"
                    );
                    signal_fixture_process(identity.pid, nix::sys::signal::Signal::SIGTERM)?;
                }
            }
            stopped.push(identity.clone());
        }
        let stop_root = |child: &mut Child| {
            stop_owned_child_mode(
                child,
                &self.root,
                &self.root.executable,
                ps,
                Duration::from_secs(10),
                false,
            )
        };
        let mut receipt = match stop_root(child) {
            Ok(receipt) => receipt,
            Err(error)
                if error.downcast_ref::<nix::errno::Errno>() == Some(&nix::errno::Errno::ESRCH) =>
            {
                // A wrapper can naturally exit as its stopped child exits.
                // Retain the actual wait status; never invent a success code.
                child.wait()?;
                stop_root(child)?
            }
            Err(error) => return Err(error),
        };
        receipt.purpose = purpose.into();
        append_fixture_exit(&self.runtime, &receipt)?;
        if receipt.forced_kill {
            errors.push("direct fixture required forced shutdown".to_owned());
        }
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let rows = fixture_process_snapshot(ps, self.root.pid)?;
            let alive: Vec<_> = rows
                .iter()
                .filter(|r| known.contains_key(&r.0) && r.0 != child.id())
                .collect();
            if alive.is_empty() {
                break;
            }
            for row in &alive {
                let old = &known[&row.0];
                ensure!(
                    row.2 == old.group_pid && row.3 == old.start,
                    "descendant identity changed after stop"
                );
            }
            if Instant::now() >= deadline {
                for row in alive {
                    if row.4.is_absolute() {
                        ensure!(
                            row.4 == known[&row.0].executable.path,
                            "descendant executable changed before forced cleanup; no signal"
                        );
                        signal_fixture_process(row.0, nix::sys::signal::Signal::SIGKILL)?;
                    }
                }
                errors.push(
                    "observed nonchild descendant required forced kill; no clean acceptance".into(),
                );
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
        let remaining = fixture_process_snapshot(ps, self.root.pid)?;
        ensure!(
            !remaining.iter().any(|row| row.2 == self.root.pid),
            "fixture group remains; no late cleanup adoption"
        );
        let relative = self
            .runtime
            .verifier
            .evidence_root
            .strip_prefix(&self.runtime.task_root)?
            .join("fixture-descendant-stops.jsonl");
        let path = checked_owned_path(&self.runtime.task_root, &relative)?;
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)?;
        writeln!(
            file,
            "{}",
            serde_json::json!({"fixture":self.kind,"direct_child_pid":child.id(),"observed_descendants":stopped,"parent_wait_completed":false,"scope":"nonchild identity/absence only; actual direct Child wait is separate","unknown_group_members_never_signalled":true})
        )?;
        if let Some(error) = failure {
            errors.push(error);
        }
        ensure!(
            errors.is_empty(),
            "fixture shutdown failed: {}",
            errors.join("; ")
        );
        Ok(())
    }
}
impl Drop for EvmFixtureOwnership {
    fn drop(&mut self) {
        let _ = self.stop_monitor();
    }
}
/// Actual fixture handles only; false preserves role/default Rust stop paths.
pub fn stop_evm_fixture(child: &mut TrackedChild) -> Result<bool> {
    let Some(mut fixture) = child.fixture.take() else {
        return Ok(false);
    };
    let result = fixture.shutdown(&mut child.child, "fixture_teardown");
    if result.is_err() {
        if matches!(child.child.try_wait(), Ok(None)) {
            let _ = child.child.kill();
        }
        let _ = child.child.wait();
    }
    result.map(|()| true)
}
/// The exact Anvil child must own its RPC socket before Source deployment.
pub fn evm_node_ready(child: &mut TrackedChild) -> Result<()> {
    let Some(manifest) = get()? else {
        return Ok(());
    };
    if manifest.scenario != "evm" {
        return Ok(());
    }
    let outcome = (|| -> Result<()> {
        let lsof = node_ownership_tool(manifest)?;
        let fixture = child
            .fixture
            .as_ref()
            .ok_or_else(|| eyre::eyre!("Anvil fixture ownership missing"))?;
        ensure!(fixture.kind == "anvil", "wrong fixture readiness child");
        let artifact = fixture.root.executable.clone();
        let token = fixture.root.os_start_token.clone();
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            ensure!(
                child.try_wait()?.is_none(),
                "Anvil fixture exited or ownership failed"
            );
            ensure!(
                live_fixture_identity(child, &artifact, &manifest.verifier_tools["ps"])? == token,
                "Anvil identity changed"
            );
            let output = Command::new(&lsof.path)
                .args([
                    "-nP",
                    "-a",
                    "-p",
                    &child.id().to_string(),
                    "-iTCP",
                    "-sTCP:LISTEN",
                    "-F",
                    "pn",
                ])
                .output()?;
            ensure!(
                output.status.success() || output.status.code() == Some(1),
                "Anvil listener lookup failed"
            );
            let ready = node_listeners(
                child.id(),
                &String::from_utf8(output.stdout)?,
                &["127.0.0.1:8545".parse()?],
            )?;
            ensure!(
                live_fixture_identity(child, &artifact, &manifest.verifier_tools["ps"])? == token,
                "Anvil exited during readiness"
            );
            if ready {
                ensure!(
                    child.try_wait()?.is_none(),
                    "Anvil ownership failed during listener lookup"
                );
                let fixture = child
                    .fixture
                    .as_ref()
                    .ok_or_else(|| eyre::eyre!("Anvil ownership absent"))?;
                let rows = fixture_process_snapshot(&manifest.verifier_tools["ps"], child.id())?;
                observe_fixture_processes(
                    &mut *fixture
                        .processes
                        .lock()
                        .map_err(|_| eyre::eyre!("fixture monitor poisoned"))?,
                    &rows,
                    child.id(),
                    std::slice::from_ref(&artifact),
                )?;
                append_fixture_observation(
                    manifest,
                    "fixture-node-readiness.jsonl",
                    &serde_json::json!({"kind":"anvil","pid":child.id(),"identity":token,"owned_rpc":"127.0.0.1:8545","scope":"actual Child/socket ownership before Source deployment; no chain acceptance"}),
                )?;
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "owned Anvil socket did not become ready"
            );
            thread::sleep(Duration::from_millis(100));
        }
    })();
    if outcome.is_err() {
        let _ = stop_evm_fixture(child);
    }
    outcome
}

/// Passive local ownership proof; never accepts another process's ready port.
fn node_listeners(pid: u32, output: &str, required: &[std::net::SocketAddr]) -> Result<bool> {
    ensure!(output.len() <= 65536, "node listener output exceeds limit");
    let mut process = None;
    let mut found = Vec::new();
    for line in output.lines() {
        match line.as_bytes().first() {
            Some(b'p') => {
                let actual = line[1..].parse::<u32>()?;
                ensure!(actual == pid, "foreign node listener PID");
                process = Some(actual);
            }
            Some(b'f') => {
                ensure!(process == Some(pid), "file descriptor has no owned process");
                let _: u32 = line[1..].parse()?;
            }
            Some(b'n') => {
                ensure!(process == Some(pid), "listener has no owned process");
                let socket: std::net::SocketAddr = line[1..].parse()?;
                ensure!(socket.ip().is_loopback(), "nonloopback node listener");
                found.push(socket);
            }
            _ => bail!("unexpected node listener field"),
        }
    }
    Ok(required.iter().all(|socket| found.contains(socket)))
}

fn actual_fixture_executable(pid: u32, comm: &Path) -> Result<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        let _ = comm;
        Ok(fs::read_link(format!("/proc/{pid}/exe"))?.canonicalize()?)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = pid;
        Ok(comm.canonicalize()?)
    }
}

fn live_fixture_identity(child: &mut Child, artifact: &Artifact, ps: &Artifact) -> Result<String> {
    ensure!(
        child.try_wait()?.is_none(),
        "fixture child exited before readiness"
    );
    let identity = child_identity(ps, child.id())?;
    let fields: Vec<_> = identity.split_whitespace().collect();
    ensure!(
        fields.len() >= 8
            && fields[0].parse::<u32>()? == child.id()
            && fields[1].parse::<u32>()? == std::process::id()
            && actual_fixture_executable(child.id(), Path::new(&fields[7..].join(" ")))?
                == artifact.path.canonicalize()?,
        "fixture executable or parent differs from actual Child"
    );
    Ok(identity)
}

fn node_ownership_tool(manifest: &Manifest) -> Result<Artifact> {
    let case = fixture_json(&manifest.case_inputs)?;
    let approval = fixture_json(&manifest.execution_approval)?;
    ensure!(
        ["cosmosnative", "cosmwasm", "evm"].contains(&manifest.scenario.as_str())
            && case["schema"] == 1
            && case["scenario"] == manifest.scenario
            && approval["root_approved"] == true
            && approval["scenario"] == manifest.scenario
            && approval["mode"] == manifest.mode
            && approval["runtime_source_commit"] == manifest.runtime_source_commit
            && approval["case_inputs"] == serde_json::to_value(&manifest.case_inputs)?
            && approval["node_ownership_tools"] == case["node_ownership_tools"],
        "node ownership tool requires exact approved case"
    );
    let tools: BTreeMap<String, Artifact> =
        serde_json::from_value(case["node_ownership_tools"].clone())?;
    ensure!(
        tools.len() == 1 && tools.contains_key("lsof"),
        "expected only pinned lsof"
    );
    let tool = tools["lsof"].clone();
    verify_executable(&tool)?;
    Ok(tool)
}

fn cosmos_node_tool_key(scenario: &str) -> Result<&'static str> {
    match scenario {
        "cosmosnative" => Ok("E2E_HYPD_PATH"),
        "cosmwasm" => Ok("E2E_OSMOSIS_CLI_PATH"),
        _ => bail!("not an admitted Cosmos fixture family"),
    }
}

fn cosmos_node_artifact(manifest: &Manifest) -> Result<&Artifact> {
    manifest
        .tool_overrides
        .get(cosmos_node_tool_key(&manifest.scenario)?)
        .ok_or_else(|| eyre::eyre!("missing pinned Cosmos node"))
}

fn cosmos_fixture_node_tool_key(scenario: &str, tool: &str) -> Result<&'static str> {
    match (tool, scenario) {
        ("hypd", "cosmosnative") => Ok("E2E_HYPD_PATH"),
        ("osmosisd", "cosmwasm") => Ok("E2E_OSMOSIS_CLI_PATH"),
        _ => bail!("wrong Cosmos fixture tool/family"),
    }
}

/// Admitted external Cosmos fixtures only. The real Child must own both consumed sockets
/// before the first HTTP readiness request or contract deployment is attempted.
pub fn cosmos_node_ready(
    child: &mut TrackedChild,
    executable: &Path,
    home: &Path,
    rpc: &str,
    grpc: &str,
) -> Result<()> {
    let Some(manifest) = get()? else {
        return Ok(());
    };
    let outcome = (|| -> Result<()> {
        let lsof = node_ownership_tool(manifest)?;
        let artifact = cosmos_node_artifact(manifest)?;
        verify_executable(artifact)?;
        ensure!(
            executable.canonicalize()? == artifact.path.canonicalize()?,
            "node executable differs"
        );
        let home =
            checked_owned_path(&manifest.task_root, home.strip_prefix(&manifest.task_root)?)?;
        ensure!(home.is_dir(), "node home missing");
        let home = home
            .to_str()
            .ok_or_else(|| eyre::eyre!("invalid node home"))?;
        ensure!(
            !home.chars().any(char::is_whitespace),
            "ambiguous node home"
        );
        let parse_endpoint = |value: &str| -> Result<std::net::SocketAddr> {
            let value = value.strip_prefix("tcp://").unwrap_or(value);
            let socket: std::net::SocketAddr = value.parse()?;
            ensure!(
                socket.ip().is_loopback() && socket.port() != 0,
                "node endpoint must be loopback"
            );
            Ok(socket)
        };
        let required = [parse_endpoint(rpc)?, parse_endpoint(grpc)?];
        let ps = &manifest.verifier_tools["ps"];
        let token = live_fixture_identity(child, artifact, ps)?;
        let command = Command::new(&ps.path)
            .args(["-ww", "-p", &child.id().to_string(), "-o", "command="])
            .output()?;
        ensure!(
            command.status.success() && command.stdout.len() <= 65536,
            "node command unavailable"
        );
        let command = String::from_utf8(command.stdout)?;
        let args: Vec<_> = command.split_whitespace().collect();
        ensure!(
            args.windows(2).any(|args| args == ["--home", home]) && args.contains(&"start"),
            "node home/start command differs"
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            ensure!(
                live_fixture_identity(child, artifact, ps)? == token,
                "node launch identity changed"
            );
            let output = Command::new(&lsof.path)
                .args([
                    "-nP",
                    "-a",
                    "-p",
                    &child.id().to_string(),
                    "-iTCP",
                    "-sTCP:LISTEN",
                    "-F",
                    "pn",
                ])
                .output()?;
            ensure!(
                output.status.success() || output.status.code() == Some(1),
                "node listener lookup failed"
            );
            let output = String::from_utf8(output.stdout)?;
            let ready = node_listeners(child.id(), &output, &required)?;
            ensure!(
                live_fixture_identity(child, artifact, ps)? == token,
                "node exited during listener lookup"
            );
            if ready {
                return Ok(());
            }
            ensure!(
                Instant::now() < deadline,
                "owned node RPC/gRPC listeners did not become ready"
            );
            thread::sleep(Duration::from_millis(100));
        }
    })();
    if outcome.is_err() {
        // This real Child is still ours even when readiness validation fails.
        // Never leave a setup panic's untracked node alive.
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    outcome
}

/// Non-role fixtures also need real parent waits. Called only from the external
/// Cosmos stack teardown; ordinary Rust stop behavior stays unchanged.
pub fn stop_cosmos_fixture(child: &mut TrackedChild, tool: &str) -> Result<()> {
    let manifest = get()?.ok_or_else(|| eyre::eyre!("external fixture manifest absent"))?;
    let artifact = if tool == "docker" {
        &manifest.verifier_tools["docker"]
    } else {
        let expected = cosmos_fixture_node_tool_key(&manifest.scenario, tool)?;
        manifest
            .tool_overrides
            .get(expected)
            .ok_or_else(|| eyre::eyre!("missing pinned Cosmos fixture"))?
    };
    let result = (|| -> Result<()> {
        verify_executable(artifact)?;
        // An already-reaped foreground docker client is valid fixture cleanup;
        // retain its actual status without granting clean role acceptance.
        let token = if child.try_wait()?.is_none() {
            live_fixture_identity(child, artifact, &manifest.verifier_tools["ps"])?
        } else {
            String::new()
        };
        let owned = OwnedChild {
            pid: child.id(),
            role: format!("fixture-{tool}"),
            executable: artifact.clone(),
            parent_pid: std::process::id(),
            os_start_token: token,
            scope: "actual external Cosmos fixture Child".into(),
        };
        let mut receipt = stop_owned_child_mode(
            child,
            &owned,
            artifact,
            &manifest.verifier_tools["ps"],
            Duration::from_secs(10),
            false,
        )?;
        receipt.purpose = "fixture_teardown".into();
        append_fixture_exit(manifest, &receipt)?;
        ensure!(!receipt.forced_kill, "fixture required forced shutdown");
        Ok(())
    })();
    if result.is_err() {
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        let _ = child.wait();
    }
    result
}

fn append_fixture_observation(
    manifest: &Manifest,
    name: &str,
    value: &serde_json::Value,
) -> Result<()> {
    use std::io::Write;
    let _guard = EVIDENCE_WRITES
        .lock()
        .map_err(|_| eyre::eyre!("fixture evidence writer poisoned"))?;
    let relative = manifest
        .verifier
        .evidence_root
        .strip_prefix(&manifest.task_root)?
        .join(name);
    let target = checked_owned_path(&manifest.task_root, &relative)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)?;
    writeln!(file, "{}", value)?;
    file.sync_all()?;
    checked_owned_path(&manifest.task_root, &relative)?;
    Ok(())
}

fn append_fixture_exit(manifest: &Manifest, receipt: &ChildExit) -> Result<()> {
    use std::io::Write;
    let relative = manifest
        .verifier
        .evidence_root
        .strip_prefix(&manifest.task_root)?
        .join("fixture-parent-waits.jsonl");
    let path = checked_owned_path(&manifest.task_root, &relative)?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(output, "{}", serde_json::to_string(receipt)?)?;
    output.sync_all()?;
    checked_owned_path(&manifest.task_root, &relative)?;
    Ok(())
}

/// EVM metadata/checkpoint evidence must outlive Source's temporary guards.
pub fn evm_checkpoint_path(index: usize) -> Result<Option<PathBuf>> {
    evm_checkpoint_path_at(get()?, index)
}
fn evm_checkpoint_path_at(runtime: Option<&Manifest>, index: usize) -> Result<Option<PathBuf>> {
    let Some(manifest) = runtime.filter(|m| m.scenario == "evm") else {
        return Ok(None);
    };
    ensure!(index < 3, "unexpected Source EVM validator index");
    Ok(Some(create_owned_directory(
        &manifest.task_root,
        &Path::new("evm-checkpoints").join(format!("validator-{index}")),
    )?))
}

pub fn create_owned_path(default: &Path, name: &str) -> PathBuf {
    match get() {
        Ok(Some(m)) => create_owned_directory(&m.task_root, Path::new(name))
            .unwrap_or_else(|e| panic!("external directory: {e:#}")),
        Ok(None) => default.to_path_buf(),
        Err(e) => panic!("external directory: {e:#}"),
    }
}
pub fn sbf_output() -> Option<PathBuf> {
    match get() {
        Ok(Some(m)) => {
            let root = checked_owned_path(&m.task_root, Path::new(""))
                .unwrap_or_else(|e| panic!("owned SBF parent: {e:#}"));
            // tempfile creates its unpredictable leaf exclusively, never follows
            // an existing leaf, and the resulting leaf is checked again.
            let path = tempfile::Builder::new()
                .prefix("sbf-dist-")
                .tempdir_in(&root)
                .unwrap_or_else(|e| panic!("owned SBF output: {e}"))
                .keep();
            Some(
                checked_owned_path(
                    &root,
                    path.strip_prefix(&root)
                        .unwrap_or_else(|e| panic!("SBF relative path: {e}")),
                )
                .unwrap_or_else(|e| panic!("owned SBF leaf: {e:#}")),
            )
        }
        Ok(None) => None,
        Err(e) => panic!("external SBF output: {e:#}"),
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CaptureReply {
    schema: u32,
    environment: BTreeMap<String, String>,
}
fn selected_chain_names(m: &Manifest) -> Result<Vec<String>> {
    m.case_inputs.verify()?;
    let case: serde_json::Value = serde_json::from_slice(&fs::read(&m.case_inputs.path)?)?;
    ensure!(
        case["schema"] == 1 && case["scenario"] == m.scenario,
        "case binding differs from actual scenario"
    );
    let names = case["chain_names"]
        .as_array()
        .ok_or_else(|| eyre::eyre!("case selected chains missing"))?;
    let mut result = Vec::new();
    for name in names {
        let name = name
            .as_str()
            .ok_or_else(|| eyre::eyre!("invalid selected chain name"))?;
        ensure!(
            !name.is_empty() && name.bytes().all(|b| b.is_ascii_alphanumeric()),
            "selected fixture names must be alphanumeric"
        );
        ensure!(
            !result.iter().any(|v| v == name),
            "duplicate selected fixture chain"
        );
        result.push(name.to_owned());
    }
    ensure!(!result.is_empty(), "empty selected chain set");
    Ok(result)
}
fn endpoint_override(key: &str, value: &str, names: &[String]) -> Result<()> {
    let suffix = names
        .iter()
        .find_map(|name| key.strip_prefix(&format!("HYP_CHAINS_{}_", name.to_ascii_uppercase())))
        .ok_or_else(|| eyre::eyre!("capture may alter only selected endpoint fields"))?;
    let customs = [
        "CUSTOMRPCURLS",
        "CUSTOMGRPCURLS",
        "CUSTOMWALLETURLS",
        "CUSTOMWALLETSOLIDITYURLS",
        "CUSTOMGATEWAYURLS",
        "CONNECTION_URLS",
    ];
    let parsed = if customs.contains(&suffix) {
        serde_json::Value::String(value.to_owned())
    } else {
        let parts: Vec<_> = suffix.split('_').collect();
        ensure!(
            parts.len() == 3
                && [
                    "RPCURLS",
                    "GRPCURLS",
                    "WALLETURLS",
                    "WALLETSOLIDITYURLS",
                    "GATEWAYURLS"
                ]
                .contains(&parts[0]),
            "base endpoints require indexed fields"
        );
        let index = parts[1].parse::<u16>()?;
        ensure!(
            index < 256 && parts[1] == index.to_string(),
            "invalid endpoint index"
        );
        if parts[2] == "PUBLIC" {
            ensure!(
                ["true", "false"].contains(&value),
                "invalid endpoint public flag"
            );
            return Ok(());
        }
        ensure!(
            parts[2] == "HTTP" && !value.contains(','),
            "unknown endpoint row field"
        );
        serde_json::Value::String(value.to_owned())
    };
    fn urls(value: &serde_json::Value, output: &mut Vec<String>) -> Result<()> {
        match value {
            serde_json::Value::String(s) => output.extend(s.split(',').map(str::to_owned)),
            _ => bail!("endpoint override must be scalar"),
        }
        Ok(())
    }
    let mut endpoints = Vec::new();
    urls(&parsed, &mut endpoints)?;
    ensure!(!endpoints.is_empty(), "empty endpoint override");
    for endpoint in endpoints {
        let url = url::Url::parse(&endpoint)?;
        ensure!(
            ["http", "https"].contains(&url.scheme())
                && matches!(
                    url.host_str(),
                    Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
                )
                && url.username().is_empty()
                && url.password().is_none(),
            "capture endpoint must be credential-free local HTTP; WS bypass unsupported"
        );
    }
    Ok(())
}
/// The pinned checker captures public effective inputs and may replace only
/// selected endpoint fields. It never receives authority to alter signing/policy.
pub fn capture_launch(command: &mut Command, executable: &Path) -> Result<()> {
    use std::io::Write;
    let Some(m) = get()? else {
        return Ok(());
    };
    configure_evm_fixture(command, executable, m)?;
    let Some(role) = ["relayer", "validator", "scraper"]
        .into_iter()
        .find(|role| m.artifacts[*role].path == executable)
    else {
        return Ok(());
    };
    let Some(loaded) = (match &*LOADED {
        Ok(v) => v.as_ref(),
        Err(e) => bail!("{e}"),
    }) else {
        bail!("missing external manifest");
    };
    let names = selected_chain_names(m)?;
    let environment: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|value| {
                (
                    key.to_string_lossy().into_owned(),
                    value.to_string_lossy().into_owned(),
                )
            })
        })
        .collect();
    let request = serde_json::json!({"schema":1,"scenario":m.scenario,"role":role,"runtime_source_commit":m.runtime_source_commit,"cwd":command.get_current_dir(),"arguments":command.get_args().map(|v|v.to_string_lossy().into_owned()).collect::<Vec<_>>(),"environment":environment,"selected_chain_names":names,"harness_pid":std::process::id()});
    m.verifier.python.verify()?;
    m.verifier.script.verify()?;
    let mut child = Command::new(&m.verifier.python.path)
        .arg(&m.verifier.script.path)
        .args(["capture", "--manifest"])
        .arg(&loaded.path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let input = serde_json::to_vec(&request)?;
    if let Some(mut pipe) = child.stdin.take() {
        if let Err(error) = pipe.write_all(&input) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error.into());
        }
    }
    let output = child.wait_with_output()?;
    ensure!(
        output.status.success() && output.stdout.len() <= 1048576,
        "external capture refused; no agent launched"
    );
    let reply: CaptureReply = serde_json::from_slice(&output.stdout)?;
    ensure!(reply.schema == 1, "unsupported capture reply");
    for (key, value) in &reply.environment {
        endpoint_override(key, value, &names)?;
    }
    for (key, value) in reply.environment {
        command.env(key, value);
    }
    Ok(())
}

/// Preserve explicit public fixture launch state before temporary setup drops.
pub fn record_launch(command: &Command, executable: &Path) -> Result<()> {
    use std::io::Write;
    let Some(m) = get()? else {
        return Ok(());
    };
    let Some(role) = ["relayer", "validator", "scraper", "init-db"]
        .into_iter()
        .find(|role| m.artifacts[*role].path == executable)
    else {
        return Ok(());
    };
    let _write_guard = EVIDENCE_WRITES
        .lock()
        .map_err(|_| eyre::eyre!("evidence writer poisoned"))?;
    let evidence_relative = m.verifier.evidence_root.strip_prefix(&m.task_root)?;
    create_owned_directory(&m.task_root, evidence_relative)?;
    ensure!(
        m.verifier
            .evidence_root
            .canonicalize()?
            .starts_with(m.task_root.canonicalize()?),
        "evidence parent escaped owned root"
    );
    let environment: BTreeMap<_, _> = command
        .get_envs()
        .filter_map(|(key, value)| {
            value.map(|v| {
                (
                    key.to_string_lossy().into_owned(),
                    v.to_string_lossy().into_owned(),
                )
            })
        })
        .collect();
    let record = serde_json::json!({"role":role,"executable":m.artifacts[role],"arguments":command.get_args().map(|a|a.to_string_lossy().into_owned()).collect::<Vec<_>>(),"explicit_public_fixture_environment":environment,"cwd":command.get_current_dir(),"runtime_source_commit":m.runtime_source_commit,"scope":"External fixture only; inherited user credentials cleared. Mapped Rocks paths stay under task ownership after setup TempDirs drop."});
    let target_relative = evidence_relative.join("role-launches.jsonl");
    let target = checked_owned_path(&m.task_root, &target_relative)?;
    if target.exists() {
        ensure!(
            fs::symlink_metadata(&target)?.is_file()
                && !fs::symlink_metadata(&target)?.file_type().is_symlink(),
            "unsafe role evidence file"
        );
    }
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)?;
    writeln!(output, "{}", serde_json::to_string(&record)?)?;
    output.sync_all()?;
    checked_owned_path(&m.task_root, &target_relative)?;
    Ok(())
}

/// Actual Child ownership evidence for later adapter cleanup, never guessed ids.
pub fn record_child(executable: &Path, pid: u32) -> Result<Option<RoleOwnership>> {
    use std::io::Write;
    let Some(m) = get()? else {
        return Ok(None);
    };
    let Some(role) = ["relayer", "validator", "scraper"]
        .into_iter()
        .find(|role| m.artifacts[*role].path == executable)
    else {
        return Ok(None);
    };
    let ps = &m.verifier_tools["ps"];
    verify_executable(ps)?;
    let status = Command::new(&ps.path)
        .args([
            "-ww",
            "-p",
            &pid.to_string(),
            "-o",
            "pid=,ppid=,lstart=,comm=",
        ])
        .output()?;
    ensure!(
        status.status.success() && status.stdout.len() <= 65536,
        "owned child identity unavailable"
    );
    let start_token = String::from_utf8(status.stdout)?;
    ensure!(
        !start_token.trim().is_empty(),
        "child exited before ownership capture"
    );
    let record = OwnedChild { pid, role: role.to_owned(), executable: m.artifacts[role].clone(), parent_pid: std::process::id(), os_start_token: start_token.trim().to_owned(), scope: "Actual Child returned by this harness spawn; verifier must revalidate process identity before signalling.".to_owned() };
    let _write_guard = EVIDENCE_WRITES
        .lock()
        .map_err(|_| eyre::eyre!("evidence writer poisoned"))?;
    let target_relative = m
        .verifier
        .evidence_root
        .strip_prefix(&m.task_root)?
        .join("owned-children.jsonl");
    let target = checked_owned_path(&m.task_root, &target_relative)?;
    if target.exists() {
        ensure!(
            fs::symlink_metadata(&target)?.is_file()
                && !fs::symlink_metadata(&target)?.file_type().is_symlink(),
            "unsafe child evidence file"
        );
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(target)?;
    writeln!(file, "{}", serde_json::to_string(&record)?)?;
    file.sync_all()?;
    checked_owned_path(&m.task_root, &target_relative)?;
    Ok(Some(RoleOwnership {
        record,
        runtime: m.clone(),
    }))
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct OwnedChild {
    pid: u32,
    role: String,
    executable: Artifact,
    parent_pid: u32,
    os_start_token: String,
    scope: String,
}
pub struct RoleOwnership {
    record: OwnedChild,
    runtime: Manifest,
}
#[derive(Debug, Serialize)]
struct ChildExit {
    pid: u32,
    role: String,
    executable: Artifact,
    parent_pid: u32,
    os_start_token: String,
    parent_wait_completed: bool,
    already_exited: bool,
    forced_kill: bool,
    success: bool,
    exit_code: Option<i32>,
    signal: Option<i32>,
    purpose: String,
    planned_exit: bool,
}

/// Role Child ownership remains attached through tuple moves, State replacement
/// and setup unwind. Absent-manifest and node/tool children retain old behavior.
pub struct TrackedChild {
    child: Child,
    owned: Option<RoleOwnership>,
    receipt_completed: bool,
    restart: Option<RoleRestart>,
    fixture: Option<EvmFixtureOwnership>,
}
#[derive(Clone)]
pub struct RoleRestart {
    program: crate::program::Program,
    log_prefix: &'static str,
    logs_directory: Option<PathBuf>,
}
impl RoleRestart {
    pub fn spawn(self) -> crate::utils::AgentHandles {
        self.program
            .spawn(self.log_prefix, self.logs_directory.as_deref())
    }
}
impl std::ops::Deref for TrackedChild {
    type Target = Child;
    fn deref(&self) -> &Child {
        &self.child
    }
}
impl std::ops::DerefMut for TrackedChild {
    fn deref_mut(&mut self) -> &mut Child {
        &mut self.child
    }
}
impl TrackedChild {
    pub fn new(child: Child, owned: Option<RoleOwnership>) -> Self {
        Self {
            child,
            owned,
            receipt_completed: false,
            restart: None,
            fixture: None,
        }
    }
    pub fn try_wait(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        if let Some(fixture) = &self.fixture {
            let state = fixture
                .processes
                .lock()
                .map_err(|_| std::io::Error::other("fixture monitor poisoned"))?;
            if let Some(error) = &state.failure {
                return Err(std::io::Error::other(error.clone()));
            }
        }
        self.child.try_wait()
    }
    pub fn retain_restart(
        &mut self,
        program: crate::program::Program,
        log_prefix: &'static str,
        logs_directory: Option<&Path>,
    ) {
        if self.owned.is_none() && ["ETH", "SQL", "KTY"].contains(&log_prefix) {
            let outcome = (|| -> Result<()> {
                if let Some(manifest) = get()? {
                    if manifest.scenario == "evm" {
                        let command = program.create_command();
                        let executable = program
                            .get_bin_path()
                            .ok_or_else(|| eyre::eyre!("fixture binary missing"))??;
                        let kind = evm_fixture_kind(&command, &executable)
                            .ok_or_else(|| eyre::eyre!("unapproved fixture launch"))?;
                        self.fixture =
                            Some(EvmFixtureOwnership::start(manifest, &mut self.child, kind)?);
                    }
                }
                Ok(())
            })();
            if let Err(error) = outcome {
                if matches!(self.child.try_wait(), Ok(None)) {
                    let _ = self.child.kill();
                }
                let _ = self.child.wait();
                panic!("external fixture ownership: {error:#}");
            }
        }
        if self.owned.is_some() {
            self.restart = Some(RoleRestart {
                program,
                log_prefix,
                logs_directory: logs_directory.map(Path::to_path_buf),
            });
        }
    }
    fn shutdown(&mut self, purpose: &str, planned: bool) -> Result<Option<ChildExit>> {
        let Some(ownership) = &self.owned else {
            return Ok(None);
        };
        let owned = &ownership.record;
        ensure!(
            !self.receipt_completed,
            "role Child already has parent wait receipt"
        );
        let m = &ownership.runtime;
        let mut receipt = stop_owned_child_mode(
            &mut self.child,
            owned,
            &m.artifacts[&owned.role],
            &m.verifier_tools["ps"],
            Duration::from_secs(30),
            planned,
        )?;
        receipt.purpose = purpose.to_owned();
        receipt.planned_exit = planned || purpose == "same_db_restart";
        append_child_exit(m, &receipt)?;
        self.receipt_completed = true;
        Ok(Some(receipt))
    }
}
impl Drop for TrackedChild {
    fn drop(&mut self) {
        if self.fixture.is_some() {
            if let Err(error) = stop_evm_fixture(self) {
                eprintln!("external fixture cleanup failed: {error:#}");
            }
            return;
        }
        if self.owned.is_none() || self.receipt_completed {
            return;
        }
        if let Err(error) = self.shutdown("unwind_or_early_drop", false) {
            // We still own this exact unreused Child handle. Cleanup may not
            // become acceptance when metadata/filesystem validation failed.
            if matches!(self.child.try_wait(), Ok(None)) {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
            eprintln!("external role cleanup failed: {error:#}");
        }
    }
}
fn append_child_exit(m: &Manifest, receipt: &ChildExit) -> Result<()> {
    use std::io::Write;
    let _write_guard = EVIDENCE_WRITES
        .lock()
        .map_err(|_| eyre::eyre!("evidence writer poisoned"))?;
    let relative = m
        .verifier
        .evidence_root
        .strip_prefix(&m.task_root)?
        .join("parent-child-exits.jsonl");
    let path = checked_owned_path(&m.task_root, &relative)?;
    let mut output = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)?;
    writeln!(output, "{}", serde_json::to_string(receipt)?)?;
    output.sync_all()?;
    checked_owned_path(&m.task_root, &relative)?;
    Ok(())
}
pub fn intentional_role_stop(child: &mut TrackedChild, purpose: &str) -> Result<()> {
    ensure!(
        ["intentional_reorg", "intentional_restart"].contains(&purpose),
        "unknown intentional child stop"
    );
    let receipt = child
        .shutdown(purpose, true)?
        .ok_or_else(|| eyre::eyre!("planned stop was not a tracked role"))?;
    ensure!(
        !receipt.already_exited && receipt.parent_wait_completed && receipt.signal == Some(9),
        "planned role was already dead or failed to reap"
    );
    Ok(())
}
fn wait_for_actual_checker(stage: &str, expected: u32, seconds: u64) -> Result<()> {
    let deadline = Instant::now() + Duration::from_secs(seconds);
    loop {
        if checker(stage, expected)? {
            return Ok(());
        }
        ensure!(
            Instant::now() < deadline,
            "actual external evidence stage timed out: {stage}"
        );
        thread::sleep(Duration::from_millis(500));
    }
}
pub fn prepare_same_db_restart<'a>(
    children: impl IntoIterator<Item = &'a mut TrackedChild>,
    expected: u32,
) -> Result<Vec<RoleRestart>> {
    let Some(m) = get()? else {
        return Ok(Vec::new());
    };
    prepare_same_db_restart_with(
        children,
        expected,
        m.harness_deadline_seconds,
        |stage, expected, seconds| {
            if seconds == 0 {
                ensure!(
                    checker(stage, expected)?,
                    "actual stopped pre-restart snapshot failed"
                );
                Ok(())
            } else {
                wait_for_actual_checker(stage, expected, seconds)
            }
        },
    )
}
fn prepare_same_db_restart_with<'a>(
    children: impl IntoIterator<Item = &'a mut TrackedChild>,
    expected: u32,
    seconds: u64,
    mut check: impl FnMut(&str, u32, u64) -> Result<()>,
) -> Result<Vec<RoleRestart>> {
    // Some Source scenarios stop at delivery observations. Keep their default
    // behavior; external correctness waits for the actual full600s proof first.
    check("live", expected, seconds)?;
    let mut roles = Vec::new();
    for child in children {
        if child.owned.is_none() {
            continue;
        }
        let spec = child
            .restart
            .clone()
            .ok_or_else(|| eyre::eyre!("actual role original Program missing"))?;
        roles.push((child, spec));
    }
    ensure!(!roles.is_empty(), "no configured actual roles to restart");
    let mut failures = Vec::new();
    for (child, _) in &mut roles {
        match child.shutdown("same_db_restart", false) {
            Ok(Some(receipt))
                if receipt.success && receipt.parent_wait_completed && !receipt.forced_kill => {}
            Ok(_) => failures.push("role was not cleanly stopped".to_owned()),
            Err(error) => failures.push(format!("role restart shutdown: {error:#}")),
        }
    }
    ensure!(
        failures.is_empty(),
        "same-DB restart stop failed: {}",
        failures.join("; ")
    );
    check("before_restart", expected, 0)?;
    Ok(roles.into_iter().map(|(_, spec)| spec).collect())
}
pub fn finish_same_db_restart(expected: u32) -> Result<()> {
    if get()?.is_some() {
        wait_for_actual_checker("after_restart", expected, 120)?;
    }
    Ok(())
}
pub fn restart_role_handles<'a>(
    handles: impl IntoIterator<Item = &'a mut crate::utils::AgentHandles>,
    expected: u32,
) -> Result<()> {
    if get()?.is_none() {
        return Ok(());
    }
    let mut handles: Vec<_> = handles.into_iter().collect();
    let specs = prepare_same_db_restart(handles.iter_mut().map(|handle| &mut handle.1), expected)?;
    ensure!(
        specs.len() == handles.len(),
        "unexpected non-role handle in configured role restart"
    );
    for (handle, spec) in handles.into_iter().zip(specs) {
        let old = std::mem::replace(handle, spec.spawn());
        old.2.join_box();
        old.3.join_box();
    }
    finish_same_db_restart(expected)
}
fn child_identity(ps: &Artifact, pid: u32) -> Result<String> {
    verify_executable(ps)?;
    let output = Command::new(&ps.path)
        .args([
            "-ww",
            "-p",
            &pid.to_string(),
            "-o",
            "pid=,ppid=,lstart=,comm=",
        ])
        .output()?;
    ensure!(
        output.status.success() && output.stdout.len() <= 65536,
        "owned child identity unavailable"
    );
    let token = String::from_utf8(output.stdout)?;
    ensure!(!token.trim().is_empty(), "owned child identity empty");
    Ok(token.trim().to_owned())
}
#[cfg(test)]
fn stop_owned_child(
    child: &mut Child,
    owned: &OwnedChild,
    artifact: &Artifact,
    ps: &Artifact,
    budget: Duration,
) -> Result<ChildExit> {
    stop_owned_child_mode(child, owned, artifact, ps, budget, false)
}
fn stop_owned_child_mode(
    child: &mut Child,
    owned: &OwnedChild,
    artifact: &Artifact,
    ps: &Artifact,
    budget: Duration,
    planned: bool,
) -> Result<ChildExit> {
    use std::os::unix::process::ExitStatusExt;
    ensure!(
        child.id() == owned.pid && owned.parent_pid == std::process::id(),
        "child ownership differs"
    );
    ensure!(
        artifact.path == owned.executable.path
            && artifact.bytes == owned.executable.bytes
            && artifact.sha256 == owned.executable.sha256,
        "owned child executable changed"
    );
    verify_executable(artifact)?;
    let prior = child.try_wait()?;
    let already_exited = prior.is_some();
    let (status, forced_kill) = if let Some(status) = prior {
        (status, false)
    } else {
        let current = child_identity(ps, child.id())?;
        ensure!(
            current == owned.os_start_token,
            "owned child start token changed"
        );
        let fields: Vec<_> = current.split_whitespace().collect();
        ensure!(
            fields.len() >= 8
                && fields[0].parse::<u32>()? == child.id()
                && fields[1].parse::<u32>()? == owned.parent_pid,
            "owned child parent identity changed"
        );
        #[cfg(target_os = "linux")]
        let actual_executable = fs::read_link(format!("/proc/{}/exe", child.id()))?;
        #[cfg(not(target_os = "linux"))]
        let actual_executable = PathBuf::from(fields[7..].join(" "));
        ensure!(
            actual_executable.canonicalize()? == artifact.path.canonicalize()?,
            "actual executable does not match manifest"
        );
        if planned {
            child.kill()?;
            (child.wait()?, false)
        } else {
            nix::sys::signal::kill(
                nix::unistd::Pid::from_raw(i32::try_from(child.id())?),
                nix::sys::signal::Signal::SIGTERM,
            )?;
            let deadline = Instant::now() + budget;
            loop {
                if let Some(status) = child.try_wait()? {
                    break (status, false);
                }
                if Instant::now() >= deadline {
                    // Cleanup is mandatory; forced shutdown is retained as failure,
                    // never accepted as clean final evidence.
                    child.kill()?;
                    break (child.wait()?, true);
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    Ok(ChildExit {
        pid: owned.pid,
        role: owned.role.clone(),
        executable: owned.executable.clone(),
        parent_pid: owned.parent_pid,
        os_start_token: owned.os_start_token.clone(),
        parent_wait_completed: true,
        already_exited,
        forced_kill,
        success: status.success() && !already_exited && !forced_kill,
        exit_code: status.code(),
        signal: status.signal(),
        purpose: "final".to_owned(),
        planned_exit: planned,
    })
}
/// Parent-only final barrier. Nodes/PostgreSQL are deliberately not selected.
/// A real Child handle plus exact launch identity is required before signalling.
pub fn stop_and_wait_roles<'a>(
    children: impl IntoIterator<Item = &'a mut TrackedChild>,
) -> Result<()> {
    let Some(_) = get()? else {
        return Ok(());
    };
    let mut receipts = Vec::new();
    let mut errors = Vec::new();
    for child in children {
        if child.owned.is_none() {
            continue;
        } // actual node/tool Child, never a role
        match child.shutdown("final", false) {
            Ok(Some(receipt)) => receipts.push(receipt),
            Ok(None) => unreachable!("checked actual tracked role"),
            Err(error) => errors.push(format!("role final shutdown: {error:#}")),
        }
    }
    ensure!(!receipts.is_empty(), "no actual role children stopped");
    ensure!(
        errors.is_empty(),
        "parent role shutdown failed: {}",
        errors.join("; ")
    );
    ensure!(
        receipts.iter().all(|row| row.success),
        "role exited early or required forced shutdown; final acceptance forbidden"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosmos_node_artifact_rejects_crossed_family_keys() {
        let root = tempfile::tempdir().unwrap();
        for (scenario, wanted, crossed) in [
            ("cosmosnative", "E2E_HYPD_PATH", "E2E_OSMOSIS_CLI_PATH"),
            ("cosmwasm", "E2E_OSMOSIS_CLI_PATH", "E2E_HYPD_PATH"),
        ] {
            let mut manifest = fixture(root.path());
            manifest.scenario = scenario.into();
            manifest.tool_overrides =
                BTreeMap::from([(crossed.into(), artifact(root.path(), "foreign-node"))]);
            assert!(cosmos_node_artifact(&manifest).is_err());
            let correct = artifact(root.path(), "correct-node");
            manifest
                .tool_overrides
                .insert(wanted.into(), correct.clone());
            assert_eq!(cosmos_node_artifact(&manifest).unwrap().path, correct.path);
        }
    }
    #[test]
    fn cosmos_fixture_tool_rejects_crossed_or_unknown_family() {
        assert_eq!(
            cosmos_fixture_node_tool_key("cosmosnative", "hypd").unwrap(),
            "E2E_HYPD_PATH"
        );
        assert_eq!(
            cosmos_fixture_node_tool_key("cosmwasm", "osmosisd").unwrap(),
            "E2E_OSMOSIS_CLI_PATH"
        );
        for (family, tool) in [
            ("cosmosnative", "osmosisd"),
            ("cosmwasm", "hypd"),
            ("evm", "hypd"),
            ("cosmwasm", "foreign"),
        ] {
            assert!(cosmos_fixture_node_tool_key(family, tool).is_err());
        }
    }
    #[test]
    fn cosmos_node_tool_uses_exact_closed_family_mapping() {
        assert_eq!(
            cosmos_node_tool_key("cosmosnative").unwrap(),
            "E2E_HYPD_PATH"
        );
        assert_eq!(
            cosmos_node_tool_key("cosmwasm").unwrap(),
            "E2E_OSMOSIS_CLI_PATH"
        );
    }
    #[test]
    fn non_cosmos_family_never_borrows_a_node_tool() {
        for family in [
            "evm", "tron", "starknet", "sealevel", "radix", "aleo", "", "cosmos",
        ] {
            assert!(cosmos_node_tool_key(family).is_err());
        }
    }
    fn artifact(root: &Path, name: &str) -> Artifact {
        let path = root.join(name);
        let content = if name == "case-inputs.json" {
            "{}".to_owned()
        } else {
            format!("public fixture {name}")
        };
        fs::write(&path, content).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        Artifact {
            bytes: fs::metadata(&path).unwrap().len(),
            sha256: sha(&path).unwrap(),
            path,
        }
    }
    fn fixture(root: &Path) -> Manifest {
        let artifacts: BTreeMap<String, Artifact> = REQUIRED
            .into_iter()
            .map(|key| (key.to_owned(), artifact(root, key)))
            .collect();
        let aliases = [
            ("HYPERLANE_STARKNET_CRYPTO_LIBRARY", "starknet"),
            ("HYPERLANE_ALEO_CRYPTO_LIBRARY", "aleo-crypto"),
            ("HYPERLANE_ALEO_VM_LIBRARY", "aleo-vm"),
            ("HYPERLANE_REGEX_LIBRARY", "regex"),
            ("ZIGGY_REGEX_LIBRARY", "regex"),
            ("HYPERLANE_ALEO_VM_WORKER", "worker"),
            ("HYPERLANE_URL_LIBRARY", "url"),
        ];
        Manifest {
            schema: 3,
            implementation: "zig".to_owned(),
            scenario: "evm".to_owned(),
            runtime_source_commit: "a".repeat(40),
            mode: "ReleaseSafe".to_owned(),
            task_root: root.to_path_buf(),
            environment: aliases
                .into_iter()
                .map(|(key, name)| {
                    (
                        key.to_owned(),
                        artifacts[name].path.to_string_lossy().into_owned(),
                    )
                })
                .collect(),
            verifier: Verifier {
                python: artifact(root, "python"),
                script: artifact(root, "checker.py"),
                evidence_root: root.join("evidence"),
            },
            execution_approval: artifact(root, "execution-approval.json"),
            case_inputs: artifact(root, "case-inputs.json"),
            verifier_tools: ["cast", "oracle", "native_rows", "psql", "docker", "ps"]
                .into_iter()
                .map(|name| (name.to_owned(), artifact(root, &format!("tool-{name}"))))
                .collect(),
            artifacts,
            harness_deadline_seconds: 1800,
            tool_overrides: BTreeMap::new(),
        }
    }
    fn contract_data(path: &Path, bytes: &[u8]) -> Artifact {
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        Artifact {
            path: path.to_path_buf(),
            bytes: u64::try_from(bytes.len()).unwrap(),
            sha256: sha(path).unwrap(),
        }
    }
    // Synthetic only: the production selector never accepts this release rule.
    fn tiny_contract_bundle(root: &Path) -> (Manifest, FixtureContracts) {
        let mut manifest = fixture(root);
        manifest.scenario = "cosmwasm".to_owned();
        let directory = root.join("contracts");
        fs::create_dir(&directory).unwrap();
        let wasm = contract_data(&directory.join("sample.wasm"), b"synthetic WASM unit bytes");
        let checksum = contract_data(
            &directory.join("checksums.txt"),
            format!("{}  sample.wasm\n", wasm.sha256).as_bytes(),
        );
        let archive = contract_data(&root.join("synthetic.zip"), b"synthetic archive unit bytes");
        let bundle = FixtureContracts {
            schema: 1,
            scenario: "cosmwasm".to_owned(),
            source_release: "synthetic".to_owned(),
            root: directory,
            archive,
            publisher_checksum: None,
            files: BTreeMap::from([
                ("sample.wasm".to_owned(), wasm),
                ("checksums.txt".to_owned(), checksum),
            ]),
        };
        (manifest, bundle)
    }
    fn tiny_release<'a>(bundle: &'a FixtureContracts, digest: &'a str) -> ContractRelease<'a> {
        ContractRelease {
            scenario: "cosmwasm",
            release: "synthetic",
            archive_name: "synthetic.zip",
            archive_bytes: bundle.archive.bytes,
            archive_sha: &bundle.archive.sha256,
            member_count: 2,
            member_digest: digest,
            publisher_checksum_sha: None,
            required: &["sample.wasm"],
        }
    }
    #[test]
    fn contract_json_rejects_raw_repeated_keys_at_every_depth() {
        for raw in [
            r#"{"fixture_contracts":{},"fixture_contracts":{}}"#,
            r#"{"fixture_contracts":{"files":{"same":{},"same":{}}}}"#,
            r#"{"nested":[{"x":1,"x":2}]}"#,
        ] {
            assert!(serde_json::from_str::<UniqueCaseJson>(raw).is_err());
        }
        assert!(serde_json::from_str::<UniqueCaseJson>(
            r#"{"nested":[null,true,1,-1,1.5,"x",{}]}"#
        )
        .is_ok());
    }
    #[test]
    fn contract_bundle_validates_closed_synthetic_data_but_production_never_admits_it() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (manifest, bundle) = tiny_contract_bundle(&root);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        assert_eq!(
            verify_contract_bundle(&manifest, &bundle, &release).unwrap(),
            bundle.root
        );
        assert!(
            verify_contract_bundle(&manifest, &bundle, &contract_release("cosmwasm").unwrap())
                .is_err()
        );
        assert!(contract_release("cosmosnative").is_none());
        assert!(contract_release("evm").is_none());
        assert!(contract_release("../starknet").is_none());
    }
    #[test]
    fn contract_bundle_missing_extra_changed_and_rebound_members_fail() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (manifest, bundle) = tiny_contract_bundle(&root);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        let mut changed = bundle.clone();
        changed.files.remove("sample.wasm");
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.files.get_mut("sample.wasm").unwrap().sha256 = "00".repeat(32);
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.files.get_mut("sample.wasm").unwrap().path = root.join("foreign.wasm");
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let extra = bundle.root.join("extra.wasm");
        contract_data(&extra, b"extra");
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
        fs::remove_file(extra).unwrap();
        fs::write(bundle.root.join("sample.wasm"), b"changed after preflight").unwrap();
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
    }
    #[test]
    fn contract_bundle_scenario_release_schema_archive_and_mode_are_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (manifest, bundle) = tiny_contract_bundle(&root);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        let mut changed = bundle.clone();
        changed.scenario = "starknet".to_owned();
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.source_release = "latest".to_owned();
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.schema = 2;
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.archive.sha256 = "00".repeat(32);
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.archive.bytes = u64::MAX;
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        #[cfg(unix)]
        {
            fs::set_permissions(&bundle.archive.path, fs::Permissions::from_mode(0o700)).unwrap();
            assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
        }
    }
    #[test]
    fn contract_bundle_rejects_foreign_root_parent_traversal_and_unknown_fields() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let foreign = tempfile::tempdir().unwrap();
        let (manifest, bundle) = tiny_contract_bundle(&root);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        let mut changed = bundle.clone();
        changed.root = foreign.path().to_path_buf();
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut changed = bundle.clone();
        changed.root = root.join("contracts/../contracts");
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
        let mut value = serde_json::to_value(&bundle).unwrap();
        value["unknown"] = serde_json::Value::Bool(true);
        assert!(serde_json::from_value::<FixtureContracts>(value).is_err());
        assert!(!flat_contract_name("../outside"));
        assert!(!flat_contract_name("a/b"));
        assert!(!flat_contract_name("a\\b"));
        assert!(!flat_contract_name(".."));
    }
    #[cfg(unix)]
    #[test]
    fn contract_bundle_rejects_symlink_parents_leaves_and_hard_links() {
        use std::os::unix::fs::symlink;
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (manifest, bundle) = tiny_contract_bundle(&root);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        let sample = bundle.root.join("sample.wasm");
        let saved = root.join("saved.wasm");
        fs::rename(&sample, &saved).unwrap();
        symlink(&saved, &sample).unwrap();
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
        fs::remove_file(&sample).unwrap();
        fs::rename(&saved, &sample).unwrap();
        let linked = root.join("hardlinked.wasm");
        fs::hard_link(&sample, &linked).unwrap();
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
        fs::remove_file(linked).unwrap();
        let alias = root.join("alias");
        symlink(&bundle.root, &alias).unwrap();
        let mut changed = bundle.clone();
        changed.root = alias;
        assert!(verify_contract_bundle(&manifest, &changed, &release).is_err());
    }
    #[test]
    fn contract_inputs_are_required_for_contract_scenarios_and_forbidden_elsewhere() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut manifest = fixture(&root);
        assert!(validate_contract_inputs(&manifest).unwrap().is_none());
        manifest.scenario = "cosmwasm".to_owned();
        assert!(validate_contract_inputs(&manifest).is_err());
        manifest.scenario = "starknet".to_owned();
        assert!(validate_contract_inputs(&manifest).is_err());
        manifest.scenario = "evm".to_owned();
        manifest.case_inputs =
            contract_data(&manifest.case_inputs.path, br#"{"fixture_contracts":{}}"#);
        assert!(validate_contract_inputs(&manifest).is_err());
        manifest.case_inputs = contract_data(
            &manifest.case_inputs.path,
            br#"{"fixture_contracts":{},"fixture_contracts":{}}"#,
        );
        assert!(validate_contract_inputs(&manifest).is_err());
    }

    #[test]
    fn contract_checksums_reject_incomplete_duplicate_and_foreign_rows() {
        for invalid in [
            "".to_owned(),
            format!("{}  sample.wasm\n", "00".repeat(32)),
            format!("{}  ../sample.wasm\n", "00".repeat(32)),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let (manifest, mut bundle) = tiny_contract_bundle(&root);
            let artifact = contract_data(&bundle.root.join("checksums.txt"), invalid.as_bytes());
            bundle.files.insert("checksums.txt".to_owned(), artifact);
            let digest = contract_member_digest(&bundle.files);
            let release = tiny_release(&bundle, &digest);
            assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
        }
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (manifest, mut bundle) = tiny_contract_bundle(&root);
        let repeated = format!(
            "{0}  sample.wasm\n{0}  sample.wasm\n",
            bundle.files["sample.wasm"].sha256
        );
        let artifact = contract_data(&bundle.root.join("checksums.txt"), repeated.as_bytes());
        bundle.files.insert("checksums.txt".to_owned(), artifact);
        let digest = contract_member_digest(&bundle.files);
        let release = tiny_release(&bundle, &digest);
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
    }
    #[test]
    fn contract_published_archive_checksum_is_required_and_exact() {
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let (mut manifest, mut bundle) = tiny_contract_bundle(&root);
        manifest.scenario = "starknet".to_owned();
        bundle.scenario = "starknet".to_owned();
        let mut text = format!("{}  synthetic.zip", bundle.archive.sha256);
        while text.len() < 95 {
            text.push(' ');
        }
        text.push('\n');
        let checksum = contract_data(&root.join("published.CHECKSUM"), text.as_bytes());
        bundle.publisher_checksum = Some(checksum.clone());
        let digest = contract_member_digest(&bundle.files);
        let release = ContractRelease {
            scenario: "starknet",
            release: "synthetic",
            archive_name: "synthetic.zip",
            archive_bytes: bundle.archive.bytes,
            archive_sha: &bundle.archive.sha256,
            member_count: 2,
            member_digest: &digest,
            publisher_checksum_sha: Some(&checksum.sha256),
            required: &["sample.wasm"],
        };
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_ok());
        let mut missing = bundle.clone();
        missing.publisher_checksum = None;
        assert!(verify_contract_bundle(&manifest, &missing, &release).is_err());
        let mut wrong = bundle.clone();
        wrong.publisher_checksum.as_mut().unwrap().sha256 = "00".repeat(32);
        assert!(verify_contract_bundle(&manifest, &wrong, &release).is_err());
        fs::write(&checksum.path, "X".repeat(96)).unwrap();
        assert!(verify_contract_bundle(&manifest, &bundle, &release).is_err());
    }
    #[test]
    fn contract_consumer_disabled_and_wrong_scenario_release_do_not_fallback() {
        assert!(contract_bundle_with(None, "cosmwasm", "v0.0.6")
            .unwrap()
            .is_none());
        let temporary = tempfile::tempdir().unwrap();
        let root = temporary.path().canonicalize().unwrap();
        let mut manifest = fixture(&root);
        manifest.scenario = "cosmwasm".to_owned();
        assert!(contract_bundle_with(Some(&manifest), "starknet", "0.3.9").is_err());
        assert!(contract_bundle_with(Some(&manifest), "cosmwasm", "latest").is_err());
        assert!(contract_bundle_with(Some(&manifest), "cosmwasm", "v0.0.6").is_err());
        assert!(contract_bundle_with(Some(&manifest), "evm", "v0.0.6").is_err());
    }

    fn postgres_test_fixture(root: &Path, token: &str) -> Manifest {
        let mut manifest = fixture(root);
        let image_id = format!("sha256:{}", "12".repeat(32));
        let case = serde_json::json!({"schema":1,"scenario":manifest.scenario,"postgres":{"image":"postgres:14","image_id":image_id,"canonical_digest":format!("postgres@{image_id}"),"run_token":token}});
        fs::write(
            &manifest.case_inputs.path,
            serde_json::to_vec(&case).unwrap(),
        )
        .unwrap();
        manifest.case_inputs.bytes = fs::metadata(&manifest.case_inputs.path).unwrap().len();
        manifest.case_inputs.sha256 = sha(&manifest.case_inputs.path).unwrap();
        let approval = serde_json::json!({"root_approved":true,"scenario":manifest.scenario,"mode":manifest.mode,"runtime_source_commit":manifest.runtime_source_commit,"case_inputs":manifest.case_inputs,"source_PG14_tag":"postgres:14","canonical_PG14_image_id":image_id,"postgres_run_token":token});
        fs::write(
            &manifest.execution_approval.path,
            serde_json::to_vec(&approval).unwrap(),
        )
        .unwrap();
        manifest.execution_approval.bytes = fs::metadata(&manifest.execution_approval.path)
            .unwrap()
            .len();
        manifest.execution_approval.sha256 = sha(&manifest.execution_approval.path).unwrap();
        manifest
    }
    #[test]
    fn postgres_absent_runtime_leaves_ordinary_rust_path_unchanged() {
        assert!(postgres_arguments_at(None, 42).unwrap().is_none());
    }
    #[test]
    fn postgres_external_arguments_are_owned_loopback_bounded_and_never_pull() {
        let root = tempfile::tempdir().unwrap();
        let manifest = postgres_test_fixture(root.path(), &"a".repeat(32));
        let arguments = postgres_arguments_at(Some(&manifest), 42).unwrap().unwrap();
        let root_hash = hex::encode(Sha256::digest(
            root.path()
                .canonicalize()
                .unwrap()
                .as_os_str()
                .as_encoded_bytes(),
        ));
        assert_eq!(
            arguments,
            vec![
                "run".to_owned(),
                "--rm".to_owned(),
                format!(
                    "--name={}",
                    resource_name_at("scraper-testnet-postgres", root.path(), 42).unwrap()
                ),
                format!("--label={POSTGRES_CASE_LABEL}={root_hash}"),
                format!("--label={POSTGRES_HARNESS_LABEL}=42"),
                format!("--label={POSTGRES_TOKEN_LABEL}={}", "a".repeat(32)),
                "--pull=never".to_owned(),
                "--memory=1073741824".to_owned(),
                "--memory-swap=1073741824".to_owned(),
                "--cpus=2".to_owned(),
                "--pids-limit=256".to_owned(),
                "--tmpfs=/var/lib/postgresql/data:rw,nosuid,size=2147483648".to_owned(),
                "--env=POSTGRES_PASSWORD=47221c18c610".to_owned(),
                "--publish=127.0.0.1:5432:5432".to_owned(),
                format!("sha256:{}", "12".repeat(32)),
            ]
        );
    }
    #[test]
    fn postgres_ownership_binds_root_pid_and_fresh_approved_token() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let a = postgres_test_fixture(first.path(), &"a".repeat(32));
        let b = postgres_test_fixture(second.path(), &"a".repeat(32));
        let first_args = postgres_arguments_at(Some(&a), 42).unwrap().unwrap();
        assert_ne!(
            first_args,
            postgres_arguments_at(Some(&a), 43).unwrap().unwrap()
        );
        assert_ne!(
            first_args,
            postgres_arguments_at(Some(&b), 42).unwrap().unwrap()
        );
        let changed = postgres_test_fixture(first.path(), &"b".repeat(32));
        assert_ne!(
            first_args,
            postgres_arguments_at(Some(&changed), 42).unwrap().unwrap()
        );
    }
    #[test]
    fn postgres_image_inspect_rejects_missing_foreign_or_wrong_native_image() {
        let root = tempfile::tempdir().unwrap();
        let manifest = postgres_test_fixture(root.path(), &"a".repeat(32));
        let fixture = postgres_fixture(&manifest).unwrap();
        let correct = serde_json::json!({"Id":fixture.image_id,"RepoDigests":[fixture.canonical_digest],"Os":"linux","Architecture":"arm64"});
        assert!(verify_postgres_inspect(&fixture, true, &[correct.to_string()]).is_ok());
        assert!(verify_postgres_inspect(&fixture, false, &[correct.to_string()]).is_err());
        for (key, value) in [
            ("Id", serde_json::json!("sha256:foreign")),
            ("RepoDigests", serde_json::json!([])),
            ("Os", serde_json::json!("foreign")),
            ("Architecture", serde_json::json!("amd64")),
        ] {
            let mut wrong = correct.clone();
            wrong[key] = value;
            assert!(verify_postgres_inspect(&fixture, true, &[wrong.to_string()]).is_err());
        }
    }
    #[test]
    fn postgres_case_requires_exact_approval_and_rejects_arbitrary_image_override() {
        let root = tempfile::tempdir().unwrap();
        for (field, value) in [
            ("image", serde_json::json!("foreign:latest")),
            ("image_id", serde_json::json!("sha256:invalid")),
            (
                "canonical_digest",
                serde_json::json!("foreign@sha256:invalid"),
            ),
            ("run_token", serde_json::json!("")),
            ("unknown", serde_json::json!(true)),
        ] {
            let mut manifest = postgres_test_fixture(root.path(), &"a".repeat(32));
            let mut case = fixture_json(&manifest.case_inputs).unwrap();
            case["postgres"][field] = value;
            fs::write(
                &manifest.case_inputs.path,
                serde_json::to_vec(&case).unwrap(),
            )
            .unwrap();
            manifest.case_inputs.bytes = fs::metadata(&manifest.case_inputs.path).unwrap().len();
            manifest.case_inputs.sha256 = sha(&manifest.case_inputs.path).unwrap();
            // Match the updated case bytes so the closed PG field guard, not
            // merely a stale artifact pin, is exercised.
            let mut approval = fixture_json(&manifest.execution_approval).unwrap();
            approval["case_inputs"] = serde_json::to_value(&manifest.case_inputs).unwrap();
            fs::write(
                &manifest.execution_approval.path,
                serde_json::to_vec(&approval).unwrap(),
            )
            .unwrap();
            manifest.execution_approval.bytes = fs::metadata(&manifest.execution_approval.path)
                .unwrap()
                .len();
            manifest.execution_approval.sha256 = sha(&manifest.execution_approval.path).unwrap();
            assert!(postgres_arguments_at(Some(&manifest), 42).is_err());
        }
        let mut manifest = postgres_test_fixture(root.path(), &"a".repeat(32));
        let mut approval = fixture_json(&manifest.execution_approval).unwrap();
        approval["root_approved"] = serde_json::json!(false);
        fs::write(
            &manifest.execution_approval.path,
            serde_json::to_vec(&approval).unwrap(),
        )
        .unwrap();
        manifest.execution_approval.bytes = fs::metadata(&manifest.execution_approval.path)
            .unwrap()
            .len();
        manifest.execution_approval.sha256 = sha(&manifest.execution_approval.path).unwrap();
        assert!(postgres_arguments_at(Some(&manifest), 42).is_err());
    }
    #[test]
    fn absent_runtime_preserves_exact_path_and_environment() {
        let root = tempfile::tempdir().unwrap();
        let input = root.path().join("target/debug/relayer");
        assert_eq!(resolve_with(None, &input, root.path()).unwrap(), input);
        let mut command = Command::new("unchanged");
        command.env("HYP_DB", "original");
        apply_environment_with(None, &mut command, &input).unwrap();
        assert_eq!(command.get_envs().count(), 1);
    }
    #[test]
    fn complete_runtime_maps_only_exact_agent_paths() {
        let root = tempfile::tempdir().unwrap();
        let m = fixture(root.path());
        m.validate().unwrap();
        for role in ["relayer", "validator", "scraper", "init-db"] {
            assert_eq!(
                resolve_with(
                    Some(&m),
                    &root.path().join("target/debug").join(role),
                    root.path()
                )
                .unwrap(),
                m.artifacts[role].path
            );
        }
        for input in [
            root.path().join("other/relayer"),
            root.path().join("target/release/validator"),
            PathBuf::from("cargo"),
        ] {
            assert_eq!(resolve_with(Some(&m), &input, root.path()).unwrap(), input);
        }
    }
    #[test]
    fn all_or_none_artifacts_and_aliases_fail_closed() {
        let root = tempfile::tempdir().unwrap();
        let original = fixture(root.path());
        for name in REQUIRED {
            let mut m = original.clone();
            m.artifacts.remove(name);
            assert!(m.validate().is_err(), "{name}");
        }
        let mut m = original.clone();
        m.environment
            .insert("ZIGGY_REGEX_LIBRARY".to_owned(), "/wrong".to_owned());
        assert!(m.validate().is_err());
        let mut m = original;
        m.artifacts.get_mut("relayer").unwrap().sha256 = "0".repeat(64);
        assert!(m.validate().is_err());
    }
    #[test]
    fn only_actual_roles_receive_runtime_aliases() {
        let root = tempfile::tempdir().unwrap();
        let m = fixture(root.path());
        let mut command = Command::new("unlaunched");
        command.env("HYP_DB", root.path().join("original-rocks"));
        apply_environment_with(Some(&m), &mut command, &m.artifacts["relayer"].path).unwrap();
        assert!(command.get_envs().any(|(key, _)| key == "HYP_DB"));
        let mut migration = Command::new("unlaunched");
        apply_environment_with(Some(&m), &mut migration, &m.artifacts["init-db"].path).unwrap();
        assert!(migration.get_envs().any(|(key, _)| key == "DATABASE_URL"));
        let mut conflict = Command::new("unlaunched");
        conflict.env("HYPERLANE_ALEO_VM_WORKER", "/wrong");
        conflict.env("HYP_DB", root.path().join("other-rocks"));
        assert!(
            apply_environment_with(Some(&m), &mut conflict, &m.artifacts["validator"].path)
                .is_err()
        );
    }
    #[test]
    fn traversing_evidence_and_wrong_deadline_rejected() {
        let root = tempfile::tempdir().unwrap();
        let mut m = fixture(root.path());
        m.verifier.evidence_root = root.path().join("../other");
        assert!(m.validate().is_err());
        m.verifier.evidence_root = root.path().join("evidence");
        m.harness_deadline_seconds = 600;
        assert!(m.validate().is_err());
    }
    #[cfg(unix)]
    #[test]
    fn owned_parent_and_leaf_symlinks_write_nothing_outside() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        for relative in [
            "databases",
            "agent-logs",
            "sealevel-checkpoints",
            "composite-checkpoints",
            "evidence",
        ] {
            let link = root.path().join(relative);
            symlink(outside.path(), &link).unwrap();
            assert!(
                create_owned_directory(root.path(), &Path::new(relative).join("nested")).is_err()
            );
            assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
            fs::remove_file(link).unwrap();
        }
        fs::create_dir(root.path().join("databases")).unwrap();
        symlink(outside.path(), root.path().join("databases/retained")).unwrap();
        assert!(create_owned_directory(root.path(), Path::new("databases/retained")).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(root.path().join("databases/retained")).unwrap();
        let mut m = fixture(root.path());
        m.tool_overrides
            .insert("E2E_HYPD_PATH".to_owned(), artifact(root.path(), "hypd"));
        assert!(m.validate().is_ok());
        let tool = &m.tool_overrides["E2E_HYPD_PATH"].path;
        fs::set_permissions(tool, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(format!("{:#}", m.validate().unwrap_err()).contains("executable permission"));
    }
    #[test]
    fn retained_owned_directory_reopens_without_mutation() {
        let root = tempfile::tempdir().unwrap();
        let path = create_owned_directory(root.path(), Path::new("databases/retained")).unwrap();
        fs::write(path.join("marker"), b"durable fixture").unwrap();
        assert_eq!(
            path,
            create_owned_directory(root.path(), Path::new("databases/retained")).unwrap()
        );
        assert_eq!(fs::read(path.join("marker")).unwrap(), b"durable fixture");
    }
    #[test]
    fn resource_identity_distinguishes_task_roots_for_reused_pid() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        assert_ne!(
            resource_name_at("radix", first.path(), 42).unwrap(),
            resource_name_at("radix", second.path(), 42).unwrap()
        );
        assert_eq!(
            resource_name_at("radix", first.path(), 42).unwrap(),
            resource_name_at("radix", first.path(), 42).unwrap()
        );
    }
    #[test]
    fn starknet_devnet_names_bind_both_ports_to_task_and_parent() {
        let root = tempfile::tempdir().unwrap();
        let first = resource_name_at("starknet-5050", root.path(), 42).unwrap();
        let second = resource_name_at("starknet-5070", root.path(), 42).unwrap();
        assert!(first.starts_with("ziggy-e2e-"));
        assert!(first.ends_with("-42-starknet-5050"));
        assert!(second.ends_with("-42-starknet-5070"));
        assert_ne!(first, second);
        assert_ne!(
            first,
            resource_name_at("starknet-5050", root.path(), 43).unwrap()
        );
    }
    #[test]
    fn capture_overrides_cannot_change_authority_or_escape_local_http() {
        let names = vec!["test1".to_owned()];
        assert!(endpoint_override(
            "HYP_CHAINS_TEST1_RPCURLS_0_HTTP",
            "http://127.0.0.1:1234",
            &names
        )
        .is_ok());
        for key in [
            "HYP_VALIDATOR_KEY",
            "HYP_CHAINS_TEST1_SIGNER_KEY",
            "HYP_CHAINS_OTHER_RPCURLS",
            "HYP_CHAINS_TEST1_MAXBATCHSIZE",
        ] {
            assert!(endpoint_override(key, "http://127.0.0.1:1234", &names).is_err());
        }
        for endpoint in [
            "https://mainnet.example",
            "ws://127.0.0.1:1234",
            "http://key:secret@127.0.0.1:1234",
            "http://127.0.0.1.attacker.example",
        ] {
            assert!(endpoint_override("HYP_CHAINS_TEST1_CUSTOMRPCURLS", endpoint, &names).is_err());
        }
    }
    #[test]
    fn capture_indexed_endpoint_grammar_is_bounded_and_preserves_public_flags() {
        let names = vec!["test1".to_owned()];
        for field in [
            "RPCURLS",
            "GRPCURLS",
            "WALLETURLS",
            "WALLETSOLIDITYURLS",
            "GATEWAYURLS",
        ] {
            assert!(endpoint_override(
                &format!("HYP_CHAINS_TEST1_{field}_0_HTTP"),
                "http://127.0.0.1:1234",
                &names
            )
            .is_ok());
            for flag in ["true", "false"] {
                assert!(endpoint_override(
                    &format!("HYP_CHAINS_TEST1_{field}_0_PUBLIC"),
                    flag,
                    &names
                )
                .is_ok());
            }
        }
        for key in [
            "HYP_CHAINS_OTHER_RPCURLS_0_HTTP",
            "HYP_CHAINS_TEST1_RPCURLS",
            "HYP_CHAINS_TEST1_RPCURLS_00_HTTP",
            "HYP_CHAINS_TEST1_RPCURLS_256_HTTP",
            "HYP_CHAINS_TEST1_RPCURLS_0_SIGNER",
            "HYP_CHAINS_TEST1_RPCURLS_0_HTTP_EXTRA",
        ] {
            assert!(endpoint_override(key, "http://127.0.0.1:1234", &names).is_err());
        }
        assert!(endpoint_override("HYP_CHAINS_TEST1_RPCURLS_0_PUBLIC", "0", &names).is_err());
        assert!(endpoint_override(
            "HYP_CHAINS_TEST1_RPCURLS_0_HTTP",
            "http://127.0.0.1:1,http://127.0.0.1:2",
            &names
        )
        .is_err());
    }

    #[test]
    fn source_loader_indexed_endpoint_child_probe() {
        use hyperlane_core::config::{ConfigPath, ConfigResult, FromRawConf, NoFilter};
        #[derive(Debug)]
        struct Merged(serde_json::Value);
        impl FromRawConf<serde_json::Value> for Merged {
            fn from_config_filtered(
                raw: serde_json::Value,
                _: &ConfigPath,
                _: NoFilter,
                _: &str,
            ) -> ConfigResult<Self> {
                Ok(Self(raw))
            }
        }
        let Ok(mode) = std::env::var("ZIGGY_ENDPOINT_LOADER_CHILD") else {
            return;
        };
        // Actual production Rust loader, including config0.13 environment
        // layering. No agent/provider/node is constructed by this test.
        let loaded =
            hyperlane_base::settings::loader::load_settings::<serde_json::Value, Merged>("relayer")
                .unwrap();
        let value = &loaded.0["chains"]["test1"]["rpcurls"];
        let parser =
            hyperlane_base::settings::parser::ValueParser::new(ConfigPath::default(), value);
        if mode == "json-string" {
            assert!(parser.into_array_iter().is_err());
        } else {
            let rows: Vec<_> = parser.into_array_iter().unwrap().collect();
            assert_eq!(rows.len(), 2);
            for (index, row) in rows.iter().enumerate() {
                assert_eq!(
                    row.value()["http"],
                    format!("http://127.0.0.1:{}", 19001 + index)
                );
                let public = hyperlane_base::settings::parser::ValueParser::new(
                    ConfigPath::default(),
                    &row.value()["public"],
                )
                .parse_bool()
                .unwrap();
                assert_eq!(public, index == 0);
            }
            let grpc = hyperlane_base::settings::parser::ValueParser::new(
                ConfigPath::default(),
                &loaded.0["chains"]["test1"]["grpcurls"],
            );
            assert_eq!(
                grpc.into_array_iter().unwrap().next().unwrap().value()["http"],
                "http://127.0.0.1:19003"
            );
        }
    }

    #[test]
    fn source_loader_roundtrip_accepts_indexed_fields_and_rejects_whole_json_array() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("config")).unwrap();
        fs::write(root.path().join("config/source.json"), serde_json::to_vec(&serde_json::json!({"chains":{"test1":{"rpcUrls":[{"http":"http://127.0.0.1:1","public":false},{"http":"http://127.0.0.1:2","public":true}],"grpcUrls":[{"http":"http://127.0.0.1:3"}]}}})).unwrap()).unwrap();
        for mode in ["indexed", "json-string"] {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command
                .args([
                    "--exact",
                    "external_agents::tests::source_loader_indexed_endpoint_child_probe",
                    "--nocapture",
                ])
                .env_clear()
                .env("ZIGGY_ENDPOINT_LOADER_CHILD", mode)
                .current_dir(root.path());
            if mode == "indexed" {
                for (key, value) in [
                    ("HYP_CHAINS_TEST1_RPCURLS_0_HTTP", "http://127.0.0.1:19001"),
                    ("HYP_CHAINS_TEST1_RPCURLS_0_PUBLIC", "true"),
                    ("HYP_CHAINS_TEST1_RPCURLS_1_HTTP", "http://127.0.0.1:19002"),
                    ("HYP_CHAINS_TEST1_RPCURLS_1_PUBLIC", "false"),
                    ("HYP_CHAINS_TEST1_GRPCURLS_0_HTTP", "http://127.0.0.1:19003"),
                ] {
                    command.env(key, value);
                }
            } else {
                command.env(
                    "HYP_CHAINS_TEST1_RPCURLS",
                    r#"[{"http":"http://127.0.0.1:19001"}]"#,
                );
            }
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "actualSource loader child {mode} failed: {} {}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    fn capture_tron_custom_wallet_endpoints_preserve_selected_chain_boundary() {
        let names = vec!["trontest1".to_owned()];
        for suffix in ["CUSTOMWALLETURLS", "CUSTOMWALLETSOLIDITYURLS"] {
            assert!(endpoint_override(
                &format!("HYP_CHAINS_TRONTEST1_{suffix}"),
                "http://127.0.0.1:9090/wallet",
                &names
            )
            .is_ok());
            assert!(endpoint_override(
                &format!("HYP_CHAINS_OTHER_{suffix}"),
                "http://127.0.0.1:9090/wallet",
                &names
            )
            .is_err());
            assert!(endpoint_override(
                &format!("HYP_CHAINS_TRONTEST1_SIGNER_{suffix}"),
                "http://127.0.0.1:9090/wallet",
                &names
            )
            .is_err());
        }
    }
    #[test]
    fn capture_reply_rejects_argument_or_signer_injection() {
        assert!(serde_json::from_str::<CaptureReply>(
            r#"{"schema":1,"environment":{},"arguments":["--validator.key","wrong"]}"#
        )
        .is_err());
        let reply: CaptureReply = serde_json::from_str(r#"{"schema":1,"environment":{}}"#).unwrap();
        assert_eq!(reply.schema, 1);
        assert!(reply.environment.is_empty());
    }
    fn actual_artifact(path: &str) -> Artifact {
        let path = Path::new(path).canonicalize().unwrap();
        Artifact {
            bytes: path.metadata().unwrap().len(),
            sha256: sha(&path).unwrap(),
            path,
        }
    }
    struct TestChild(Option<Child>);
    impl std::ops::Deref for TestChild {
        type Target = Child;
        fn deref(&self) -> &Child {
            self.0.as_ref().unwrap()
        }
    }
    impl std::ops::DerefMut for TestChild {
        fn deref_mut(&mut self) -> &mut Child {
            self.0.as_mut().unwrap()
        }
    }
    impl Drop for TestChild {
        fn drop(&mut self) {
            if let Some(child) = &mut self.0 {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
    #[test]
    fn node_listeners_requires_both_consumed_loopback_sockets() {
        let ports = [
            "127.0.0.1:26659".parse().unwrap(),
            "127.0.0.1:26660".parse().unwrap(),
        ];
        assert!(!node_listeners(42, "", &ports).unwrap());
        assert!(!node_listeners(42, "p42\nn127.0.0.1:26659\n", &ports).unwrap());
        assert!(node_listeners(
            42,
            "p42\nn127.0.0.1:26659\nn127.0.0.1:26660\nn127.0.0.1:26658\n",
            &ports
        )
        .unwrap());
    }
    #[test]
    fn node_listeners_rejects_foreign_pid_unbound_and_exposed_endpoints() {
        let ports = ["127.0.0.1:26659".parse().unwrap()];
        for output in [
            "p43\nn127.0.0.1:26659\n",
            "n127.0.0.1:26659\n",
            "p42\nn*:26659\n",
            "p42\nn0.0.0.0:26659\n",
        ] {
            assert!(node_listeners(42, output, &ports).is_err());
        }
    }
    #[test]
    fn node_listeners_rejects_malformed_oversized_output() {
        let ports = ["127.0.0.1:26659".parse().unwrap()];
        for output in ["pnot-a-pid", "p42\nfbad\n", "p42\nn127.0.0.1:not-a-port\n"] {
            assert!(node_listeners(42, output, &ports).is_err());
        }
        assert!(node_listeners(42, &"x".repeat(65537), &ports).is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn node_listeners_actual_owned_tcp_listener_lsof_roundtrip() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let socket = listener.local_addr().unwrap();
        let pid = std::process::id();
        let tool = actual_artifact("/usr/sbin/lsof");
        verify_executable(&tool).unwrap();
        let output = Command::new(&tool.path)
            .args([
                "-nP",
                "-a",
                "-p",
                &pid.to_string(),
                "-iTCP",
                "-sTCP:LISTEN",
                "-F",
                "pn",
            ])
            .output()
            .unwrap();
        assert!(output.status.success());
        let output = String::from_utf8(output.stdout).unwrap();
        assert!(output.lines().any(|line| line.starts_with('f')));
        assert!(node_listeners(pid, &output, &[socket]).unwrap());
        assert!(node_listeners(pid + 1, &output, &[socket]).is_err());
    }
    #[test]
    fn node_ready_identity_requires_live_real_child_and_exact_executable() {
        let (mut child, owned, binary, ps) = owned_fixture(false);
        assert_eq!(
            live_fixture_identity(&mut child, &binary, &ps).unwrap(),
            owned.os_start_token
        );
        assert!(live_fixture_identity(&mut child, &ps, &ps).is_err());
        let receipt =
            stop_owned_child(&mut child, &owned, &binary, &ps, Duration::from_secs(1)).unwrap();
        assert!(receipt.parent_wait_completed && receipt.success && !receipt.forced_kill);
    }
    #[test]
    fn node_ready_identity_rejects_exited_real_child() {
        let (mut child, _, binary, ps) = owned_fixture(false);
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(live_fixture_identity(&mut child, &binary, &ps).is_err());
    }
    fn approved_node_ownership_fixture(root: &Path, scenario: &str) -> (Manifest, Artifact) {
        let mut manifest = fixture(root);
        manifest.scenario = scenario.into();
        let lsof = artifact(root, "lsof");
        let case = serde_json::json!({"schema":1,"scenario":scenario,"node_ownership_tools":{"lsof":lsof}});
        fs::write(
            &manifest.case_inputs.path,
            serde_json::to_vec(&case).unwrap(),
        )
        .unwrap();
        manifest.case_inputs = actual_artifact(manifest.case_inputs.path.to_str().unwrap());
        let approval = serde_json::json!({"root_approved":true,"scenario":manifest.scenario,"runtime_source_commit":manifest.runtime_source_commit,"mode":manifest.mode,"case_inputs":manifest.case_inputs,"node_ownership_tools":case["node_ownership_tools"]});
        fs::write(
            &manifest.execution_approval.path,
            serde_json::to_vec(&approval).unwrap(),
        )
        .unwrap();
        manifest.execution_approval =
            actual_artifact(manifest.execution_approval.path.to_str().unwrap());
        (manifest, lsof)
    }
    #[test]
    fn node_ownership_requires_exact_approved_tool_map() {
        for scenario in ["cosmosnative", "cosmwasm", "evm"] {
            let root = tempfile::tempdir().unwrap();
            let (mut manifest, lsof) = approved_node_ownership_fixture(root.path(), scenario);
            assert_eq!(node_ownership_tool(&manifest).unwrap().sha256, lsof.sha256);
            let mut case = fixture_json(&manifest.case_inputs).unwrap();
            case["node_ownership_tools"]["foreign"] = serde_json::to_value(&lsof).unwrap();
            fs::write(
                &manifest.case_inputs.path,
                serde_json::to_vec(&case).unwrap(),
            )
            .unwrap();
            manifest.case_inputs = actual_artifact(manifest.case_inputs.path.to_str().unwrap());
            // Even a consistently pinned/approved extra tool is outside the closed capability.
            let mut approval = fixture_json(&manifest.execution_approval).unwrap();
            approval["case_inputs"] = serde_json::to_value(&manifest.case_inputs).unwrap();
            approval["node_ownership_tools"] = case["node_ownership_tools"].clone();
            fs::write(
                &manifest.execution_approval.path,
                serde_json::to_vec(&approval).unwrap(),
            )
            .unwrap();
            manifest.execution_approval =
                actual_artifact(manifest.execution_approval.path.to_str().unwrap());
            assert!(node_ownership_tool(&manifest).is_err());
        }
    }
    #[test]
    fn node_ownership_cw_rejects_crossed_case_approval_and_unadmitted_family() {
        for (field, wrong) in [
            ("root_approved", serde_json::json!(false)),
            ("scenario", serde_json::json!("cosmosnative")),
            ("runtime_source_commit", serde_json::json!("b".repeat(40))),
            ("mode", serde_json::json!("ReleaseFast")),
            ("case_inputs", serde_json::json!({})),
            ("node_ownership_tools", serde_json::json!({})),
        ] {
            let root = tempfile::tempdir().unwrap();
            let (mut manifest, _) = approved_node_ownership_fixture(root.path(), "cosmwasm");
            let mut approval = fixture_json(&manifest.execution_approval).unwrap();
            approval[field] = wrong;
            fs::write(
                &manifest.execution_approval.path,
                serde_json::to_vec(&approval).unwrap(),
            )
            .unwrap();
            manifest.execution_approval =
                actual_artifact(manifest.execution_approval.path.to_str().unwrap());
            assert!(
                node_ownership_tool(&manifest).is_err(),
                "accepted crossed {field}"
            );
        }
        let root = tempfile::tempdir().unwrap();
        let (mut manifest, _) = approved_node_ownership_fixture(root.path(), "cosmwasm");
        let mut case = fixture_json(&manifest.case_inputs).unwrap();
        case["scenario"] = serde_json::json!("cosmosnative");
        fs::write(
            &manifest.case_inputs.path,
            serde_json::to_vec(&case).unwrap(),
        )
        .unwrap();
        manifest.case_inputs = actual_artifact(manifest.case_inputs.path.to_str().unwrap());
        let mut approval = fixture_json(&manifest.execution_approval).unwrap();
        approval["case_inputs"] = serde_json::to_value(&manifest.case_inputs).unwrap();
        fs::write(
            &manifest.execution_approval.path,
            serde_json::to_vec(&approval).unwrap(),
        )
        .unwrap();
        manifest.execution_approval =
            actual_artifact(manifest.execution_approval.path.to_str().unwrap());
        assert!(node_ownership_tool(&manifest).is_err());
        for family in ["starknet", "sealevel", "tron", "radix", "aleo"] {
            let root = tempfile::tempdir().unwrap();
            let (manifest, _) = approved_node_ownership_fixture(root.path(), family);
            assert!(
                node_ownership_tool(&manifest).is_err(),
                "granted unadmitted {family}"
            );
        }
    }
    fn evm_tools_fixture(root: &Path, node: &Artifact) -> Manifest {
        let mut m = fixture(root);
        fs::create_dir_all(&m.verifier.evidence_root).unwrap();
        m.verifier_tools
            .insert("ps".into(), actual_artifact("/bin/ps"));
        let tools = serde_json::json!({
            "anvil":artifact(root,"anvil"),"node":node,
            "pnpm_launcher":artifact(root,"pnpm"),"pnpm_native":artifact(root,"pnpm-native"),
            "sh":actual_artifact("/bin/sh"),"esbuild":artifact(root,"esbuild")
        });
        let case = serde_json::json!({"schema":1,"scenario":"evm","fixture_tools":tools});
        fs::write(&m.case_inputs.path, serde_json::to_vec(&case).unwrap()).unwrap();
        m.case_inputs = actual_artifact(m.case_inputs.path.to_str().unwrap());
        let approval = serde_json::json!({"root_approved":true,"scenario":"evm","mode":m.mode,"runtime_source_commit":m.runtime_source_commit,"case_inputs":m.case_inputs,"fixture_tools":tools});
        fs::write(
            &m.execution_approval.path,
            serde_json::to_vec(&approval).unwrap(),
        )
        .unwrap();
        m.execution_approval = actual_artifact(m.execution_approval.path.to_str().unwrap());
        m
    }
    #[test]
    fn evm_fixture_tools_bind_approved_case_and_reject_changed_or_extra_tools() {
        let root = tempfile::tempdir().unwrap();
        let binary = actual_artifact("/bin/sh");
        let mut m = evm_tools_fixture(root.path(), &binary);
        let tools = evm_fixture_tools(&m).unwrap();
        assert_ne!(tools["pnpm_launcher"].path, tools["node"].path);
        let mut value = fixture_json(&m.case_inputs).unwrap();
        value["fixture_tools"]["foreign"] = serde_json::to_value(&binary).unwrap();
        fs::write(&m.case_inputs.path, serde_json::to_vec(&value).unwrap()).unwrap();
        m.case_inputs = actual_artifact(m.case_inputs.path.to_str().unwrap());
        assert!(evm_fixture_tools(&m).is_err());
    }
    #[test]
    fn evm_fixture_group_selection_is_only_exact_long_running_source_commands() {
        let mut command = Command::new("anvil");
        command.arg("--silent");
        assert_eq!(
            evm_fixture_kind(&command, Path::new("/tools/anvil")),
            Some("anvil")
        );
        let mut command = Command::new("pnpm");
        command.args(["kathy", "--mineforever"]);
        assert_eq!(
            evm_fixture_kind(&command, Path::new("/tools/pnpm")),
            Some("kathy")
        );
        let mut command = Command::new("pnpm");
        command.args(["deploy-core"]);
        assert_eq!(evm_fixture_kind(&command, Path::new("/tools/pnpm")), None);
        let mut command = Command::new("docker");
        command.args(["exec", "container", "true"]);
        assert_eq!(evm_fixture_kind(&command, Path::new("/tools/docker")), None);
    }
    #[test]
    fn evm_fixture_configuration_rejects_changed_anvil_arguments() {
        let root = tempfile::tempdir().unwrap();
        let binary = actual_artifact("/bin/sh");
        let m = evm_tools_fixture(root.path(), &binary);
        let tool = evm_fixture_tools(&m).unwrap()["anvil"].clone();
        let mut command = Command::new(&tool.path);
        command.arg("--silent");
        configure_evm_fixture(&mut command, &tool.path, &m).unwrap();
        let mut command = Command::new(&tool.path);
        command.args(["--host", "0.0.0.0"]);
        assert!(configure_evm_fixture(&mut command, &tool.path, &m).is_err());
    }
    fn model_fixture_process(binary: &Artifact) -> (FixtureProcesses, Vec<FixtureSnapshot>) {
        let mut state = FixtureProcesses::default();
        state.known.insert(
            10,
            FixtureProcess {
                pid: 10,
                parent_pid: 1,
                group_pid: 10,
                start: "root-start".into(),
                executable: binary.clone(),
            },
        );
        let rows = vec![
            (10, 1, 10, "root-start".into(), binary.path.clone()),
            (11, 10, 10, "child-start".into(), binary.path.clone()),
            (12, 11, 10, "leaf-start".into(), binary.path.clone()),
        ];
        (state, rows)
    }
    #[test]
    fn evm_fixture_descendants_require_observed_parent_lineage_not_group_alone() {
        let binary = actual_artifact("/bin/sh");
        let (mut state, mut rows) = model_fixture_process(&binary);
        observe_fixture_processes(&mut state, &rows, 10, std::slice::from_ref(&binary)).unwrap();
        assert_eq!(state.known.len(), 3);
        rows.push((13, 999, 10, "foreign-start".into(), binary.path.clone()));
        assert!(
            observe_fixture_processes(&mut state, &rows, 10, std::slice::from_ref(&binary))
                .is_err()
        );
        assert!(!state.known.contains_key(&13));
    }
    #[test]
    fn evm_fixture_reused_pid_start_parent_or_unapproved_executable_fail_closed() {
        let binary = actual_artifact("/bin/sh");
        for variant in 0..3 {
            let (mut state, mut rows) = model_fixture_process(&binary);
            observe_fixture_processes(&mut state, &rows, 10, std::slice::from_ref(&binary))
                .unwrap();
            match variant {
                0 => rows[1].3 = "new-process".into(),
                1 => rows[1].1 = 999,
                _ => rows[1].4 = PathBuf::from("/not-approved/executable"),
            };
            assert!(observe_fixture_processes(
                &mut state,
                &rows,
                10,
                std::slice::from_ref(&binary)
            )
            .is_err());
        }
    }
    #[test]
    fn evm_fixture_unseen_orphan_is_not_late_adopted_after_parent_exit() {
        let binary = actual_artifact("/bin/sh");
        let (mut state, mut rows) = model_fixture_process(&binary);
        rows.remove(0);
        assert!(
            observe_fixture_processes(&mut state, &rows, 10, std::slice::from_ref(&binary))
                .is_err()
        );
        assert_eq!(state.known.len(), 1);
    }
    #[test]
    fn evm_fixture_current_process_executable_is_resolved_portably() {
        let ps = actual_artifact("/bin/ps");
        let token = child_identity(&ps, std::process::id()).unwrap();
        let fields: Vec<_> = token.split_whitespace().collect();
        let path = actual_fixture_executable(std::process::id(), Path::new(&fields[7..].join(" ")))
            .unwrap();
        assert_eq!(
            path,
            std::env::current_exe().unwrap().canonicalize().unwrap()
        );
    }
    #[test]
    fn evm_fixture_actual_node_interpreter_child_and_descendant_are_stopped_and_reaped() {
        use std::io::BufRead;
        use std::os::unix::process::CommandExt;
        let root = tempfile::tempdir().unwrap();
        let node = which::which("node")
            .expect("EVM fixture ownership controls require pinned Node in PATH")
            .canonicalize()
            .unwrap();
        let binary = actual_artifact(node.to_str().unwrap());
        let m = evm_tools_fixture(root.path(), &binary);
        let child_script = r#"process.on('SIGTERM',()=>process.exit(0));
process.stdout.write('READY\n');
setInterval(()=>{},1000);"#;
        let script = format!(
            r#"const cp=require('node:child_process');
const c=cp.spawn(process.execPath,['-e',{}],{{stdio:['ignore','pipe','inherit']}});
c.stdout.once('data',()=>process.stdout.write('READY\n'));
c.on('exit',()=>process.exit(0));
process.on('SIGTERM',()=>c.kill('SIGTERM'));
setInterval(()=>{{}},1000);"#,
            serde_json::to_string(child_script).unwrap()
        );
        let mut command = Command::new(&binary.path);
        command
            .args(["-e", script.as_str()])
            .process_group(0)
            .stdout(Stdio::piped());
        let mut raw = TestChild(Some(command.spawn().unwrap()));
        let mut line = String::new();
        std::io::BufReader::new(raw.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, "READY\n");
        let owner = EvmFixtureOwnership::start(&m, &mut raw, "kathy").unwrap();
        let mut tracked = TrackedChild::new(raw.0.take().unwrap(), None);
        tracked.fixture = Some(owner);
        let owner = tracked.fixture.as_ref().unwrap();
        assert_eq!(owner.root.executable.path, binary.path);
        assert_ne!(
            owner.root.executable.path,
            evm_fixture_tools(&m).unwrap()["pnpm_launcher"].path
        );
        let deadline = Instant::now() + Duration::from_secs(3);
        while owner.processes.lock().unwrap().known.len() < 2 {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(20));
        }
        assert!(stop_evm_fixture(&mut tracked).unwrap());
        assert!(tracked.child.try_wait().unwrap().is_some());
        let receipts =
            fs::read_to_string(m.verifier.evidence_root.join("fixture-parent-waits.jsonl"))
                .unwrap();
        let receipt: serde_json::Value = serde_json::from_str(receipts.trim()).unwrap();
        assert_eq!(receipt["parent_wait_completed"], true);
        assert_eq!(receipt["forced_kill"], false);
        let evidence = fs::read_to_string(
            m.verifier
                .evidence_root
                .join("fixture-descendant-stops.jsonl"),
        )
        .unwrap();
        let evidence: serde_json::Value = serde_json::from_str(evidence.trim()).unwrap();
        assert_eq!(evidence["parent_wait_completed"], false);
        assert!(!evidence["observed_descendants"]
            .as_array()
            .unwrap()
            .is_empty());
    }

    #[test]
    fn evm_checkpoints_are_unique_owned_and_retained_after_path_drop() {
        let root = tempfile::tempdir().unwrap();
        let m = fixture(root.path());
        let mut paths = Vec::new();
        for index in 0..3 {
            let path = evm_checkpoint_path_at(Some(&m), index).unwrap().unwrap();
            fs::write(
                path.join("metadata_latest.json"),
                b"public retention unit fixture",
            )
            .unwrap();
            paths.push(path);
        }
        assert_ne!(paths[0], paths[1]);
        let first = paths[0].clone();
        drop(paths);
        assert!(first.join("metadata_latest.json").is_file());
        assert!(evm_checkpoint_path_at(Some(&m), 3).is_err());
    }
    #[test]
    fn evm_checkpoint_default_tempdir_lifetime_and_other_family_unchanged() {
        assert!(evm_checkpoint_path_at(None, 0).unwrap().is_none());
        let root = tempfile::tempdir().unwrap();
        let mut m = fixture(root.path());
        m.scenario = "cosmosnative".into();
        assert!(evm_checkpoint_path_at(Some(&m), 0).unwrap().is_none());
        let path = crate::validator_checkpoint_directory(0);
        let original = path.as_ref().as_ref().to_path_buf();
        assert!(original.is_dir());
        drop(path);
        assert!(!original.exists());
    }

    #[test]
    fn evm_fixture_snapshot_timeout_kills_and_reaps_its_actual_inspection_child() {
        use std::os::unix::fs::PermissionsExt;
        let root = tempfile::tempdir().unwrap();
        let script = root.path().join("slow-ps");
        let pidfile = root.path().join("pid");
        fs::write(
            &script,
            format!(
                "#!/bin/sh\nprintf '%s' $$ > '{}'\nexec /bin/sleep 10\n",
                pidfile.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let tool = actual_artifact(script.to_str().unwrap());
        let start = Instant::now();
        assert!(fixture_process_snapshot(&tool, std::process::id()).is_err());
        assert!(start.elapsed() < Duration::from_secs(5));
        let pid = fs::read_to_string(pidfile).unwrap().parse::<u32>().unwrap();
        assert!(child_identity(&actual_artifact("/bin/ps"), pid).is_err());
    }

    fn owned_fixture(ignore_term: bool) -> (TestChild, OwnedChild, Artifact, Artifact) {
        use std::io::BufRead;
        let binary = actual_artifact("/bin/sh");
        let ps = actual_artifact("/bin/ps");
        let script = if ignore_term {
            "trap '' TERM; echo READY; while :; do read line; done"
        } else {
            "trap 'exit 0' TERM; echo READY; while :; do read line; done"
        };
        let mut child = TestChild(Some(
            Command::new(&binary.path)
                .args(["-c", script])
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .spawn()
                .unwrap(),
        ));
        let mut ready = String::new();
        std::io::BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "READY\n");
        let owned = OwnedChild {
            pid: child.id(),
            role: "relayer".to_owned(),
            executable: binary.clone(),
            parent_pid: std::process::id(),
            os_start_token: child_identity(&ps, child.id()).unwrap(),
            scope: "Actual short owned child, no node".to_owned(),
        };
        (child, owned, binary, ps)
    }
    #[test]
    fn parent_shutdown_reaps_actual_owned_child_before_acceptance() {
        let (mut child, owned, binary, ps) = owned_fixture(false);
        let receipt =
            stop_owned_child(&mut child, &owned, &binary, &ps, Duration::from_secs(3)).unwrap();
        assert!(
            receipt.parent_wait_completed
                && receipt.success
                && !receipt.forced_kill
                && !receipt.already_exited
        );
        assert_eq!(receipt.exit_code, Some(0));
        assert!(child.try_wait().unwrap().is_some());
    }
    #[test]
    fn parent_shutdown_rejects_wrong_artifact_without_signalling_child() {
        let (mut child, owned, mut binary, ps) = owned_fixture(false);
        binary.sha256 = "0".repeat(64);
        assert!(
            stop_owned_child(&mut child, &owned, &binary, &ps, Duration::from_secs(3)).is_err()
        );
        assert!(child.try_wait().unwrap().is_none());
        child.kill().unwrap();
        child.wait().unwrap();
    }
    #[test]
    fn parent_shutdown_already_exited_is_reaped_but_not_clean_final_acceptance() {
        let (mut child, owned, binary, ps) = owned_fixture(false);
        child.kill().unwrap();
        child.wait().unwrap();
        let receipt =
            stop_owned_child(&mut child, &owned, &binary, &ps, Duration::from_secs(3)).unwrap();
        assert!(receipt.parent_wait_completed && receipt.already_exited && !receipt.success);
    }
    #[test]
    fn parent_shutdown_timeout_kills_and_reaps_but_never_passes_clean_final() {
        let (mut child, owned, binary, ps) = owned_fixture(true);
        let receipt =
            stop_owned_child(&mut child, &owned, &binary, &ps, Duration::from_millis(30)).unwrap();
        assert!(receipt.parent_wait_completed && receipt.forced_kill && !receipt.success);
        assert_eq!(receipt.signal, Some(9));
        assert!(child.try_wait().unwrap().is_some());
    }
    #[test]
    fn external_evm_rpc_override_preserves_value_and_default_rust_cli_exactly() {
        let rust = format!(
            "{:#}",
            relayer_test_rpc_override(crate::program::Program::new("original"), false)
        );
        let external = format!(
            "{:#}",
            relayer_test_rpc_override(crate::program::Program::new("original"), true)
        );
        let urls = "http://127.0.0.1:8545,http://127.0.0.1:8545,http://127.0.0.1:8545";
        assert_eq!(
            rust,
            format!("(./)$ original --chains.test1.customRpcUrls {urls}")
        );
        assert_eq!(
            external,
            format!("(./)$ HYP_CHAINS_TEST1_CUSTOMRPCURLS={urls} original")
        );
        assert!(!external.contains("--chains.test1.customRpcUrls"));
    }
    fn tracked_fixture(root: &Path) -> (TrackedChild, u32) {
        let (mut child, owned, binary, ps) = owned_fixture(false);
        let mut m = fixture(root);
        m.artifacts.insert("relayer".to_owned(), binary);
        m.verifier_tools.insert("ps".to_owned(), ps);
        fs::create_dir(&m.verifier.evidence_root).unwrap();
        let pid = child.id();
        (
            TrackedChild::new(
                child.0.take().unwrap(),
                Some(RoleOwnership {
                    record: owned,
                    runtime: m,
                }),
            ),
            pid,
        )
    }
    #[test]
    fn tracked_role_setup_unwind_reaps_and_records_actual_parent_wait() {
        let root = tempfile::tempdir().unwrap();
        let (child, pid) = tracked_fixture(root.path());
        let unwind = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _held = child;
            panic!("intentional setup failure after role spawn");
        }));
        assert!(unwind.is_err());
        let row: serde_json::Value = serde_json::from_str(
            fs::read_to_string(root.path().join("evidence/parent-child-exits.jsonl"))
                .unwrap()
                .trim(),
        )
        .unwrap();
        assert_eq!(row["pid"], pid);
        assert_eq!(row["parent_wait_completed"], true);
        assert_eq!(row["purpose"], "unwind_or_early_drop");
        assert_eq!(row["exit_code"], 0);
    }
    #[test]
    fn tracked_role_planned_kill_reaps_without_clean_final_credit_or_duplicate_drop() {
        let root = tempfile::tempdir().unwrap();
        let (mut child, pid) = tracked_fixture(root.path());
        intentional_role_stop(&mut child, "intentional_restart").unwrap();
        drop(child);
        let raw =
            fs::read_to_string(root.path().join("evidence/parent-child-exits.jsonl")).unwrap();
        assert_eq!(raw.lines().count(), 1);
        let row: serde_json::Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(row["pid"], pid);
        assert_eq!(row["parent_wait_completed"], true);
        assert_eq!(row["planned_exit"], true);
        assert_eq!(row["success"], false);
        assert_eq!(row["signal"], 9);
    }
    #[test]
    fn tracked_role_replacement_cleans_old_child_and_keeps_replacement_owned() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let (old, old_pid) = tracked_fixture(first.path());
        let (new, new_pid) = tracked_fixture(second.path());
        let mut state = BTreeMap::new();
        state.insert("RLY", old);
        drop(state.insert("RLY", new));
        let raw =
            fs::read_to_string(first.path().join("evidence/parent-child-exits.jsonl")).unwrap();
        let row: serde_json::Value = serde_json::from_str(raw.trim()).unwrap();
        assert_eq!(row["pid"], old_pid);
        assert_eq!(row["parent_wait_completed"], true);
        assert_eq!(state["RLY"].id(), new_pid);
        drop(state);
        assert!(second
            .path()
            .join("evidence/parent-child-exits.jsonl")
            .is_file());
    }
    #[test]
    fn schema3_requires_real_native_row_reader_before_scenario_admission() {
        let root = tempfile::tempdir().unwrap();
        let mut m = fixture(root.path());
        m.validate().unwrap();
        m.verifier_tools.remove("native_rows");
        assert!(m.validate().is_err());
        m.schema = 2;
        assert!(m.validate().is_err());
    }
    #[test]
    fn all_role_restart_preserves_original_program_and_snapshots_after_parent_wait() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let (mut one, first_pid) = tracked_fixture(first.path());
        let (mut two, second_pid) = tracked_fixture(second.path());
        let original = crate::program::Program::new("original-executable")
            .arg("original.option", "original-value")
            .hyp_env("DB", "/original/retained-db")
            .hyp_env("METRICSPORT", "9092");
        let rendered = format!("{original:#}");
        one.retain_restart(original.clone(), "RLY", Some(first.path()));
        two.retain_restart(original, "VL1", None);
        let mut stages = Vec::new();
        let specs =
            prepare_same_db_restart_with([&mut one, &mut two], 7, 1800, |stage, expected, _| {
                stages.push(stage.to_owned());
                assert_eq!(expected, 7);
                if stage == "before_restart" {
                    for (root, pid) in [(first.path(), first_pid), (second.path(), second_pid)] {
                        let raw =
                            fs::read_to_string(root.join("evidence/parent-child-exits.jsonl"))?;
                        let row: serde_json::Value = serde_json::from_str(raw.trim())?;
                        assert_eq!(row["pid"], pid);
                        assert_eq!(row["parent_wait_completed"], true);
                        assert_eq!(row["exit_code"], 0);
                        assert_eq!(row["purpose"], "same_db_restart");
                    }
                }
                Ok(())
            })
            .unwrap();
        assert_eq!(stages, ["live", "before_restart"]);
        assert_eq!(specs.len(), 2);
        assert_eq!(format!("{:#}", specs[0].program), rendered);
        assert_eq!(format!("{:#}", specs[1].program), rendered);
        assert_eq!(specs[0].log_prefix, "RLY");
        assert_eq!(specs[0].logs_directory.as_deref(), Some(first.path()));
        assert!(specs[1].logs_directory.is_none());
        assert!(one.try_wait().unwrap().is_some() && two.try_wait().unwrap().is_some());
    }
    #[test]
    fn restart_snapshot_failure_keeps_every_role_reaped_and_never_respawns() {
        let root = tempfile::tempdir().unwrap();
        let (mut child, _) = tracked_fixture(root.path());
        child.retain_restart(
            crate::program::Program::new("must-never-spawn"),
            "RLY",
            None,
        );
        let result = prepare_same_db_restart_with([&mut child], 1, 1800, |stage, _, _| {
            if stage == "before_restart" {
                bail!("actual independent snapshot rejected");
            }
            Ok(())
        });
        assert!(result.is_err());
        assert!(child.try_wait().unwrap().is_some());
        drop(child);
        assert_eq!(
            fs::read_to_string(root.path().join("evidence/parent-child-exits.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
    }
}
