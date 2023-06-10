use cli::mock::environment::MockEnvironment;
use color_eyre::Result;
use hyperlane_base::setup_error_handling;

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    setup_error_handling()?;

    let _env = MockEnvironment::new().await?;

    loop {
        tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;
    }
}
