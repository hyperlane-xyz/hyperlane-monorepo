//! Explicit protocol VM/proving primitives. No HTTP, Hyperlane agent, Tokio,
//! credential lookup, environment writes, transaction policy or logging.
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use serde::Deserialize;
use snarkvm::{
    circuit::{Aleo, AleoCanaryV0, AleoTestnetV0, AleoV0},
    ledger::store::{helpers::memory::ConsensusMemory, ConsensusStore},
    prelude::{
        execution_cost_for_authorization, minimum_cost_in_microcredits_v3, Authorization, CanaryV0,
        FromBytes, Identifier, MainnetV0, Network, PrivateKey, Program, ProgramID, TestnetV0,
        ToBytes, Value, VM,
    },
};
use std::{
    panic::{catch_unwind, AssertUnwindSafe},
    str::FromStr,
};
use zeroize::Zeroizing;

type Machine<N> = VM<N, ConsensusMemory<N>>;
pub enum Engine {
    Main(Machine<MainnetV0>),
    Test(Machine<TestnetV0>),
    Canary(Machine<CanaryV0>),
}
pub struct Prepared<N: Network> {
    authorization: Authorization<N>,
    fee: Option<Authorization<N>>,
    program: ProgramID<N>,
    function: Identifier<N>,
}
pub enum Job {
    Main(Prepared<MainnetV0>),
    Test(Prepared<TestnetV0>),
    Canary(Prepared<CanaryV0>),
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Authorize {
    program_id: String,
    function_name: String,
    inputs: Vec<String>,
    unchecked: bool,
}
fn checked(f: impl FnOnce() -> Result<(), i32>) -> i32 {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Ok(())) => 0,
        Ok(Err(code)) => code,
        Err(_) => -3,
    }
}
unsafe fn text<'a>(input: *const u8, len: usize) -> Result<&'a str, i32> {
    if input.is_null() || len == 0 || len > 16 * 1024 * 1024 {
        return Err(-1);
    }
    std::str::from_utf8(std::slice::from_raw_parts(input, len)).map_err(|_| -2)
}
unsafe fn rng(seed: *const u8) -> Result<ChaCha20Rng, i32> {
    if seed.is_null() {
        return Err(-1);
    }
    let bytes = Zeroizing::new(*(seed as *const [u8; 32]));
    Ok(ChaCha20Rng::from_seed(*bytes))
}
unsafe fn key<N: Network>(input: *const u8) -> Result<Zeroizing<PrivateKey<N>>, i32> {
    if input.is_null() {
        return Err(-1);
    }
    let bytes = Zeroizing::new(*(input as *const [u8; 32]));
    PrivateKey::<N>::from_bytes_le(bytes.as_slice())
        .map(Zeroizing::new)
        .map_err(|_| -2)
}
unsafe fn write(
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
    bytes: &[u8],
) -> Result<(), i32> {
    if out.is_null() || written.is_null() {
        return Err(-1);
    }
    *written = bytes.len();
    if capacity < bytes.len() {
        return Err(-4);
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len());
    Ok(())
}
fn machine<N: Network>() -> Result<Machine<N>, i32> {
    let store = ConsensusStore::open(aleo_std::StorageMode::Production).map_err(|_| -2)?;
    VM::from(store).map_err(|_| -2)
}
fn add<N: Network>(vm: &Machine<N>, program: &str, edition: u16) -> Result<(), i32> {
    let program = Program::<N>::from_str(program).map_err(|_| -2)?;
    vm.process()
        .lock()
        .add_program_with_edition(&program, edition)
        .map_err(|_| -2)
}
unsafe fn authorize<N: Network, A: Aleo<Network = N>>(
    vm: &Machine<N>,
    request: Authorize,
    key_ptr: *const u8,
    seed: *const u8,
) -> Result<Prepared<N>, i32> {
    if request.inputs.len() > 1024 || request.inputs.iter().any(|s| s.len() > 1024 * 1024) {
        return Err(-1);
    }
    let program = ProgramID::from_str(&request.program_id).map_err(|_| -2)?;
    let function = Identifier::from_str(&request.function_name).map_err(|_| -2)?;
    let key = key::<N>(key_ptr)?;
    let mut rng = rng(seed)?;
    let inputs = request
        .inputs
        .into_iter()
        .map(|s| Value::<N>::from_str(&s))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| -2)?;
    let authorization = if request.unchecked {
        vm.process()
            .authorize_unchecked::<A, _>(&key, program, function, inputs.into_iter(), &mut rng)
            .map_err(|_| -2)?
    } else {
        vm.authorize(&key, program, function, inputs, &mut rng)
            .map_err(|_| -2)?
    };
    Ok(Prepared {
        authorization,
        fee: None,
        program,
        function,
    })
}
fn estimate<N: Network>(vm: &Machine<N>, job: &Prepared<N>, height: u32) -> Result<u64, i32> {
    let stack = vm.process().get_stack(job.program).map_err(|_| -2)?;
    let consensus = N::CONSENSUS_VERSION(height).map_err(|_| -2)?;
    let finalize = minimum_cost_in_microcredits_v3(&stack, &job.function).map_err(|_| -2)?;
    let execution = execution_cost_for_authorization(vm.process(), &job.authorization, consensus)
        .map_err(|_| -2)?
        .0;
    finalize.checked_add(execution).ok_or(-2)
}
unsafe fn fee<N: Network, A: Aleo<Network = N>>(
    vm: &Machine<N>,
    job: &mut Prepared<N>,
    key_ptr: *const u8,
    seed: *const u8,
    base: u64,
    priority: u64,
    unchecked: bool,
) -> Result<(), i32> {
    let key = key::<N>(key_ptr)?;
    let mut rng = rng(seed)?;
    let execution = job.authorization.to_execution_id().map_err(|_| -2)?;
    let authorization = if unchecked {
        vm.process()
            .authorize_unchecked::<A, _>(
                &key,
                ProgramID::<N>::from_str("credits.aleo").map_err(|_| -2)?,
                Identifier::<N>::from_str("fee_public").map_err(|_| -2)?,
                [
                    format!("{base}u64"),
                    format!("{priority}u64"),
                    execution.to_string(),
                ]
                .into_iter(),
                &mut rng,
            )
            .map_err(|_| -2)?
    } else {
        vm.authorize_fee_public(&key, base, priority, execution, &mut rng)
            .map_err(|_| -2)?
    };
    job.fee = Some(authorization);
    Ok(())
}
fn info<N: Network>(job: &Prepared<N>) -> Result<Vec<u8>, i32> {
    let transitions=job.authorization.transitions().values().map(|t|serde_json::json!({"program_id":t.program_id().to_string(),"function_name":t.function_name().to_string()})).collect::<Vec<_>>();
    let root = job.authorization.peek_next().map_err(|_| -2)?;
    let fee_amounts = if let Some(fee) = &job.fee {
        if !fee.is_fee_public() {
            return Err(-5);
        }
        let request = fee.peek_next().map_err(|_| -2)?;
        let base = request.inputs().first().ok_or(-2)?.to_string();
        let priority = request.inputs().get(1).ok_or(-2)?.to_string();
        let base = base
            .strip_suffix("u64")
            .ok_or(-2)?
            .parse::<u64>()
            .map_err(|_| -2)?;
        let priority = priority
            .strip_suffix("u64")
            .ok_or(-2)?
            .parse::<u64>()
            .map_err(|_| -2)?;
        Some((base, priority))
    } else {
        None
    };

    let outputs = job
        .authorization
        .transitions()
        .values()
        .flat_map(|t| t.commitments().map(ToString::to_string))
        .collect::<std::collections::BTreeSet<_>>();
    let mut commitments = std::collections::BTreeSet::new();
    for i in 0..job.authorization.len() {
        let request = job.authorization.get(i).map_err(|_| -2)?;
        for input in request.input_ids() {
            if let snarkvm::prelude::InputID::Record(commitment, ..) = input {
                let value = commitment.to_string();
                if !outputs.contains(&value) {
                    commitments.insert(value);
                }
            }
        }
    }
    serde_json::to_vec(&serde_json::json!({"authorization":job.authorization,"fee_authorization":job.fee,"base_fee":fee_amounts.map(|v|v.0),"priority_fee":fee_amounts.map(|v|v.1),"execution_id":job.authorization.to_execution_id().map_err(|_|-2)?.to_string(),"transitions":transitions,"record_commitments":commitments,"program_id":job.program.to_string(),"function_name":job.function.to_string(),"root_inputs":root.inputs().iter().map(ToString::to_string).collect::<Vec<_>>(),"signer":root.signer().to_string()})).map_err(|_|-2)
}
fn proving_request<N: Network>(job: &Prepared<N>) -> Result<Vec<u8>, i32> {
    let mut out = job.authorization.to_bytes_le().map_err(|_| -2)?;
    let fee = job.fee.as_ref().ok_or(-2)?;
    true.write_le(&mut out).map_err(|_| -2)?;
    fee.write_le(&mut out).map_err(|_| -2)?;
    false.write_le(&mut out).map_err(|_| -2)?;
    Ok(out)
}

