//! Shared origin discovery. RPC fills subscription gaps; both transports use the
//! same DB writes. EVM discovery is provisional; other VMs retain configured finality.
use crate::merkle_tree::builder::MerkleTreeBuilder;
use async_trait::async_trait;
use eyre::{bail, ensure, Context, ContextCompat, Result};
use futures_util::{stream, StreamExt};
use hyperlane_base::{
    broadcast::{BroadcastMpscSender, IndexingNotification},
    db::{DiscoveryCheckpoint, HyperlaneDb, HyperlaneRocksDB},
    scraper_websocket::{
        parse_address, EventMessage, MerkleEventData, ScraperSession, ServerMessage, SessionEvent,
        StreamHealth, StreamTimeouts, StringOrNumber, SubscribeMessage, SubscribeStream,
    },
    settings::SequenceIndexer,
    CoreMetrics,
};
use hyperlane_core::{
    bytes_to_h512, ContractSyncCursor, CursorAction, HyperlaneMessage, HyperlaneProvider, Indexed,
    Indexer, InterchainGasPayment, LogMeta, MerkleTreeInsertion, H256, H512, U256,
};
use prometheus::IntGaugeVec;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fmt::Debug,
    ops::RangeInclusive,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{
    sync::{watch, Notify, RwLock},
    time::{timeout, Instant},
};
use tracing::{info, warn};
use url::Url;

const AUDIT_INTERVAL: Duration = Duration::from_secs(5);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
#[error("Confirmed origin history changed on {chain} at block {height}; manual recovery required")]
pub(crate) struct RollbackRecoveryRequired {
    chain: String,
    height: u64,
}

#[derive(Clone, Copy, Debug)]
pub(crate) enum Kind {
    Dispatch,
    Merkle,
    Gas,
}
impl Kind {
    const ALL: [Self; 3] = [Self::Dispatch, Self::Merkle, Self::Gas];
    fn index(self) -> usize {
        self as usize
    }
    fn label(self) -> &'static str {
        match self {
            Self::Dispatch => "dispatch",
            Self::Merkle => "merkle_tree_insertion",
            Self::Gas => "gas_payment",
        }
    }
    fn parse(value: &str) -> Result<Self> {
        match value {
            "dispatch" => Ok(Self::Dispatch),
            "merkle_tree_insertion" => Ok(Self::Merkle),
            "gas_payment" => Ok(Self::Gas),
            _ => bail!("Unexpected event type {value}"),
        }
    }
}

#[derive(Clone)]
pub(crate) struct ScraperSource {
    chain: String,
    domain: u32,
    mailbox: H256,
    interchain_gas_paymaster: H256,
    merkle_tree_hook: H256,
    database: HyperlaneRocksDB,
    block_provider: Option<Arc<dyn HyperlaneProvider>>,
    broadcaster: Option<BroadcastMpscSender<IndexingNotification>>,
    freshness_indexer: Option<SequenceIndexer<HyperlaneMessage>>,
    merkle_freshness_indexer: Option<SequenceIndexer<MerkleTreeInsertion>>,
    finality_indexer: Option<SequenceIndexer<HyperlaneMessage>>,
    prover: Option<Arc<RwLock<MerkleTreeBuilder>>>,
    gas_enabled: bool,
    recover_provisional: bool,
    confirmations: Option<u32>,
    control: Arc<Authority>,
}
impl ScraperSource {
    pub(crate) fn new(
        chain: String,
        domain: u32,
        mailbox: H256,
        interchain_gas_paymaster: H256,
        merkle_tree_hook: H256,
        database: HyperlaneRocksDB,
    ) -> Result<Self> {
        Ok(Self {
            chain,
            domain,
            mailbox,
            interchain_gas_paymaster,
            merkle_tree_hook,
            database,
            block_provider: None,
            broadcaster: None,
            freshness_indexer: None,
            merkle_freshness_indexer: None,
            finality_indexer: None,
            prover: None,
            gas_enabled: true,
            recover_provisional: false,
            confirmations: None,
            control: Arc::new(Authority::new(domain)),
        })
    }
    pub(crate) fn with_block_provider(mut self, value: Arc<dyn HyperlaneProvider>) -> Self {
        self.block_provider = Some(value);
        self
    }
    pub(crate) fn with_confirmations(mut self, confirmations: Option<u32>) -> Self {
        self.confirmations = confirmations;
        self
    }
    pub(crate) fn with_broadcaster(
        mut self,
        value: Option<BroadcastMpscSender<IndexingNotification>>,
    ) -> Self {
        self.broadcaster = value;
        self
    }
    pub(crate) fn with_freshness_indexer(
        mut self,
        value: SequenceIndexer<HyperlaneMessage>,
    ) -> Self {
        self.freshness_indexer = Some(value);
        self
    }
    pub(crate) fn with_merkle_freshness_indexer(
        mut self,
        value: SequenceIndexer<MerkleTreeInsertion>,
    ) -> Self {
        self.merkle_freshness_indexer = Some(value);
        self
    }
    pub(crate) fn with_recovery(
        mut self,
        indexer: Option<SequenceIndexer<HyperlaneMessage>>,
        prover: Arc<RwLock<MerkleTreeBuilder>>,
        gas_enabled: bool,
        recover_provisional: bool,
    ) -> Self {
        self.recover_provisional = recover_provisional;
        self.finality_indexer = indexer;
        self.prover = Some(prover);
        self.gas_enabled = gas_enabled;
        self
    }
    async fn block(&self, height: u64) -> Result<DiscoveryCheckpoint> {
        let block = timeout(
            RPC_TIMEOUT,
            self.block_provider
                .as_ref()
                .context("Missing block provider")?
                .get_block_by_height(height),
        )
        .await??;
        ensure!(
            block.number == height && !block.hash.is_zero(),
            "RPC returned an invalid block identity"
        );
        Ok(DiscoveryCheckpoint {
            height,
            hash: block.hash,
        })
    }
    async fn stable(&self) -> Result<DiscoveryCheckpoint> {
        let height = timeout(
            RPC_TIMEOUT,
            self.finality_indexer
                .as_ref()
                .context("Missing finality indexer")?
                .get_finalized_block_number(),
        )
        .await??;
        self.block(u64::from(height)).await
    }
    fn confirmed_reorg(&self, height: u64) -> Result<()> {
        self.database.mark_indexed_event_conflict()?;
        bail!(RollbackRecoveryRequired {
            chain: self.chain.clone(),
            height
        })
    }

