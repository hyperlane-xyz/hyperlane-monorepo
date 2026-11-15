//! Durable EVM message-controller step. The caller owns queues, worker lifetime,
//! resources, and credentials; Lander owns nonce, signing, and broadcast state.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const evm = @import("../../evm/root.zig");
const db = @import("../../db/root.zig");
const lander = @import("../../lander/root.zig");
const ccip = @import("../../relayer/ccip.zig");
const metadata_parallel = @import("../../relayer/metadata_parallel.zig");
const native = @import("../store.zig");
const agents_operation = @import("../operation.zig");
const payload_links = @import("../payload_links.zig");
const relay_policy = @import("../relay_policy.zig");
const evm_prepare = @import("evm_prepare.zig");
const evm_accounting = @import("evm_accounting.zig");

const Allocator = std.mem.Allocator;
const Reason = db.json.ReprepareReason;

pub const Config = struct {
    metadata_cache: ?*@import("../../relayer/contract_cache.zig").Cache = null,
    default_ism_cache: ?*@import("../../relayer/contract_cache.zig").Cache = null,
    cache_context: ?@import("../../relayer/contract_cache.zig").Context = null,
    ism_cache_configs: []const @import("../../settings/types.zig").IsmCache = &.{},
    source: evm_prepare.Config,
    jitter: u64 = 0,
    payload_retry_delay_ms: u64 = 1_000,
    confirm_poll_ms: u64 = 500,
    /// Longest a prepare may wait for its origin index (tree leaf or gas
    /// payment) without consuming a retry; afterwards the normal ladder runs.
    max_index_wait_ms: u64 = 60_000,
};

/// Origin rows a prepare found not yet indexed. Not a failure: the lane
/// parks the message until the origin indexer commits the row.
pub const IndexWait = enum { merkle_leaf, gas_payment };

pub const Callbacks = struct {
    /// Last new-payload handoff gate. This callback may inspect only current
    /// local message policy and cached signers, never perform origin RPC.
    local_admission: ?struct {
        context: *anyopaque,
        allowed_fn: *const fn (*anyopaque, protocol.Message) anyerror!bool,
    } = null,
    origin_sender: ?evm_prepare.OriginSender = null,
    private_estimator: ?evm_prepare.PrivateEstimator = null,
    executor: ?*metadata_parallel.Executor = null,
    pending_delay: ?evm_prepare.PendingDelay = null,
    batch_resolver: ?evm_accounting.BatchResolver = null,
    cost_receipt_reader: ?evm_accounting.CostReceiptReader = null,
    ccip_handler: ?ccip.Handler = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    observation_clock: ?agents_operation.ObservationClock = null,
    observation: ?@import("../../relayer/metadata.zig").Observation = null,
    /// Concurrent batch preparation: parks until every earlier batch
    /// position finished, so Lander payload order follows batch order
    /// rather than RPC completion order. Never performs I/O.
    handoff_gate: ?HandoffGate = null,
    /// Concurrent batch beside a Lander tick: parks until that tick released
    /// the Lander, before this step replays a sealed payload into it (the
    /// replay holds the origin store lock; it must never wait inside it).
    lander_gate: ?HandoffGate = null,
};

pub const HandoffGate = struct {
    context: *anyopaque,
    wait_fn: *const fn (*anyopaque) void,
};

pub const State = enum {
    idle,
    awaiting_index,
    existing_payload,
    retried,
    prepared,
    denied,
    not_contract,
    delivered,
};

pub const Report = struct {
    state: State,
    reason: ?Reason = null,
    failure: ?anyerror = null,
    denial: ?relay_policy.Denial = null,
    payload: ?payload_links.Uuid = null,
    index_wait: ?IndexWait = null,
};

