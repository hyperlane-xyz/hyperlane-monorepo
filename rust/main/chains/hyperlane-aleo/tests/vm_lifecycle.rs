//! Regression tests for the pinned snarkVM sequential worker ownership fix.

use std::sync::{Arc, Barrier};

use aleo_std::StorageMode;
use snarkvm::{
    ledger::store::{helpers::memory::ConsensusMemory, ConsensusStore},
    prelude::{CanaryV0, MainnetV0, Network, ProgramID, TestnetV0, VM},
};

fn new_vm<N: Network>() -> VM<N, ConsensusMemory<N>> {
    VM::from(ConsensusStore::open(StorageMode::Production).unwrap()).unwrap()
}

fn assert_dropped_vm_releases_process<N: Network>() {
    // Repeated provider replacement must not retain one Process per iteration.
    for _ in 0..3 {
        let vm = new_vm::<N>();
        let process = Arc::downgrade(vm.process());
        let clone = vm.clone();
        drop(vm);
        assert!(process.upgrade().is_some());
        assert!(clone.contains_program(&"credits.aleo".parse::<ProgramID<N>>().unwrap()));
        drop(clone);
        // Final drop joins the worker; no sleep or timing assumption is needed.
        assert!(process.upgrade().is_none(), "worker retained a dropped VM");
    }
}

#[test]
fn dropped_mainnet_vm_releases_process() {
    assert_dropped_vm_releases_process::<MainnetV0>();
}

#[test]
fn dropped_testnet_vm_releases_process() {
    assert_dropped_vm_releases_process::<TestnetV0>();
}

#[test]
fn dropped_canary_vm_releases_process() {
    assert_dropped_vm_releases_process::<CanaryV0>();
}

#[test]
fn concurrent_final_vm_clones_release_process() {
    for _ in 0..8 {
        let vm = new_vm::<MainnetV0>();
        let process = Arc::downgrade(vm.process());
        let barrier = Arc::new(Barrier::new(5));
        std::thread::scope(|scope| {
            for _ in 0..4 {
                let clone = vm.clone();
                let barrier = barrier.clone();
                scope.spawn(move || {
                    barrier.wait();
                    drop(clone);
                });
            }
            drop(vm);
            barrier.wait();
        });
        assert!(
            process.upgrade().is_none(),
            "concurrent drops retained a VM"
        );
    }
}

#[test]
fn abandoned_blocking_initializer_releases_process() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime");
    let process = runtime.block_on(async {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let initializer = tokio::task::spawn_blocking(move || {
            let vm = new_vm::<MainnetV0>();
            started_tx
                .send(Arc::downgrade(vm.process()))
                .expect("initializer observed");
            release_rx.recv().expect("release initializer");
            vm
        });
        let process = started_rx.await.expect("VM initialized");
        // Cancelling the OnceCell initializer drops its JoinHandle while the
        // blocking task keeps running. Its unpublished VM must still be freed.
        drop(initializer);
        release_tx.send(()).expect("finish abandoned initializer");
        process
    });
    // Runtime shutdown waits for blocking tasks, avoiding sleep-based checks.
    drop(runtime);
    assert!(
        process.upgrade().is_none(),
        "abandoned initialization retained a VM"
    );
}