    fn ensure_confirmed_history(&self) -> Result<()> {
        if self.database.confirmed_discovery_conflict()? {
            self.confirmed_reorg(
                self.database
                    .discovery_checkpoint()?
                    .map_or(0, |block| block.height),
            )?;
        }
        Ok(())
    }
    async fn verify(&self, blocks: &[DiscoveryCheckpoint]) -> Result<bool> {
        let confirmed = self
            .database
            .discovery_checkpoint()?
            .context("Missing discovery boundary")?;
        let mut probes = stream::iter(blocks.iter().copied())
            .map(|block| async move {
                Ok::<_, eyre::Report>((block, self.block(block.height).await? == block))
            })
            .buffer_unordered(8);
        let mut valid = true;
        while let Some(result) = probes.next().await {
            let (block, matches) = result?;
            if !matches && block.height <= confirmed.height {
                self.confirmed_reorg(block.height)?;
            }
            valid &= matches;
        }
        Ok(valid)
    }
    pub(crate) async fn verify_live_blocks(&self) -> Result<()> {
        if self.finality_indexer.is_none() {
            return Ok(());
        }
        self.ensure_confirmed_history()?;
        let stable = self.stable().await?;
        let upgrading = !self
            .database
            .retrieve_value_by_key::<_, bool>("discovery_legacy_checked", &false)?
            .unwrap_or(false);
        self.database.enable_discovery(stable)?;
        if upgrading {
            let mut invalid = self
                .database
                .retrieve_value_by_key::<_, bool>("indexed_event_conflict_v1_", &false)?
                .unwrap_or(false);
            for address in [
                self.mailbox,
                self.merkle_tree_hook,
                self.interchain_gas_paymaster,
            ] {
                if let Some(height) = self
                    .database
                    .retrieve_value_by_key::<_, u64>("scraper_websocket_live_block", &address)?
                {
                    let hash = self.database.retrieve_value_by_key::<_, H256>(
                        "scraper_websocket_live_block_hash",
                        &address,
                    )?;
                    invalid |= hash != Some(self.block(height).await?.hash);
                }
            }
            if invalid {
                self.confirmed_reorg(stable.height)?;
            }
            self.database
                .store_value_by_key("discovery_legacy_checked", &false, &true)?;
        }
        let checkpoint = self
            .database
            .discovery_checkpoint()?
            .context("Missing discovery boundary")?;
        if self.database.confirmed_discovery_conflict()?
            || self.block(checkpoint.height).await? != checkpoint
        {
            self.confirmed_reorg(checkpoint.height)?;
        }
        let valid = self.verify(&self.database.discovery_blocks()?).await?;
        if self.database.discovery_recovery_pending()? || !valid {
            self.rewind().await?;
        }
        Ok(())
    }
    pub(crate) async fn retry_startup_verification(&self) -> Result<()> {
        while self.database.live_block_verification_pending() {
            match self.verify_live_blocks().await {
                Ok(()) => self.database.set_live_block_verification_pending(false),
                Err(error) if error.is::<RollbackRecoveryRequired>() => return Err(error),
                Err(error) => warn!(chain = self.chain, ?error, "Origin verification pending"),
            }
            if self.database.live_block_verification_pending() {
                tokio::time::sleep(AUDIT_INTERVAL).await;
            }
        }
        Ok(())
    }
    async fn rewind(&self) -> Result<()> {
        if !self.recover_provisional {
            self.confirmed_reorg(
                self.database
                    .discovery_checkpoint()?
                    .context("Missing discovery boundary")?
                    .height,
            )?;
        }
        let mut prover = self
            .prover
            .as_ref()
            .context("Missing origin prover")?
            .clone()
            .write_owned()
            .await;
        let db = self.database.clone();
        // Recovery can scan Merkle history; keep that work off async workers.
        let first = tokio::task::spawn_blocking(move || -> Result<Option<u32>> {
            let first = db.rollback_discovery()?;
            if let Some(index) = first {
                prover.rewind(index)?;
            }
            db.finish_discovery_recovery()?;
            Ok(first)
        })
        .await??;
        info!(
            chain = self.chain,
            ?first,
            "Recovered provisional origin discovery"
        );
        Ok(())
    }
    // This runs even without a WebSocket. The persisted boundary catches offline reorgs.
    async fn audit(&self) -> Result<()> {
        if self.finality_indexer.is_none() {
            return Ok(());
        }
        self.database.wait_for_live_block_verification().await;
        let mut previous_head = None;
        loop {
            let result: Result<()> = async {
                self.ensure_confirmed_history()?;
                let stable = self.stable().await?;
                let checkpoint = self
                    .database
                    .discovery_checkpoint()?
                    .context("Missing discovery boundary")?;
                let canonical = if checkpoint.height == stable.height {
                    stable
                } else {
                    self.block(checkpoint.height).await?
                };
                if self.database.confirmed_discovery_conflict()? || canonical != checkpoint {
                    self.confirmed_reorg(checkpoint.height)?;
                }
                let blocks = self.database.discovery_blocks()?;
                let mut verify = blocks
                    .iter()
                    .copied()
                    .filter(|block| block.height <= stable.height)
                    .collect::<Vec<_>>();
                if let Some(previous) = previous_head {
                    verify.push(previous);
                }
                verify.sort_unstable_by_key(|block| (block.height, block.hash));
                verify.dedup();
                let pending = self.database.discovery_recovery_pending()?;
                if pending {
                    verify.extend(blocks.iter().copied());
                }
                let valid = self.verify(&verify).await?;
                if pending || !valid {
                    self.database.request_discovery_recovery()?;
                    let generation = self.control.request();
                    ensure!(
                        timeout(RPC_TIMEOUT, self.control.paused(generation)).await?,
                        "RPC recovery pause cancelled"
                    );
                    self.rewind().await?;
                    self.control.resume();
                    previous_head = None;
                } else {
                    self.database.confirm_discovery(stable, &verify)?;
                    // Compare this identity again next time, even if new canonical events arrive.
                    previous_head = blocks.last().copied();
                }
                Ok(())
            }
            .await;
            if let Err(error) = result {
                if error.is::<RollbackRecoveryRequired>() {
                    return Err(error);
                }
                warn!(
                    chain = self.chain,
                    ?error,
                    "Origin recovery audit failed; retrying"
                );
            }
            tokio::time::sleep(AUDIT_INTERVAL).await;
        }
    }
    async fn counts(&self) -> Result<([u32; 2], u32)> {
        let (dispatch, merkle) = tokio::try_join!(
            self.freshness_indexer
                .as_ref()
                .context("Missing mailbox indexer")?
                .latest_sequence_count_and_tip(),
            self.merkle_freshness_indexer
                .as_ref()
                .context("Missing Merkle indexer")?
                .latest_sequence_count_and_tip(),
        )?;
        Ok((
            [
                dispatch.0.context("Missing mailbox count")?,
                merkle.0.context("Missing Merkle count")?,
            ],
            dispatch.1.max(merkle.1),
        ))
    }
    async fn store(&self, event: EventMessage<serde_json::Value>) -> Result<Option<(Kind, u32)>> {
        ensure!(
            event.domain == self.domain && event.confirmations == self.confirmations,
            "Unexpected discovery stream"
        );
        let kind = Kind::parse(&event.event_type)?;
        let hash = event.block_hash.as_deref().map(parse_address).transpose()?;
        match kind {
            Kind::Dispatch => {
                let data: DispatchData = serde_json::from_value(event.data)?;
                if parse_address(&data.origin_mailbox)? != self.mailbox {
                    return Ok(None);
                }
                let message = data
                    .message(self.domain, self.mailbox)?
                    .context("Dispatch body unavailable; use RPC")?;
                ensure!(
                    event
                        .sequence
                        .as_deref()
                        .context("Missing dispatch sequence")?
                        .parse::<u32>()?
                        == message.nonce,
                    "Dispatch sequence mismatch"
                );
                let meta = LogMeta {
                    address: self.mailbox,
                    block_number: data.origin_block_height.as_u64("dispatch height")?,
                    block_hash: self.event_block_hash(hash, data.origin_block_hash.as_deref())?,
                    transaction_id: parse_tx(&data.origin_tx_hash)?,
                    transaction_index: 0,
                    log_index: U256::zero(),
                };
                let inserted = self.database.store_indexed_dispatch(&message, &meta)?;
                if inserted {
                    if let Some(sender) = &self.broadcaster {
                        timeout(
                            RPC_TIMEOUT,
                            sender.send(IndexingNotification {
                                tx_id: meta.transaction_id,
                                sequences: vec![Some(message.nonce)],
                            }),
                        )
                        .await??;
                    }
                }
                Ok(Some((kind, message.nonce)))
            }
            Kind::Merkle => {
                let data: MerkleEventData = serde_json::from_value(event.data)?;
                if parse_address(&data.merkle_tree_hook)? != self.merkle_tree_hook {
                    return Ok(None);
                }
                let hash = self.event_block_hash(hash, data.block_hash.as_deref())?;
                let sequence = event.sequence.context("Missing Merkle sequence")?.parse()?;
                let (leaf, height) = data.decode(self.domain, self.merkle_tree_hook, sequence)?;
                self.database.store_indexed_merkle(
                    &leaf,
                    &LogMeta {
                        address: self.merkle_tree_hook,
                        block_number: height,
                        block_hash: hash,
                        transaction_id: H512::zero(),
                        transaction_index: 0,
                        log_index: U256::zero(),
                    },
                )?;
                Ok(Some((kind, sequence)))
            }
            Kind::Gas => {
                let data: GasData = serde_json::from_value(event.data)?;
                if parse_address(&data.interchain_gas_paymaster)? != self.interchain_gas_paymaster {
                    return Ok(None);
                }
                ensure!(
                    data.domain == self.domain && data.origin == self.domain,
                    "Gas domain mismatch"
                );
                let (payment, meta) = data.decode(self.interchain_gas_paymaster)?;
                ensure!(
                    hash.is_none_or(|hash| hash == meta.block_hash),
                    "Gas block identity mismatch"
                );
                self.database.process_indexed_gas_payment(payment, &meta)?;
                Ok(None)
            }
        }
    }

