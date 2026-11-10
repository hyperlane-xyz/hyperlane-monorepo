//! Project noisy implementation observations into changes to public diagnostic state.
//! Runs exclusively on the background writer; never delays message delivery.
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
    time::Duration,
};

use hyperlane_base::db::DB;
use moka::future::Cache;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{Activity, ObservationEvent, StoredActivity, StoredEvent, H256};

const STATE_CACHE_ENTRIES: u64 = 10_000;

#[derive(Clone, Deserialize, Serialize)]
struct MessageState {
    current: BTreeMap<String, Value>,
    #[serde(skip)]
    published_snapshot: Option<Arc<Value>>,
    #[serde(skip)]
    anchor_snapshot: Option<Arc<Value>>,
    submitted_validation: Option<Value>,
    #[serde(skip)]
    persistence_pending: bool,
}

impl Default for MessageState {
    fn default() -> Self {
        Self {
            current: BTreeMap::from([("message".to_owned(), json!({"phase": "preparing"}))]),
            published_snapshot: None,
            anchor_snapshot: None,
            submitted_validation: None,
            persistence_pending: false,
        }
    }
}

pub(super) struct ActivityState {
    messages: Cache<H256, MessageState>,
    database: Option<DB>,
}

impl ActivityState {
    pub(super) fn new(database: Option<DB>) -> Self {
        Self {
            database,
            messages: Cache::builder()
                .max_capacity(STATE_CACHE_ENTRIES)
                .time_to_idle(Duration::from_secs(24 * 60 * 60))
                .build(),
        }
    }

    pub(super) async fn failed(&self, events: &[ObservationEvent]) {
        for event in events {
            if let Some(mut state) = self.messages.get(&event.message_id).await {
                // The next observation republishes the complete known baseline after a failed write.
                state.published_snapshot = None;
                state.anchor_snapshot = None;
                self.messages.insert(event.message_id, state).await;
            }
        }
    }

    async fn load(&self, id: H256) -> eyre::Result<MessageState> {
        if let Some(state) = self.messages.get(&id).await {
            return Ok(state);
        }
        let Some(database) = self.database.clone() else {
            return Ok(MessageState::default());
        };
        tokio::task::spawn_blocking(move || {
            database
                .retrieve(&state_key(id))?
                .map(|bytes| serde_json::from_slice(&bytes).map_err(Into::into))
                .unwrap_or_else(|| Ok(MessageState::default()))
        })
        .await?
    }

    async fn persist(&self, id: H256, state: &MessageState) -> eyre::Result<()> {
        if let Some(database) = self.database.clone() {
            let bytes = serde_json::to_vec(state)?;
            tokio::task::spawn_blocking(move || database.store(&state_key(id), &bytes)).await??;
        }
        Ok(())
    }

    pub(super) async fn committed(&self, events: &[StoredEvent]) -> eyre::Result<()> {
        // A batch can include a terminal attempt followed by a manual retry.
        // Only the last projected state may retire that message's pending record.
        let latest = events
            .iter()
            .map(|event| (event.message_id, event))
            .collect::<BTreeMap<_, _>>();
        for event in latest.values() {
            let (StoredActivity::Snapshot { state } | StoredActivity::SnapshotUpdate { state }) =
                &event.activity;
            if state["phase"] == "delivered" || state["phase"] == "dropped" {
                if let Some(database) = self.database.clone() {
                    let key = state_key(event.message_id);
                    tokio::task::spawn_blocking(move || database.delete(&key)).await??;
                }
            }
        }
        Ok(())
    }

    pub(super) async fn project(
        &self,
        events: &[ObservationEvent],
    ) -> eyre::Result<Vec<StoredEvent>> {
        let mut output = Vec::new();
        for event in events {
            let mut state = self.load(event.message_id).await?;
            let delivered = state
                .current
                .get("message")
                .is_some_and(|message| message["phase"] == "delivered");
            // Preserve the submitted path after delivery, but still allow a
            // frozen terminal anchor to be republished after a failed write.
            if !delivered {
                state.observe(event)?;
            }
            // Retrying preparation invalidates the previous submission path.
            // Confirmation polling uses reason=None and retains the same path.
            let invalidated_submission = !delivered
                && matches!(
                    event.activity,
                    Activity::Retry {
                        reason: Some(_),
                        ..
                    } | Activity::Status {
                        status: super::PendingOperationStatus::Retry(_)
                    }
                )
                && state.submitted_validation.take().is_some();
            let submitted = !delivered
                && matches!(
                    event.activity,
                    Activity::Status {
                        status: super::PendingOperationStatus::Confirm(
                            super::ConfirmReason::SubmittedBySelf
                        )
                    }
                );
            if submitted {
                state.submitted_validation = Some(state.validation());
            }
            state.persistence_pending |= submitted || invalidated_submission;
            let persisted = if state.persistence_pending {
                // A failed write is not a durable transition. Keep it pending
                // in cache and retry on subsequent observations.
                let result = self.persist(event.message_id, &state).await;
                if result.is_ok() {
                    state.persistence_pending = false;
                }
                result
            } else {
                Ok(())
            };
            // Initial discovery is accumulated into one whole-tree snapshot. Afterwards,
            // checkpoint/verification changes can animate progress without replaying configuration.
            let root_result = matches!(event.activity, Activity::Metadata { .. })
                && event.node_id.as_ref().is_some_and(|id| !id.contains('/'));
            let meaningful = (delivered && state.published_snapshot.is_none())
                || root_result
                || match &event.activity {
                    Activity::Checkpoint { .. }
                    | Activity::IsmVerification { .. }
                    | Activity::OffchainRead { .. } => state.published_snapshot.is_some(),
                    Activity::Retry {
                        reason: Some(_), ..
                    }
                    | Activity::Status { .. }
                    | Activity::Delivered
                    | Activity::Dropped
                    | Activity::RetryLimitReached { .. }
                    | Activity::Filtered { .. }
                    | Activity::ChainFailure { .. }
                    | Activity::ConfirmationError { .. }
                    | Activity::TransactionOutcome { .. }
                    | Activity::Submission { .. }
                    | Activity::RecipientNotContract
                    | Activity::OriginSenderDenied => true,
                    _ => false,
                };
            if meaningful {
                let snapshot = state.snapshot();
                if state.published_snapshot.as_deref() != Some(&snapshot) {
                    let anchor = state.published_snapshot.is_none()
                        || matches!(
                            event.activity,
                            Activity::Status {
                                status: super::PendingOperationStatus::ReadyToSubmit
                            } | Activity::Delivered
                                | Activity::Dropped
                                | Activity::Filtered { .. }
                                | Activity::RetryLimitReached { .. }
                        );
                    let snapshot = Arc::new(snapshot);
                    let activity = if anchor {
                        state.anchor_snapshot = Some(snapshot.clone());
                        StoredActivity::Snapshot {
                            state: snapshot.as_ref().clone(),
                        }
                    } else {
                        StoredActivity::SnapshotUpdate {
                            state: snapshot_update(
                                state
                                    .anchor_snapshot
                                    .as_ref()
                                    .expect("full snapshot anchor"),
                                &snapshot,
                            ),
                        }
                    };
                    output.push(StoredEvent {
                        relayer: event.relayer,
                        observed_at: event.observed_at,
                        message_id: event.message_id,
                        origin: event.origin,
                        destination: event.destination,
                        activity,
                    });
                    state.published_snapshot = Some(snapshot);
                }
            }
            self.messages.insert(event.message_id, state).await;
            persisted?;
        }
        Ok(output)
    }
}

