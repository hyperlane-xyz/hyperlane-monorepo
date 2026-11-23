//! Runs the actual packed prover and builder against the actual core Merkle
//! implementations without linking RocksDB, chain SDKs, or the relayer binary.

extern crate self as hyperlane_base;

// The builder's error enum names DbError, but the in-memory builder does no
// database I/O. This stand-in is never constructed or used by the benchmark.
pub mod db {
    #[derive(Debug, thiserror::Error)]
    #[error("database I/O is outside the isolated replay benchmark")]
    pub struct DbError;
}

#[allow(dead_code)]
pub mod prover {
    include!(concat!(env!("OUT_DIR"), "/prover.rs"));
}

#[path = "../../../../rust/main/agents/relayer/src/merkle_tree/builder.rs"]
pub mod builder;

#[allow(dead_code)]
pub mod baseline_prover {
    include!(concat!(env!("OUT_DIR"), "/baseline_prover.rs"));
}

#[allow(dead_code)]
pub mod baseline_builder {
    include!(concat!(env!("OUT_DIR"), "/baseline_builder.rs"));
}

#[cfg(test)]
mod benchmarks {
    use std::{hint::black_box, time::Duration, time::Instant};

    use hyperlane_core::{accumulator::merkle::Proof, H256};

    use super::{baseline_builder, builder};

    struct Replay {
        elapsed: Duration,
        count: u32,
        proofs: Vec<Proof>,
    }

    fn replay(leaves: &[H256], batched: bool) -> Replay {
        let queries: Vec<_> = (0..100)
            .map(|index| {
                let root = index * 2654435761_usize % leaves.len();
                let leaf = index * 2246822519_usize % (root + 1);
                (leaf as u32, root as u32)
            })
            .collect();
        if batched {
            let mut tree = builder::MerkleTreeBuilder::new();
            let begin = Instant::now();
            for batch in leaves.chunks(32) {
                tree.ingest_message_ids(black_box(batch)).unwrap();
            }
            let elapsed = begin.elapsed();
            Replay {
                elapsed,
                count: tree.count(),
                proofs: queries
                    .iter()
                    .map(|(leaf, root)| tree.get_proof(*leaf, *root).unwrap())
                    .collect(),
            }
        } else {
            let mut tree = baseline_builder::MerkleTreeBuilder::new();
            let begin = Instant::now();
            for leaf in leaves {
                tree.ingest_message_id(black_box(*leaf)).unwrap();
            }
            let elapsed = begin.elapsed();
            Replay {
                elapsed,
                count: tree.count(),
                proofs: queries
                    .iter()
                    .map(|(leaf, root)| tree.get_proof(*leaf, *root).unwrap())
                    .collect(),
            }
        }
    }

    /// Time the actual original source against the actual candidate source.
    #[test]
    #[ignore = "manual before/after Merkle replay CPU benchmark"]
    fn original_vs_batched_replay() {
        let count: usize = std::env::var("MERKLE_BENCH_LEAVES")
            .unwrap_or_else(|_| "100000".into())
            .parse()
            .unwrap();
        assert!(count > 0 && count < u32::MAX as usize);
        let leaves: Vec<_> = (0..count)
            .map(|index| H256::from_low_u64_be(index as u64))
            .collect();
        let mut original_times = Vec::new();
        let mut batch_times = Vec::new();
        let mut expected_proofs = None;
        for round in 0..6 {
            for batched in if round % 2 == 0 {
                [false, true]
            } else {
                [true, false]
            } {
                let result = replay(&leaves, batched);
                assert_eq!(result.count as usize, count);
                if let Some(expected) = &expected_proofs {
                    assert_eq!(&result.proofs, expected);
                } else {
                    expected_proofs = Some(result.proofs);
                }
                if round > 0 {
                    let elapsed = result.elapsed.as_micros();
                    if batched {
                        batch_times.push(elapsed);
                    } else {
                        original_times.push(elapsed);
                    }
                }
            }
        }
        original_times.sort_unstable();
        batch_times.sort_unstable();
        println!(
            "base=e8689117d9 leaves={count} original_us={} batch32_us={} speedup={:.3} original_samples={original_times:?} batch32_samples={batch_times:?}",
            original_times[2], batch_times[2], original_times[2] as f64 / batch_times[2] as f64
        );
    }
}