pub const Driver = struct {
    allocator: Allocator,
    retry_state: evm_prepare.RetryState = .{},
    cached_metadata: ?[]u8 = null,
    /// In-memory only: a restart simply prepares again.
    index_wait_since_ms: ?u64 = null,
    /// Sealed payload already replayed into Lander by this process.
    replayed_payload: ?payload_links.Uuid = null,

    pub fn init(allocator: Allocator) Driver {
        return .{ .allocator = allocator };
    }

    pub fn deinit(self: *Driver) void {
        if (self.cached_metadata) |bytes| self.allocator.free(bytes);
        self.* = undefined;
    }

    pub fn step(
        self: *Driver,
        allocator: Allocator,
        destination: *lander.Service,
        actor: *agents_operation.Operation,
        origin: anytype,
        policy: *relay_policy.Policy,
        message: protocol.Message,
        client: *evm.RpcClient,
        config: Config,
        now: agents_operation.Times,
        callbacks: Callbacks,
    ) !Report {
        try checkCancelled(callbacks.cancel);
        try validateAuthority(destination, actor, message, config);
        try validateCanonical(actor.store, message);
        if (actor.value.stage == .delivered) return .{ .state = .delivered };

        var link = try payload_links.load(allocator, actor.store, message.id(), actor.options.context);
        defer if (link) |*value| value.deinit();
        if (link) |*value| {
            // Replay closes the seal/enqueue crash window once per process;
            // Lander keeps the payload durably, so later polls of the same
            // ready payload skip the canonical re-encode and enqueue check.
            const uuid = value.record().payload.uuid;
            const replayed = self.replayed_payload != null and std.mem.eql(u8, &self.replayed_payload.?, &uuid) and actor.value.stage == .ready;
            if (!replayed) {
                if (callbacks.lander_gate) |gate| gate.wait_fn(gate.context);
                try value.replay(destination);
                if (actor.value.stage != .denied) try actor.payloadEnqueued(value.record().generation, now);
                self.replayed_payload = uuid;
            }
        } else self.replayed_payload = null;

        const inherited = try payload_links.inheritedUuids(allocator, actor.store, message.id());
        defer allocator.free(inherited);
        if (inherited.len != 0) return self.reconcilePayloads(allocator, destination, actor, client, message, config, now, callbacks, inherited, if (link) |*value| value.record().payload.uuid else null, if (link) |*value| value else null);

        const current = try observationTime(callbacks, now);
        if (actor.parked or current.monotonic_ms < actor.value.next_attempt_ms) return .{ .state = .idle };
        if (actor.value.confirmation_started) {
            if (!config.source.chain_verified) try client.checkChain(config.source.chain_id);
            if (!try client.delivered(config.source.mailbox[12..32].*, message.id(), .latest)) return self.retry(actor, .RevertedOrReorged, error.ExternalDeliveryReorged, config, try observationTime(callbacks, current), null);
            if (!try finalizedDelivered(client, message, config)) {
                try actor.waitForFinality(try observationTime(callbacks, current), config.confirm_poll_ms);
                return .{ .state = .existing_payload };
            }
            _ = try actor.apply(.{ .already_delivered = .{ .finalized = true } }, try observationTime(callbacks, current), null);
            return .{ .state = .delivered };
        }
        return self.prepareFresh(allocator, destination, actor, origin, policy, message, client, config, now, callbacks);
    }

    fn reconcilePayloads(
        self: *Driver,
        allocator: Allocator,
        destination: *lander.Service,
        actor: *agents_operation.Operation,
        client: *evm.RpcClient,
        message: protocol.Message,
        config: Config,
        now: agents_operation.Times,
        callbacks: Callbacks,
        inherited: []const payload_links.Uuid,
        linked_uuid: ?payload_links.Uuid,
        native_link: ?*const payload_links.Link,
    ) !Report {
        const statuses = try allocator.alloc(PayloadDisposition, inherited.len);
        defer allocator.free(statuses);
        var unknown = false;
        for (inherited, statuses) |uuid, *disposition| {
            disposition.* = try payloadStatus(allocator, destination.store, uuid) orelse {
                unknown = true;
                disposition.* = .unknown;
                continue;
            };
        }
        if (unknown) {
            // Lander no longer knows a linked payload: replay it again.
            self.replayed_payload = null;
            if (!actor.value.confirmation_started and (actor.value.stage == .preparing or actor.value.stage == .ready)) {
                _ = try actor.apply(.{ .delay = .{ .generation = actor.value.generation, .now_ms = now.monotonic_ms, .delay_ms = config.payload_retry_delay_ms } }, now, .ErrorRetrievingPayloadStatus);
            }
            return .{ .state = .existing_payload, .reason = .ErrorRetrievingPayloadStatus, .failure = error.PayloadStatusUnknown, .payload = linked_uuid orelse inherited[0] };
        }

        var active = false;
        var included = false;
        var failed = true;
        var finalized = true;
        for (statuses) |status| switch (status) {
            .active => {
                active = true;
                failed = false;
                finalized = false;
            },
            .included => {
                included = true;
                failed = false;
                finalized = false;
            },
            .failed => finalized = false,
            .finalized => failed = false,
            .unknown => unreachable,
        };
        if (active) return .{ .state = .existing_payload, .payload = linked_uuid orelse inherited[0] };
        if (included) {
            const observed_at = try observationTime(callbacks, now);
            try actor.beginConfirmation(observed_at, true);
            try actor.waitForFinality(observed_at, config.confirm_poll_ms);
            return .{ .state = .existing_payload, .payload = linked_uuid orelse inherited[0] };
        }
        if (!failed and !finalized) return error.AmbiguousPayloadDisposition;

        if (finalized) {
            const observed_at = try observationTime(callbacks, now);
            try actor.beginConfirmation(observed_at, true);
            if (!actor.value.confirmationReady(observed_at.monotonic_ms)) return .{ .state = .existing_payload, .payload = linked_uuid orelse inherited[0] };
        }
        const delivered = if (finalized) try finalizedDelivered(client, message, config) else false;
        var account_receipt = finalized;
        if (failed) if (native_link) |link| {
            // Lander marks an undelivered mined member Dropped(Reverted), even
            // when its transaction finalized. Keep its association until finality
            // and charge the actual receipt before releasing it for another try.
            if (try destination.store.payloadTransaction(allocator, link.record().payload.uuid)) |uuid| {
                if (!std.mem.eql(u8, &uuid, &lander.types.nil_uuid)) {
                    var status = (try destination.store.transactionStatus(allocator, uuid)) orelse return error.CostTransactionAssociationMissing;
                    defer status.deinit(allocator);
                    switch (status.value) {
                        .finalized => account_receipt = true,
                        .pending_inclusion, .mempool, .included => return .{ .state = .existing_payload, .payload = linked_uuid orelse inherited[0] },
                        .dropped => {},
                    }
                }
            }
        };
        if (account_receipt) {
            if (native_link) |link| {
                const proof = try evm_accounting.finalizedReceipt(allocator, destination, client, link, callbacks.batch_resolver, callbacks.cost_receipt_reader);
                _ = try evm_accounting.recordCost(allocator, actor.store, .{
                    .message = message,
                    .generation = link.record().generation,
                    .payload_uuid = link.record().payload.uuid,
                    .transaction_uuid = proof.transaction_uuid,
                    .transaction_hash = proof.transaction_hash,
                    .gas_used = proof.gas_used,
                    .gas_price = proof.effective_gas_price,
                    .operation_estimate = proof.operation_estimate,
                    .submission_estimate = proof.submission_estimate,
                });
            }
        }
        if (delivered) {
            try actor.payloadDelivered(try observationTime(callbacks, now));
            return .{ .state = .delivered, .payload = linked_uuid orelse inherited[0] };
        }
        try payload_links.clearTerminal(allocator, actor.store, message.id(), inherited);
        return retryExisting(actor, .RevertedOrReorged, if (finalized) error.PayloadFailedFinalizedReconcile else error.PayloadDroppedOrReverted, config, try observationTime(callbacks, now), linked_uuid orelse inherited[0]);
    }

    fn prepareFresh(
        self: *Driver,
        allocator: Allocator,
        destination: *lander.Service,
        actor: *agents_operation.Operation,
        origin: anytype,
        policy: *relay_policy.Policy,
        message: protocol.Message,
        client: *evm.RpcClient,
        config: Config,
        now: agents_operation.Times,
        callbacks: Callbacks,
    ) !Report {
        if (actor.value.stage == .ready) return self.retry(actor, .RevertedOrReorged, error.PayloadRelationMissingAfterTerminalClear, config, now, null);
        if (actor.value.stage == .denied) _ = try actor.apply(.allow, now, null);
        if (actor.value.stage == .pending) _ = try actor.apply(.{ .tick = .{ .now_ms = now.monotonic_ms } }, now, null);
        if (actor.value.stage != .preparing and actor.value.stage != .ready) return error.EvmDriverStateMismatch;

        const metadata = try evm.codecs.hexAlloc(allocator, &message.id());
        defer allocator.free(metadata);
        var preparer: evm_prepare.Preparer(@TypeOf(origin.*)) = .{
            .allocator = allocator,
            .client = client,
            .origin = origin,
            .policy = policy,
            .config = config.source,
            .origin_sender = callbacks.origin_sender,
            .private_estimator = callbacks.private_estimator,
            .executor = callbacks.executor,
            .pending_delay = callbacks.pending_delay,
            .ccip_handler = callbacks.ccip_handler,
            .metadata_cache = config.metadata_cache,
            .default_ism_cache = config.default_ism_cache,
            .cache_context = config.cache_context,
            .ism_cache_configs = config.ism_cache_configs,
            .cancel = callbacks.cancel,
            .observation_clock = callbacks.observation_clock,
            .observation = callbacks.observation,
        };
        var outcome = try preparer.prepare(.{
            .store = actor.store,
            .message = message,
            .uuid = payload_links.uuid(actor.options.context, message.id(), actor.value.generation),
            .metadata = metadata,
            .now_ms = now.monotonic_ms,
            .retry_state = self.retry_state,
            .cached_metadata = self.cached_metadata,
        });
        defer outcome.deinit();

        // Park only before the first retry: once the cap (or any failure) has
        // charged a retry, the persisted Source ladder governs later attempts.
        if (outcome.value == .retry and actor.value.retries == 0) if (indexWait(outcome.value.retry)) |wait| {
            const since = self.index_wait_since_ms orelse now.monotonic_ms;
            if (now.monotonic_ms -| since < config.max_index_wait_ms) {
                try self.updateRetryState(outcome.value.retry.retry_state, outcome.value.retry.cached_metadata);
                self.index_wait_since_ms = since;
                return .{ .state = .awaiting_index, .reason = retryReason(outcome.value.retry.reason), .index_wait = wait };
            }
        };
        self.index_wait_since_ms = null;
        switch (outcome.value) {
            .ready => |ready| {
                try self.updateRetryState(ready.retry_state, null);
                if (callbacks.handoff_gate) |gate| gate.wait_fn(gate.context);
                // Source Lander rechecks current deny rules after payload RPC
                // and immediately before handoff. A rule can change during
                // metadata/gas estimation; no new link/UUID may escape it.
                var decision = try policy.check(message);
                defer decision.deinit();
                var denial = decision.denial;
                if (denial == null) {
                    if (callbacks.local_admission) |gate| {
                        if (!try gate.allowed_fn(gate.context, message)) denial = .runtime_denylisted;
                    }
                }
                if (denial) |reason| {
                    _ = try actor.apply(.deny, try observationTime(callbacks, now), null);
                    return .{ .state = .denied, .denial = reason };
                }
                const record: payload_links.Record = .{
                    .context = actor.options.context,
                    .message_id = message.id(),
                    .generation = actor.value.generation,
                    .estimated_gas = (ready.diagnostics.estimate orelse return error.MissingNativeOperationEstimate).gas_limit,
                    .payload = ready.payload,
                    .delivery = .{ .mailbox_message = message.id() },
                };
                try payload_links.seal(allocator, actor.store, record);
                var sealed = (try payload_links.load(allocator, actor.store, message.id(), actor.options.context)) orelse return error.MissingSealedPayloadLink;
                defer sealed.deinit();
                sealed.replay(destination) catch |err| {
                    if (evm_prepare.hardFailure(err)) return err;
                    return self.retry(actor, .ErrorSubmitting, err, config, now, record.payload.uuid);
                };
                try actor.payloadEnqueued(record.generation, now);
                return .{ .state = .prepared, .payload = record.payload.uuid };
            },
            .retry => |source_retry| {
                try self.updateRetryState(source_retry.retry_state, source_retry.cached_metadata);
                const reason = retryReason(source_retry.reason);
                if (source_retry.delay_ms) |delay| {
                    _ = try actor.apply(.{ .delay = .{ .generation = actor.value.generation, .now_ms = now.monotonic_ms, .delay_ms = delay } }, now, reason);
                    return .{ .state = .retried, .reason = reason, .failure = retryFailure(source_retry.failure) };
                }
                return self.retry(actor, reason, retryFailure(source_retry.failure), config, now, null);
            },
            .finality_wait => |waiting| {
                try self.updateRetryState(waiting.retry_state, null);
                const observed_at = waiting.observed_at orelse try observationTime(callbacks, now);
                try actor.beginConfirmation(observed_at, false);
                const current_at = try observationTime(callbacks, now);
                if (waiting.delivered) {
                    _ = try actor.apply(.{ .already_delivered = .{ .finalized = true } }, current_at, null);
                    return .{ .state = if (actor.value.stage == .delivered) .delivered else .existing_payload };
                }
                try actor.waitForFinality(current_at, config.confirm_poll_ms);
                return .{ .state = .existing_payload, .reason = .ErrorCheckingDeliveryStatus, .failure = retryFailure(waiting.failure) };
            },
            .denied => |denied| {
                try self.updateRetryState(denied.retry_state, null);
                _ = try actor.apply(.deny, now, null);
                return .{ .state = .denied, .denial = denied.denial };
            },
            .not_contract => |terminal| {
                try self.updateRetryState(terminal.retry_state, null);
                try markNonContractTerminal(allocator, actor.store, message);
                return .{ .state = .not_contract };
            },
        }
    }

    pub fn indexWait(source_retry: evm_prepare.Retry) ?IndexWait {
        return switch (source_retry.reason) {
            .gas_payment_not_found => .gas_payment,
            .metadata => if (source_retry.failure != null and std.mem.eql(u8, source_retry.failure.?, "MessageNotInMerkleTree")) .merkle_leaf else null,
            else => null,
        };
    }

    fn updateRetryState(self: *Driver, state: evm_prepare.RetryState, cached: ?[]const u8) !void {
        const replacement = if (cached) |bytes| try self.allocator.dupe(u8, bytes) else null;
        if (self.cached_metadata) |bytes| self.allocator.free(bytes);
        self.cached_metadata = replacement;
        self.retry_state = state;
    }

    fn retry(self: *Driver, actor: *agents_operation.Operation, reason: Reason, failure: ?anyerror, config: Config, now: agents_operation.Times, uuid: ?payload_links.Uuid) !Report {
        _ = self;
        if (failure) |err| if (evm_prepare.hardFailure(err)) return err;
        if (actor.value.stage == .preparing or actor.value.stage == .ready or (actor.value.stage == .pending and actor.value.confirmation_started)) {
            const kind: @import("../../runtime/relayer.zig").RetryReason = if (reason == .AwaitingValidatorSignatures) .awaiting_signatures else .transient;
            _ = try actor.apply(.{ .retry = .{ .generation = actor.value.generation, .reason = kind, .now_ms = now.monotonic_ms, .jitter = config.jitter } }, now, reason);
        } else if (actor.value.stage != .pending) return error.EvmDriverStateMismatch;
        return .{ .state = .retried, .reason = reason, .failure = failure, .payload = uuid };
    }
};