#[no_mangle]
pub extern "C" fn ziggy_aleo_vm_abi_version() -> u32 {
    1
}
/// # Safety
/// `out` is a live pointer; ownership of the returned handle belongs to the caller.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_create(network: u16, out: *mut *mut Engine) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let engine = match network {
            0 => Engine::Main(machine()?),
            1 => Engine::Test(machine()?),
            2 => Engine::Canary(machine()?),
            _ => return Err(-1),
        };
        *out = Box::into_raw(Box::new(engine));
        Ok(())
    })
}
/// # Safety
/// Handle must have come from create and must not be reused or concurrently borrowed.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_destroy(engine: *mut Engine) {
    if !engine.is_null() {
        drop(Box::from_raw(engine));
    }
}
/// # Safety
/// Handles and text buffers must be live and exclusively borrowed for this call.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_add_program(
    engine: *mut Engine,
    input: *const u8,
    len: usize,
    edition: u16,
) -> i32 {
    checked(|| {
        let engine = engine.as_ref().ok_or(-1)?;
        let program = text(input, len)?;
        match engine {
            Engine::Main(vm) => add(vm, program, edition),
            Engine::Test(vm) => add(vm, program, edition),
            Engine::Canary(vm) => add(vm, program, edition),
        }
    })
}
/// # Safety
/// Handle/key/seed/JSON buffers must be live and not alias output. No concurrent jobs.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_authorize(
    engine: *mut Engine,
    key: *const u8,
    seed: *const u8,
    input: *const u8,
    len: usize,
    out: *mut *mut Job,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let request = serde_json::from_str(text(input, len)?).map_err(|_| -2)?;
        let engine = engine.as_ref().ok_or(-1)?;
        let job = match engine {
            Engine::Main(vm) => Job::Main(authorize::<MainnetV0, AleoV0>(vm, request, key, seed)?),
            Engine::Test(vm) => Job::Test(authorize::<TestnetV0, AleoTestnetV0>(
                vm, request, key, seed,
            )?),
            Engine::Canary(vm) => {
                Job::Canary(authorize::<CanaryV0, AleoCanaryV0>(vm, request, key, seed)?)
            }
        };
        *out = Box::into_raw(Box::new(job));
        Ok(())
    })
}
/// # Safety
/// Job must come from authorize and must not be reused after destroy.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_job_destroy(job: *mut Job) {
    if !job.is_null() {
        drop(Box::from_raw(job));
    }
}
/// # Safety
/// Valid matching network handles and a live output pointer are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_estimate(
    engine: *mut Engine,
    job: *const Job,
    height: u32,
    out: *mut u64,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let engine = engine.as_ref().ok_or(-1)?;
        let job = job.as_ref().ok_or(-1)?;
        *out = match (engine, job) {
            (Engine::Main(vm), Job::Main(j)) => estimate(vm, j, height)?,
            (Engine::Test(vm), Job::Test(j)) => estimate(vm, j, height)?,
            (Engine::Canary(vm), Job::Canary(j)) => estimate(vm, j, height)?,
            _ => return Err(-1),
        };
        Ok(())
    })
}
/// # Safety
/// Valid matching handles/key/seed, exclusive job borrow and scalar fields are required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_authorize_fee(
    engine: *mut Engine,
    job: *mut Job,
    key: *const u8,
    seed: *const u8,
    base: u64,
    priority: u64,
    unchecked: u8,
) -> i32 {
    checked(|| {
        if unchecked > 1 || base.checked_add(priority).is_none() {
            return Err(-1);
        }
        let engine = engine.as_ref().ok_or(-1)?;
        let job = job.as_mut().ok_or(-1)?;
        match (engine, job) {
            (Engine::Main(vm), Job::Main(j)) => {
                fee::<MainnetV0, AleoV0>(vm, j, key, seed, base, priority, unchecked != 0)
            }
            (Engine::Test(vm), Job::Test(j)) => {
                fee::<TestnetV0, AleoTestnetV0>(vm, j, key, seed, base, priority, unchecked != 0)
            }
            (Engine::Canary(vm), Job::Canary(j)) => {
                fee::<CanaryV0, AleoCanaryV0>(vm, j, key, seed, base, priority, unchecked != 0)
            }
            _ => Err(-1),
        }
    })
}
/// # Safety
/// Job and bounded output buffers must be valid; mode0 is JSON info, mode1 binary prover wire.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_job_export(
    job: *const Job,
    mode: u8,
    out: *mut u8,
    capacity: usize,
    written: *mut usize,
) -> i32 {
    checked(|| {
        let job = job.as_ref().ok_or(-1)?;
        let bytes = Zeroizing::new(match (job, mode) {
            (Job::Main(j), 0) => info(j)?,
            (Job::Test(j), 0) => info(j)?,
            (Job::Canary(j), 0) => info(j)?,
            (Job::Main(j), 1) => proving_request(j)?,
            (Job::Test(j), 1) => proving_request(j)?,
            (Job::Canary(j), 1) => proving_request(j)?,
            _ => return Err(-1),
        });
        write(out, capacity, written, &bytes)
    })
}

