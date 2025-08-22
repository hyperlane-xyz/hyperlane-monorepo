use std::{
    future::Future,
    net::TcpListener,
    time::{Duration, Instant},
};

pub fn get_free_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").expect("Failed to bind");
    let port = listener.local_addr().unwrap().port();
    drop(listener);
    port
}

pub async fn try_for<F, Fut, R>(duration: Duration, interval: Duration, f: F) -> anyhow::Result<R>
where
    F: Fn() -> Fut, // closure che genera un nuovo Future ad ogni tentativo
    Fut: Future<Output = anyhow::Result<R>>,
{
    let now = Instant::now();
    loop {
        if let Ok(result) = f().await {
            return Ok(result);
        }

        tokio::time::sleep(interval).await;

        if now.elapsed() > duration {
            break;
        }
    }

    Err(anyhow::anyhow!(
        "Failed to execute function after {} seconds",
        duration.as_secs()
    ))
}