fn observationTime(callbacks: Callbacks, fallback: agents_operation.Times) !agents_operation.Times {
    return if (callbacks.observation_clock) |clock| clock.now() else fallback;
}

const PayloadDisposition = enum { unknown, active, included, failed, finalized };

/// Only identity and status of a stored Lander payload. Its EVM data and
/// criteria are byte arrays (one JSON integer per byte); a typed parse skips
/// them instead of materializing a Value per byte on every poll.
fn payloadStatus(allocator: Allocator, store: lander.store.Store, uuid: lander.types.Uuid) !?PayloadDisposition {
    const bytes = (try store.typed.get(allocator, lander.store.payload_by_uuid, &uuid)) orelse return null;
    defer allocator.free(bytes);
    const Head = struct { details: struct { uuid: []const u8 }, status: std.json.Value };
    var head = try std.json.parseFromSlice(Head, allocator, bytes, .{ .ignore_unknown_fields = true, .duplicate_field_behavior = .@"error" });
    defer head.deinit();
    if (!std.mem.eql(u8, &try lander.types.parseUuid(head.value.details.uuid), &uuid)) return error.PayloadRecordIdentityMismatch;
    return try statusDisposition(head.value.status);
}

fn statusDisposition(status: std.json.Value) !PayloadDisposition {
    if (status == .string) {
        if (std.mem.eql(u8, status.string, "ReadyToSubmit")) return .active;
        return error.InvalidLanderRecord;
    }
    if (status != .object or status.object.count() != 1) return error.InvalidLanderRecord;
    if (status.object.get("Dropped")) |reason| {
        if (reason != .string) return error.InvalidLanderRecord;
        const valid = std.mem.eql(u8, reason.string, "FailedToBuildAsTransaction") or
            std.mem.eql(u8, reason.string, "FailedSimulation") or
            std.mem.eql(u8, reason.string, "Reverted") or
            std.mem.eql(u8, reason.string, "UnhandledError");
        if (!valid) return error.InvalidLanderRecord;
        return .failed;
    }
    if (status.object.get("Retry")) |reason| {
        if (reason != .string or !std.mem.eql(u8, reason.string, "Reorged")) return error.InvalidLanderRecord;
        return .failed;
    }
    const inner = status.object.get("InTransaction") orelse return error.InvalidLanderRecord;
    return switch (try lander.types.statusFromJson(inner)) {
        .pending_inclusion, .mempool => .active,
        .included => .included,
        .finalized => .finalized,
        .dropped => .failed,
    };
}

