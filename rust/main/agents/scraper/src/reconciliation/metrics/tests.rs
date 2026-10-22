use super::*;

async fn run_pending_tasks() {
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn reconciliation_idle_sleep_updates_liveness() {
    let liveness = IntGauge::new("test_reconcile_liveness", "test reconcile liveness")
        .expect("test gauge should be valid");
    let liveness_clone = liveness.clone();
    let task = tokio::spawn(async move {
        sleep_with_liveness(Duration::from_secs(65), &liveness_clone).await;
    });

    run_pending_tasks().await;
    tokio::time::advance(LIVENESS_UPDATE_INTERVAL - Duration::from_secs(1)).await;
    run_pending_tasks().await;
    assert_eq!(liveness.get(), 0);

    tokio::time::advance(Duration::from_secs(1)).await;
    run_pending_tasks().await;
    assert!(liveness.get() > 0);
    assert!(!task.is_finished());

    liveness.set(0);
    tokio::time::advance(LIVENESS_UPDATE_INTERVAL).await;
    run_pending_tasks().await;
    assert!(liveness.get() > 0);
    assert!(!task.is_finished());

    tokio::time::advance(Duration::from_secs(5)).await;
    task.await.expect("idle sleep should complete");
}

#[tokio::test]
async fn operations_preserve_results_and_recover_from_errors_and_panics() {
    let core = CoreMetrics::new("reconciliation_test", 0, prometheus::Registry::new()).unwrap();
    let metrics = ReconciliationMetrics::new(&core);
    assert_eq!(metrics.run("chain", "test", async { Ok(7) }).await, Some(7));
    assert_eq!(
        metrics
            .run::<i32>("chain", "test", async { Err(eyre::eyre!("rpc failed")) })
            .await,
        None
    );
    assert_eq!(
        metrics
            .run::<i32>("chain", "test", async { panic!("provider panicked") })
            .await,
        None
    );
    assert_eq!(
        metrics
            .operations
            .with_label_values(&["chain", "test"])
            .get(),
        3
    );
    assert_eq!(
        metrics
            .duration
            .with_label_values(&["chain", "test"])
            .get_sample_count(),
        3
    );
}