#[repr(C)]
pub struct Buffer {
    pub data: *mut u8,
    pub len: usize,
}
unsafe fn owned(out: *mut Buffer, bytes: Vec<u8>) -> Result<(), i32> {
    if out.is_null() || bytes.len() > 64 * 1024 * 1024 {
        return Err(-1);
    }
    let boxed = bytes.into_boxed_slice();
    let len = boxed.len();
    let data = Box::into_raw(boxed) as *mut u8;
    *out = Buffer { data, len };
    Ok(())
}
/// # Safety
/// Buffer must come from this library and may be destroyed exactly once.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_buffer_destroy(buffer: Buffer) {
    if !buffer.data.is_null() {
        let mut boxed = Box::from_raw(std::ptr::slice_from_raw_parts_mut(buffer.data, buffer.len));
        use zeroize::Zeroize;
        boxed.zeroize();
        drop(boxed);
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Query {
    height: u32,
    state_root: String,
    #[serde(default)]
    state_paths: std::collections::BTreeMap<String, serde_json::Value>,
}
unsafe fn prove<N: Network>(
    vm: &Machine<N>,
    job: &Prepared<N>,
    query: Query,
    seed: *const u8,
) -> Result<Vec<u8>, i32> {
    use snarkvm::{
        ledger::query::StaticQuery,
        prelude::{Field, StatePath},
    };
    if query.state_paths.len() > 4096 {
        return Err(-1);
    }
    let root = N::StateRoot::from_str(&query.state_root).map_err(|_| -2)?;
    let mut paths = std::collections::HashMap::new();
    for (key, value) in query.state_paths {
        let commitment = Field::<N>::from_str(&key).map_err(|_| -2)?;
        let path: StatePath<N> = serde_json::from_value(value).map_err(|_| -2)?;
        if paths.insert(commitment, path).is_some() {
            return Err(-2);
        }
    }
    let query = StaticQuery::new(query.height, root, paths);
    let mut rng = rng(seed)?;
    let transaction = vm
        .execute_authorization(
            job.authorization.clone(),
            Some(job.fee.clone().ok_or(-2)?),
            Some(&query),
            &mut rng,
        )
        .map_err(|_| -2)?;
    serde_json::to_vec(&transaction).map_err(|_| -2)
}
fn validate<N: Network>(job: &Prepared<N>, bytes: &str) -> Result<Vec<u8>, i32> {
    let tx: snarkvm::prelude::Transaction<N> = serde_json::from_str(bytes).map_err(|_| -2)?;
    let expected = job.authorization.to_execution_id().map_err(|_| -2)?;
    let execution = tx.execution().ok_or(-2)?;
    if execution.to_execution_id().map_err(|_| -2)? != expected {
        return Err(-5);
    }
    let fee = tx.fee_transition().ok_or(-2)?;
    let authorized = job.fee.as_ref().ok_or(-2)?;
    let authorized = authorized.transitions();
    if authorized.len() != 1
        || authorized.values().next().ok_or(-2)?.id() != fee.transition_id()
        || fee.deployment_or_execution_id().map_err(|_| -2)? != expected
    {
        return Err(-5);
    }
    serde_json::to_vec(&serde_json::json!({"id":tx.id().to_string(),"execution_id":expected.to_string(),"base_fee":*tx.base_fee_amount().map_err(|_|-2)?,"priority_fee":*tx.priority_fee_amount().map_err(|_|-2)?})).map_err(|_|-2)
}
/// Local proof generation using explicit state query data; never performs network I/O.
/// # Safety
/// Live matching network handles/seed/query are required, output owns returned buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_vm_prove(
    engine: *mut Engine,
    job: *const Job,
    seed: *const u8,
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let engine = engine.as_ref().ok_or(-1)?;
        let job = job.as_ref().ok_or(-1)?;
        let query = serde_json::from_str(text(input, len)?).map_err(|_| -2)?;
        let bytes = match (engine, job) {
            (Engine::Main(vm), Job::Main(j)) => prove(vm, j, query, seed)?,
            (Engine::Test(vm), Job::Test(j)) => prove(vm, j, query, seed)?,
            (Engine::Canary(vm), Job::Canary(j)) => prove(vm, j, query, seed)?,
            _ => return Err(-1),
        };
        owned(out, bytes)
    })
}
/// Bind a returned transaction to this job's exact authorized execution and fee.
/// This is identity/structure validation; chain admission still verifies the proof.
/// # Safety
/// Live job/text/output buffers required; output owns the returned metadata buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_job_validate_transaction(
    job: *const Job,
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let job = job.as_ref().ok_or(-1)?;
        let bytes = text(input, len)?;
        owned(
            out,
            match job {
                Job::Main(j) => validate(j, bytes)?,
                Job::Test(j) => validate(j, bytes)?,
                Job::Canary(j) => validate(j, bytes)?,
            },
        )
    })
}
/// Parse a program into its actual ID and ordered imports for host-side loading.
/// # Safety
/// Live program/output buffers required; output owns the returned metadata buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_program_info(
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let program = Program::<MainnetV0>::from_str(text(input, len)?).map_err(|_| -2)?;
        let imports = program
            .imports()
            .keys()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        owned(
            out,
            serde_json::to_vec(
                &serde_json::json!({"program_id":program.id().to_string(),"imports":imports}),
            )
            .map_err(|_| -2)?,
        )
    })
}