/// An update carries complete message-level state and complete replacements for
/// nodes changed since the latest full anchor. Consumers upsert nodes by `node_id`
/// and remove tombstoned IDs. Every update can therefore be applied directly to
/// its anchor without replaying intermediate updates.
fn snapshot_update(anchor: &Value, current: &Value) -> Value {
    let anchor_modules = anchor["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|module| Some((module["node_id"].as_str()?.to_owned(), module)))
        .collect::<BTreeMap<_, _>>();
    let current_modules = current["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|module| Some((module["node_id"].as_str()?.to_owned(), module)))
        .collect::<BTreeMap<_, _>>();
    let changed = current["modules"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|module| {
            module["node_id"]
                .as_str()
                .is_none_or(|id| anchor_modules.get(id).copied() != Some(*module))
        })
        .cloned()
        .collect::<Vec<_>>();
    let removed = anchor_modules
        .keys()
        .filter(|id| !current_modules.contains_key(*id))
        .cloned()
        .collect::<Vec<_>>();
    let mut update = current.clone();
    update["modules"] = json!(changed);
    update["removed_modules"] = json!(removed);
    update
}

fn state_key(id: H256) -> Vec<u8> {
    let mut key = b"relayer_diagnostics_snapshot_v1_".to_vec();
    key.extend_from_slice(id.as_bytes());
    key
}

impl MessageState {
    /// Build the entire public tree here; the proxy only validates/returns this value.
    fn validation(&self) -> Value {
        let root = self.current.get("tree").and_then(Value::as_str);
        let mut modules = Vec::new();
        let mut pending = root
            .map(|id| vec![(id.to_owned(), id.to_owned())])
            .unwrap_or_default();
        let mut visited = BTreeSet::new();
        while let Some((id, address)) = pending.pop() {
            if !visited.insert(id.clone()) {
                continue;
            }
            let key = format!("node:{id}");
            let mut node = self
                .current
                .get(&key)
                .cloned()
                .unwrap_or_else(|| json!({"node_id": id, "ism": address, "children": []}));
            node["discovered"] = json!(node.get("module_type").is_some());
            if let Some(children) = node["children"].as_array() {
                pending.extend(children.iter().rev().filter_map(|child| {
                    Some((
                        child["node_id"].as_str()?.to_owned(),
                        child["ism"].as_str()?.to_owned(),
                    ))
                }));
            }
            if let Some(mut signatures) = node
                .get("signatures")
                .or_else(|| node.get("discovery"))
                .cloned()
            {
                for (field, value_field) in [
                    ("unavailable", "reason"),
                    ("latest_indices", "index"),
                    ("discovery_unavailable", "reason"),
                ] {
                    signatures[field] = json!(signatures[field]
                        .as_object()
                        .into_iter()
                        .flatten()
                        .map(
                            |(validator, value)| json!({"validator": validator, value_field: value})
                        )
                        .collect::<Vec<_>>());
                }
                node["signatures"] = signatures;
            }
            if let Some(fields) = node.as_object_mut() {
                fields.remove("discovery");
            }
            modules.push(node);
        }
        json!({"tree_root": root, "modules": modules})
    }

    fn snapshot(&self) -> Value {
        let mut state = self
            .current
            .get("message")
            .cloned()
            .unwrap_or_else(|| json!({"phase": "preparing"}));
        let delivered = state["phase"] == "delivered";
        let validation = if delivered {
            self.submitted_validation.clone().unwrap_or_else(|| {
                // A previously inspected tree is not evidence of another submitter's
                // validation path. Its observations remain in earlier snapshots.
                json!({"tree_root": null, "modules": []})
            })
        } else {
            self.validation()
        };
        for field in ["tree_root", "modules"] {
            state[field] = validation[field].clone();
        }
        if state["retry"].is_object() {
            let reason = &state["retry"]["reason"];
            let code = if let Some(reason) = reason.as_str() {
                reason.to_owned()
            } else if let Some(reason) = reason.as_object().filter(|reason| reason.len() == 1) {
                reason
                    .iter()
                    .next()
                    .and_then(|(tag, reason)| Some(format!("{tag}.{}", reason.as_str()?)))
                    .unwrap_or_else(|| "unknown".into())
            } else {
                "unknown".into()
            };
            state["retry"]["reason"] = json!(code);
        }
        state
    }

    fn prune_tree(&mut self) {
        let Some(root) = self.current.get("tree").and_then(Value::as_str) else {
            return;
        };
        let mut pending = vec![root.to_owned()];
        let mut reachable = BTreeSet::new();
        while let Some(id) = pending.pop() {
            let key = format!("node:{id}");
            if !reachable.insert(key.clone()) {
                continue;
            }
            if let Some(children) = self
                .current
                .get(&key)
                .and_then(|node| node["children"].as_array())
            {
                pending.extend(
                    children
                        .iter()
                        .filter_map(|child| child["node_id"].as_str().map(str::to_owned)),
                );
            }
        }
        self.current
            .retain(|key, _| !key.starts_with("node:") || reachable.contains(key));
    }

    fn observe(&mut self, event: &ObservationEvent) -> eyre::Result<()> {
        if self
            .current
            .get("message")
            .is_some_and(|state| state["phase"] == "delivered")
        {
            return Ok(());
        }
        // Activity contains only bounded, explicitly sanitized fields.
        let value = serde_json::to_value(&event.activity)?;
        if let Some(id) = &event.node_id {
            let root = id.split('/').next().unwrap_or(id);
            self.current.insert("tree".into(), json!(root));
            let key = format!("node:{id}");
            let node = self.current.entry(key).or_insert_with(|| {
                json!({"node_id": id, "ism": id.rsplit(':').next().unwrap_or(id), "children": []})
            });
            match &event.activity {
                Activity::InlineModule {
                    kind,
                    children,
                    threshold,
                } => {
                    node["module_type"] = json!(kind);
                    node["threshold"] = json!(threshold);
                    let address = node["ism"].clone();
                    node["children"] = json!((0..*children).map(|i|
                        json!({"node_id": format!("{id}/{i}:{}", address.as_str().unwrap_or_default()), "ism": address})
                    ).collect::<Vec<_>>());
                }
                Activity::MetadataModule { .. } => {
                    node["module_type"] = value["module_type"].clone()
                }
                Activity::Aggregation { modules, .. } => {
                    node["threshold"] = value["threshold"].clone();
                    node["children"] = json!(modules.iter().enumerate().map(|(i, addr)|
                        json!({"node_id": format!("{id}/{i}:{addr:#x}"), "ism": addr})
                    ).collect::<Vec<_>>());
                }
                Activity::Routing { module, .. } => {
                    node["children"] =
                        json!([{"node_id": format!("{id}/0:{module:#x}"), "ism": module}]);
                    node["selected_children"] = json!([format!("{id}/0:{module:#x}")]);
                }
                Activity::ValidatorSet { .. } => {
                    if node.get("validators").is_some()
                        && (node["validators"] != value["validators"]
                            || node["threshold"] != value["threshold"])
                    {
                        // A new validator set invalidates the old quorum and verification.
                        for field in [
                            "signatures",
                            "verification",
                            "metadata_status",
                            "metadata_error",
                        ] {
                            node.as_object_mut().map(|n| n.remove(field));
                        }
                    }
                    node["validators"] = value["validators"].clone();
                    node["threshold"] = value["threshold"].clone();
                }
                Activity::Metadata { error, .. } => {
                    node["metadata_status"] =
                        json!(if error.is_some() { "blocked" } else { "ready" });
                    node["metadata_error"] = json!(error);
                    if error.is_some() {
                        node["verification"] = Value::Null;
                        if let Some(fields) = node.as_object_mut() {
                            fields.remove("selected_children");
                        }
                    }
                }
                Activity::AggregationSelection { indices } => {
                    node["selected_children"] = json!(indices
                        .iter()
                        .filter_map(|index| node["children"]
                            .get(*index)
                            .map(|child| child["node_id"].clone()))
                        .collect::<Vec<_>>());
                }
                Activity::IsmVerification { .. } => node["verification"] = value["outcome"].clone(),
                Activity::AggregationProgress { .. } => {
                    node["verified"] = value["verified"].clone()
                }
                Activity::Checkpoint { .. } => {
                    let mut summary = value["summary"].clone();
                    if let Some(summary) = summary.as_object_mut() {
                        summary.remove("attempts");
                    }
                    summary["threshold"] = value["threshold"].clone();
                    // Discovery-only results are distinct from fetching a checkpoint. Do not
                    // reset an observed signature count to zero just because discovery ran again.
                    if summary["index"].is_null() {
                        if let Some(signatures) = node.get_mut("signatures") {
                            for field in ["latest_indices", "discovery_unavailable"] {
                                if let (Some(current), Some(update)) = (
                                    signatures[field].as_object_mut(),
                                    summary[field].as_object(),
                                ) {
                                    current.extend(update.clone());
                                }
                            }
                        } else {
                            node["discovery"] = summary;
                        }
                    } else {
                        if node.get("signatures").is_some()
                            && (node["signatures"]["index"] != summary["index"]
                                || node["signatures"]["root"] != summary["root"])
                        {
                            if let Some(fields) = node.as_object_mut() {
                                fields.remove("verification");
                                fields.remove("metadata_status");
                                fields.remove("metadata_error");
                            }
                        }
                        node["signatures"] = summary;
                        node.as_object_mut().map(|n| n.remove("discovery"));
                    }
                }
                Activity::OffchainRead { .. } => {
                    let mut observation = value.clone();
                    if let Some(o) = observation.as_object_mut() {
                        o.remove("type");
                        o.remove("ism");
                        o.remove("attempt");
                    }
                    node["offchain_read"] = observation;
                }
                Activity::MerkleLeaf { .. } => {
                    node["merkle_leaf"] =
                        json!({"index": value["index"], "highest_known": value["highest_known"]});
                }
                Activity::Progress {
                    outcome: super::Outcome::Started,
                    ..
                } => {}
                Activity::Progress { .. } => {
                    let stage = value["stage"].as_str().unwrap_or("unknown");
                    if node.get("checks").is_none() {
                        node["checks"] = json!({});
                    }
                    node["checks"][stage] = value["outcome"].clone();
                }
                _ => {}
            }
            self.prune_tree();
            return Ok(());
        }
        let message = self
            .current
            .entry("message".into())
            .or_insert_with(|| json!({"phase": "preparing"}));
        let phase = match &event.activity {
            Activity::Retry {
                reason: Some(reason),
                ..
            } => {
                message["retry"] = json!({"reason": value["reason"], "count": value["retry_count"], "observed_at_millis": event.observed_at, "next_attempt_at_millis": value["next_attempt_at_millis"]});
                Some(
                    if matches!(reason, super::ReprepareReason::AwaitingValidatorSignatures) {
                        "awaiting_signatures"
                    } else {
                        "retrying"
                    },
                )
            }
            // Scheduling confirmation is not a retry.
            Activity::Retry { reason: None, .. } => None,
            Activity::Status { status } => match status {
                super::PendingOperationStatus::ReadyToSubmit => Some("ready_to_submit"),
                super::PendingOperationStatus::Confirm(_) => Some("confirming"),
                super::PendingOperationStatus::Retry(reason) => {
                    // Normal reprepare reports count/deadline before setting
                    // Retry status. Preserve that matching observation; a
                    // status-only manual reset cannot supply those details.
                    if matches!(reason, super::ReprepareReason::Manual)
                        || message["retry"]["reason"] != value["status"]["Retry"]
                    {
                        message["retry"] = Value::Null;
                    }
                    Some(
                        if matches!(reason, super::ReprepareReason::AwaitingValidatorSignatures) {
                            "awaiting_signatures"
                        } else {
                            "retrying"
                        },
                    )
                }
                _ => None,
            },
            Activity::FirstSeen { at_millis } => {
                message["relayer_first_seen_at_millis"] = json!(at_millis);
                if message.get("phase_started_at_millis").is_none() {
                    message["phase_started_at_millis"] = json!(at_millis);
                }
                return Ok(());
            }
            Activity::Submission { stage } => {
                let phase = match stage {
                    super::SubmissionStage::Submitting
                    | super::SubmissionStage::Submitted
                    | super::SubmissionStage::PendingInclusion
                    | super::SubmissionStage::Mempool => "submitting",
                    super::SubmissionStage::Included | super::SubmissionStage::Finalized => {
                        "confirming"
                    }
                };
                if message["submission"]["stage"] == value["stage"] && message["phase"] == phase {
                    return Ok(());
                }
                message["submission"] = json!({
                    "stage": value["stage"],
                    "observed_at_millis": event.observed_at,
                });
                Some(phase)
            }
            Activity::Delivered => {
                message["delivered_observed_at_millis"] = json!(event.observed_at);
                Some("delivered")
            }
            Activity::Dropped | Activity::Filtered { .. } | Activity::RetryLimitReached { .. } => {
                message["terminal"] = value.clone();
                Some("dropped")
            }
            Activity::ChainFailure { .. } => {
                message["failure"] = value.clone();
                None
            }
            Activity::ConfirmationError { .. } => {
                message["confirmation_error"] = value.clone();
                None
            }
            Activity::TransactionOutcome { .. } => {
                message["submission"] = json!({
                    "stage": "included",
                    "observed_at_millis": event.observed_at,
                });
                message["transaction"] = json!({
                    "transaction_id": value["transaction_id"],
                    "executed": value["executed"],
                    "included_observed_at_millis": event.observed_at,
                });
                Some("confirming")
            }
            Activity::Progress {
                stage: super::Stage::Submit,
                outcome: super::Outcome::Started,
            } => Some("submitting"),
            Activity::Progress {
                stage: super::Stage::Confirm,
                outcome: super::Outcome::Started,
            } => Some("confirming"),
            Activity::Progress {
                outcome: super::Outcome::Started,
                ..
            } => None,
            Activity::Progress { .. } => {
                if message.get("checks").is_none() {
                    message["checks"] = json!({});
                }
                message["checks"][value["stage"].as_str().unwrap_or("unknown")] =
                    value["outcome"].clone();
                None
            }
            Activity::RecipientNotContract | Activity::OriginSenderDenied => {
                message["failure"] = json!({"stage": "prepare", "reason": value["type"]});
                None
            }
            Activity::ValidatorStorage { .. } => return Ok(()),
            // Preserve useful observations from non-tree paths, without repeated payloads.
            _ => {
                self.current
                    .insert(value["type"].as_str().unwrap_or("unknown").into(), value);
                return Ok(());
            }
        };
        if let Some(phase) = phase {
            if message["phase"].as_str() != Some(phase)
                || message.get("phase_started_at_millis").is_none()
            {
                message["phase_started_at_millis"] = json!(event.observed_at);
            }
            message["phase"] = json!(phase);
            if matches!(
                phase,
                "ready_to_submit" | "submitting" | "confirming" | "delivered"
            ) {
                message["failure"] = Value::Null;
                message["retry"] = Value::Null;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::message_activity::{CheckpointSummary, Outcome, Stage};
    use hyperlane_base::CheckpointSigner;
    use hyperlane_core::{
        ConfirmReason, ModuleType, PendingOperationStatus, ReprepareReason, SubmissionStage, H160,
    };

    fn event(node: Option<&str>, activity: Activity) -> ObservationEvent {
        event_at(node, activity, 1_700_000_000_000)
    }

    fn event_at(node: Option<&str>, activity: Activity, observed_at: i64) -> ObservationEvent {
        ObservationEvent {
            relayer: H160::zero(),
            observed_at,
            message_id: H256::zero(),
            origin: 1,
            destination: 2,
            activity,
            node_id: node.map(str::to_owned),
        }
    }
    fn module(id: &str) -> ObservationEvent {
        event(
            Some(id),
            Activity::MetadataModule {
                ism: H256::zero(),
                module_type: ModuleType::MessageIdMultisig,
            },
        )
    }
    fn metadata(id: &str, error: Option<&str>) -> ObservationEvent {
        event(
            Some(id),
            Activity::Metadata {
                ism: H256::zero(),
                error: error.map(str::to_owned),
            },
        )
    }
    fn checkpoint(collection: &str, index: u32, collected: usize) -> ObservationEvent {
        checkpoint_for(
            collection,
            index,
            (1..=u8::try_from(collected).expect("small signer count"))
                .map(|validator| CheckpointSigner {
                    validator: H256::repeat_byte(validator),
                    location: None,
                })
                .collect(),
        )
    }
    fn checkpoint_for(
        collection: &str,
        index: u32,
        signers: Vec<CheckpointSigner>,
    ) -> ObservationEvent {
        event(
            Some("root"),
            Activity::Checkpoint {
                ism: Some(H256::zero()),
                collection_id: collection.into(),
                threshold: 2,
                summary: CheckpointSummary {
                    index: Some(index),
                    root: Some(H256::repeat_byte(1)),
                    collected: signers.len(),
                    signers,
                    ..Default::default()
                },
            },
        )
    }
    fn snapshot(events: &[StoredEvent]) -> &Value {
        match &events.last().expect("snapshot event").activity {
            StoredActivity::Snapshot { state } | StoredActivity::SnapshotUpdate { state } => state,
        }
    }

    fn is_full_snapshot(events: &[StoredEvent]) -> bool {
        matches!(
            events.last().expect("snapshot event").activity,
            StoredActivity::Snapshot { .. }
        )
    }
    async fn project(states: &ActivityState, events: &[ObservationEvent]) -> Vec<StoredEvent> {
        states.project(events).await.expect("project observations")
    }

    #[test]
    fn snapshot_updates_replace_changed_nodes_and_remove_missing_nodes() {
        let anchor = json!({
            "phase": "preparing",
            "tree_root": "a",
            "modules": [
                {"node_id": "a", "verified": 0},
                {"node_id": "b", "verified": 0}
            ]
        });
        let current = json!({
            "phase": "awaiting_signatures",
            "tree_root": "b",
            "modules": [
                {"node_id": "b", "verified": 1},
                {"node_id": "c", "verified": 0}
            ]
        });
        let update = snapshot_update(&anchor, &current);
        assert_eq!(update["phase"], "awaiting_signatures");
        assert_eq!(update["tree_root"], "b");
        assert_eq!(
            update["modules"],
            json!([
                {"node_id": "b", "verified": 1},
                {"node_id": "c", "verified": 0}
            ])
        );
        assert_eq!(update["removed_modules"], json!(["a"]));
    }

    #[tokio::test]
    async fn initial_discovery_is_one_whole_tree_row_and_unchanged_retries_only_add_retry_rows() {
        let states = ActivityState::new(None);
        assert!(
            project(&states, &[module("root"), checkpoint("first", 10, 1)])
                .await
                .is_empty()
        );
        let first = project(
            &states,
            &[metadata("root", Some("Awaiting validator signatures"))],
        )
        .await;
        assert_eq!(first.len(), 1);
        assert!(is_full_snapshot(&first));
        assert_eq!(snapshot(&first)["modules"][0]["signatures"]["collected"], 1);
        for count in 1..=5 {
            let updates = project(
                &states,
                &[
                    event(
                        None,
                        Activity::Progress {
                            stage: Stage::Prepare,
                            outcome: Outcome::Started,
                        },
                    ),
                    module("root"),
                    checkpoint("different uuid", 10, 1),
                    metadata("root", Some("Awaiting validator signatures")),
                    event(
                        None,
                        Activity::Retry {
                            reason: Some(ReprepareReason::AwaitingValidatorSignatures),
                            retry_count: count,
                            next_attempt_at_millis: Some(u64::from(count) * 1000),
                        },
                    ),
                ],
            )
            .await;
            assert_eq!(updates.len(), 1);
            assert!(!is_full_snapshot(&updates));
            assert_eq!(snapshot(&updates)["retry"]["count"], count);
            assert_eq!(snapshot(&updates)["modules"], json!([]));
            assert_eq!(snapshot(&updates)["removed_modules"], json!([]));
        }
        assert_eq!(project(&states, &[checkpoint("new", 10, 2)]).await.len(), 1);
        assert_eq!(project(&states, &[metadata("root", None)]).await.len(), 1);
        assert!(project(&states, &[metadata("root", None)]).await.is_empty());
        assert_eq!(
            project(
                &states,
                &[metadata("root", Some("Awaiting validator signatures"))]
            )
            .await
            .len(),
            1
        );
    }

    #[tokio::test]
    async fn one_row_contains_repeated_address_branches_and_unexplored_children() {
        let states = ActivityState::new(None);
        let address = H256::zero();
        let first = format!("root/0:{address:#x}");
        let second = format!("root/1:{address:#x}");
        let events = project(
            &states,
            &[
                module("root"),
                event(
                    Some("root"),
                    Activity::Aggregation {
                        ism: address,
                        modules: vec![address, address],
                        threshold: 1,
                    },
                ),
                module(&first),
                metadata(&first, None),
                event(
                    Some("root"),
                    Activity::AggregationSelection { indices: vec![0] },
                ),
                metadata("root", None),
            ],
        )
        .await;
        assert_eq!(events.len(), 1);
        let tree = snapshot(&events);
        assert_eq!(tree["modules"].as_array().expect("nodes").len(), 3);
        assert_eq!(tree["modules"][1]["node_id"], first);
        assert_eq!(tree["modules"][2]["node_id"], second);
        assert_eq!(tree["modules"][2]["discovered"], false);
        assert_eq!(tree["modules"][0]["selected_children"], json!([first]));
    }

    #[tokio::test]
    async fn failed_writes_republish_a_self_contained_snapshot() {
        let states = ActivityState::new(None);
        let batch = [module("root"), metadata("root", None)];
        project(&states, &batch).await;
        assert!(project(&states, &batch).await.is_empty());
        states.failed(&batch).await;
        let updates = project(&states, &[metadata("root", None)]).await;
        assert_eq!(updates.len(), 1);
        assert!(is_full_snapshot(&updates));
        assert_eq!(
            snapshot(&updates)["modules"][0]["module_type"],
            "MessageIdMultisig"
        );
    }

    #[tokio::test]
    async fn ready_and_delivered_are_full_snapshots_between_node_updates() {
        let states = ActivityState::new(None);
        let first = project(
            &states,
            &[
                module("root"),
                checkpoint("first", 10, 1),
                metadata("root", Some("Awaiting validator signatures")),
            ],
        )
        .await;
        assert!(is_full_snapshot(&first));

        let update = project(&states, &[checkpoint("second", 10, 2)]).await;
        assert!(!is_full_snapshot(&update));
        assert_eq!(
            snapshot(&update)["modules"].as_array().map(Vec::len),
            Some(1)
        );
        assert_eq!(snapshot(&update)["modules"][0]["node_id"], "root");

        let cumulative = project(
            &states,
            &[event(
                None,
                Activity::Retry {
                    reason: Some(ReprepareReason::AwaitingValidatorSignatures),
                    retry_count: 1,
                    next_attempt_at_millis: Some(1_000),
                },
            )],
        )
        .await;
        assert!(!is_full_snapshot(&cumulative));
        assert_eq!(
            snapshot(&cumulative)["modules"].as_array().map(Vec::len),
            Some(1),
            "updates remain independently applicable to the latest full anchor"
        );

        let ready = project(
            &states,
            &[
                metadata("root", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::ReadyToSubmit,
                    },
                ),
            ],
        )
        .await;
        assert!(is_full_snapshot(&ready));
        assert_eq!(snapshot(&ready)["phase"], "ready_to_submit");
        assert_eq!(
            snapshot(&ready)["modules"].as_array().map(Vec::len),
            Some(1)
        );

        let confirming = project(
            &states,
            &[event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                },
            )],
        )
        .await;
        assert!(!is_full_snapshot(&confirming));
        assert_eq!(snapshot(&confirming)["phase"], "confirming");
        assert_eq!(snapshot(&confirming)["modules"], json!([]));

        let delivered = project(&states, &[event(None, Activity::Delivered)]).await;
        assert!(is_full_snapshot(&delivered));
        assert_eq!(snapshot(&delivered)["phase"], "delivered");
        assert_eq!(
            snapshot(&delivered)["modules"].as_array().map(Vec::len),
            Some(1)
        );
    }

    #[tokio::test]
    async fn delivery_after_restart_retains_the_submitted_tree_and_deletes_only_local_pending_state(
    ) {
        hyperlane_base::db::test_utils::run_test_db(|database| async move {
            let states = ActivityState::new(Some(database.clone()));
            project(
                &states,
                &[
                    module("root"),
                    metadata("root", None),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                        },
                    ),
                ],
            )
            .await;
            drop(states);
            let restarted = ActivityState::new(Some(database.clone()));
            let final_events = project(&restarted, &[event(None, Activity::Delivered)]).await;
            assert_eq!(final_events.len(), 1);
            let final_state = snapshot(&final_events);
            assert_eq!(final_state["phase"], "delivered");
            assert_eq!(final_state["tree_root"], "root");
            assert_eq!(final_state["modules"][0]["metadata_status"], "ready");
            assert!(database
                .retrieve(&state_key(H256::zero()))
                .expect("read pending state")
                .is_some());
            restarted
                .committed(&final_events)
                .await
                .expect("commit terminal state");
            assert!(database
                .retrieve(&state_key(H256::zero()))
                .expect("read cleaned state")
                .is_none());
        })
        .await;
    }

    #[tokio::test]
    async fn delivery_freezes_submission_choices_and_does_not_invent_a_tree_for_external_delivery()
    {
        let states = ActivityState::new(None);
        project(
            &states,
            &[
                module("root"),
                metadata("root", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
            ],
        )
        .await;
        project(
            &states,
            &[module("other-root"), metadata("other-root", None)],
        )
        .await;
        let delivered = project(&states, &[event(None, Activity::Delivered)]).await;
        assert_eq!(snapshot(&delivered)["tree_root"], "root");
        let unknown = project(
            &ActivityState::new(None),
            &[event(None, Activity::Delivered)],
        )
        .await;
        assert_eq!(snapshot(&unknown)["tree_root"], Value::Null);
        assert_eq!(snapshot(&unknown)["modules"], json!([]));
    }

    #[tokio::test]
    async fn external_delivery_does_not_claim_an_earlier_failed_tree_was_used() {
        let states = ActivityState::new(None);
        project(
            &states,
            &[
                module("unverified-root"),
                metadata("unverified-root", Some("Awaiting validator signatures")),
            ],
        )
        .await;
        let events = project(
            &states,
            &[
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::AlreadySubmitted),
                    },
                ),
                event(None, Activity::Delivered),
            ],
        )
        .await;
        assert_eq!(snapshot(&events)["tree_root"], Value::Null);
        assert_eq!(snapshot(&events)["modules"], json!([]));
    }

    #[tokio::test]
    async fn validator_changes_invalidate_quorum_and_signer_location_is_preserved() {
        let states = ActivityState::new(None);
        let validators = |v| {
            event(
                Some("root"),
                Activity::ValidatorSet {
                    ism: None,
                    validators: vec![H256::repeat_byte(v)],
                    threshold: 1,
                },
            )
        };
        project(
            &states,
            &[
                module("root"),
                validators(1),
                checkpoint("a", 10, 1),
                metadata("root", None),
            ],
        )
        .await;
        let updates = project(
            &states,
            &[
                validators(2),
                metadata("root", Some("Could not fetch metadata")),
            ],
        )
        .await;
        assert!(snapshot(&updates)["modules"][0].get("signatures").is_none());
        let recovered = project(
            &states,
            &[
                checkpoint_for(
                    "b",
                    10,
                    vec![CheckpointSigner {
                        validator: H256::repeat_byte(2),
                        location: Some("s3://validator-bucket/us-east-1/checkpoints".into()),
                    }],
                ),
                metadata("root", None),
            ],
        )
        .await;
        assert_eq!(
            snapshot(&recovered)["modules"][0]["signatures"]["signers"][0]["location"],
            "s3://validator-bucket/us-east-1/checkpoints"
        );
    }

    #[tokio::test]
    async fn confirmation_scheduling_is_not_a_retry() {
        let states = ActivityState::new(None);
        project(
            &states,
            &[event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::ReadyToSubmit,
                },
            )],
        )
        .await;
        assert!(project(
            &states,
            &[event(
                None,
                Activity::Retry {
                    reason: None,
                    retry_count: 0,
                    next_attempt_at_millis: Some(600_000)
                }
            )]
        )
        .await
        .is_empty());
    }

    #[tokio::test]
    async fn lifecycle_timestamps_and_submission_stages_are_compact() {
        let states = ActivityState::new(None);
        let first_seen = event_at(
            None,
            Activity::FirstSeen {
                at_millis: 1_700_000_000_000,
            },
            1_700_000_000_001,
        );
        let initial = project(
            &states,
            &[first_seen, module("root"), metadata("root", None)],
        )
        .await;
        assert_eq!(
            snapshot(&initial)["relayer_first_seen_at_millis"],
            1_700_000_000_000_u64
        );
        assert_eq!(
            snapshot(&initial)["phase_started_at_millis"],
            1_700_000_000_000_u64
        );

        project(
            &states,
            &[event_at(
                None,
                Activity::Status {
                    status: PendingOperationStatus::ReadyToSubmit,
                },
                1_700_000_001_000,
            )],
        )
        .await;
        let submitting = project(
            &states,
            &[event_at(
                None,
                Activity::Submission {
                    stage: SubmissionStage::PendingInclusion,
                },
                1_700_000_002_000,
            )],
        )
        .await;
        assert_eq!(snapshot(&submitting)["phase"], "submitting");
        assert_eq!(
            snapshot(&submitting)["submission"],
            json!({"stage": "pending_inclusion", "observed_at_millis": 1_700_000_002_000_i64})
        );
        assert_eq!(snapshot(&submitting)["modules"], json!([]));
        assert!(project(
            &states,
            &[event_at(
                None,
                Activity::Submission {
                    stage: SubmissionStage::PendingInclusion,
                },
                1_700_000_002_100,
            )]
        )
        .await
        .is_empty());

        let included = project(
            &states,
            &[event_at(
                None,
                Activity::Submission {
                    stage: SubmissionStage::Included,
                },
                1_700_000_003_000,
            )],
        )
        .await;
        assert_eq!(snapshot(&included)["phase"], "confirming");
        assert_eq!(snapshot(&included)["submission"]["stage"], "included");
        assert_eq!(snapshot(&included)["modules"], json!([]));

        let delivered = project(
            &states,
            &[event_at(None, Activity::Delivered, 1_700_000_004_000)],
        )
        .await;
        assert!(is_full_snapshot(&delivered));
        assert_eq!(
            snapshot(&delivered)["delivered_observed_at_millis"],
            1_700_000_004_000_i64
        );
    }
    // Scratch regression cases for insertion into the existing state.rs tests module.
    // Uses exact-head test helpers; original source unchanged. Parent owns compilation.

    #[tokio::test]
    async fn invalidated_self_submission_does_not_claim_an_external_delivery_tree() {
        let states = ActivityState::new(None);
        project(
            &states,
            &[
                module("own-tree"),
                metadata("own-tree", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
            ],
        )
        .await;
        project(
            &states,
            &[
                event(
                    None,
                    Activity::Retry {
                        reason: Some(ReprepareReason::RevertedOrReorged),
                        retry_count: 1,
                        next_attempt_at_millis: Some(1000),
                    },
                ),
                module("other-inspected-tree"),
                metadata("other-inspected-tree", None),
            ],
        )
        .await;
        let delivered = project(
            &states,
            &[
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::AlreadySubmitted),
                    },
                ),
                event(None, Activity::Delivered),
            ],
        )
        .await;
        assert_eq!(snapshot(&delivered)["tree_root"], Value::Null);
        assert_eq!(snapshot(&delivered)["modules"], json!([]));
    }

    #[tokio::test]
    async fn invalidated_submission_stays_invalidated_across_restart() {
        hyperlane_base::db::test_utils::run_test_db(|database| async move {
            let states = ActivityState::new(Some(database.clone()));
            project(
                &states,
                &[
                    module("own-tree"),
                    metadata("own-tree", None),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                        },
                    ),
                    event(
                        None,
                        Activity::Retry {
                            reason: Some(ReprepareReason::RevertedOrReorged),
                            retry_count: 1,
                            next_attempt_at_millis: Some(1000),
                        },
                    ),
                ],
            )
            .await;
            drop(states);
            let restarted = ActivityState::new(Some(database));
            let delivered = project(
                &restarted,
                &[
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Confirm(
                                ConfirmReason::AlreadySubmitted,
                            ),
                        },
                    ),
                    event(None, Activity::Delivered),
                ],
            )
            .await;
            assert_eq!(snapshot(&delivered)["tree_root"], Value::Null);
            assert_eq!(snapshot(&delivered)["modules"], json!([]));
        })
        .await;
    }

    #[tokio::test]
    async fn an_earlier_terminal_row_does_not_delete_a_later_pending_submission() {
        hyperlane_base::db::test_utils::run_test_db(|database| async move {
            let states = ActivityState::new(Some(database.clone()));
            let updates = project(
                &states,
                &[
                    module("first-tree"),
                    metadata("first-tree", None),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                        },
                    ),
                    event(None, Activity::Dropped),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Retry(ReprepareReason::Manual),
                        },
                    ),
                    module("retry-tree"),
                    metadata("retry-tree", None),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::ReadyToSubmit,
                        },
                    ),
                    event(
                        None,
                        Activity::Status {
                            status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                        },
                    ),
                ],
            )
            .await;
            assert!(database
                .retrieve(&state_key(H256::zero()))
                .expect("read pending state")
                .is_some());
            states
                .committed(&updates)
                .await
                .expect("commit activity batch");
            assert!(database
                .retrieve(&state_key(H256::zero()))
                .expect("read retained pending state")
                .is_some());
            drop(states);
            let restarted = ActivityState::new(Some(database));
            let delivered = project(&restarted, &[event(None, Activity::Delivered)]).await;
            assert_eq!(snapshot(&delivered)["tree_root"], "retry-tree");
        })
        .await;
    }

    #[tokio::test]
    async fn late_observations_cannot_rewrite_a_delivered_validation_path() {
        let states = ActivityState::new(None);
        project(
            &states,
            &[
                module("own-tree"),
                metadata("own-tree", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
                module("later-inspected-tree"),
                metadata("later-inspected-tree", None),
                event(None, Activity::Delivered),
            ],
        )
        .await;
        let late = project(
            &states,
            &[
                event(
                    None,
                    Activity::Retry {
                        reason: Some(ReprepareReason::Manual),
                        retry_count: 0,
                        next_attempt_at_millis: None,
                    },
                ),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
                module("late-tree"),
            ],
        )
        .await;
        assert!(late.is_empty());
    }
    #[tokio::test]
    async fn a_failed_terminal_write_can_republish_the_frozen_path() {
        let states = ActivityState::new(None);
        let observations = [
            module("own-tree"),
            metadata("own-tree", None),
            event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                },
            ),
            module("later-inspected-tree"),
            metadata("later-inspected-tree", None),
            event(None, Activity::Delivered),
        ];
        project(&states, &observations).await;
        states.failed(&observations).await;
        let retried = project(
            &states,
            &[event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                },
            )],
        )
        .await;
        assert!(is_full_snapshot(&retried));
        assert_eq!(snapshot(&retried)["phase"], "delivered");
        assert_eq!(snapshot(&retried)["tree_root"], "own-tree");
    }

    #[tokio::test]
    async fn a_manual_retry_status_invalidates_the_old_submission() {
        let states = ActivityState::new(None);
        project(
            &states,
            &[
                module("own-tree"),
                metadata("own-tree", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
            ],
        )
        .await;
        let retry = project(
            &states,
            &[event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Retry(ReprepareReason::Manual),
                },
            )],
        )
        .await;
        assert_eq!(snapshot(&retry)["phase"], "retrying");
        let delivered = project(
            &states,
            &[
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::AlreadySubmitted),
                    },
                ),
                event(None, Activity::Delivered),
            ],
        )
        .await;
        assert_eq!(snapshot(&delivered)["tree_root"], Value::Null);
    }
    #[tokio::test]
    async fn a_normal_retry_status_preserves_its_preceding_retry_details() {
        let states = ActivityState::new(None);
        let retry = project(
            &states,
            &[
                event(
                    None,
                    Activity::Retry {
                        reason: Some(ReprepareReason::AwaitingValidatorSignatures),
                        retry_count: 7,
                        next_attempt_at_millis: Some(12345),
                    },
                ),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Retry(
                            ReprepareReason::AwaitingValidatorSignatures,
                        ),
                    },
                ),
            ],
        )
        .await;
        assert_eq!(snapshot(&retry)["phase"], "awaiting_signatures");
        assert_eq!(snapshot(&retry)["retry"]["count"], 7);
        assert_eq!(
            snapshot(&retry)["retry"]["reason"],
            "AwaitingValidatorSignatures"
        );
        assert_eq!(snapshot(&retry)["retry"]["next_attempt_at_millis"], 12345);
        let manual = project(
            &states,
            &[event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Retry(ReprepareReason::Manual),
                },
            )],
        )
        .await;
        assert_eq!(snapshot(&manual)["phase"], "retrying");
        assert_eq!(snapshot(&manual)["retry"], Value::Null);
    }
    #[tokio::test]
    async fn a_failed_invalidation_is_retried_before_later_restart() {
        use hyperlane_base::db::test_utils::{setup_db, setup_read_only_db};
        let directory = tempfile::tempdir().expect("test db directory");
        let path = directory.path().to_str().expect("test path").to_owned();
        let database = setup_db(path.clone());
        let states = ActivityState::new(Some(database.clone()));
        project(
            &states,
            &[
                module("old-submission"),
                metadata("old-submission", None),
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                    },
                ),
            ],
        )
        .await;
        drop(states);
        drop(database);
        let mut states = ActivityState::new(Some(setup_read_only_db(path.clone())));
        let retry = [event(
            None,
            Activity::Retry {
                reason: Some(ReprepareReason::RevertedOrReorged),
                retry_count: 1,
                next_attempt_at_millis: Some(12345),
            },
        )];
        assert!(states.project(&retry).await.is_err());
        states.failed(&retry).await;
        let stale = states
            .database
            .as_ref()
            .expect("readonly db")
            .retrieve(&state_key(H256::zero()))
            .expect("read old record")
            .expect("old record");
        let stale: MessageState = serde_json::from_slice(&stale).expect("decode old record");
        assert!(stale.submitted_validation.is_some());
        drop(states.database.take());
        let database = setup_db(path);
        states.database = Some(database.clone());
        // No new capture or invalidation: only the outstanding dirty write can repair disk.
        project(
            &states,
            &[event(
                None,
                Activity::Retry {
                    reason: None,
                    retry_count: 1,
                    next_attempt_at_millis: None,
                },
            )],
        )
        .await;
        drop(states);
        let restarted = ActivityState::new(Some(database));
        let delivered = project(
            &restarted,
            &[
                event(
                    None,
                    Activity::Status {
                        status: PendingOperationStatus::Confirm(ConfirmReason::AlreadySubmitted),
                    },
                ),
                event(None, Activity::Delivered),
            ],
        )
        .await;
        assert_eq!(snapshot(&delivered)["tree_root"], Value::Null);
        assert_eq!(snapshot(&delivered)["modules"], json!([]));
    }

    #[tokio::test]
    async fn a_failed_capture_is_retried_without_another_submission_event() {
        use hyperlane_base::db::test_utils::{setup_db, setup_read_only_db};
        let directory = tempfile::tempdir().expect("test db directory");
        let path = directory.path().to_str().expect("test path").to_owned();
        drop(setup_db(path.clone()));
        let mut states = ActivityState::new(Some(setup_read_only_db(path.clone())));
        let capture = [
            module("own-submission"),
            metadata("own-submission", None),
            event(
                None,
                Activity::Status {
                    status: PendingOperationStatus::Confirm(ConfirmReason::SubmittedBySelf),
                },
            ),
        ];
        assert!(states.project(&capture).await.is_err());
        states.failed(&capture).await;
        drop(states.database.take());
        let database = setup_db(path);
        states.database = Some(database.clone());
        project(
            &states,
            &[event(
                None,
                Activity::Retry {
                    reason: None,
                    retry_count: 0,
                    next_attempt_at_millis: None,
                },
            )],
        )
        .await;
        drop(states);
        let restarted = ActivityState::new(Some(database));
        let delivered = project(&restarted, &[event(None, Activity::Delivered)]).await;
        assert_eq!(snapshot(&delivered)["tree_root"], "own-submission");
    }
}
