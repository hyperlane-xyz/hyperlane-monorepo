use super::*;

fn reporter(capacity: usize) -> (MessageActivityReporter, mpsc::Receiver<Event>) {
    let (sender, receiver) = mpsc::channel(capacity);
    (
        MessageActivityReporter {
            sender,
            relayer: H160::repeat_byte(0x11),
            metrics: ActivityMetrics::new(
                &CoreMetrics::new("test", 0, prometheus::Registry::new()).expect("core metrics"),
            )
            .expect("activity metrics"),
        },
        receiver,
    )
}

#[test]
fn metadata_errors_exclude_external_text() {
    for error in [
        MetadataBuildError::FailedToBuild(
            "https://rpc.example/private-key?secret=password".to_owned(),
        ),
        MetadataBuildError::FastPathError("gs://private-bucket/credentials".to_owned()),
    ] {
        let text = metadata_error(&error);
        for secret in [
            "https",
            "private",
            "secret",
            "password",
            "gs:",
            "credentials",
        ] {
            assert!(!text.contains(secret));
        }
    }
    assert_eq!(
        metadata_error(&MetadataBuildError::AwaitingValidatorSignatures),
        "Awaiting validator signatures"
    );
}

#[test]
fn bounded_queue_drops_without_blocking_and_excludes_message_body() {
    let (reporter, mut receiver) = reporter(1);
    let message = HyperlaneMessage {
        origin: u32::MAX,
        destination: 10,
        body: b"private-body".to_vec(),
        ..Default::default()
    };
    reporter.report(&message, Activity::Delivered);
    reporter.report(&message, Activity::Dropped); // Full: must return immediately.
    assert_eq!(reporter.metrics.dropped.get(), 1);
    let first = receiver.try_recv().expect("first event");
    assert_eq!(first.message_id, message.id());
    assert_eq!(first.origin, u32::MAX);
    assert_eq!(first.destination, 10);
    assert!(!serde_json::to_string(&first)
        .expect("serialize")
        .contains("private-body"));
    assert!(receiver.try_recv().is_err());
    reporter.report(&message, Activity::Dropped);
    let next = receiver.try_recv().expect("queue recovers");
    assert_eq!(first.relayer, H160::repeat_byte(0x11));
    assert_eq!(next.relayer, first.relayer);
    drop(receiver);
    reporter.report(&message, Activity::Dropped); // Closed: also nonblocking.
    assert_eq!(reporter.metrics.dropped.get(), 2);
}

#[test]
fn checkpoint_collections_are_distinct_and_bound_to_message() {
    let (reporter, mut receiver) = reporter(2);
    let message = HyperlaneMessage::default();
    for _ in 0..2 {
        let observer = reporter.checkpoint_observer(&message, Some(H256::repeat_byte(7)), 2);
        observer.observe(CheckpointObservation::Fetching { index: 12 });
        observer.observe(CheckpointObservation::Signature {
            validator: H256::repeat_byte(1),
            index: 12,
            root: H256::repeat_byte(2),
            collected: 1,
        });
        observer.report();
    }
    let first = receiver.try_recv().expect("first collection");
    let second = receiver.try_recv().expect("second collection");
    assert_eq!(first.message_id, message.id());
    let first = serde_json::to_value(first).expect("serialize");
    let second = serde_json::to_value(second).expect("serialize");
    assert_ne!(
        first["activity"]["collection_id"],
        second["activity"]["collection_id"]
    );
    assert_eq!(first["activity"]["threshold"], 2);
    assert_eq!(first["activity"]["summary"]["collected"], 1);
}