/// Derive an account address from the exact source compressed private-key seed.
/// # Safety
/// Key must reference32 live bytes; output must hold32 nonoverlapping bytes.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_private_key_address(key_ptr: *const u8, out: *mut u8) -> i32 {
    checked(|| {
        use snarkvm::prelude::{Address, ComputeKey};
        if out.is_null() {
            return Err(-1);
        }
        let private = key::<MainnetV0>(key_ptr)?;
        let compute = ComputeKey::try_from(&*private).map_err(|_| -2)?;
        let address = Address::try_from(&compute).map_err(|_| -2)?;
        let bytes = address.to_bytes_le().map_err(|_| -2)?;
        if bytes.len() != 32 {
            return Err(-2);
        }
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out, 32);
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn checked_authorization_fee_and_exact_prover_wire_are_explicit() {
        let vm = machine::<MainnetV0>().expect("fixture VM");
        let key = [0x11u8; 32];
        let seed = [7u8; 32];
        let recipient = ProgramID::<MainnetV0>::from_str("credits.aleo")
            .expect("program")
            .to_address()
            .expect("address");
        let request = Authorize {
            program_id: "credits.aleo".into(),
            function_name: "transfer_public".into(),
            inputs: vec![recipient.to_string(), "1u64".into()],
            unchecked: false,
        };
        let mut job =
            unsafe { authorize::<MainnetV0, AleoV0>(&vm, request, key.as_ptr(), seed.as_ptr()) }
                .expect("authorization");
        let metadata = info(&job).expect("metadata");
        let metadata: serde_json::Value = serde_json::from_slice(&metadata).expect("json");
        assert_eq!(metadata["transitions"][0]["program_id"], "credits.aleo");
        unsafe {
            fee::<MainnetV0, AleoV0>(&vm, &mut job, key.as_ptr(), seed.as_ptr(), 1000, 1, false)
        }
        .expect("fee");
        let actual = proving_request(&job).expect("prover wire");
        let mut expected = job
            .authorization
            .to_bytes_le()
            .expect("authorization bytes");
        true.write_le(&mut expected).expect("flag");
        job.fee
            .as_ref()
            .expect("fee")
            .write_le(&mut expected)
            .expect("fee bytes");
        false.write_le(&mut expected).expect("broadcast false");
        assert_eq!(expected, actual);
        assert_eq!(validate(&job, "{}"), Err(-2));
    }
}

