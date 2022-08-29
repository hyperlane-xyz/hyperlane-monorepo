use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use tokio::fs::remove_dir_all;
use tokio::process::Command;
use tokio::time::sleep;

use common::*;

mod common;

const RAW_DB_PATH: &str = "./agents/scraper/src/db";
const DOCKER_NAME: &str = "scraper-entity-generator";

struct PostgresDockerContainer;

impl PostgresDockerContainer {
    async fn start() -> Result<Self, ()> {
        let status = Command::new("docker")
            .args([
                "run",
                "--name",
                DOCKER_NAME,
                "-e",
                "POSTGRES_PASSWORD=47221c18c610",
                "-p",
                "5432:5432",
                "--rm",
                "-d",
                "postgres:14",
            ])
            .stdout(Stdio::inherit())
            .stdout(Stdio::inherit())
            .status()
            .await;
        if let Ok(status) = status {
            if status.success() {
                sleep(Duration::from_secs(1)).await;
                return Ok(Self);
            }
        }
        Err(())
    }
}

impl Drop for PostgresDockerContainer {
    fn drop(&mut self) {
        let status = std::process::Command::new("docker")
            .args(["stop", DOCKER_NAME])
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .status();
        if let Err(e) = status {
            eprintln!("Encountered error when stopping postgres: {e}");
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), DbErr> {
    assert_eq!(
        std::env::current_dir().unwrap().file_name().unwrap(),
        "rust",
        "Must run from the rust dir"
    );
    let postgres = PostgresDockerContainer::start();

    let install_cli = tokio::spawn(
        Command::new("cargo")
            .args(["install", "sea-orm-cli"])
            .stdout(Stdio::inherit())
            .stdout(Stdio::inherit())
            .status(),
    );

    let postgres = postgres.await.unwrap();
    let db = init().await?;
    Migrator::up(&db, None).await?;
    drop(db);

    let db_path = Path::new(RAW_DB_PATH);
    if db_path.exists() {
        remove_dir_all(db_path)
            .await
            .expect("Failed to delete old entity code");
    }

    assert!(install_cli.await.unwrap().unwrap().success());
    let generate_status = Command::new("sea-orm-cli")
        .env("DATABASE_URL", url())
        .args([
            "generate",
            "entity",
            "--output-dir",
            db_path.to_str().unwrap(),
            "--with-serde",
            "both",
            // we want expanded format because it plays nicely with the IDEs
            "--expanded-format",
            "--date-time-crate",
            "time",
            "--with-copy-enums",
        ])
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .status()
        .await
        .expect("Failed to generate entities")
        .success();
    assert!(generate_status, "Failed to generate entities");
    drop(postgres);

    Ok(())
}
