//! Replays fixed Cancun transactions without RPC, state import, tracing or JIT in the timed loop.
use alloy_consensus::{TxEip1559, transaction::Recovered};
use alloy_primitives::{Address, Bytes, TxKind, U256, hex};
use evm2::{
    BaseEvmTypes, Evm, ExecutionConfig, Precompiles, SpecId, Version,
    bytecode::Bytecode,
    env::BlockEnv,
    ethereum::{RecoveredTxEnvelope, TxEnvelope, ethereum_tx_registry},
    evm::{AccountInfo, InMemoryDB},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    error::Error,
    fs,
    hint::black_box,
    io,
    path::{Path, PathBuf},
    time::Instant,
};

mod counters;
type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    scenario: String,
    label: String,
    prestate: BTreeMap<String, Value>,
    block: Value,
    transaction: Value,
    expected_gas: u64,
    expected_output: String,
}

#[derive(Deserialize)]
struct Manifest {
    fixtures: Vec<String>,
}

struct Prepared {
    name: String,
    evm: Evm<'static, BaseEvmTypes>,
    tx: RecoveredTxEnvelope,
    expected_gas: u64,
}

#[derive(Serialize)]
struct Sample {
    wall_ns_per_tx: f64,
    thread_cpu_ns_per_tx: f64,
    cycles_per_tx: Option<f64>,
    instructions_per_tx: Option<f64>,
    counter_running_ratio: Option<f64>,
}

#[derive(Serialize)]
struct Measurement {
    name: String,
    gas_per_tx: u64,
    samples: Vec<Sample>,
}

fn word(value: &Value) -> Result<U256> {
    match value {
        Value::String(s) => Ok(if let Some(hex) = s.strip_prefix("0x") {
            U256::from_str_radix(hex, 16)?
        } else {
            s.parse()?
        }),
        Value::Number(n) => Ok(U256::from(n.as_u64().ok_or("Expected unsigned integer")?)),
        Value::Null => Ok(U256::ZERO),
        _ => Err("Expected number or hex string".into()),
    }
}

fn integer(value: &Value) -> Result<u64> {
    Ok(word(value)?.try_into()?)
}
fn bytes(value: &str) -> Result<Bytes> {
    Ok(hex::decode(value.strip_prefix("0x").unwrap_or(value))?.into())
}
fn string(value: &Value) -> Result<&str> {
    value.as_str().ok_or_else(|| "Expected string".into())
}

fn prepare(path: &Path) -> Result<Prepared> {
    let fixture: Fixture = serde_json::from_slice(&fs::read(path)?)?;
    let mut db = InMemoryDB::default();
    for (address, data) in &fixture.prestate {
        let address: Address = address.parse()?;
        let code = data.get("code").and_then(Value::as_str).unwrap_or("0x");
        let info = AccountInfo::default()
            .with_code(Bytecode::new_legacy(bytes(code)?))
            .with_nonce(integer(&data["nonce"])?)
            .with_balance(word(&data["balance"])?);
        db.insert_account_info(&address, info);
        if let Some(storage) = data.get("storage").and_then(Value::as_object) {
            for (key, value) in storage {
                db.insert_account_storage(
                    &address,
                    &word(&Value::String(key.clone()))?,
                    &word(value)?,
                );
            }
        }
    }
    let block = &fixture.block;
    let env = BlockEnv::<BaseEvmTypes> {
        number: word(&block["number"])?,
        beneficiary: string(&block["miner"])?.parse()?,
        timestamp: word(&block["timestamp"])?,
        gas_limit: word(&block["gasLimit"])?,
        basefee: word(&block["baseFeePerGas"])?,
        prevrandao: word(&block["mixHash"])?,
        ..Default::default()
    };
    let t = &fixture.transaction;
    if integer(&t["type"])? != 2 || !t["accessList"].as_array().is_some_and(Vec::is_empty) {
        return Err("Fixture must be EIP-1559 without an access list".into());
    }
    let tx = Recovered::new_unchecked(
        TxEnvelope::Eip1559(TxEip1559 {
            chain_id: integer(&t["chainId"])?,
            nonce: integer(&t["nonce"])?,
            gas_limit: integer(&t["gas"])?,
            max_fee_per_gas: word(&t["maxFeePerGas"])?.try_into()?,
            max_priority_fee_per_gas: word(&t["maxPriorityFeePerGas"])?.try_into()?,
            to: TxKind::Call(string(&t["to"])?.parse()?),
            value: word(&t["value"])?,
            input: bytes(string(&t["input"])?)?,
            access_list: Default::default(),
        }),
        string(&t["from"])?.parse()?,
    );
    let mut version = Version::new(SpecId::CANCUN);
    version.chain_id = integer(&t["chainId"])?;
    let config = ExecutionConfig::<BaseEvmTypes>::for_spec_and_version(SpecId::CANCUN, version);
    let mut evm = Evm::new_with_execution_config(
        config,
        SpecId::CANCUN,
        env,
        ethereum_tx_registry(SpecId::CANCUN),
        db,
        Precompiles::base(SpecId::CANCUN),
    );
    let expected_output = bytes(&fixture.expected_output)?;
    // Discard clears transaction scratch without committing writes. Each replay
    // must therefore see the same nonce, balances and storage as the original.
    for _ in 0..100 {
        let result = evm
            .transact(&tx)
            .map_err(|e| format!("Replay rejected: {e:?}"))?
            .discard();
        if !result.status
            || result.tx_gas_used() != fixture.expected_gas
            || result.output != expected_output
        {
            return Err(format!(
                "Replay mismatch {} {}: status={} gas={} expected={} stop={:?}",
                fixture.scenario,
                fixture.label,
                result.status,
                result.tx_gas_used(),
                fixture.expected_gas,
                result.stop
            )
            .into());
        }
    }
    Ok(Prepared {
        name: format!("{}:{}", fixture.scenario, fixture.label),
        evm,
        tx,
        expected_gas: fixture.expected_gas,
    })
}

