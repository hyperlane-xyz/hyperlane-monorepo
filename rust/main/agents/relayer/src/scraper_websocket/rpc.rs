//! RPC progress and cancellation acknowledgement for a live-stream cutover.
use super::Kind;
use async_trait::async_trait;
use eyre::Result;
use hyperlane_core::{ContractSyncCursor, CursorAction, Indexed, LogMeta};
use std::{
    fmt::Debug,
    ops::RangeInclusive,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{watch, Notify},
    time::Instant,
};
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AuthorityCommand {
    pub(crate) desired: bool,
    pub(crate) generation: u64,
}
struct PauseAck {
    domain: u32,
    generation: AtomicU64,
    changed: Notify,
    recovery: Arc<Mutex<[Option<RpcProgress>; 3]>>,
}
pub(super) struct Authority {
    command: watch::Sender<AuthorityCommand>,
    ack: Arc<PauseAck>,
}
impl Authority {
    pub(super) fn new(domain: u32) -> Self {
        Self {
            command: watch::channel(AuthorityCommand {
                desired: false,
                generation: 0,
            })
            .0,
            ack: Arc::new(PauseAck {
                domain,
                generation: AtomicU64::new(0),
                changed: Notify::new(),
                recovery: Arc::default(),
            }),
        }
    }
    pub(super) fn receiver(&self) -> ScraperAuthorityReceiver {
        ScraperAuthorityReceiver {
            desired: self.command.subscribe(),
            ack: self.ack.clone(),
        }
    }
    pub(super) fn request(&self, expected: u64) -> Option<u64> {
        let mut requested = None;
        self.command.send_if_modified(|command| {
            if command.desired || command.generation != expected {
                return false;
            }
            command.desired = true;
            command.generation = command
                .generation
                .checked_add(1)
                .expect("RPC handoff generation exhausted");
            requested = Some(command.generation);
            true
        });
        requested
    }
    pub(super) fn generation(&self) -> u64 {
        self.command.borrow().generation
    }
    pub(super) fn desired(&self) -> bool {
        self.command.borrow().desired
    }
    pub(super) fn current(&self, generation: u64) -> bool {
        let command = self.command.borrow();
        command.desired && command.generation == generation
    }
    pub(super) fn history_ready(&self, since: Instant, block: u64, gas: bool) -> bool {
        let progress = self.ack.recovery.lock().expect("RPC recovery lock");
        Kind::ALL
            .into_iter()
            .filter(|kind| gas || *kind != Kind::Gas)
            .all(|kind| {
                progress[kind.index()].is_some_and(|p| p.at >= since && u64::from(p.block) >= block)
            })
    }
    pub(super) fn resume(&self) {
        self.command.send_if_modified(|command| {
            let changed = command.desired;
            command.desired = false;
            command.generation = command
                .generation
                .checked_add(1)
                .expect("RPC handoff generation exhausted");
            // Invalidate scheduled cutovers without restarting RPC if it is already running.
            changed
        });
    }
    pub(super) async fn paused(&self, generation: u64) -> bool {
        let mut command = self.command.subscribe();
        loop {
            let notified = self.ack.changed.notified();
            let current = *command.borrow_and_update();
            if !current.desired || current.generation != generation {
                return false;
            }
            if self.ack.generation.load(Ordering::Acquire) == generation {
                return true;
            }
            tokio::select! { _ = notified => {}, result = command.changed() => { if result.is_err() { return false; } } }
        }
    }
}
#[derive(Clone)]
pub(crate) struct ScraperAuthorityReceiver {
    desired: watch::Receiver<AuthorityCommand>,
    ack: Arc<PauseAck>,
}
impl ScraperAuthorityReceiver {
    pub(crate) fn recovery(&self, kind: Kind) -> RpcRecovery {
        RpcRecovery {
            kind,
            progress: self.ack.recovery.clone(),
        }
    }

    #[cfg(test)]
    pub(crate) fn test_channel(domain: u32) -> (watch::Sender<AuthorityCommand>, Self) {
        let authority = Authority::new(domain);
        (authority.command.clone(), authority.receiver())
    }
    pub(crate) fn borrow_and_update(&mut self) -> AuthorityCommand {
        *self.desired.borrow_and_update()
    }
    pub(crate) async fn changed(&mut self) -> Result<(), watch::error::RecvError> {
        self.desired.changed().await
    }
    pub(crate) fn mark_paused(&self, domain: u32, generation: u64) {
        if domain == self.ack.domain {
            self.ack.generation.store(generation, Ordering::Release);
            self.ack.changed.notify_waiters();
        }
    }
    pub(crate) fn mark_running(&self, domain: u32) {
        if domain == self.ack.domain {
            self.ack.generation.store(0, Ordering::Release);
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct RpcProgress {
    at: Instant,
    block: u32,
}

#[derive(Clone, Debug)]
pub(crate) struct RpcRecovery {
    kind: Kind,
    progress: Arc<Mutex<[Option<RpcProgress>; 3]>>,
}
impl RpcRecovery {
    pub(crate) fn track<T: Send + Sync + Debug + 'static>(
        cursor: Box<dyn ContractSyncCursor<T>>,
        recovery: Option<Self>,
    ) -> Box<dyn ContractSyncCursor<T>> {
        match recovery {
            Some(recovery) => Box::new(RecoveryCursor { cursor, recovery }),
            None => cursor,
        }
    }
}

#[derive(Debug)]
struct RecoveryCursor<T> {
    cursor: Box<dyn ContractSyncCursor<T>>,
    recovery: RpcRecovery,
}
impl<T: Send + Sync + Debug + 'static> RecoveryCursor<T> {
    fn record_progress(&self) {
        if self.cursor.is_caught_up() {
            self.recovery.progress.lock().expect("RPC recovery lock")[self.recovery.kind.index()] =
                Some(RpcProgress {
                    at: Instant::now(),
                    block: self.cursor.latest_queried_block(),
                });
        }
    }
}
#[async_trait]
impl<T: Send + Sync + Debug + 'static> ContractSyncCursor<T> for RecoveryCursor<T> {
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        let action = self.cursor.next_action().await?;
        self.record_progress();
        Ok(action)
    }
    fn latest_queried_block(&self) -> u32 {
        self.cursor.latest_queried_block()
    }
    async fn update(
        &mut self,
        logs: Vec<(Indexed<T>, LogMeta)>,
        range: RangeInclusive<u32>,
    ) -> Result<()> {
        self.cursor.update(logs, range).await?;
        self.record_progress();
        Ok(())
    }
}
