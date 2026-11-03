use std::{env, sync::Arc, time::Instant};

use serde::Serialize;
use tokio::{
    runtime::Builder,
    sync::Notify,
    time::{sleep, Duration},
};

mod baseline;
mod proposed;

#[derive(Serialize)]
struct Sample {
    elapsed_ms: f64,
    ready_delivery_ms: Option<f64>,
    registration_ms: Option<f64>,
    deliveries: usize,
}

// Expand identical measurement code around the two verbatim source snapshots.
macro_rules! measurements {
    ($module:ident, $sender:path, $notification:path) => {
        mod $module {
            use super::*;
            use $notification as Notification;
            use $sender as Sender;

            pub async fn uniform(messages: usize, subscribers: usize) -> Sample {
                let broadcaster = Sender::<u64>::new(128);
                let mut consumers = Vec::new();
                for _ in 0..subscribers {
                    let mut receiver = broadcaster.get_receiver().await;
                    consumers.push(tokio::spawn(async move {
                        for expected in 0..messages {
                            assert_eq!(receiver.recv().await, Some(expected as u64));
                        }
                    }));
                }
                let start = Instant::now();
                for value in 0..messages {
                    broadcaster.send(value as u64).await.expect("broadcast");
                }
                for consumer in consumers {
                    consumer.await.expect("consumer");
                }
                Sample {
                    elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                    ready_delivery_ms: None,
                    registration_ms: None,
                    deliveries: messages * subscribers,
                }
            }

            pub async fn notifications(messages: usize) -> Sample {
                let broadcaster = Sender::<Notification>::new(128);
                let mut consumers = Vec::new();
                for _ in 0..3 {
                    let mut receiver = broadcaster.get_receiver().await;
                    consumers.push(tokio::spawn(async move {
                        for expected in 0..messages {
                            let message = receiver.recv().await.expect("notification");
                            assert_eq!(
                                message.tx_id,
                                hyperlane_core::H512::from_low_u64_be(expected as u64)
                            );
                            assert_eq!(message.sequences, vec![Some(expected as u32)]);
                        }
                    }));
                }
                let start = Instant::now();
                for value in 0..messages {
                    broadcaster
                        .send(Notification {
                            tx_id: hyperlane_core::H512::from_low_u64_be(value as u64),
                            sequences: vec![Some(value as u32)],
                        })
                        .await
                        .expect("notification broadcast");
                }
                for consumer in consumers {
                    consumer.await.expect("notification consumer");
                }
                Sample {
                    elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                    ready_delivery_ms: None,
                    registration_ms: None,
                    deliveries: messages * 3,
                }
            }

            pub async fn slow_consumer(delay_ms: u64) -> Sample {
                let broadcaster = Sender::<u64>::new(1);
                let mut slow = broadcaster.get_receiver().await;
                let mut ready = broadcaster.get_receiver().await;
                broadcaster.send(0).await.expect("prefill");
                assert_eq!(ready.recv().await, Some(0));
                let start = Instant::now();
                let release = Arc::new(Notify::new());
                let slow_release = release.clone();
                let slow_task = tokio::spawn(async move {
                    slow_release.notified().await;
                    assert_eq!(slow.recv().await, Some(0));
                    assert_eq!(slow.recv().await, Some(1));
                });
                let release_task = tokio::spawn(async move {
                    sleep(Duration::from_millis(delay_ms)).await;
                    release.notify_one();
                });
                let ready_task = tokio::spawn(async move {
                    assert_eq!(ready.recv().await, Some(1));
                    start.elapsed().as_secs_f64() * 1000.0
                });
                let sending = broadcaster.clone();
                let send_task = tokio::spawn(async move {
                    sending.send(1).await.expect("second broadcast");
                });
                // Begin registration after the second broadcast has had time
                // to acquire its turn and block on the full first subscriber.
                sleep(Duration::from_millis(2)).await;
                let registration_start = Instant::now();
                let late = broadcaster.get_receiver().await;
                let registration_ms = registration_start.elapsed().as_secs_f64() * 1000.0;
                drop(late);
                send_task.await.expect("producer");
                slow_task.await.expect("slow consumer");
                release_task.await.expect("release");
                let ready_delivery_ms = ready_task.await.expect("ready consumer");
                Sample {
                    elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                    ready_delivery_ms: Some(ready_delivery_ms),
                    registration_ms: Some(registration_ms),
                    deliveries: 2,
                }
            }
        }
    };
}

measurements!(
    old,
    crate::baseline::BroadcastMpscSender,
    crate::baseline::IndexingNotification
);
measurements!(
    new,
    crate::proposed::BroadcastMpscSender,
    crate::proposed::IndexingNotification
);

fn main() {
    let args: Vec<_> = env::args().collect();
    let version = args.get(1).expect("version");
    let scenario = args.get(2).expect("scenario");
    let repetitions: usize = args.get(3).expect("repetitions").parse().expect("integer");
    let warmups: usize = args.get(4).expect("warmups").parse().expect("integer");
    let threads: usize = args.get(5).expect("threads").parse().expect("integer");
    let runtime = if threads == 1 {
        Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("runtime")
    } else {
        Builder::new_multi_thread()
            .worker_threads(threads)
            .enable_time()
            .build()
            .expect("runtime")
    };
    let samples = runtime.block_on(async {
        let mut samples = Vec::new();
        for index in 0..warmups + repetitions {
            let sample = match (version.as_str(), scenario.as_str()) {
                ("baseline", "uniform_1") => old::uniform(20_000, 1).await,
                ("proposed", "uniform_1") => new::uniform(20_000, 1).await,
                ("baseline", "uniform_3") => old::uniform(20_000, 3).await,
                ("proposed", "uniform_3") => new::uniform(20_000, 3).await,
                ("baseline", "notifications_3") => old::notifications(20_000).await,
                ("proposed", "notifications_3") => new::notifications(20_000).await,
                ("baseline", "slow_consumer") => old::slow_consumer(25).await,
                ("proposed", "slow_consumer") => new::slow_consumer(25).await,
                _ => panic!("unknown version or scenario"),
            };
            if index >= warmups {
                samples.push(sample);
            }
        }
        samples
    });
    println!("{}", serde_json::to_string(&samples).expect("samples"));
}