fn retryExisting(actor: *agents_operation.Operation, reason: Reason, failure: anyerror, config: Config, now: agents_operation.Times, uuid: payload_links.Uuid) !Report {
    if (actor.value.stage == .denied) _ = try actor.apply(.allow, now, null);
    if (actor.value.stage == .preparing or actor.value.stage == .ready or (actor.value.stage == .pending and actor.value.confirmation_started)) {
        _ = try actor.apply(.{ .retry = .{ .generation = actor.value.generation, .reason = .transient, .now_ms = now.monotonic_ms, .jitter = config.jitter } }, now, reason);
    } else if (actor.value.stage != .pending) return error.EvmDriverStateMismatch;
    return .{ .state = .retried, .reason = reason, .failure = failure, .payload = uuid };
}

fn retryReason(reason: evm_prepare.RetryReason) Reason {
    return switch (reason) {
        .chain_validation, .canonical_message, .delivery_status => .ErrorCheckingDeliveryStatus,
        .recipient_contract => .ErrorCheckingIfRecipientIsContract,
        .gas_payment_not_found => .GasPaymentNotFound,
        .gas_payment_requirement_not_met => .GasPaymentRequirementNotMet,
        .gas_payment_check => .ErrorCheckingGasRequirement,
        .origin_sender => .ErrorFetchingOriginTxSender,
        .metadata => .CouldNotFetchMetadata,
        .metadata_refused => .MessageMetadataRefused,
        .awaiting_validator_signatures => .AwaitingValidatorSignatures,
        .estimation => .ErrorEstimatingGas,
        .awaiting_ica_reveal => .AwaitingIcaReveal,
        .exceeds_max_gas_limit => .ExceedsMaxGasLimit,
        .payload_validation => .ErrorCreatingPayload,
    };
}