    fn event_block_hash(&self, envelope: Option<H256>, payload: Option<&str>) -> Result<H256> {
        // Confirmed streams can contain legacy rows without a block hash. Only
        // provisional discovery needs the identity for journal verification.
        if self.finality_indexer.is_none() && envelope.is_none() && payload.is_none() {
            return Ok(H256::zero());
        }
        event_block_hash(envelope, payload)
    }
}

pub(crate) struct ScraperWebSocketMonitor {
    sources: HashMap<u32, ScraperSource>,
    url: Option<Url>,
    authority_enabled: bool,
    active: IntGaugeVec,
    authority: IntGaugeVec,
}
impl ScraperWebSocketMonitor {
    pub(crate) fn new_with_authority(
        url: Option<Url>,
        sources: Vec<ScraperSource>,
        metrics: &CoreMetrics,
        authority_enabled: bool,
    ) -> Result<Self> {
        Ok(Self {
            sources: sources
                .into_iter()
                .map(|source| (source.domain, source))
                .collect(),
            url,
            authority_enabled,
            active: metrics.new_int_gauge(
                "relayer_scraper_websocket_active",
                "Whether the scraper stream is connected",
                &["chain"],
            )?,
            authority: metrics.new_int_gauge(
                "relayer_scraper_websocket_authority",
                "Whether scraper replaces RPC discovery",
                &["chain"],
            )?,
        })
    }
    pub(crate) fn authority_receiver(&self, domain: u32) -> Option<ScraperAuthorityReceiver> {
        self.sources
            .get(&domain)
            .map(|source| source.control.receiver())
    }
    pub(crate) async fn run(self) {
        futures_util::future::join_all(self.sources.values().map(|source| async {
            tokio::join!(
                async {
                    source
                        .audit()
                        .await
                        .expect("Confirmed origin reorg requires manual recovery");
                },
                async {
                    let Some(url) = &self.url else {
                        return;
                    };
                    if !self.authority_enabled {
                        return;
                    }
                    source.database.wait_for_live_block_verification().await;
                    loop {
                        let result = self.stream(source, url, StreamTimeouts::default()).await;
                        if !source.database.discovery_recovery_pending().unwrap_or(true) {
                            source.control.resume();
                        }
                        self.active.with_label_values(&[&source.chain]).set(0);
                        self.authority.with_label_values(&[&source.chain]).set(0);
                        if let Err(error) = result {
                            assert!(
                                !error.is::<RollbackRecoveryRequired>(),
                                "Confirmed origin reorg requires manual recovery: {error}"
                            );
                            warn!(
                                chain = source.chain,
                                ?error,
                                "Scraper unavailable; using RPC discovery"
                            );
                        }
                        tokio::time::sleep(AUDIT_INTERVAL).await;
                    }
                }
            );
        }))
        .await;
    }
    async fn stream(
        &self,
        source: &ScraperSource,
        url: &Url,
        timeouts: StreamTimeouts,
    ) -> Result<()> {
        let _fallback = RpcFallback(source.clone());
        source.ensure_confirmed_history()?;
        source.database.ensure_no_indexed_event_conflict()?;
        let epoch = source.database.discovery_generation();
        let mut session =
            ScraperSession::<Result<([u32; 2], u32)>, bool>::connect(url, timeouts).await?;
        let mut subscribed = None;
        let mut target = None;
        let mut next = [0; 2];
        let mut health = [StreamHealth::default(), StreamHealth::default()];
        let mut authoritative = false;
        while let Some(event) = session
            .next::<serde_json::Value>(subscribed.is_some(), || {
                let source = source.clone();
                stream::once(async move {
                    timeout(RPC_TIMEOUT, source.counts())
                        .await
                        .context("RPC progress timed out")?
                })
                .boxed()
            })
            .await?
        {
            ensure!(
                epoch == source.database.discovery_generation(),
                "Origin recovered; reconnect live discovery"
            );
            source.database.ensure_no_indexed_event_conflict()?;
            match event {
                SessionEvent::Message(ServerMessage::Ready { .. }) => {
                    session
                        .subscribe(SubscribeMessage {
                            message_type: "subscribe",
                            streams: Kind::ALL
                                .into_iter()
                                .filter(|kind| source.gas_enabled || !matches!(kind, Kind::Gas))
                                .map(|kind| SubscribeStream {
                                    event_type: kind.label(),
                                    domains: Some(vec![source.domain]),
                                    confirmations: source.confirmations,
                                    include_zero_confirmations: None,
                                    cursors: None,
                                    stream_cursor_version: None,
                                })
                                .collect(),
                        })
                        .await?;
                }
                SessionEvent::Message(ServerMessage::Subscribed { .. }) => {
                    subscribed = Some(Instant::now());
                    self.active.with_label_values(&[&source.chain]).set(1);
                }
                SessionEvent::Message(ServerMessage::Event(event)) => {
                    ensure!(
                        subscribed.is_some(),
                        "Event before subscription acknowledgement"
                    );
                    if let Some((kind, sequence)) = source.store(event).await? {
                        let current = &mut next[kind.index()];
                        ensure!(
                            (target.is_none() && *current == 0) || sequence <= *current,
                            "Live discovery sequence gap"
                        );
                        *current =
                            (*current).max(sequence.checked_add(1).context("Sequence overflow")?);
                    }
                }
                SessionEvent::Message(ServerMessage::Rollback {
                    domain,
                    confirmations,
                    to_height,
                    ..
                }) => {
                    ensure!(
                        domain == source.domain && confirmations == source.confirmations,
                        "Unexpected rollback scope"
                    );
                    if source.finality_indexer.is_none() {
                        source.confirmed_reorg(to_height.as_u64("rollback height")?)?;
                    }
                    source.database.request_discovery_recovery()?;
                    bail!("Origin rollback; recovering through RPC");
                }
                SessionEvent::Message(ServerMessage::Error { error }) => {
                    bail!("Scraper rejected discovery: {error}")
                }
                SessionEvent::Progress(result) => {
                    let (counts, height) = result?;
                    if target.is_none() {
                        // RPC must cover this prefix. Subsequent live frames must
                        // be contiguous even while the overlap query is pending.
                        for index in 0..2 {
                            next[index] = next[index].max(counts[index]);
                        }
                    }
                    let (since, _, block) = *target.get_or_insert((Instant::now(), counts, height));
                    if !authoritative {
                        let progress = *source
                            .control
                            .ack
                            .recovery
                            .lock()
                            .expect("RPC progress lock");
                        if Kind::ALL
                            .into_iter()
                            .filter(|kind| source.gas_enabled || !matches!(kind, Kind::Gas))
                            .all(|kind| {
                                progress[kind.index()].is_some_and(|progress| {
                                    progress.at >= since && progress.block >= block
                                })
                            })
                            && next == counts
                        {
                            let control = source.control.clone();
                            let generation = control.request();
                            session.start_cutover(source.domain, async move {
                                timeout(RPC_TIMEOUT, control.paused(generation))
                                    .await
                                    .unwrap_or(false)
                            });
                        }
                    } else {
                        for index in 0..2 {
                            // Frames can arrive after the RPC count snapshot was taken.
                            // Hash audits detect reorgs; a newer live count is not one.
                            health[index].observe(counts[index], next[index], false)?;
                        }
                    }
                }
                SessionEvent::Cutover { result, .. } => {
                    ensure!(result, "RPC pause timed out");
                    authoritative = true;
                    self.authority.with_label_values(&[&source.chain]).set(1);
                }
                _ => {}
            }
        }
        Ok(())
    }
}
struct RpcFallback(ScraperSource);
impl Drop for RpcFallback {
    fn drop(&mut self) {
        if !self.0.database.discovery_recovery_pending().unwrap_or(true) {
            self.0.control.resume();
        }
    }
}
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
struct Authority {
    command: watch::Sender<AuthorityCommand>,
    ack: Arc<PauseAck>,
}
impl Authority {
    fn new(domain: u32) -> Self {
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
    fn receiver(&self) -> ScraperAuthorityReceiver {
        ScraperAuthorityReceiver {
            desired: self.command.subscribe(),
            ack: self.ack.clone(),
        }
    }
    fn request(&self) -> u64 {
        self.command.send_if_modified(|command| {
            if command.desired {
                return false;
            }
            command.desired = true;
            command.generation = command
                .generation
                .checked_add(1)
                .expect("RPC handoff generation exhausted");
            true
        });
        self.command.borrow().generation
    }
    fn resume(&self) {
        self.command.send_if_modified(|command| {
            let changed = command.desired;
            command.desired = false;
            changed
        });
    }
    async fn paused(&self, generation: u64) -> bool {
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
#[async_trait]
impl<T: Send + Sync + Debug + 'static> ContractSyncCursor<T> for RecoveryCursor<T> {
    async fn next_action(&mut self) -> Result<(CursorAction, Duration)> {
        let action = self.cursor.next_action().await?;
        self.recovery.progress.lock().expect("RPC recovery lock")[self.recovery.kind.index()] =
            self.cursor.is_caught_up().then(|| RpcProgress {
                at: Instant::now(),
                block: self.cursor.latest_queried_block(),
            });
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
        self.cursor.update(logs, range).await
    }
}

#[derive(Deserialize)]
struct DispatchData {
    origin_mailbox: String,
    nonce: StringOrNumber,
    sender: String,
    recipient: String,
    destination_domain: u32,
    msg_body: Option<String>,
    msg_id: String,
    origin_block_height: StringOrNumber,
    origin_block_hash: Option<String>,
    origin_tx_hash: String,
}
impl DispatchData {
    fn message(&self, domain: u32, mailbox: H256) -> Result<Option<HyperlaneMessage>> {
        ensure!(
            parse_address(&self.origin_mailbox)? == mailbox,
            "Dispatch mailbox does not match configured mailbox"
        );
        let Some(body) = &self.msg_body else {
            return Ok(None);
        };
        let message = HyperlaneMessage {
            version: 3,
            nonce: self.nonce.as_u32("dispatch nonce")?,
            origin: domain,
            sender: parse_address(&self.sender)?,
            destination: self.destination_domain,
            recipient: parse_address(&self.recipient)?,
            body: parse_hex(body)?,
        };
        ensure!(
            message.id() == parse_address(&self.msg_id)?,
            "Dispatch payload does not match its message ID"
        );
        Ok(Some(message))
    }
}

#[derive(Deserialize, Serialize)]
struct GasData {
    destination: u32,
    domain: u32,
    gas_amount: String,
    id: String,
    interchain_gas_paymaster: String,
    log_index: String,
    msg_id: String,
    origin: u32,
    origin_block_hash: Option<String>,
    origin_block_height: Option<String>,
    origin_tx_hash: Option<String>,
    payment: String,
    sequence: Option<String>,
    time_created: String,
    tx_id: Option<String>,
}
impl GasData {
    fn decode(self, paymaster: H256) -> Result<(Indexed<InterchainGasPayment>, LogMeta)> {
        let payment = InterchainGasPayment {
            message_id: parse_address(&self.msg_id)?,
            destination: self.destination,
            payment: U256::from_dec_str(&self.payment)?,
            gas_amount: U256::from_dec_str(&self.gas_amount)?,
        };
        let sequence = self
            .sequence
            .map(|sequence| sequence.parse::<u32>())
            .transpose()?;
        // Legacy rows without receipt metadata cannot be safely deduplicated with
        // RPC logs. Keep gas RPC running until receipt enrichment supplies it.
        let meta = LogMeta {
            address: paymaster,
            block_number: self
                .origin_block_height
                .context("Gas payment needs RPC block metadata")?
                .parse()?,
            block_hash: parse_address(
                &self
                    .origin_block_hash
                    .context("Gas payment needs RPC block hash")?,
            )?,
            transaction_id: parse_tx(
                &self
                    .origin_tx_hash
                    .context("Gas payment needs RPC transaction hash")?,
            )?,
            transaction_index: 0,
            log_index: U256::from_dec_str(&self.log_index)?,
        };
        let mut payment = Indexed::new(payment);
        payment.sequence = sequence;
        Ok((payment, meta))
    }
}
fn event_block_hash(envelope: Option<H256>, payload: Option<&str>) -> Result<H256> {
    let payload = payload.map(parse_address).transpose()?;
    ensure!(
        envelope.zip(payload).is_none_or(|(a, b)| a == b),
        "Conflicting event block identities"
    );
    envelope.or(payload).context("Missing event block identity")
}
fn parse_hex(value: &str) -> Result<Vec<u8>> {
    hex::decode(
        value
            .strip_prefix("0x")
            .or_else(|| value.strip_prefix("\\x"))
            .unwrap_or(value),
    )
    .context("Invalid scraper hex")
}
fn parse_tx(value: &str) -> Result<H512> {
    let bytes = parse_hex(value)?;
    ensure!(
        matches!(bytes.len(), 32 | 64),
        "Invalid transaction hash length"
    );
    Ok(bytes_to_h512(&bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::SinkExt;
    use hyperlane_base::db::test_utils;
    use hyperlane_core::{ChainResult, HyperlaneDomain, SequenceAwareIndexer};
    use prometheus::Registry;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicBool, AtomicU32};
    use tokio::net::{TcpListener, TcpStream};
    use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
    #[derive(Debug)]
    struct Counts(AtomicU32, AtomicBool);
    #[async_trait]
    impl<T: Send + Sync + 'static> Indexer<T> for Counts {
        async fn fetch_logs_in_range(
            &self,
            _: RangeInclusive<u32>,
        ) -> ChainResult<Vec<(Indexed<T>, LogMeta)>> {
            unreachable!("count probes only")
        }
        async fn get_finalized_block_number(&self) -> ChainResult<u32> {
            Ok(99)
        }
    }
    #[async_trait]
    impl<T: Send + Sync + 'static> SequenceAwareIndexer<T> for Counts {
        async fn latest_sequence_count_and_tip(&self) -> ChainResult<(Option<u32>, u32)> {
            Ok((
                self.1
                    .load(Ordering::Acquire)
                    .then(|| self.0.load(Ordering::Acquire)),
                100,
            ))
        }
    }
    #[derive(Debug)]
    struct Blocks(AtomicU64, AtomicBool);
    impl hyperlane_core::HyperlaneChain for Blocks {
        fn domain(&self) -> &HyperlaneDomain {
            unreachable!("block checks only")
        }
        fn provider(&self) -> Box<dyn HyperlaneProvider> {
            unreachable!("block checks only")
        }
    }
    #[async_trait]
    impl HyperlaneProvider for Blocks {
        async fn get_block_by_height(&self, height: u64) -> ChainResult<hyperlane_core::BlockInfo> {
            if self.1.load(Ordering::Acquire) {
                return Err(hyperlane_core::ChainCommunicationError::from_other_str(
                    "RPC unavailable",
                ));
            }
            Ok(hyperlane_core::BlockInfo {
                number: height,
                hash: H256::from_low_u64_be(if height < 100 {
                    8
                } else {
                    self.0.load(Ordering::Acquire)
                }),
                timestamp: 0,
            })
        }
        async fn get_txn_by_hash(&self, _: &H512) -> ChainResult<hyperlane_core::TxnInfo> {
            unreachable!()
        }
        async fn is_contract(&self, _: &H256) -> ChainResult<bool> {
            unreachable!()
        }
        async fn get_balance(&self, _: String) -> ChainResult<U256> {
            unreachable!()
        }
        async fn get_chain_metrics(&self) -> ChainResult<Option<hyperlane_core::ChainInfo>> {
            unreachable!()
        }
    }
    fn message(nonce: u32) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce,
            origin: 5,
            destination: 6,
            sender: H256::from_low_u64_be(3),
            recipient: H256::from_low_u64_be(4),
            body: vec![1, 2, 3],
        }
    }
    fn dispatch(nonce: u32) -> Value {
        let message = message(nonce);
        json!({"nonce": nonce, "origin_mailbox": format!("{:#x}", H256::from_low_u64_be(1)), "sender": format!("{:#x}", message.sender), "recipient": format!("{:#x}", message.recipient), "destination_domain": 6,
            "msg_id": format!("{:#x}", message.id()), "msg_body": "\\x010203", "origin_block_height": "100", "origin_block_hash": format!("{:#x}", H256::from_low_u64_be(8)), "origin_tx_hash": format!("{:#x}", H256::from_low_u64_be(9))})
    }
    fn merkle(nonce: u32) -> Value {
        json!({"domain":5, "merkle_tree_hook":format!("{:#x}", H256::from_low_u64_be(2)), "leaf_index":nonce, "message_id":format!("{:#x}", message(nonce).id()), "block_number":"100", "block_hash": format!("{:#x}", H256::from_low_u64_be(8))})
    }
    fn gas(cursor: u64) -> Value {
        json!({"destination":6, "domain":5, "origin":5, "id":cursor.to_string(),
            "interchain_gas_paymaster":format!("{:#x}", H256::from_low_u64_be(3)),
            "time_created":"2026-10-27T00:00:00Z", "tx_id":"9",
            "gas_amount":"50000", "payment":"1000", "msg_id":format!("{:#x}", H256::from_low_u64_be(7)), "log_index":cursor.to_string(), "sequence":null,
            "origin_block_hash":format!("{:#x}", H256::from_low_u64_be(8)), "origin_block_height":"100", "origin_tx_hash":format!("{:#x}", H256::from_low_u64_be(9))})
    }
    async fn send(socket: &mut WebSocketStream<TcpStream>, value: Value) {
        socket
            .send(Message::Text(value.to_string().into()))
            .await
            .expect("send frame");
    }
    async fn handshake(listener: &TcpListener) -> (WebSocketStream<TcpStream>, Value) {
        let (tcp, _) = listener.accept().await.expect("accept");
        let mut socket = accept_async(tcp).await.expect("WebSocket");
        send(
            &mut socket,
            json!({"type":"ready", "streamCursorVersions":{"gas_payment":3}}),
        )
        .await;
        let frame = socket.next().await.expect("subscription").expect("frame");
        let request: Value = serde_json::from_str(frame.to_text().expect("text")).expect("JSON");
        let mut response = request["streams"].clone();
        for stream in response.as_array_mut().expect("streams") {
            if let Some(cursors) = stream["cursors"].as_array_mut() {
                for cursor in cursors {
                    cursor
                        .as_object_mut()
                        .expect("cursor")
                        .remove("allowReplay");
                }
            }
        }
        send(
            &mut socket,
            json!({"type":"subscribed", "streams":response}),
        )
        .await;
        (socket, request)
    }
    async fn listener() -> (TcpListener, Url) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("listener");
        let url =
            Url::parse(&format!("ws://{}", listener.local_addr().expect("address"))).expect("URL");
        (listener, url)
    }
    fn timeouts() -> StreamTimeouts {
        StreamTimeouts {
            progress_check: Duration::from_millis(10),
            ..StreamTimeouts::default()
        }
    }
    async fn eventually(mut condition: impl FnMut() -> bool) {
        timeout(Duration::from_secs(5), async {
            while !condition() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("condition");
    }
    fn acknowledge(source: &ScraperSource) -> tokio::task::JoinHandle<()> {
        let mut receiver = source.control.receiver();
        let domain = source.domain;
        tokio::spawn(async move {
            while receiver.changed().await.is_ok() {
                let command = receiver.borrow_and_update();
                if command.desired {
                    receiver.mark_paused(domain, command.generation);
                }
            }
        })
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        source: ScraperSource,
        monitor: Arc<ScraperWebSocketMonitor>,
        blocks: Arc<Blocks>,
    }
    impl Fixture {
        fn new(url: Url) -> Self {
            Self::with_confirmations(url, Some(0), true)
        }
        fn with_confirmations(url: Url, confirmations: Option<u32>, provisional: bool) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let db = HyperlaneRocksDB::new(
                &HyperlaneDomain::new_test_domain("origin"),
                test_utils::setup_db(dir.path().to_string_lossy().into_owned()),
            );
            let counts = Arc::new(Counts(AtomicU32::new(0), AtomicBool::new(true)));
            let blocks = Arc::new(Blocks(AtomicU64::new(8), AtomicBool::new(false)));
            let source = ScraperSource::new(
                "origin".into(),
                5,
                H256::from_low_u64_be(1),
                H256::from_low_u64_be(3),
                H256::from_low_u64_be(2),
                db,
            )
            .unwrap()
            .with_confirmations(confirmations)
            .with_block_provider(blocks.clone())
            .with_freshness_indexer(counts.clone())
            .with_merkle_freshness_indexer(counts.clone())
            .with_recovery(
                provisional.then_some(counts),
                Arc::new(RwLock::new(MerkleTreeBuilder::new())),
                true,
                true,
            );
            if provisional {
                source
                    .database
                    .enable_discovery(DiscoveryCheckpoint {
                        height: 99,
                        hash: H256::from_low_u64_be(8),
                    })
                    .unwrap();
            }
            let metrics = CoreMetrics::new("discovery-test", 9090, Registry::new()).unwrap();
            let monitor = Arc::new(
                ScraperWebSocketMonitor::new_with_authority(
                    Some(url),
                    vec![source.clone()],
                    &metrics,
                    true,
                )
                .unwrap(),
            );
            Self {
                _dir: dir,
                source,
                monitor,
                blocks,
            }
        }
        fn connect(&self, url: Url) -> tokio::task::JoinHandle<Result<()>> {
            let monitor = self.monitor.clone();
            let source = self.source.clone();
            tokio::spawn(async move { monitor.stream(&source, &url, timeouts()).await })
        }
    }
    fn event(kind: Kind, sequence: u32, data: Value) -> Value {
        json!({"type":"event", "domain":5, "eventType":kind.label(), "confirmations":0, "sequence":sequence.to_string(), "data":data})
    }

    #[tokio::test]
    async fn confirmed_vm_streams_ingest_cut_over_and_restore_rpc_on_gaps() {
        for confirmations in [Some(7), None] {
            let (listener, url) = listener().await;
            let fixture = Fixture::with_confirmations(url.clone(), confirmations, false);
            assert!(fixture.monitor.authority_receiver(5).is_some());
            // These adapters need neither the EVM finality RPC nor its journal.
            fixture.blocks.1.store(true, Ordering::Release);
            fixture.source.verify_live_blocks().await.unwrap();
            fixture.source.audit().await.unwrap();
            let ack = acknowledge(&fixture.source);
            let task = fixture.connect(url);
            let (mut socket, subscription) = handshake(&listener).await;
            for stream in subscription["streams"].as_array().unwrap() {
                assert_eq!(
                    stream["confirmations"].as_u64(),
                    confirmations.map(u64::from)
                );
                assert!(stream.get("cursors").is_none());
            }
            // Cover the live subscription with RPC history before pausing writers.
            tokio::time::sleep(Duration::from_millis(50)).await;
            fixture
                .source
                .control
                .ack
                .recovery
                .lock()
                .unwrap()
                .fill(Some(RpcProgress {
                    at: Instant::now(),
                    block: 100,
                }));
            eventually(|| {
                fixture
                    .monitor
                    .authority
                    .with_label_values(&["origin"])
                    .get()
                    == 1
            })
            .await;
            for (kind, mut data) in [
                (Kind::Dispatch, dispatch(0)),
                (Kind::Merkle, merkle(0)),
                (Kind::Gas, gas(1)),
            ] {
                // Older confirmed dispatch/Merkle projections can omit hashes.
                if !matches!(kind, Kind::Gas) {
                    data.as_object_mut().unwrap().remove("origin_block_hash");
                    data.as_object_mut().unwrap().remove("block_hash");
                }
                let mut frame = event(kind, 0, data);
                frame["confirmations"] = json!(confirmations);
                send(&mut socket, frame.clone()).await;
                send(&mut socket, frame).await;
            }
            eventually(|| {
                fixture
                    .source
                    .database
                    .retrieve_gas_payment_by_gas_payment_key(hyperlane_core::GasPaymentKey {
                        message_id: H256::from_low_u64_be(7),
                        destination: 6,
                    })
                    .unwrap()
                    .is_some()
            })
            .await;
            assert_eq!(
                fixture
                    .source
                    .database
                    .retrieve_message_by_nonce(0)
                    .unwrap(),
                Some(message(0))
            );
            assert!(fixture
                .source
                .database
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .unwrap()
                .is_some());
            assert!(fixture
                .source
                .database
                .discovery_checkpoint()
                .unwrap()
                .is_none());
            assert_eq!(fixture.source.database.discovery_generation(), 0);

            let mut gap = event(Kind::Dispatch, 2, dispatch(2));
            gap["confirmations"] = json!(confirmations);
            send(&mut socket, gap).await;
            assert!(timeout(Duration::from_secs(5), task)
                .await
                .unwrap()
                .unwrap()
                .is_err());
            assert!(!fixture.source.control.command.borrow().desired);
            assert!(!fixture
                .source
                .database
                .discovery_recovery_pending()
                .unwrap());
            ack.abort();
        }
    }

    #[tokio::test]
    async fn confirmed_vm_rejects_wrong_depth_and_halts_on_rollback() {
        let (listener, url) = listener().await;
        let fixture = Fixture::with_confirmations(url.clone(), Some(7), false);
        assert!(fixture
            .source
            .store(serde_json::from_value(event(Kind::Dispatch, 0, dispatch(0)),).unwrap())
            .await
            .is_err());
        assert!(fixture
            .source
            .database
            .retrieve_message_by_nonce(0)
            .unwrap()
            .is_none());
        let task = fixture.connect(url);
        let (mut socket, _) = handshake(&listener).await;
        send(&mut socket, json!({"type":"rollback", "domain":5, "eventType":"dispatch", "confirmations":7, "toHeight":99})).await;
        let error = timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .unwrap_err();
        assert!(error.is::<RollbackRecoveryRequired>());
        assert!(fixture
            .source
            .database
            .confirmed_discovery_conflict()
            .unwrap());
        assert!(!fixture
            .source
            .database
            .discovery_recovery_pending()
            .unwrap());
        assert_eq!(fixture.source.database.discovery_generation(), 0);
    }

    #[tokio::test]
    async fn zero_confirmation_events_share_rpc_deduplication_and_rollback() {
        let (listener, url) = listener().await;
        let fixture = Fixture::new(url.clone());
        let task = fixture.connect(url);
        let (mut socket, subscription) = handshake(&listener).await;
        assert_eq!(subscription["streams"].as_array().unwrap().len(), 3);
        for stream in subscription["streams"].as_array().unwrap() {
            assert_eq!(stream["confirmations"], 0);
            assert!(stream.get("cursors").is_none());
        }
        for value in [
            event(Kind::Dispatch, 0, dispatch(0)),
            event(Kind::Merkle, 0, merkle(0)),
            event(Kind::Gas, 0, gas(1)),
            event(Kind::Gas, 0, gas(1)),
        ] {
            send(&mut socket, value).await;
        }
        eventually(|| {
            fixture
                .source
                .database
                .retrieve_gas_payment_by_gas_payment_key(hyperlane_core::GasPaymentKey {
                    message_id: H256::from_low_u64_be(7),
                    destination: 6,
                })
                .unwrap()
                .is_some()
        })
        .await;
        assert_eq!(
            fixture
                .source
                .database
                .retrieve_message_by_nonce(0)
                .unwrap(),
            Some(message(0))
        );
        assert_eq!(
            fixture
                .source
                .database
                .retrieve_merkle_tree_insertion_by_leaf_index(&0)
                .unwrap()
                .unwrap()
                .message_id(),
            message(0).id()
        );
        let data: GasData = serde_json::from_value(gas(1)).unwrap();
        let (payment, meta) = data
            .decode(fixture.source.interchain_gas_paymaster)
            .unwrap();
        assert!(!fixture
            .source
            .database
            .process_indexed_gas_payment(payment, &meta)
            .unwrap());
        send(&mut socket, json!({"type":"rollback", "domain":5, "eventType":"dispatch", "confirmations":0, "toHeight":99})).await;
        assert!(timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap()
            .is_err());
        assert!(fixture
            .source
            .database
            .discovery_recovery_pending()
            .unwrap());
        fixture.source.rewind().await.unwrap();
        assert!(fixture
            .source
            .database
            .retrieve_message_by_nonce(0)
            .unwrap()
            .is_none());
        assert!(fixture
            .source
            .database
            .ensure_no_indexed_event_conflict()
            .is_ok());
    }

    #[tokio::test]
    async fn rpc_covers_all_streams_after_subscribing_before_cutover() {
        let (listener, url) = listener().await;
        let fixture = Fixture::new(url.clone());
        let ack = acknowledge(&fixture.source);
        let task = fixture.connect(url);
        let (socket, _) = handshake(&listener).await;
        tokio::time::sleep(Duration::from_millis(50)).await;
        for index in 0..2 {
            fixture.source.control.ack.recovery.lock().unwrap()[index] = Some(RpcProgress {
                at: Instant::now(),
                block: 100,
            });
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(
            !fixture.source.control.command.borrow().desired,
            "gas history must be covered too"
        );
        fixture.source.control.ack.recovery.lock().unwrap()[2] = Some(RpcProgress {
            at: Instant::now(),
            block: 100,
        });
        eventually(|| {
            fixture
                .monitor
                .authority
                .with_label_values(&["origin"])
                .get()
                == 1
        })
        .await;
        drop(socket);
        task.await.unwrap().ok();
        assert!(!fixture.source.control.command.borrow().desired);
        ack.abort();
    }

    #[tokio::test]
    async fn rpc_only_audit_recovers_a_live_reorg_and_resumes_writers() {
        let fixture = Fixture::new(Url::parse("ws://localhost:1").unwrap());
        fixture
            .source
            .store(serde_json::from_value(event(Kind::Dispatch, 0, dispatch(0))).unwrap())
            .await
            .unwrap();
        let ack = acknowledge(&fixture.source);
        let source = fixture.source.clone();
        let audit = tokio::spawn(async move { source.audit().await });
        tokio::time::sleep(Duration::from_millis(50)).await;
        fixture.blocks.0.store(9, Ordering::Release);
        timeout(Duration::from_secs(10), async {
            while fixture.source.database.discovery_generation() == 0 {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            while fixture
                .source
                .database
                .discovery_recovery_pending()
                .unwrap()
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        eventually(|| !fixture.source.control.command.borrow().desired).await;
        assert!(fixture
            .source
            .database
            .retrieve_message_by_nonce(0)
            .unwrap()
            .is_none());
        assert!(fixture
            .source
            .database
            .ensure_no_indexed_event_conflict()
            .is_ok());
        audit.abort();
        ack.abort();
    }

    #[tokio::test]
    async fn zero_configured_reorg_period_has_no_automatic_recovery_window() {
        let mut fixture = Fixture::new(Url::parse("ws://localhost:1").unwrap());
        fixture.source.recover_provisional = false;
        fixture
            .source
            .store(serde_json::from_value(event(Kind::Dispatch, 0, dispatch(0))).unwrap())
            .await
            .unwrap();
        fixture
            .source
            .database
            .request_discovery_recovery()
            .unwrap();
        assert!(fixture
            .source
            .rewind()
            .await
            .unwrap_err()
            .is::<RollbackRecoveryRequired>());
        assert_eq!(
            fixture
                .source
                .database
                .retrieve_message_by_nonce(0)
                .unwrap(),
            Some(message(0))
        );
        assert_eq!(fixture.source.database.discovery_generation(), 0);
    }

    #[tokio::test]
    async fn confirmed_reorg_halts_without_rewriting_history_online_and_after_restart() {
        for online in [false, true] {
            let fixture = Fixture::new(Url::parse("ws://localhost:1").unwrap());
            fixture
                .source
                .store(serde_json::from_value(event(Kind::Dispatch, 0, dispatch(0))).unwrap())
                .await
                .unwrap();
            let checkpoint = DiscoveryCheckpoint {
                height: 100,
                hash: H256::from_low_u64_be(8),
            };
            fixture
                .source
                .database
                .confirm_discovery(checkpoint, &[checkpoint])
                .unwrap();
            fixture.blocks.0.store(9, Ordering::Release);
            let error = if online {
                fixture.source.audit().await.unwrap_err()
            } else {
                fixture.source.verify_live_blocks().await.unwrap_err()
            };
            assert!(error.is::<RollbackRecoveryRequired>());
            assert_eq!(
                fixture
                    .source
                    .database
                    .retrieve_message_by_nonce(0)
                    .unwrap(),
                Some(message(0))
            );
            assert_eq!(fixture.source.database.discovery_generation(), 0);
            assert!(fixture
                .source
                .database
                .ensure_no_indexed_event_conflict()
                .is_err());
            assert!(fixture.source.database.rollback_discovery().is_err());
            assert!(fixture.source.database.finish_discovery_recovery().is_err());
        }
    }
}
