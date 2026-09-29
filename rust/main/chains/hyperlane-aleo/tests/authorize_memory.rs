//! Manual memory workload for Aleo `process` authorization.
//!
//! Replays the public inputs of a confirmed mainnet `process` transition with a
//! throwaway key. Programs and inputs are read from the public explorer API.
//! Run on Linux/glibc to observe allocator retention:
//!
//! ```sh
//! AUTH_MODE=workers cargo test -p hyperlane-aleo --release --test authorize_memory -- --ignored --nocapture
//! AUTH_MODE=dedicated cargo test -p hyperlane-aleo --release --test authorize_memory -- --ignored --nocapture
//! ```
//!
//! `WORKERS` threads model Tokio workers. After each authorization, one worker
//! allocates `INTERLEAVE_KIB` long-lived KiB, modelling other relayer work.
//! `workers` authorizes on that worker, as today; `dedicated` authorizes on one
//! separate long-lived thread.

use std::{
    alloc::{GlobalAlloc, Layout, System},
    str::FromStr,
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Mutex,
    },
};

use aleo_std::StorageMode;
use rand_chacha::{rand_core::SeedableRng, ChaCha20Rng};
use snarkvm::{
    ledger::store::{helpers::memory::ConsensusMemory, ConsensusStore},
    prelude::{Identifier, MainnetV0, PrivateKey, Program, ProgramID, Value, VM},
};

type N = MainnetV0;

struct Counting;
static CURRENT: AtomicUsize = AtomicUsize::new(0);
static PEAK: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = System.alloc(layout);
        if !ptr.is_null() {
            let now = CURRENT.fetch_add(layout.size(), Ordering::Relaxed) + layout.size();
            PEAK.fetch_max(now, Ordering::Relaxed);
        }
        ptr
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        CURRENT.fetch_sub(layout.size(), Ordering::Relaxed);
        System.dealloc(ptr, layout)
    }
}

#[global_allocator]
static ALLOC: Counting = Counting;

const API: &str = "https://api.explorer.provable.com/v2/mainnet";
const TX: &str = "at1l034qvtmqlarj6n0tfhy8esdcx6uw66kmcnr8he7jlldrc2mtszsdna9f6";
const PROGRAM: &str = "hyp_warp_token_sol_v2.aleo";
const MIB: f64 = (1 << 20) as f64;

fn get<T: serde::de::DeserializeOwned>(path: &str) -> T {
    reqwest::blocking::get(format!("{API}/{path}"))
        .and_then(|r| r.error_for_status())
        .and_then(|r| r.json())
        .unwrap_or_else(|e| panic!("GET {path}: {e}"))
}

fn load(vm: &VM<N, ConsensusMemory<N>>, id: &ProgramID<N>) {
    if vm.contains_program(id) {
        return;
    }
    let edition: u16 = get(&format!("program/{id}/latest_edition"));
    let source: String = get(&format!("program/{id}/{edition}"));
    let program = Program::<N>::from_str(&source).unwrap();
    for import in program.imports().keys() {
        load(vm, import);
    }
    vm.process()
        .lock()
        .add_program_with_edition(&program, edition)
        .unwrap();
}

fn process_inputs() -> Vec<String> {
    let tx: serde_json::Value = get(&format!("transaction/{TX}"));
    let transition = tx["execution"]["transitions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["program"] == PROGRAM && t["function"] == "process")
        .expect("process transition");
    transition["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["value"].as_str().unwrap().to_owned())
        .collect()
}

fn status_kib(field: &str) -> usize {
    std::fs::read_to_string("/proc/self/status")
        .ok()
        .and_then(|s| {
            s.lines()
                .find(|l| l.starts_with(field))
                .and_then(|l| l.split_whitespace().nth(1)?.parse().ok())
        })
        .unwrap_or(0)
}

fn env(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

#[test]
#[ignore = "network-dependent manual memory workload"]
fn authorize_process_memory() {
    let dedicated = std::env::var("AUTH_MODE").as_deref() == Ok("dedicated");
    let workers = env("WORKERS", 8);
    let rounds = env("AUTH_ROUNDS", 24);
    let interleave_kib = env("INTERLEAVE_KIB", 512);

    let vm =
        VM::<N, ConsensusMemory<N>>::from(ConsensusStore::open(StorageMode::Production).unwrap())
            .unwrap();
    let program_id = ProgramID::<N>::from_str(PROGRAM).unwrap();
    load(&vm, &program_id);
    let inputs = process_inputs();
    let mut rng = ChaCha20Rng::seed_from_u64(7);
    let key = PrivateKey::<N>::new(&mut rng).unwrap();
    let retained: Mutex<Vec<Box<[u8]>>> = Mutex::default();

    let authorize = |round: usize| {
        let mut rng = ChaCha20Rng::seed_from_u64(round as u64);
        let before = CURRENT.load(Ordering::Relaxed);
        PEAK.store(before, Ordering::Relaxed);
        let ok = vm
            .authorize(
                &key,
                program_id,
                Identifier::<N>::from_str("process").unwrap(),
                inputs.iter().map(|i| Value::<N>::from_str(i).unwrap()),
                &mut rng,
            )
            .is_ok();
        (ok, PEAK.load(Ordering::Relaxed) - before)
    };
    let interleave = || {
        let mut retained = retained.lock().unwrap();
        for _ in 0..interleave_kib / 8 {
            retained.push(vec![1u8; 8 << 10].into_boxed_slice());
        }
    };
    type Job<'a> = Box<dyn FnOnce() -> (bool, usize) + Send + 'a>;

    let base_rss = status_kib("RssAnon:");
    println!(
        "dedicated={dedicated} workers={workers} rounds={rounds} interleave_kib={interleave_kib}"
    );
    std::thread::scope(|scope| {
        let spawn = || {
            let (job_tx, job_rx) = mpsc::channel::<Job>();
            let (done_tx, done_rx) = mpsc::channel();
            scope.spawn(move || {
                for job in job_rx {
                    done_tx.send(job()).unwrap();
                }
            });
            (job_tx, done_rx)
        };
        let pool: Vec<_> = (0..workers).map(|_| spawn()).collect();
        let vm_thread = spawn();
        fn run<'a>(
            thread: &(mpsc::Sender<Job<'a>>, mpsc::Receiver<(bool, usize)>),
            job: Job<'a>,
        ) -> (bool, usize) {
            thread.0.send(job).unwrap();
            thread.1.recv().unwrap()
        }
        for round in 0..rounds {
            let worker = &pool[round % workers];
            let (ok, transient) = if dedicated {
                let result = run(&vm_thread, Box::new(move || authorize(round)));
                run(
                    worker,
                    Box::new(move || {
                        interleave();
                        (true, 0)
                    }),
                );
                result
            } else {
                run(
                    worker,
                    Box::new(move || {
                        let result = authorize(round);
                        interleave();
                        result
                    }),
                )
            };
            println!(
                "round={round:2} ok={ok} transient_peak={:6.1} MiB live={:6.1} MiB rss_anon={:7.1} MiB",
                transient as f64 / MIB,
                CURRENT.load(Ordering::Relaxed) as f64 / MIB,
                status_kib("RssAnon:") as f64 / 1024.0,
            );
        }
    });
    println!(
        "final rss_anon_growth={:.1} MiB of which interleaved live={:.1} MiB",
        (status_kib("RssAnon:") - base_rss) as f64 / 1024.0,
        (rounds * interleave_kib) as f64 / 1024.0,
    );
}