fn thread_cpu_ns() -> io::Result<u64> {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: ts points to valid writable storage for clock_gettime.
    if unsafe { libc::clock_gettime(libc::CLOCK_THREAD_CPUTIME_ID, &mut ts) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(
        u64::try_from(ts.tv_sec).map_err(io::Error::other)? * 1_000_000_000
            + u64::try_from(ts.tv_nsec).map_err(io::Error::other)?,
    )
}

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let manifest_path = PathBuf::from(
        args.next()
            .ok_or("Usage: bench MANIFEST OUTPUT [ROUNDS] [ITERATIONS]")?,
    );
    let output = args.next().ok_or("Missing OUTPUT")?;
    let rounds: usize = args.next().unwrap_or_else(|| "11".into()).parse()?;
    let iterations: u64 = args.next().unwrap_or_else(|| "2000".into()).parse()?;
    if args.next().is_some() || rounds == 0 || iterations == 0 {
        return Err("Invalid benchmark arguments".into());
    }
    let manifest: Manifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    let base = manifest_path
        .parent()
        .ok_or("Manifest needs a parent directory")?;
    let mut prepared = manifest
        .fixtures
        .iter()
        .map(|f| prepare(&base.join(f)))
        .collect::<Result<Vec<_>>>()?;
    if prepared.is_empty() {
        return Err("No fixtures".into());
    }
    let affinity = counters::pin_thread();
    let (mut counters, counter_error) = match counters::Counters::open() {
        Ok(c) => (Some(c), None),
        Err(e) => {
            eprintln!("Hardware PMU unavailable: {e}");
            (None, Some(e.to_string()))
        }
    };
    let mut measurements = prepared
        .iter()
        .map(|p| Measurement {
            name: p.name.clone(),
            gas_per_tx: p.expected_gas,
            samples: Vec::new(),
        })
        .collect::<Vec<_>>();
    for round in 0..rounds {
        let order: Vec<usize> = if round % 2 == 0 {
            (0..prepared.len()).collect()
        } else {
            (0..prepared.len()).rev().collect()
        };
        for index in order {
            let case = &mut prepared[index];
            if let Some(c) = &mut counters {
                c.start()?;
            }
            let cpu_start = thread_cpu_ns()?;
            let start = Instant::now();
            let mut gas_sum = 0u64;
            for _ in 0..iterations {
                let result = case
                    .evm
                    .transact(black_box(&case.tx))
                    .map_err(|e| format!("Replay rejected: {e:?}"))?
                    .discard();
                gas_sum = gas_sum
                    .checked_add(black_box(result.tx_gas_used()))
                    .ok_or("gas sum overflow")?;
            }
            let elapsed = start.elapsed().as_nanos();
            let cpu_ns = thread_cpu_ns()? - cpu_start;
            let counts = counters
                .as_mut()
                .map(counters::Counters::stop)
                .transpose()?;
            if gas_sum
                != case
                    .expected_gas
                    .checked_mul(iterations)
                    .ok_or("gas sum overflow")?
            {
                return Err("Replay gas changed during timing".into());
            }
            let n = iterations as f64;
            measurements[index].samples.push(Sample {
                wall_ns_per_tx: elapsed as f64 / n,
                thread_cpu_ns_per_tx: cpu_ns as f64 / n,
                cycles_per_tx: counts.as_ref().map(|c| c.cycles / n),
                instructions_per_tx: counts.as_ref().map(|c| c.instructions / n),
                counter_running_ratio: counts.map(|c| c.running_ratio),
            });
        }
        eprintln!("round {}/{}", round + 1, rounds);
    }
    fs::write(
        output,
        serde_json::to_vec_pretty(&serde_json::json!({
            "engine": "evm2 interpreter 9b037449c846515624ff6afde739f2b764851446",
            "method": "Fixed prestate; EIP-1559 Cancun transact/discard; 100 correctness/warm-up replays per fixture. Timed loop includes transaction validation, interpretation, precompiles and journal cleanup. Excludes JSON/RPC, state import, persistent commit, block production, JIT, transaction signature recovery and consensus. Alternating forward/reverse fixture order.",
            "rounds": rounds, "iterations": iterations, "affinity": affinity,
            "counter_error": counter_error, "measurements": measurements,
        }))?,
    )?;
    Ok(())
}
