//! Includes actual production PackedMerkle, unchanged.
#[path = "../../../rust/main/agents/relayer/src/prover/packed.rs"]
mod packed;
use hyperlane_core::{accumulator::incremental::IncrementalMerkle, H256};
use std::{
    hint::black_box,
    io::{self, BufRead},
    time::Instant,
};
fn leaf(index: u64) -> H256 {
    H256::from_low_u64_be(index)
}
fn hex(h: H256) -> String {
    h.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
}
fn build(tree: &mut packed::PackedMerkle, n: usize) {
    for i in tree.count()..n {
        tree.push(leaf(i as u64)).expect("valid count");
    }
}
fn vectors() {
    let mut tree = packed::PackedMerkle::default();
    let mut incremental = IncrementalMerkle::default();
    let mut roots = Vec::new();
    for line in io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let n = v["leaves"].as_u64().unwrap() as usize;
        let index = v["leaf_index"].as_u64().unwrap() as usize;
        let root_index = v["root_index"].as_u64().unwrap() as usize;
        if n < tree.count() {
            tree = Default::default();
            incremental = Default::default();
            roots.clear();
        }
        for i in tree.count()..n {
            incremental.ingest(leaf(i as u64));
            roots.push(incremental.root());
        }
        build(&mut tree, n);
        let p = tree.prove(index, root_index);
        assert_eq!(p.root(), roots[root_index]);
        println!(
            "{}",
            serde_json::json!({"count":tree.count(),"root":hex(tree.root()),"leaf":hex(p.leaf),"index":p.index,"path":p.path.iter().copied().map(hex).collect::<Vec<_>>(),"historical_root":hex(roots[root_index]),"proof_root":hex(p.root())})
        );
    }
}
fn bench(kernel: &str, iterations: u32, leaves: usize) {
    let mut tree = packed::PackedMerkle::default();
    if kernel != "packed_ingest" {
        assert!(leaves > 0);
        build(&mut tree, leaves);
    }
    let mut checksum = 0u64;
    let start = Instant::now();
    if kernel == "packed_ingest" {
        for i in 0..iterations {
            tree.push(black_box(leaf(i as u64))).expect("valid count");
        }
        checksum = u64::from_be_bytes(black_box(tree.root()).as_bytes()[..8].try_into().unwrap());
    } else {
        assert!(kernel == "packed_proof_latest" || kernel == "packed_proof_historical");
        for i in 0..iterations {
            let root_index = if kernel == "packed_proof_latest" {
                leaves - 1
            } else {
                ((i as u64 * 7919) % leaves as u64) as usize
            };
            let index = ((i as u64 * 104729) % (root_index as u64 + 1)) as usize;
            let proof = black_box(tree.prove(black_box(index), black_box(root_index)));
            for p in proof.path {
                checksum = checksum
                    .wrapping_add(u64::from_be_bytes(p.as_bytes()[..8].try_into().unwrap()));
            }
        }
    }
    let elapsed = start.elapsed().as_nanos();
    println!(
        "{}",
        serde_json::json!({"kernel":kernel,"iterations":iterations,"body_len":leaves,"elapsed_ns":elapsed,"checksum":format!("{checksum:016x}")})
    );
}
fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("vectors") => vectors(),
        Some("bench") => bench(&args[2], args[3].parse().unwrap(), args[4].parse().unwrap()),
        _ => panic!("vectors|bench KERNEL ITERATIONS LEAVES"),
    }
}