fn retryFailure(failure: ?[]const u8) ?anyerror {
    return if (failure == null) null else error.SourcePreparationFailed;
}

fn finalizedDelivered(client: *evm.RpcClient, message: protocol.Message, config: Config) !bool {
    if (!config.source.chain_verified) try client.checkChain(config.source.chain_id);
    const block: evm.provider.BlockRef = switch (config.source.reorg) {
        .blocks => |blocks| .{ .number = (try client.blockNumber()) -| blocks },
        .tag => |tag| try evm.provider.BlockRef.fromTag(tag),
    };
    return client.delivered(config.source.mailbox[12..32].*, message.id(), block);
}

fn validateAuthority(destination: *lander.Service, actor: *agents_operation.Operation, message: protocol.Message, config: Config) !void {
    if (!std.mem.eql(u8, &actor.options.id, &message.id()) or actor.options.nonce != message.nonce or actor.options.destination != message.destination) return error.EvmDriverAuthorityMismatch;
    if (config.source.domain != message.destination or config.source.chain_id != destination.config.chain_id) return error.EvmDriverAuthorityMismatch;
    if (!std.mem.eql(u8, &config.source.relayer, &destination.config.signer.address)) return error.EvmDriverAuthorityMismatch;
    if (actor.value.transaction != null) return error.EvmDriverClassicTransactionForbidden;
}