// Requires an empty disposable database and a superuser test login, to exercise
// real restricted writer permissions via SET SESSION AUTHORIZATION.
#[tokio::test]
#[ignore = "requires ACTIVITY_TEST_DATABASE_URL pointing to a disposable PostgreSQL database"]
async fn postgres() -> eyre::Result<()> {
    use message_activity_migration::{Migrator, MigratorTrait};

    let url = Secret::new(std::env::var("ACTIVITY_TEST_DATABASE_URL")?);
    let db = connect(&url).await?;
    Migrator::up(&db, Some(1)).await?;
    Migrator::up(&db, None).await?;
    // Re-running the deployment command must preserve the existing schema.
    Migrator::up(&db, None).await?;
    assert_eq!(
        Migrator::get_applied_migrations(&db).await?.len(),
        Migrator::migrations().len()
    );
    let role = format!("activity_test_{}", Uuid::new_v4().simple());
    let result: eyre::Result<()> = async {
        db.execute_unprepared(&format!(r#"
            CREATE ROLE {role};
            GRANT USAGE ON SCHEMA public TO {role};
            GRANT INSERT (relayer, observed_at, message_id, origin, destination, activity)
                ON public.message_activity TO {role};
            GRANT USAGE ON SEQUENCE public.message_activity_id_seq TO {role};
            SET SESSION AUTHORIZATION {role};
        "#)).await?;
        let (mut reporter, mut receiver) = reporter(2);
        let message = HyperlaneMessage { origin: u32::MAX, destination: 1, ..Default::default() };
        let observer = reporter.checkpoint_observer(&message, Some(H256::repeat_byte(7)), 2);
        observer.observe(CheckpointObservation::Fetching { index: 12 });
        observer.observe(CheckpointObservation::Signature {
            validator: H256::repeat_byte(1), index: 12, root: H256::repeat_byte(2), collected: 1,
        });
        observer.report();
        let batch = vec![receiver.try_recv()?];
        insert_events(&db, &batch).await?;
        assert!(db.execute_unprepared("DELETE FROM public.message_activity").await.is_err());
        assert!(db.execute_unprepared("UPDATE public.message_activity SET relayer = 'spoof'").await.is_err());
        // Shared credentials allow different configured EVM identities.
        reporter.relayer = H160::repeat_byte(0x22);
        reporter.report(&message, Activity::Delivered);
        insert_events(&db, &[receiver.try_recv()?]).await?;
        // The shared writer still cannot choose server receipt timestamps.
        assert!(db.execute_unprepared("INSERT INTO public.message_activity (received_at) VALUES (now())").await.is_err());
        db.execute_unprepared("RESET SESSION AUTHORIZATION").await?;
        let row = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT count(*) AS count, min(encode(relayer, 'hex')) AS relayer, count(DISTINCT relayer) AS relayers, max(origin) AS origin, min(encode(message_id, 'hex')) AS message_id FROM public.message_activity"))
            .await?.ok_or_else(|| eyre::eyre!("missing activity"))?;
        assert_eq!(row.try_get::<i64>("", "count")?, 2);
        assert_eq!(row.try_get::<i64>("", "relayers")?, 2);
        assert_eq!(row.try_get::<String>("", "relayer")?, hex::encode(H160::repeat_byte(0x11)));
        assert_eq!(row.try_get::<i64>("", "origin")?, i64::from(u32::MAX));
        assert_eq!(row.try_get::<String>("", "message_id")?, hex::encode(message.id()));
        let checkpoint = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT activity FROM public.message_activity WHERE activity->>'type' = 'checkpoint'"))
            .await?.ok_or_else(|| eyre::eyre!("missing checkpoint"))?;
        let activity: serde_json::Value = checkpoint.try_get("", "activity")?;
        assert_eq!(activity["summary"]["collected"], 1);
        assert_eq!(activity["summary"]["index"], 12);
        // Exercise the background writer and its success counter, not only INSERT.
        let (writer_reporter, writer_receiver) = self::reporter(1);
        let metrics = writer_reporter.metrics.clone();
        writer_reporter.report(&message, Activity::Delivered);
        drop(writer_reporter);
        tokio::time::timeout(Duration::from_secs(5), write_events(url.clone(), writer_receiver, metrics.clone())).await?;
        assert_eq!(metrics.written.get(), 1);
        assert_eq!(metrics.failed.get(), 0);
        let index = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT indexdef FROM pg_indexes WHERE indexname = 'message_activity_received_at_idx'"))
            .await?.ok_or_else(|| eyre::eyre!("missing retention index"))?;
        assert!(index.try_get::<String>("", "indexdef")?.contains("USING brin (received_at)"));
        let trigger = db.query_one(Statement::from_string(DbBackend::Postgres,
            "SELECT count(*) AS count FROM pg_trigger WHERE tgname = 'notify_message_activity_insert' AND NOT tgisinternal"))
            .await?.ok_or_else(|| eyre::eyre!("missing notification trigger"))?;
        assert_eq!(trigger.try_get::<i64>("", "count")?, 1);
        db.execute_unprepared("UPDATE public.message_activity SET received_at = now() - interval '91 days' WHERE activity->>'type' = 'checkpoint'").await?;
        let deleted = db.execute_unprepared(include_str!("prune.sql")).await?;
        assert_eq!(deleted.rows_affected(), 1);
        let remaining = db.query_one(Statement::from_string(DbBackend::Postgres, "SELECT count(*) AS count FROM public.message_activity"))
            .await?.ok_or_else(|| eyre::eyre!("missing retained events"))?;
        assert_eq!(remaining.try_get::<i64>("", "count")?, 2);
        Ok(())
    }.await;
    db.execute_unprepared("RESET SESSION AUTHORIZATION").await?;
    Migrator::down(&db, None).await?;
    db.execute_unprepared(&format!("DROP OWNED BY {role}; DROP ROLE {role};"))
        .await?;
    result
}

#[test]
fn chain_error_codes_exclude_external_details() {
    for (error, expected) in [
        (
            ChainCommunicationError::SimulationFailed("private-password".to_owned()),
            "simulation_failed",
        ),
        (
            ChainCommunicationError::CustomError("https://rpc.example/private-password".to_owned()),
            "chain_error",
        ),
        (
            ChainCommunicationError::InvalidRequest {
                msg: "private-password".to_owned(),
            },
            "invalid_request",
        ),
        (
            ChainCommunicationError::TransactionTimeout,
            "transaction_timeout",
        ),
        (
            ChainCommunicationError::SignerUnavailable,
            "signer_unavailable",
        ),
        (
            ChainCommunicationError::InsufficientFunds {
                required: Box::new(2.into()),
                available: Box::new(1.into()),
            },
            "insufficient_funds",
        ),
    ] {
        assert_eq!(chain_error(&error), expected);
        let event = Activity::ChainFailure {
            stage: Stage::Submit,
            reason: chain_error(&error),
        };
        assert!(!serde_json::to_string(&event)
            .expect("serialize")
            .contains("private-password"));
    }
}

#[test]
fn checkpoint_range_walk_emits_one_bounded_summary() {
    let (reporter, mut receiver) = reporter(1);
    let observer = reporter.checkpoint_observer(&HyperlaneMessage::default(), None, 2);
    for index in (0..10_000).rev() {
        observer.observe(CheckpointObservation::Fetching { index });
        observer.observe(CheckpointObservation::Signature {
            validator: H256::repeat_byte(1),
            index,
            root: H256::repeat_byte(2),
            collected: 1,
        });
        observer.observe(CheckpointObservation::Unavailable {
            validator: H256::repeat_byte(3),
            index: Some(index),
            reason: CheckpointUnavailableReason::Missing,
        });
    }
    assert!(receiver.try_recv().is_err());
    observer.report();
    let event = receiver.try_recv().expect("one summary");
    let json = serde_json::to_value(&event).expect("serialize event");
    assert_eq!(json["activity"]["summary"]["attempts"], 10_000);
    assert_eq!(json["activity"]["summary"]["index"], 0);
    assert_eq!(json["activity"]["summary"]["collected"], 1);
    assert_eq!(
        json["activity"]["summary"]["unavailable"]
            .as_object()
            .expect("summary map")
            .len(),
        1
    );
    assert!(serde_json::to_vec(&event).expect("serialize event").len() < 1_024);
    observer.report(); // Already drained: no duplicate.
    assert!(receiver.try_recv().is_err());
}

#[test]
fn checkpoint_summary_never_combines_roots_or_indices() {
    let (reporter, mut receiver) = reporter(1);
    let observer = reporter.checkpoint_observer(&HyperlaneMessage::default(), None, 3);
    observer.observe(CheckpointObservation::Fetching { index: 12 });
    for (root, collected) in [(1, 2), (2, 1)] {
        observer.observe(CheckpointObservation::Signature {
            validator: H256::repeat_byte(root),
            index: 12,
            root: H256::repeat_byte(root),
            collected,
        });
    }
    assert_eq!(observer.summary.lock().collected, 2);
    assert_eq!(observer.summary.lock().root, Some(H256::repeat_byte(1)));
    observer.observe(CheckpointObservation::Fetching { index: 11 });
    observer.observe(CheckpointObservation::Unavailable {
        validator: H256::repeat_byte(1),
        index: Some(11),
        reason: CheckpointUnavailableReason::FetchError,
    });
    observer.report();
    let json = serde_json::to_value(receiver.try_recv().expect("checkpoint event"))
        .expect("serialize event");
    assert_eq!(json["activity"]["summary"]["index"], 11);
    assert_eq!(json["activity"]["summary"]["collected"], 0);
    assert!(json["activity"]["summary"]["root"].is_null());
}

#[test]
fn checkpoint_summary_reports_discovery_failures_without_a_fetch() {
    let (reporter, mut receiver) = reporter(1);
    let observer = reporter.checkpoint_observer(&HyperlaneMessage::default(), None, 2);
    observer.observe(CheckpointObservation::LatestIndex {
        validator: H160::repeat_byte(1),
        index: Some(4),
    });
    observer.observe(CheckpointObservation::Unavailable {
        validator: H256::repeat_byte(2),
        index: None,
        reason: CheckpointUnavailableReason::NoStorage,
    });
    observer.report();
    let json = serde_json::to_value(receiver.try_recv().expect("checkpoint event"))
        .expect("serialize event");
    assert_eq!(json["activity"]["summary"]["attempts"], 0);
    assert!(json["activity"]["summary"]["index"].is_null());
    assert_eq!(
        json["activity"]["summary"]["latest_indices"]
            .as_object()
            .expect("summary map")
            .len(),
        1
    );
    assert_eq!(
        json["activity"]["summary"]["discovery_unavailable"]
            .as_object()
            .expect("summary map")
            .len(),
        1
    );
    assert!(json["activity"]["summary"]["unavailable"]
        .as_object()
        .expect("summary map")
        .is_empty());
}

#[test]
fn checkpoint_summary_separates_discovery_failures_in_both_completion_orders() {
    for discovery_finishes_first in [true, false] {
        let (reporter, mut receiver) = reporter(1);
        let observer = reporter.checkpoint_observer(&HyperlaneMessage::default(), None, 2);
        let discovery_failure = || CheckpointObservation::Unavailable {
            validator: H256::repeat_byte(1),
            index: None,
            reason: CheckpointUnavailableReason::FetchError,
        };
        if discovery_finishes_first {
            observer.observe(discovery_failure());
        }
        observer.observe(CheckpointObservation::Fetching { index: 12 });
        observer.observe(CheckpointObservation::Signature {
            validator: H256::repeat_byte(1),
            index: 12,
            root: H256::repeat_byte(2),
            collected: 1,
        });
        if !discovery_finishes_first {
            observer.observe(discovery_failure());
        }

        observer.report();
        let json = serde_json::to_value(receiver.try_recv().expect("checkpoint event"))
            .expect("serialize event");
        let summary = &json["activity"]["summary"];
        assert_eq!(summary["collected"], 1);
        assert!(summary["unavailable"]
            .as_object()
            .expect("summary map")
            .is_empty());
        assert_eq!(
            summary["discovery_unavailable"]
                .as_object()
                .expect("summary map")
                .len(),
            1
        );
    }
}

#[tokio::test]
async fn restoring_pending_messages_does_not_replay_activity() {
    use crate::{
        msg::pending_message::PendingMessage,
        test_utils::dummy_data::{dummy_message_context, dummy_metadata_builder},
    };
    use hyperlane_base::{
        cache::OptionalCache,
        db::{HyperlaneDb, HyperlaneRocksDB, PendingMessageRetryState, DB},
    };
    use hyperlane_core::{HyperlaneDomain, KnownHyperlaneDomain, PendingOperation};

    let origin = HyperlaneDomain::Known(KnownHyperlaneDomain::Arbitrum);
    let destination = HyperlaneDomain::Known(KnownHyperlaneDomain::Ethereum);
    let dir = tempfile::tempdir().expect("test directory");
    let db = HyperlaneRocksDB::new(
        &origin,
        DB::from_path(dir.path()).expect("open test database"),
    );
    let cache = OptionalCache::new(None);
    let (reporter, mut receiver) = reporter(10);
    let builder = dummy_metadata_builder(&origin, &destination, &db, cache.clone())
        .with_activity_reporter(Some(reporter));
    let ctx = Arc::new(dummy_message_context(Arc::new(builder), &db, cache));
    let message = HyperlaneMessage {
        origin: origin.id(),
        destination: destination.id(),
        ..Default::default()
    };
    let reason = ReprepareReason::CouldNotFetchMetadata;
    let retry = PendingMessageRetryState::new(3, None, None, Some(reason.clone()));
    db.store_pending_message_retry_state_by_message_id(&message.id(), &retry)
        .expect("store retry");
    db.store_status_by_message_id(&message.id(), &PendingOperationStatus::Retry(reason))
        .expect("store status");
    let mut restored = PendingMessage::maybe_from_persisted_retries(message, ctx, None, 100)
        .expect("restore retry");
    assert!(receiver.try_recv().is_err());
    restored.set_status(PendingOperationStatus::ReadyToSubmit);
    assert!(matches!(
        receiver.try_recv().expect("checkpoint event").activity,
        Activity::Status {
            status: PendingOperationStatus::ReadyToSubmit
        }
    ));
    restored.set_status(PendingOperationStatus::ReadyToSubmit);
    assert!(receiver.try_recv().is_err());
}

#[tokio::test(start_paused = true)]
async fn failed_writer_counts_loss_and_keeps_queue_nonblocking() {
    let (reporter, receiver) = reporter(1);
    let metrics = reporter.metrics.clone();
    let message = HyperlaneMessage::default();
    let writer = tokio::spawn(write_events(
        Secret::new("invalid-diagnostics-url".to_owned()),
        receiver,
        metrics.clone(),
    ));
    reporter.report(&message, Activity::Delivered);
    tokio::time::timeout(Duration::from_secs(1), async {
        while metrics.failed.get() == 0 {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }
    })
    .await
    .expect("failed connection must be counted");
    // Writer is in backoff. One event fits; the next must drop immediately.
    reporter.report(&message, Activity::Delivered);
    reporter.report(&message, Activity::Dropped);
    assert_eq!(metrics.dropped.get(), 1);
    drop(reporter);
    writer
        .await
        .expect("writer exits after draining closed channel");
    assert_eq!(metrics.failed.get(), 2);
    assert_eq!(metrics.written.get(), 0);
}
