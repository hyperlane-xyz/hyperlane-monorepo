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

/// A bounded direct Docker client, with actual Child wait on every path. Use
/// files instead of pipes so a full output pipe cannot deadlock a timeout.
fn docker(manifest: &Manifest, tool: &Artifact, args: &[String], seconds: u64) -> Result<Vec<u8>> {
    tool.verify()?;
    let (host, config) = fixture_docker_environment(manifest)?;
    let mut output = tempfile::tempfile()?;
    use std::os::unix::process::CommandExt;
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
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let outcome = (|| -> Result<std::process::ExitStatus> {
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
    let status = match outcome {
        Ok(status) => status,
        Err(error) => {
            // Child is deliberately unreaped here, anchoring its new group.
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(child.id() as i32),
                nix::sys::signal::Signal::SIGKILL,
            );
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    ensure!(status.success(), "Radix Docker command failed ({status})");
    output.seek(SeekFrom::Start(0))?;
    let mut bytes = Vec::new();
    output.take(4 * 1024 * 1024 + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 4 * 1024 * 1024, "Radix Docker output bound");
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
        services.insert(
            name.to_owned(),
            json!({
                "image": configuration.images[name].id, "pull_policy":"never",
                "init":true, "mem_limit":format!("{memory}m"),
                "memswap_limit":format!("{memory}m"), "cpus":2.0,
                "pids_limit":pids, "restart":"no",
                "deploy":{"restart_policy":{"condition":"none"}},
                "labels":{"io.hyperlane.ziggy.radix-token":configuration.token},
                "security_opt":["no-new-privileges:true"]
            }),
        );
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
fn local_status(agent: &ureq::Agent, endpoint: &str) -> Result<Value> {
    let response = agent
        .post(endpoint)
        .timeout(Duration::from_secs(2))
        .set("Content-Type", "application/json")
        .send_string("{}")?;
    let mut wire = Vec::new();
    response
        .into_reader()
        .take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut wire)?;
    ensure!(
        wire.len() <= 2 * 1024 * 1024,
        "Radix readiness response bound"
    );
    Ok(serde_json::from_slice(&wire)?)
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
        let agent = ureq::AgentBuilder::new().try_proxy_from_env(false).build();
        let deadline = Instant::now() + Duration::from_secs(120);
        loop {
            let core = local_status(
                &agent,
                "http://127.0.0.1:3333/core/status/network-configuration",
            );
            let gateway = local_status(&agent, "http://127.0.0.1:5308/status/gateway-status");
            if let (Ok(core), Ok(gateway)) = (core, gateway) {
                ready_payloads(&core, &gateway)?;
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "owned Radix Core/Gateway startup deadline"
            );
            thread::sleep(Duration::from_millis(500));
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
        for index in 0..SERVICES.len() {
            let name = SERVICES[index].0;
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
        assert!(validate_cached_image(&[row.clone()], image, "arm64").is_err());
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
        assert_eq!(model["networks"]["default"]["internal"], true);
        for (name, _, memory, pids) in SERVICES {
            let row = &model["services"][name];
            assert_eq!(row["image"], c.images[name].id);
            assert_eq!(row["pull_policy"], "never");
            assert_eq!(row["restart"], "no");
            assert_eq!(row["mem_limit"], format!("{memory}m"));
            assert_eq!(row["memswap_limit"], row["mem_limit"]);
            assert_eq!(row["pids_limit"], pids);
            assert_eq!(row["deploy"]["restart_policy"]["condition"], "none");
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