fn validateCanonical(store: *native.Store, message: protocol.Message) !void {
    if (!try store.operationMessageAuthorized(message)) return error.StaleCanonicalMessage;
}

fn markNonContractTerminal(allocator: Allocator, store: *native.Store, message: protocol.Message) !void {
    store.mutex.lock();
    defer store.mutex.unlock();
    if (!try store.operationMessageAuthorized(message)) return error.StaleCanonicalMessage;
    var batch = try store.typed.batch(allocator);
    defer batch.deinit();
    try batch.put(db.keys.Table.terminally_dropped_message_by_id.prefix(), &message.id(), &.{1});
    const prefix = try db.keys.pendingDestination(allocator, message.destination);
    defer allocator.free(prefix);
    var nonce: [4]u8 = undefined;
    std.mem.writeInt(u32, &nonce, message.nonce, .big);
    const indexed = try store.typed.get(allocator, prefix, &nonce);
    defer if (indexed) |bytes| allocator.free(bytes);
    if (indexed != null and std.mem.eql(u8, indexed.?, &message.id())) try batch.delete(prefix, &nonce);
    try batch.commitSync();
}

fn checkCancelled(cancel: ?*const std.atomic.Value(bool)) !void {
    if (cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
}

test {
    _ = @import("evm_driver_test.zig");
}