fn block_info<N: Network>(wire: &str) -> Result<Vec<u8>, i32> {
    use snarkvm::{ledger::Block, synthesizer::program::FinalizeOperation};
    let block = Block::<N>::from_str(wire).map_err(|_| -2)?;
    let mut transactions = Vec::new();
    for transaction in block.transactions().iter() {
        let transitions=transaction.transitions().map(|transition|serde_json::json!({"program_id":transition.program_id().to_string(),"function_name":transition.function_name().to_string()})).collect::<Vec<_>>();
        let mut keys = Vec::new();
        for operation in transaction.finalize_operations() {
            match operation {
                FinalizeOperation::InsertKeyValue(_, key, _)
                | FinalizeOperation::UpdateKeyValue(_, key, _) => {
                    keys.push(key.to_bytes_le().map_err(|_| -2)?)
                }
                _ => {}
            }
        }
        transactions.push(serde_json::json!({"id":transaction.id().to_string(),"index":transaction.index(),"accepted":transaction.is_accepted(),"transitions":transitions,"finalize_keys":keys}));
    }
    serde_json::to_vec(&serde_json::json!({"hash":block.hash().to_string(),"parent":block.previous_hash().to_string(),"height":block.height(),"timestamp":block.timestamp(),"transactions":transactions})).map_err(|_|-2)
}
/// Decode actual consensus-checked network Block into protocol transaction metadata.
/// # Safety
/// Live input/output buffers required; output owns returned bounded metadata buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_block_info(
    network: u16,
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let wire = text(input, len)?;
        owned(
            out,
            match network {
                0 => block_info::<MainnetV0>(wire)?,
                1 => block_info::<TestnetV0>(wire)?,
                2 => block_info::<CanaryV0>(wire)?,
                _ => return Err(-1),
            },
        )
    })
}

