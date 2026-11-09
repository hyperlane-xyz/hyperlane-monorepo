//! Owned external-runtime Radix Compose lifecycle. Ordinary Rust fixtures keep
//! their existing path. This module never pulls images or builds services.
use super::{fixture_docker_environment, fixture_json, get, resource_name, Artifact, Manifest};
use eyre::{ensure, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Seek, SeekFrom},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const SERVICES: [(&str, &str, u64, u64); 5] = [
    ("fullnode", "radixdlt/babylon-node:v1.3.0.1", 1536, 256),
    ("postgres_db", "postgres:15.2-alpine", 512, 128),
    (
        "database_migrations_image",
        "radixdlt/babylon-ng-database-migrations:v1.10.3",
        256,
        128,
    ),
    (
        "data_aggregator_image",
        "radixdlt/babylon-ng-data-aggregator:v1.10.3",
        1024,
        256,
    ),
    (
        "gateway_api_image",
        "radixdlt/babylon-ng-gateway-api:v1.10.3",
        512,
        128,
    ),
];

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct Image {
    source: String,
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Configuration {
    token: String,
    architecture: String,
    images: BTreeMap<String, Image>,
}

fn hex(value: &str, size: usize) -> bool {
    value.len() == size
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn validate(configuration: &Configuration) -> Result<()> {
    ensure!(hex(&configuration.token, 32), "invalid Radix fixture token");
    ensure!(
        matches!(configuration.architecture.as_str(), "arm64" | "amd64"),
        "unsupported Radix image platform"
    );
    ensure!(
        configuration.images.len() == SERVICES.len(),
        "exact Radix services required"
    );
    for (name, source, _, _) in SERVICES {
        let image = configuration
            .images
            .get(name)
            .ok_or_else(|| eyre::eyre!("missing Radix service {name}"))?;
        ensure!(
            image.source == source && image.id.strip_prefix("sha256:").is_some_and(|v| hex(v, 64)),
            "Radix service image differs"
        );
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn client_start_identity(pid: u32) -> Result<Option<String>> {
    let mut wire = String::new();
    fs::File::open(format!("/proc/{pid}/stat"))?
        .take(65537)
        .read_to_string(&mut wire)?;
    ensure!(wire.len() <= 65536, "bounded actual child stat required");
    let (prefix, fields) = wire
        .rsplit_once(") ")
        .ok_or_else(|| eyre::eyre!("actual child stat shape"))?;
    ensure!(
        prefix.split_once('(').is_some_and(|(actual, _)| actual
            .trim()
            .parse::<u32>()
            .is_ok_and(|actual| actual == pid)),
        "actual child stat PID differs"
    );
    let fields: Vec<_> = fields.split_whitespace().collect();
    ensure!(
        fields.len() > 19 && fields[1].parse::<u32>()? == std::process::id(),
        "actual Docker client parent differs"
    );
    let start = fields[19].parse::<u64>()?;
    ensure!(start > 0, "actual Docker child start tick missing");
    Ok(Some(format!("linux-ticks:{start}")))
}

#[cfg(not(target_os = "linux"))]
fn client_start_identity(_: u32) -> Result<Option<String>> {
    // No Linux identity is manufactured by host-only controls.
    Ok(None)
}

/// Bounded direct Docker client; every actual wait is retained, including errors.
fn docker(manifest: &Manifest, tool: &Artifact, args: &[String], seconds: u64) -> Result<Vec<u8>> {
    tool.verify()?;
    let (host, config) = fixture_docker_environment(manifest)?;
    let mut output = tempfile::tempfile()?;
    use std::os::unix::process::{CommandExt, ExitStatusExt};
    let mut child = Command::new(&tool.path)
        .args(args)
        .env_clear()
        .env("PATH", "/usr/bin:/bin")
        .env("HOME", manifest.task_root.join("home"))
        .env("DOCKER_HOST", host)
        .env("DOCKER_CONFIG", config)
        .stdin(Stdio::null())
        .stdout(output.try_clone()?)
        .stderr(output.try_clone()?)
        .process_group(0)
        .spawn()?;
    let started = Instant::now();
    let deadline = started + Duration::from_secs(seconds);
    let mut identity = None;
    let outcome = (|| -> Result<std::process::ExitStatus> {
        // The direct child remains unreaped, so its PID cannot be reused here.
        identity = client_start_identity(child.id())?;
        loop {
            ensure!(
                output.metadata()?.len() <= 4 * 1024 * 1024 && Instant::now() < deadline,
                "Radix Docker command exceeded time/output bound"
            );
            if let Some(status) = child.try_wait()? {
                return Ok(status);
            }
            thread::sleep(Duration::from_millis(20));
        }
    })();
    let (status, mut primary, forced) = match outcome {
        Ok(status) => (status, None, false),
        Err(error) => {
            // The unreaped direct child anchors its original process group.
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(child.id() as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill();
            (child.wait()?, Some(error), true)
        }
    };
    let mut length = None;
    let mut bytes = Vec::new();
    let readback = (|| -> Result<()> {
        let size = output.metadata()?.len();
        length = Some(size);
        ensure!(size <= 4 * 1024 * 1024, "Radix Docker output bound");
        if primary.is_none() && status.success() {
            output.seek(SeekFrom::Start(0))?;
            output.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 4 * 1024 * 1024, "Radix Docker output bound");
        }
        Ok(())
    })();
    primary = primary.or_else(|| readback.err());
    use sha2::{Digest, Sha256};
    let receipt = json!({
        "schema":1,"purpose":"radix-fixture-docker-client",
        "runtime_source_commit":manifest.runtime_source_commit,"mode":manifest.mode,
        "pid":child.id(),"parent_pid":std::process::id(),"os":std::env::consts::OS,
        "os_start_token":identity,"executable":tool,"arguments":args,
        "parent_wait_completed":true,"exit_code":status.code(),"signal":status.signal(),
        "forced_cleanup":forced,"elapsed_monotonic_ns":u64::try_from(started.elapsed().as_nanos())?,
        "output_bytes":length,"output_sha256":if length == Some(bytes.len() as u64) {Some(hex::encode(Sha256::digest(&bytes)))}else{None},
        "success":primary.is_none() && status.success(),
        "error":primary.as_ref().map(ToString::to_string),
        "scope":"Actual direct Docker client Child wait only. Daemon-managed container processes are not claimed as child waits."
    });
    super::append_fixture_observation(manifest, "radix-client-parent-waits.jsonl", &receipt)?;
    if let Some(error) = primary {
        return Err(error);
    }
    ensure!(status.success(), "Radix Docker command failed ({status})");
    Ok(bytes)
}

fn validate_cached_image(rows: &[Value], image: &Image, architecture: &str) -> Result<()> {
    ensure!(
        rows.len() == 2
            && rows.iter().all(|row| row["Id"] == image.id
                && row["Os"] == "linux"
                && row["Architecture"] == architecture),
        "Radix cached source tag/immutable image identity/platform differs"
    );
    Ok(())
}

fn overrides(configuration: &Configuration) -> Value {
    let mut services = serde_json::Map::new();
    for (name, _, memory, pids) in SERVICES {
        let mut service = json!({
            "image": configuration.images[name].id, "pull_policy":"never",
            "init":true, "mem_limit":format!("{memory}m"),
            "memswap_limit":format!("{memory}m"), "cpus":2.0,
            "pids_limit":pids, "restart":"no",
            "deploy":{"restart_policy":{"condition":"none"}},
            "labels":{"io.hyperlane.ziggy.radix-token":configuration.token},
            "security_opt":["no-new-privileges:true"]
        });
        if name == "fullnode" {
            // The pinned single-node image skips external IP-oracle queries for
            // loopback. This P2P host property does not change the API bindings.
            service["environment"] = json!({"RADIXDLT_HOST_IP_ADDRESS":"127.0.0.1"});
        }
        services.insert(name.to_owned(), service);
    }
    json!({"services":services,"networks":{"default":{"internal":true}}})
}
fn ready_payloads(core: &Value, gateway: &Value) -> Result<()> {
    ensure!(
        core["network"] == "localnet"
            && core["network_id"] == 240
            && core["network_hrp_suffix"] == "loc",
        "Radix Core readiness belongs to another native network"
    );
    let state = &gateway["ledger_state"];
    ensure!(
        state["network"] == "localnet" && state["state_version"].as_u64().is_some_and(|v| v > 0),
        "Radix Gateway readiness has no local committed ledger"
    );
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ReadinessFailure {
    Pending,
    HttpStatus(u16),
    Transport,
    BodyBound,
    Schema,
    Deadline,
}
impl std::fmt::Display for ReadinessFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for ReadinessFailure {}

fn readiness_failure(error: &eyre::Report) -> ReadinessFailure {
    if let Some(error) = error.downcast_ref::<ReadinessFailure>() {
        return *error;
    }
    if let Some(ureq::Error::Status(status, _)) = error.downcast_ref::<ureq::Error>() {
        return ReadinessFailure::HttpStatus(*status);
    }
    ReadinessFailure::Transport
}

fn readiness_response(response: ureq::Response, deadline: Instant) -> Result<Value> {
    ensure!(Instant::now() < deadline, ReadinessFailure::Deadline);
    ensure!(
        response.status() == 200,
        ReadinessFailure::HttpStatus(response.status())
    );
    let mut wire = Vec::new();
    response
        .into_reader()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut wire)?;
    ensure!(Instant::now() < deadline, ReadinessFailure::Deadline);
    ensure!(wire.len() <= 2 * 1024 * 1024, ReadinessFailure::BodyBound);
    let value = serde_json::from_slice(&wire).map_err(|_| ReadinessFailure::Schema)?;
    ensure!(Instant::now() < deadline, ReadinessFailure::Deadline);
    Ok(value)
}

fn local_status(
    agent: &ureq::Agent,
    endpoint: &str,
    deadline: Instant,
    body: &str,
) -> Result<Value> {
    let request_deadline = deadline.min(Instant::now() + Duration::from_secs(2));
    let timeout = request_deadline
        .checked_duration_since(Instant::now())
        .ok_or(ReadinessFailure::Deadline)?;
    ensure!(!timeout.is_zero(), ReadinessFailure::Deadline);
    let request = agent
        .post(endpoint)
        .timeout(timeout)
        .set("Content-Type", "application/json");
    let response = match body {
        "{}" => request.send_string("{}")?,
        // No historical selector: this invokes the same current read-lag
        // guard used by submission, without constructing/submitting a tx.
        r#"{"limit_per_page":1}"# => request.send_string(r#"{"limit_per_page":1}"#)?,
        _ => return Err(ReadinessFailure::Schema.into()),
    };
    readiness_response(response, request_deadline)
}

fn ready_read_payloads(
    core: &Value,
    gateway: &Value,
    read: Result<Value>,
) -> Result<Option<ReadinessFailure>> {
    ready_payloads(core, gateway)?;
    match read {
        Ok(read) => {
            ready_payloads(core, &read)?;
            Ok(None)
        }
        Err(error) => Ok(Some(readiness_failure(&error))),
    }
}

fn publish_stop_intent(path: &std::path::Path, wire: &[u8]) -> Result<()> {
    use std::io::Write;
    let directory = path
        .parent()
        .ok_or_else(|| eyre::eyre!("Radix stop intent directory missing"))?;
    let mut pending = tempfile::NamedTempFile::new_in(directory)?;
    pending.write_all(wire)?;
    pending.as_file().sync_all()?;
    pending.persist_noclobber(path)?;
    fs::File::open(directory)?.sync_all()?;
    Ok(())
}

pub struct Localnet {
    docker: Artifact,
    manifest: Manifest,
    configuration: Configuration,
    project: String,
    override_file: PathBuf,
    identities: BTreeMap<String, String>,
    creation_armed: bool,
    stopped: bool,
}
impl Localnet {
    pub fn start() -> Result<Option<Self>> {
        let Some(manifest) = get()? else {
            return Ok(None);
        };
        ensure!(manifest.scenario == "radix", "wrong external Radix fixture");
        let case = fixture_json(&manifest.case_inputs)?;
        let approval = fixture_json(&manifest.execution_approval)?;
        ensure!(
            approval["case_inputs"] == serde_json::to_value(&manifest.case_inputs)?
                && approval["root_approved"] == true
                && approval["scenario"] == "radix"
                && approval["runtime_source_commit"] == manifest.runtime_source_commit
                && approval["mode"] == manifest.mode,
            "Radix case/approval differs"
        );
        let configuration: Configuration = serde_json::from_value(case["radix_localnet"].clone())?;
        validate(&configuration)?;
        ensure!(
            approval["radix_localnet"] == case["radix_localnet"],
            "Radix image/capability approval differs"
        );
        let docker_tool = manifest
            .verifier_tools
            .get("docker")
            .ok_or_else(|| eyre::eyre!("Docker tool missing"))?
            .clone();
        for image in configuration.images.values() {
            let bytes = docker(
                manifest,
                &docker_tool,
                &[
                    "image".into(),
                    "inspect".into(),
                    image.id.clone(),
                    image.source.clone(),
                ],
                10,
            )?;
            let rows: Vec<Value> = serde_json::from_slice(&bytes)?;
            validate_cached_image(&rows, image, &configuration.architecture)?;
        }
        let directory = super::create_owned_directory(
            &manifest.task_root,
            std::path::Path::new("radix-localnet"),
        )?;
        let override_file = directory.join("compose.override.json");
        use std::io::Write;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&override_file)?;
        file.write_all(serde_json::to_string_pretty(&overrides(&configuration))?.as_bytes())?;
        file.sync_all()?;
        let mut localnet = Self {
            docker: docker_tool,
            manifest: manifest.clone(),
            configuration,
            project: resource_name("radix"),
            override_file,
            identities: BTreeMap::new(),
            creation_armed: false,
            stopped: false,
        };
        // Guard exists before the first create. Any partial setup is cleaned on
        // unwind; service identities are checked before removing this project.
        ensure!(
            localnet.inspect(false)?.is_empty(),
            "Radix project already exists"
        );
        localnet.require_no_networks_or_volumes()?;
        localnet.creation_armed = true;
        localnet.compose(&["up", "--detach", "--no-build", "--pull", "never"], 180)?;
        localnet.identities = localnet.inspect(true)?;
        let network: Vec<Value> = serde_json::from_slice(&docker(
            &localnet.manifest,
            &localnet.docker,
            &[
                "network".into(),
                "inspect".into(),
                format!("{}_default", localnet.project),
            ],
            10,
        )?)?;
        ensure!(
            network.len() == 1
                && network[0]["Internal"] == true
                && network[0]["Labels"]["com.docker.compose.project"] == localnet.project,
            "Radix fixture network is not owned and isolated from external networks"
        );
        ensure!(
            localnet.identities.len() == SERVICES.len(),
            "Radix Compose service coverage differs"
        );
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(false)
            .redirects(0)
            .build();
        let deadline = Instant::now() + Duration::from_secs(120);
        let mut last_probe = ("startup", ReadinessFailure::Pending);
        loop {
            ensure!(
                Instant::now() < deadline,
                "owned Radix Core/Gateway startup deadline; phase={}, status={:?}",
                last_probe.0,
                last_probe.1
            );
            let core = local_status(
                &agent,
                "http://127.0.0.1:3333/core/status/network-configuration",
                deadline,
                "{}",
            );
            let gateway = local_status(
                &agent,
                "http://127.0.0.1:5308/status/gateway-status",
                deadline,
                "{}",
            );
            match (core, gateway) {
                (Ok(core), Ok(gateway)) => {
                    // Wrong network/schema remains fatal before any new read.
                    ready_payloads(&core, &gateway)?;
                    let read = local_status(
                        &agent,
                        "http://127.0.0.1:5308/stream/transactions",
                        deadline,
                        r#"{"limit_per_page":1}"#,
                    );
                    if let Some(reason) = ready_read_payloads(&core, &gateway, read)? {
                        last_probe = ("gateway-read", reason);
                    } else {
                        ensure!(Instant::now() < deadline, ReadinessFailure::Deadline);
                        break;
                    }
                }
                (Err(error), _) => last_probe = ("core-status", readiness_failure(&error)),
                (_, Err(error)) => last_probe = ("gateway-status", readiness_failure(&error)),
            }
            thread::sleep(
                Duration::from_millis(500).min(deadline.saturating_duration_since(Instant::now())),
            );
        }
        Ok(Some(localnet))
    }
    fn compose(&self, arguments: &[&str], seconds: u64) -> Result<Vec<u8>> {
        let source = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("src/radix/docker-compose.yml");
        let mut args = vec![
            "compose".to_owned(),
            "--project-name".into(),
            self.project.clone(),
            "--file".into(),
            source.to_string_lossy().into_owned(),
            "--file".into(),
            self.override_file.to_string_lossy().into_owned(),
            "--profile".into(),
            "fullnode".into(),
            "--profile".into(),
            "network-gateway-image".into(),
        ];
        args.extend(arguments.iter().map(|s| (*s).to_owned()));
        docker(&self.manifest, &self.docker, &args, seconds)
    }
    fn require_no_networks_or_volumes(&self) -> Result<()> {
        for kind in ["network", "volume"] {
            let output = docker(
                &self.manifest,
                &self.docker,
                &[
                    kind.into(),
                    "ls".into(),
                    "--quiet".into(),
                    "--filter".into(),
                    format!("label=com.docker.compose.project={}", self.project),
                ],
                10,
            )?;
            ensure!(
                std::str::from_utf8(&output)?.trim().is_empty(),
                "Radix project network/volume already exists or remains"
            );
        }
        Ok(())
    }
    fn inspect(&self, validate_bounds: bool) -> Result<BTreeMap<String, String>> {
        let bytes = docker(
            &self.manifest,
            &self.docker,
            &[
                "ps".into(),
                "--all".into(),
                "--no-trunc".into(),
                "--filter".into(),
                format!("label=com.docker.compose.project={}", self.project),
                "--format".into(),
                "{{.ID}}".into(),
            ],
            10,
        )?;
        let mut found = BTreeMap::new();
        for id in std::str::from_utf8(&bytes)?.lines() {
            ensure!(hex(id, 64), "Radix container identity malformed");
            let rows: Vec<Value> = serde_json::from_slice(&docker(
                &self.manifest,
                &self.docker,
                &["inspect".into(), id.into()],
                10,
            )?)?;
            ensure!(rows.len() == 1, "Radix inspect coverage differs");
            let row = &rows[0];
            let labels = &row["Config"]["Labels"];
            let service = labels["com.docker.compose.service"]
                .as_str()
                .ok_or_else(|| eyre::eyre!("Radix service label missing"))?;
            ensure!(
                labels["com.docker.compose.project"] == self.project
                    && labels["io.hyperlane.ziggy.radix-token"] == self.configuration.token
                    && self
                        .configuration
                        .images
                        .get(service)
                        .is_some_and(|image| row["Image"] == image.id),
                "Radix container owner/image differs"
            );
            if validate_bounds {
                let (_, _, memory, pids) = SERVICES
                    .iter()
                    .find(|item| item.0 == service)
                    .ok_or_else(|| eyre::eyre!("unexpected Radix service"))?;
                let host = &row["HostConfig"];
                ensure!(
                    host["Memory"] == memory * 1024 * 1024
                        && host["MemorySwap"] == memory * 1024 * 1024
                        && host["NanoCpus"] == 2_000_000_000u64
                        && host["PidsLimit"] == *pids
                        && host["Init"] == true
                        && host["RestartPolicy"]["Name"] == "no"
                        && host["SecurityOpt"].as_array().is_some_and(|values| values
                            .iter()
                            .any(|v| v == "no-new-privileges:true")),
                    "actual Radix service resource bounds differ"
                );
                ensure!(
                    row["Mounts"]
                        .as_array()
                        .is_some_and(|mounts| mounts.iter().all(|m| m["Type"] == "volume")),
                    "Radix service acquired an unowned bind mount"
                );
            }
            ensure!(
                self.identities.get(service).is_none_or(|prior| prior == id),
                "Radix service container replaced"
            );
            ensure!(
                found.insert(service.to_owned(), id.to_owned()).is_none(),
                "duplicate Radix service container"
            );
        }
        Ok(found)
    }
    pub fn stop(&mut self) -> Result<()> {
        if self.stopped {
            return Ok(());
        }
        if !self.creation_armed {
            self.stopped = true;
            return Ok(());
        }
        // Cleanup authorizes exact ownership/CID, independent of a resource
        // acceptance failure which may be why startup is unwinding.
        let before = self.inspect(false)?;
        // Bind the planned disappearance to actual authenticated CIDs before
        // Compose starts removing them. Containers are daemon objects, not
        // direct children; the independent owner retains client wait receipts.
        let intent_path = self.override_file.with_file_name("stopping.json");
        let intent = serde_json::to_vec(&json!({
            "project":self.project,"parent_pid":std::process::id(),"containers":before
        }))?;
        if intent_path.exists() {
            ensure!(
                fs::symlink_metadata(&intent_path)?.file_type().is_file()
                    && fs::metadata(&intent_path)?.len() <= 16 * 1024,
                "Radix Source stop intent is not bounded regular data"
            );
            let prior: Value = serde_json::from_slice(&fs::read(&intent_path)?)?;
            ensure!(
                prior.as_object().is_some_and(|row| row.len() == 3)
                    && prior["project"] == self.project
                    && prior["parent_pid"] == std::process::id(),
                "Radix Source stop intent authority changed"
            );
            let original: BTreeMap<String, String> =
                serde_json::from_value(prior["containers"].clone())?;
            ensure!(
                before
                    .iter()
                    .all(|(service, cid)| original.get(service) == Some(cid)),
                "Radix Source stop retry added or replaced a container"
            );
            // A failed first down may have removed some services. Preserve its
            // first durable authority and retry only the remaining exact CIDs.
        } else {
            // Readers may observe this live marker while cleanup begins. Only
            // publish the complete fsynced bytes, preserving any first intent.
            publish_stop_intent(&intent_path, &intent)?;
        }
        self.compose(&["down", "--timeout", "15", "--volumes"], 60)?;
        ensure!(
            self.inspect(false)?.is_empty(),
            "owned Radix containers remain after down"
        );
        self.require_no_networks_or_volumes()?;
        let result = json!({"project":self.project,"removed":before,"all_owned_containers_absent":true,
            "actual_client_waits":true,"runtime_source_commit":self.manifest.runtime_source_commit});
        fs::write(
            self.override_file.with_file_name("stopped.json"),
            serde_json::to_vec_pretty(&result)?,
        )?;
        self.stopped = true;
        Ok(())
    }
}
impl Drop for Localnet {
    fn drop(&mut self) {
        if let Err(error) = self.stop() {
            eprintln!("owned Radix localnet cleanup failed: {error:#}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn configuration() -> Configuration {
        Configuration {
            token: "11".repeat(16),
            architecture: "arm64".into(),
            images: SERVICES
                .iter()
                .enumerate()
                .map(|(i, (name, source, _, _))| {
                    (
                        (*name).to_owned(),
                        Image {
                            source: (*source).to_owned(),
                            id: format!("sha256:{i:064x}"),
                        },
                    )
                })
                .collect(),
        }
    }
    #[test]
    fn exact_source_images_and_native_platform_are_required() {
        let mut c = configuration();
        validate(&c).unwrap();
        // Exact Python fixture_configuration wire shape. Nested Source config
        // has three fields; the outer case already carries its schema version.
        let wire = json!({
            "token":c.token,"architecture":"amd64",
            "images":c.images.iter().map(|(name, image)|
                (name.clone(), json!({"source":image.source,"id":image.id}))
            ).collect::<BTreeMap<String, Value>>()
        });
        let decoded: Configuration = serde_json::from_value(wire.clone()).unwrap();
        validate(&decoded).unwrap();
        // The address is fixed by this external fixture, never case-supplied.
        for (field, value) in [
            (
                "environment",
                json!({"RADIXDLT_HOST_IP_ADDRESS":"198.51.100.1"}),
            ),
            ("network.host_ip", json!("remote.example")),
        ] {
            let mut foreign_host = wire.clone();
            foreign_host[field] = value;
            assert!(serde_json::from_value::<Configuration>(foreign_host).is_err());
        }
        let mut redundant_version = wire;
        redundant_version["schema"] = json!(1);
        assert!(serde_json::from_value::<Configuration>(redundant_version).is_err());
        for &(name, _, _, _) in &SERVICES {
            let old = c.images[name].clone();
            c.images.get_mut(name).unwrap().source = "foreign/image:latest".into();
            assert!(validate(&c).is_err());
            c.images.insert(name.into(), old.clone());
            c.images.get_mut(name).unwrap().id = "sha256:short".into();
            assert!(validate(&c).is_err());
            c.images.insert(name.into(), old);
        }
        c.architecture = "darwin".into();
        assert!(validate(&c).is_err());
        c.architecture = "amd64".into();
        validate(&c).unwrap();
        c.token = "".into();
        assert!(validate(&c).is_err());
    }
    #[test]
    fn cached_source_tag_must_resolve_to_the_same_native_immutable_image() {
        let configuration = configuration();
        let image = &configuration.images["fullnode"];
        let row = json!({"Id":image.id,"Os":"linux","Architecture":"arm64"});
        validate_cached_image(&[row.clone(), row.clone()], image, "arm64").unwrap();
        let mut different_tag = row.clone();
        different_tag["Id"] = json!(format!("sha256:{}", "ff".repeat(32)));
        assert!(validate_cached_image(&[row.clone(), different_tag], image, "arm64").is_err());
        assert!(validate_cached_image(std::slice::from_ref(&row), image, "arm64").is_err());
        assert!(
            validate_cached_image(&[row.clone(), row.clone(), row.clone()], image, "arm64")
                .is_err()
        );
        for (key, value) in [("Os", "darwin"), ("Architecture", "amd64")] {
            let mut wrong_platform = row.clone();
            wrong_platform[key] = json!(value);
            assert!(validate_cached_image(&[row.clone(), wrong_platform], image, "arm64").is_err());
        }
    }

    #[test]
    fn absent_or_additional_services_are_rejected() {
        let mut c = configuration();
        let old = c.images.remove("fullnode").unwrap();
        assert!(validate(&c).is_err());
        c.images.insert("fullnode".into(), old.clone());
        c.images.insert("foreign-service".into(), old);
        assert!(validate(&c).is_err());
    }
    #[test]
    fn compose_model_cannot_pull_or_restart_unbounded_services() {
        let c = configuration();
        let model = overrides(&c);
        assert_eq!(model["networks"], json!({"default":{"internal":true}}));
        assert_eq!(
            model["services"]["fullnode"]["environment"],
            json!({"RADIXDLT_HOST_IP_ADDRESS":"127.0.0.1"})
        );
        for (name, _, memory, pids) in SERVICES {
            let row = &model["services"][name];
            assert_eq!(row["image"], c.images[name].id);
            assert_eq!(row["pull_policy"], "never");
            assert_eq!(row["restart"], "no");
            assert_eq!(row["mem_limit"], format!("{memory}m"));
            assert_eq!(row["memswap_limit"], row["mem_limit"]);
            assert_eq!(row["pids_limit"], pids);
            assert_eq!(row["deploy"]["restart_policy"]["condition"], "none");
            assert_eq!(row["init"], true);
            assert_eq!(row["cpus"], 2.0);
            assert_eq!(row["security_opt"], json!(["no-new-privileges:true"]));
            assert!(row.get("network_mode").is_none());
            assert!(row.get("networks").is_none());
            assert!(row.get("ports").is_none());
            if name != "fullnode" {
                assert!(row.get("environment").is_none());
            }
        }
    }
    fn pin(path: PathBuf) -> Artifact {
        use sha2::{Digest, Sha256};
        let bytes = fs::read(&path).unwrap();
        Artifact {
            path,
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
    fn manifest(directory: &std::path::Path) -> Manifest {
        let config = directory.join("docker-config");
        fs::create_dir_all(&config).unwrap();
        let local = json!({"host":format!("unix://{}", directory.join("fixture.sock").display()),"config_dir":config});
        let case = directory.join("case.json");
        let approval = directory.join("approval.json");
        fs::write(
            &case,
            serde_json::to_vec(&json!({"local_docker":local})).unwrap(),
        )
        .unwrap();
        fs::write(
            &approval,
            serde_json::to_vec(&json!({"local_docker":local})).unwrap(),
        )
        .unwrap();
        let case = pin(case);
        let approval = pin(approval);
        serde_json::from_value(json!({
            "schema":3,"implementation":"zig","scenario":"radix",
            "case_inputs":case,"execution_approval":approval,
            "runtime_source_commit":"11".repeat(20),"mode":"ReleaseSafe",
            "verifier_tools":{},"task_root":directory,
            "artifacts":{},"environment":{},"tool_overrides":{},"harness_deadline_seconds":1800,
            "verifier":{"python":case,"script":case,"evidence_root":directory}
        }))
        .unwrap()
    }
    // Only the isolated parent control sets this marker. Normal suite invocation is inert.
    #[test]
    fn docker_environment_probe_worker() {
        let Some(root) = std::env::var_os("ZIGGY_RADIX_ENV_CONTROL_ROOT") else {
            return;
        };
        use std::os::unix::fs::PermissionsExt;
        let root = PathBuf::from(root);
        let manifest = manifest(&root);
        let path = root.join("fake-docker");
        let script = format!(
            r#"#!/bin/sh
set -eu
test "$DOCKER_HOST" = 'unix://{0}/fixture.sock'
test "$DOCKER_CONFIG" = '{0}/docker-config'
test "$HOME" = '{0}/home'
test "$PATH" = '/usr/bin:/bin'
test -z "${{DOCKER_CONTEXT+x}}"
test -z "${{DOCKER_AUTH_CONFIG+x}}"
test -z "${{HTTP_PROXY+x}}"
test -z "${{AWS_SECRET_ACCESS_KEY+x}}"
printf '%s:%s' "$1" "$2"
"#,
            root.display()
        );
        fs::write(&path, script).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let tool = pin(path);
        for args in [["image", "inspect"], ["compose", "down"]] {
            assert_eq!(
                docker(&manifest, &tool, &args.map(String::from), 2).unwrap(),
                format!("{}:{}", args[0], args[1]).as_bytes()
            );
        }
        println!("isolated approved Docker environment confirmed");
    }
    #[test]
    fn docker_launch_strips_hostile_inherited_authority_for_inspect_and_compose() {
        let root = tempfile::tempdir().unwrap();
        let log = tempfile::tempfile().unwrap();
        let module = module_path!().split_once("::").unwrap().1;
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                &format!("{module}::docker_environment_probe_worker"),
                "--nocapture",
            ])
            .env_clear()
            .env("ZIGGY_RADIX_ENV_CONTROL_ROOT", root.path())
            .env("DOCKER_HOST", "tcp://foreign.example:2375")
            .env("DOCKER_CONTEXT", "foreign")
            .env("DOCKER_CONFIG", "/foreign/config")
            .env("HOME", "/foreign/home")
            .env("HTTP_PROXY", "http://foreign.example")
            .env("DOCKER_AUTH_CONFIG", "synthetic-not-a-credential")
            .env("AWS_SECRET_ACCESS_KEY", "synthetic-not-a-credential")
            .stdin(Stdio::null())
            .stdout(log.try_clone().unwrap())
            .stderr(log.try_clone().unwrap())
            .spawn()
            .unwrap();
        let end = Instant::now() + Duration::from_secs(5);
        let status = loop {
            if let Some(status) = child.try_wait().unwrap() {
                break status;
            }
            if Instant::now() >= end {
                let _ = child.kill();
                let _ = child.wait();
                panic!("Docker environment control timed out");
            }
            thread::sleep(Duration::from_millis(10));
        };
        assert!(status.success());
        let mut log = log;
        log.seek(SeekFrom::Start(0)).unwrap();
        let mut text = String::new();
        log.take(16384).read_to_string(&mut text).unwrap();
        assert!(
            text.contains("isolated approved Docker environment confirmed"),
            "{text}"
        );
    }
    fn shell() -> Artifact {
        use sha2::{Digest, Sha256};
        let path = PathBuf::from("/bin/sh").canonicalize().unwrap();
        let bytes = fs::read(&path).unwrap();
        Artifact {
            path,
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(bytes)),
        }
    }
    #[test]
    fn bounded_client_preserves_output_and_rejects_actual_nonzero_exit() {
        let dir = tempfile::tempdir().unwrap();
        let manifest = manifest(dir.path());
        let sh = shell();
        assert_eq!(
            docker(
                &manifest,
                &sh,
                &["-c".into(), "printf public-control".into()],
                2
            )
            .unwrap(),
            b"public-control"
        );
        assert!(docker(&manifest, &sh, &["-c".into(), "exit 7".into()], 2).is_err());
        let waits: Vec<Value> =
            fs::read_to_string(dir.path().join("radix-client-parent-waits.jsonl"))
                .unwrap()
                .lines()
                .map(|line| serde_json::from_str(line).unwrap())
                .collect();
        assert_eq!(waits.len(), 2);
        assert_ne!(waits[0]["pid"], waits[1]["pid"]);
        for row in &waits {
            assert_eq!(row["parent_pid"], std::process::id());
            assert_eq!(row["executable"], serde_json::to_value(&sh).unwrap());
            assert_eq!(row["parent_wait_completed"], true);
            assert_eq!(row["forced_cleanup"], false);
            assert!(row["elapsed_monotonic_ns"].as_u64().unwrap() > 0);
            if cfg!(target_os = "linux") {
                assert!(row["os_start_token"]
                    .as_str()
                    .unwrap()
                    .starts_with("linux-ticks:"));
            } else {
                assert!(row["os_start_token"].is_null());
            }
        }
        assert_eq!(waits[0]["success"], true);
        assert_eq!(waits[0]["exit_code"], 0);
        assert_eq!(waits[0]["output_bytes"], 14);
        assert_eq!(waits[1]["success"], false);
        assert_eq!(waits[1]["exit_code"], 7);
    }
    #[test]
    fn bounded_client_kills_and_waits_its_original_process() {
        let dir = tempfile::tempdir().unwrap();
        let pidfile = dir.path().join("pid");
        let command = format!("echo $$ > '{}'; exec sleep 30", pidfile.display());
        let start = Instant::now();
        assert!(docker(&manifest(dir.path()), &shell(), &["-c".into(), command], 1).is_err());
        assert!(start.elapsed() < Duration::from_secs(3));
        let pid: i32 = fs::read_to_string(pidfile).unwrap().trim().parse().unwrap();
        assert!(matches!(
            nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None),
            Err(nix::errno::Errno::ESRCH)
        ));
    }
    #[test]
    fn bounded_client_rejects_excess_output() {
        let dir = tempfile::tempdir().unwrap();
        assert!(docker(
            &manifest(dir.path()),
            &shell(),
            &["-c".into(), "head -c 4194305 /dev/zero".into()],
            2
        )
        .is_err());
    }
    #[test]
    fn default_rust_fixture_path_remains_unselected() {
        assert!(Localnet::start().unwrap().is_none());
    }
    #[test]
    fn readiness_requires_both_actual_local_native_networks_and_committed_gateway_state() {
        let core = json!({"network":"localnet","network_id":240,"network_hrp_suffix":"loc"});
        let gateway = json!({"ledger_state":{"network":"localnet","state_version":1}});
        ready_payloads(&core, &gateway).unwrap();
        for (key, value) in [
            ("network", json!("mainnet")),
            ("network_id", json!(1)),
            ("network_hrp_suffix", json!("rdx")),
        ] {
            let mut other = core.clone();
            other[key] = value;
            assert!(ready_payloads(&other, &gateway).is_err());
        }
        for value in [
            json!({"ledger_state":{"network":"mainnet","state_version":1}}),
            json!({"ledger_state":{"network":"localnet","state_version":0}}),
        ] {
            assert!(ready_payloads(&core, &value).is_err());
        }
    }

    fn readiness_http_fixture(
        replies: Vec<(u16, Vec<u8>, Duration)>,
    ) -> (String, thread::JoinHandle<Vec<(String, Value)>>) {
        use std::io::Write;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let handle = thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body, delay) in replies {
                let deadline = Instant::now() + Duration::from_secs(3);
                let mut socket = loop {
                    match listener.accept() {
                        Ok((socket, _)) => break socket,
                        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                            assert!(Instant::now() < deadline, "owned HTTP fixture not called");
                            thread::sleep(Duration::from_millis(1));
                        }
                        Err(error) => panic!("owned HTTP fixture accept: {error}"),
                    }
                };
                socket
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let (header_end, length) = loop {
                    assert!(request.len() <= 4096, "owned request bound");
                    if let Some(end) = request.windows(4).position(|part| part == b"\r\n\r\n") {
                        let header = std::str::from_utf8(&request[..end]).unwrap();
                        let length = header
                            .lines()
                            .find_map(|line| {
                                let (name, value) = line.split_once(':')?;
                                name.eq_ignore_ascii_case("content-length")
                                    .then(|| value.trim().parse::<usize>().unwrap())
                            })
                            .unwrap();
                        assert!(length <= 64);
                        break (end + 4, length);
                    }
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                };
                let mut body_request = vec![0; length];
                socket.read_exact(&mut body_request).unwrap();
                let first_line = std::str::from_utf8(&request[..header_end])
                    .unwrap()
                    .lines()
                    .next()
                    .unwrap()
                    .to_owned();
                requests.push((first_line, serde_json::from_slice(&body_request).unwrap()));
                thread::sleep(delay);
                let header = format!("HTTP/1.1 {status} Test\r\nContent-Length: {}\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n", body.len());
                if socket.write_all(header.as_bytes()).is_ok() {
                    let _ = socket.write_all(&body);
                }
            }
            requests
        });
        (endpoint, handle)
    }

    #[test]
    fn readiness_waits_for_current_read_guard_without_submitting_or_renewing_network_checks() {
        let core = json!({"network":"localnet","network_id":240,"network_hrp_suffix":"loc"});
        let gateway = json!({"ledger_state":{"network":"localnet","state_version":1}});
        let body = serde_json::to_vec(&gateway).unwrap();
        let (endpoint, server) = readiness_http_fixture(vec![
            (200, serde_json::to_vec(&core).unwrap(), Duration::ZERO),
            (200, body.clone(), Duration::ZERO),
            (
                500,
                br#"{"details":{"type":"NotSyncedUpError"}}"#.to_vec(),
                Duration::ZERO,
            ),
            (200, body, Duration::ZERO),
        ]);
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(false)
            .redirects(0)
            .build();
        let deadline = Instant::now() + Duration::from_secs(10);
        let actual_core = local_status(
            &agent,
            &format!("{endpoint}/core/status/network-configuration"),
            deadline,
            "{}",
        )
        .unwrap();
        let actual_gateway = local_status(
            &agent,
            &format!("{endpoint}/status/gateway-status"),
            deadline,
            "{}",
        )
        .unwrap();
        // The old status-only gate accepts this stale/genesis-shaped state.
        ready_payloads(&actual_core, &actual_gateway).unwrap();
        let pending = local_status(
            &agent,
            &format!("{endpoint}/stream/transactions"),
            deadline,
            r#"{"limit_per_page":1}"#,
        );
        assert_eq!(
            ready_read_payloads(&actual_core, &actual_gateway, pending).unwrap(),
            Some(ReadinessFailure::HttpStatus(500))
        );
        let current = local_status(
            &agent,
            &format!("{endpoint}/stream/transactions"),
            deadline,
            r#"{"limit_per_page":1}"#,
        );
        assert_eq!(
            ready_read_payloads(&actual_core, &actual_gateway, current).unwrap(),
            None
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 4);
        assert_eq!(
            requests[0],
            (
                "POST /core/status/network-configuration HTTP/1.1".into(),
                json!({})
            )
        );
        assert_eq!(
            requests[1],
            ("POST /status/gateway-status HTTP/1.1".into(), json!({}))
        );
        for request in &requests[2..] {
            assert_eq!(
                *request,
                (
                    "POST /stream/transactions HTTP/1.1".into(),
                    json!({"limit_per_page":1})
                )
            );
            assert!(request.1.get("at_ledger_state").is_none());
        }
        let wrong_core = json!({"network":"mainnet","network_id":1,"network_hrp_suffix":"rdx"});
        assert!(ready_read_payloads(
            &wrong_core,
            &gateway,
            Err(ureq::Error::Status(500, ureq::Response::new(500, "Test", "{}").unwrap()).into())
        )
        .is_err());
        let wrong_read = json!({"ledger_state":{"network":"mainnet","state_version":1}});
        assert!(ready_read_payloads(&core, &gateway, Ok(wrong_read)).is_err());
        assert!(ready_read_payloads(&core, &gateway, Ok(json!({}))).is_err());
    }

    #[test]
    fn readiness_read_probe_has_expired_and_delayed_absolute_fences() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!(
            "http://{}/stream/transactions",
            listener.local_addr().unwrap()
        );
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(false)
            .redirects(0)
            .build();
        let expired = Instant::now() - Duration::from_millis(1);
        for result in [
            local_status(&agent, &endpoint, expired, "{}"),
            local_status(&agent, &endpoint, expired, r#"{"limit_per_page":1}"#),
        ] {
            assert_eq!(
                readiness_failure(&result.unwrap_err()),
                ReadinessFailure::Deadline
            );
        }
        let unapproved_body = local_status(
            &agent,
            &endpoint,
            Instant::now() + Duration::from_secs(1),
            r#"{"at_ledger_state":{"state_version":1}}"#,
        );
        assert_eq!(
            readiness_failure(&unapproved_body.unwrap_err()),
            ReadinessFailure::Schema
        );
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        let (endpoint, server) =
            readiness_http_fixture(vec![(200, b"{}".to_vec(), Duration::from_secs(1))]);
        let started = Instant::now();
        assert!(local_status(
            &agent,
            &endpoint,
            started + Duration::from_millis(250),
            r#"{"limit_per_page":1}"#
        )
        .is_err());
        assert!(started.elapsed() < Duration::from_millis(750));
        server.join().unwrap();
    }

    #[test]
    fn readiness_response_byte_schema_and_http_status_bounds_remain_hard() {
        let agent = ureq::AgentBuilder::new()
            .try_proxy_from_env(false)
            .redirects(0)
            .build();
        for (status, body, expected) in [
            (
                200,
                vec![b'x'; 2 * 1024 * 1024 + 1],
                ReadinessFailure::BodyBound,
            ),
            (200, b"not-json PRIVATE".to_vec(), ReadinessFailure::Schema),
            (201, b"{}".to_vec(), ReadinessFailure::HttpStatus(201)),
        ] {
            let (endpoint, server) = readiness_http_fixture(vec![(status, body, Duration::ZERO)]);
            let error = local_status(
                &agent,
                &endpoint,
                Instant::now() + Duration::from_secs(2),
                r#"{"limit_per_page":1}"#,
            )
            .unwrap_err();
            assert_eq!(readiness_failure(&error), expected);
            assert!(!format!("{:?}", readiness_failure(&error)).contains("PRIVATE"));
            server.join().unwrap();
        }
    }

    fn fake_localnet(directory: &std::path::Path, foreign: bool, changed: bool) -> Localnet {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        let configuration = configuration();
        let cid = "ab".repeat(32);
        let marker = directory.join("removed");
        let row = json!([{"Id":cid,"Image":configuration.images["fullnode"].id,"Config":{"Labels":{
            "com.docker.compose.project":"private-fixture", "com.docker.compose.service":"fullnode",
            "io.hyperlane.ziggy.radix-token":if foreign {"foreign".into()}else{configuration.token.clone()}}},
            "HostConfig":{},"Mounts":[]}]);
        let data = directory.join("row.json");
        fs::write(&data, serde_json::to_vec(&row).unwrap()).unwrap();
        let script=format!("#!/bin/sh\ncase \"$1\" in\nps) test -f '{}' || printf '%s\\n' '{}' ;;\ninspect) cat '{}' ;;\ncompose) touch '{}' ;;\nnetwork|volume) : ;;\n*) exit 9 ;;\nesac\n",marker.display(),cid,data.display(),marker.display());
        let path = directory.join("docker-fixture");
        fs::write(&path, script.as_bytes()).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let artifact = Artifact {
            path,
            bytes: script.len() as u64,
            sha256: format!("{:x}", Sha256::digest(script.as_bytes())),
        };
        let manifest = manifest(directory);
        Localnet {
            docker: artifact,
            manifest,
            configuration,
            project: "private-fixture".into(),
            override_file: directory.join("override.json"),
            identities: BTreeMap::from([(
                "fullnode".into(),
                if changed { "cd".repeat(32) } else { cid },
            )]),
            creation_armed: true,
            stopped: false,
        }
    }
    #[test]
    fn failed_resource_acceptance_still_cleans_exact_owned_containers() {
        let directory = tempfile::tempdir().unwrap();
        let mut value = fake_localnet(directory.path(), false, false);
        assert!(value.inspect(true).is_err());
        value.stop().unwrap();
        assert!(directory.path().join("removed").exists());
        assert!(directory.path().join("stopped.json").exists());
        let intent_path = directory.path().join("stopping.json");
        let complete = fs::read(&intent_path).unwrap();
        let published: Value = serde_json::from_slice(&complete).unwrap();
        assert_eq!(
            published,
            json!({"project":"private-fixture","parent_pid":std::process::id(),
                "containers":{"fullnode":"ab".repeat(32)}})
        );
        let names = || {
            let mut names: Vec<_> = fs::read_dir(directory.path())
                .unwrap()
                .map(|entry| entry.unwrap().file_name())
                .collect();
            names.sort();
            names
        };
        let before_names = names();
        assert!(publish_stop_intent(&intent_path, b"replacement must not publish").is_err());
        assert_eq!(fs::read(&intent_path).unwrap(), complete);
        assert_eq!(names(), before_names);
        // A previous down removed the gateway, leaving the same fullnode.
        let retry = tempfile::tempdir().unwrap();
        let mut value = fake_localnet(retry.path(), false, false);
        let first = json!({"project":"private-fixture","parent_pid":std::process::id(),
            "containers":{"fullnode":"ab".repeat(32),"gateway_api_image":"ef".repeat(32)}});
        let intent = serde_json::to_vec(&first).unwrap();
        fs::write(retry.path().join("stopping.json"), &intent).unwrap();
        value.stop().unwrap();
        assert_eq!(
            fs::read(retry.path().join("stopping.json")).unwrap(),
            intent
        );
        assert!(retry.path().join("removed").exists());
    }
    #[test]
    fn cleanup_preserves_foreign_or_replaced_container() {
        for (foreign, changed) in [(true, false), (false, true)] {
            let directory = tempfile::tempdir().unwrap();
            let mut value = fake_localnet(directory.path(), foreign, changed);
            assert!(value.stop().is_err());
            assert!(!directory.path().join("removed").exists());
            value.creation_armed = false;
        }
        for containers in [json!({}), json!({"fullnode":"cd".repeat(32)})] {
            let directory = tempfile::tempdir().unwrap();
            let mut value = fake_localnet(directory.path(), false, false);
            fs::write(directory.path().join("stopping.json"), serde_json::to_vec(&json!({
                "project":"private-fixture","parent_pid":std::process::id(),"containers":containers
            })).unwrap()).unwrap();
            assert!(value.stop().is_err());
            assert!(!directory.path().join("removed").exists());
            value.creation_armed = false;
        }
    }
    #[test]
    fn preexisting_project_cannot_arm_cleanup() {
        let directory = tempfile::tempdir().unwrap();
        let mut value = fake_localnet(directory.path(), false, false);
        value.creation_armed = false;
        value.stop().unwrap();
        assert!(!directory.path().join("removed").exists());
    }
}
