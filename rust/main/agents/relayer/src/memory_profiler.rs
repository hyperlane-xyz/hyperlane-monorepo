use dhat::Profiler;
use eyre::Error as Report;

#[global_allocator]
static ALLOC: dhat::Alloc = dhat::Alloc;

fn initialize() -> Option<Profiler> {
    let profiler = Profiler::new_heap();
    Some(profiler)
}

fn termination_handler(profiler_singleton: &mut Option<Profiler>) {
    // only call drop on the profiler once
    if let Some(profiler) = profiler_singleton.take() {
        drop(profiler);
    }
}

pub(crate) async fn run_future<F, T>(fut: F) -> Result<T, Report>
where
    F: std::future::Future<Output = Result<T, Report>>,
    T: Default,
{
    let mut profiler_singleton = initialize();

    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    let mut shutdown_tx_singleton = Some(shutdown_tx);

    ctrlc::set_handler(move || {
        termination_handler(&mut profiler_singleton);

        // only send the shutdown signal once
        let Some(shutdown_tx) = shutdown_tx_singleton.take() else {
            return;
        };
        if let Err(_) = shutdown_tx.send(()) {
            eprintln!("failed to send shutdown signal");
        }
    })
    .expect("Error setting termination handler");

    // this `select!` isn't cancellation-safe if `fut` owns state
    // but for profiling scenarios this is not a risk
    tokio::select! {
        res = fut => { return res; },
        _ = shutdown_rx => { return Ok(T::default()) },
    };
}