fn transaction_info<N: Network>(wire: &str) -> Result<Vec<u8>, i32> {
    let tx = snarkvm::prelude::Transaction::<N>::from_str(wire).map_err(|_| -2)?;
    let amount = tx.fee_amount().map(|x| *x).unwrap_or(0);
    let sender = tx
        .fee_transition()
        .and_then(|fee| fee.payer())
        .map(|address| address.to_bytes_le())
        .transpose()
        .map_err(|_| -2)?
        .unwrap_or_else(|| vec![0u8; 32]);
    let recipient = tx
        .transitions()
        .next()
        .map(|transition| transition.program_id().to_address())
        .transpose()
        .map_err(|_| -2)?
        .map(|address| address.to_bytes_le())
        .transpose()
        .map_err(|_| -2)?;
    serde_json::to_vec(&serde_json::json!({"id":tx.id().to_string(),"fee":amount,"sender":sender,"recipient":recipient})).map_err(|_|-2)
}
/// Parse a source SDK transaction into its protocol provider metadata.
/// # Safety
/// Valid input/output buffers required; caller owns returned metadata buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_transaction_info(
    network: u16,
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let wire = text(input, len)?;
        owned(
            out,
            match network {
                0 => transaction_info::<MainnetV0>(wire)?,
                1 => transaction_info::<TestnetV0>(wire)?,
                2 => transaction_info::<CanaryV0>(wire)?,
                _ => return Err(-1),
            },
        )
    })
}

