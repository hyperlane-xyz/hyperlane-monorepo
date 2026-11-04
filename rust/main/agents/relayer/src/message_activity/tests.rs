use super::*;

fn reporter(capacity: usize) -> (MessageActivityReporter, mpsc::Receiver<Event>) {
    let (sender, receiver) = mpsc::channel(capacity);
    (
        MessageActivityReporter {
            sender,
            relayer: H160::repeat_byte(0x11),
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
}

#[test]
fn checkpoint_collections_are_distinct_and_bound_to_message() {
    let (reporter, mut receiver) = reporter(2);
    let message = HyperlaneMessage::default();
    for _ in 0..2 {
        reporter
            .checkpoint_observer(&message, Some(H256::repeat_byte(7)), 2)
            .observe(CheckpointObservation::Signature {
                validator: H256::repeat_byte(1),
                index: 12,
                root: H256::repeat_byte(2),
                collected: 1,
            });
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
    assert_eq!(first["activity"]["observation"]["collected"], 1);
}

// Requires an empty disposable database and a superuser test login, to exercise
// real restricted writer permissions via SET SESSION AUTHORIZATION.
#[tokio::test]
#[ignore = "requires ACTIVITY_TEST_DATABASE_URL pointing to a disposable PostgreSQL database"]
async fn postgres() -> eyre::Result<()> {
    use message_activity_migration::{Migrator, MigratorTrait};

    let url = Secret::new(std::env::var("ACTIVITY_TEST_DATABASE_URL")?);
    let db = connect(&url).await?;
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
        reporter.report(&message, Activity::Delivered);
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