fn confirmed_info<N: Network>(wire: &str) -> Result<Vec<u8>, i32> {
    let tx = snarkvm::prelude::ConfirmedTransaction::<N>::from_str(wire).map_err(|_| -2)?;
    let fee = tx.fee_amount().map_err(|_| -2)?;
    serde_json::to_vec(&serde_json::json!({"id":tx.to_unconfirmed_transaction_id().map_err(|_|-2)?.to_string(),"chain_id":tx.transaction().id().to_string(),"accepted":tx.is_accepted(),"index":tx.index(),"fee_amount":*fee})).map_err(|_|-2)
}
/// Decode inclusion identity, including rejected transactions whose fee ID differs.
/// # Safety
/// Valid input/output buffers required; caller owns returned metadata buffer.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_confirmed_info(
    network: u16,
    input: *const u8,
    len: usize,
    out: *mut Buffer,
) -> i32 {
    checked(|| {
        let wire = text(input, len)?;
        owned(
            out,
            match network {
                0 => confirmed_info::<MainnetV0>(wire)?,
                1 => confirmed_info::<TestnetV0>(wire)?,
                2 => confirmed_info::<CanaryV0>(wire)?,
                _ => return Err(-1),
            },
        )
    })
}

#[derive(Deserialize)]
#[serde(bound = "")]
struct Restored<N: Network> {
    authorization: Authorization<N>,
    fee_authorization: Option<Authorization<N>>,
    program_id: String,
    function_name: String,
}
fn restore<N: Network>(wire: &str) -> Result<Prepared<N>, i32> {
    let data: Restored<N> = serde_json::from_str(wire).map_err(|_| -2)?;
    let program = ProgramID::from_str(&data.program_id).map_err(|_| -2)?;
    let function = Identifier::from_str(&data.function_name).map_err(|_| -2)?;
    let root = data.authorization.peek_next().map_err(|_| -2)?;
    if root.program_id() != &program || root.function_name() != &function {
        return Err(-5);
    }
    if let Some(fee) = &data.fee_authorization {
        if !fee.is_fee_public() || fee.peek_next().map_err(|_| -2)?.signer() != root.signer() {
            return Err(-5);
        }
    }
    Ok(Prepared {
        authorization: data.authorization,
        fee: data.fee_authorization,
        program,
        function,
    })
}
/// Restore exact SDK authorizations; host must bind returned root fields to intent.
/// # Safety
/// Valid matching network handle, input buffer and output job pointer required.
#[no_mangle]
pub unsafe extern "C" fn ziggy_aleo_job_restore(
    engine: *mut Engine,
    input: *const u8,
    len: usize,
    out: *mut *mut Job,
) -> i32 {
    checked(|| {
        if out.is_null() {
            return Err(-1);
        }
        let wire = text(input, len)?;
        let job = match engine.as_ref().ok_or(-1)? {
            Engine::Main(_) => Job::Main(restore(wire)?),
            Engine::Test(_) => Job::Test(restore(wire)?),
            Engine::Canary(_) => Job::Canary(restore(wire)?),
        };
        *out = Box::into_raw(Box::new(job));
        Ok(())
    })
}
