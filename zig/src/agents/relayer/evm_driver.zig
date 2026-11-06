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
};

pub const Callbacks = struct {
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
};

pub const State = enum {
    idle,
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
};

pub const Driver = struct {
    allocator: Allocator,
    retry_state: evm_prepare.RetryState = .{},
    cached_metadata: ?[]u8 = null,

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
            try value.replay(destination);
            if (actor.value.stage != .denied) try actor.payloadEnqueued(value.record().generation, now);
        }

        const inherited = try payload_links.inheritedUuids(allocator, actor.store, message.id());
        defer allocator.free(inherited);
        if (inherited.len != 0) return self.reconcilePayloads(allocator, destination, actor, client, message, config, now, callbacks, inherited, if (link) |*value| value.record().payload.uuid else null, if (link) |*value| value else null);

        const current = try observationTime(callbacks, now);
        if (actor.parked or current.monotonic_ms < actor.value.next_attempt_ms) return .{ .state = .idle };
        if (actor.value.confirmation_started) {
            try client.checkChain(config.source.chain_id);
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
        _ = self;
        const statuses = try allocator.alloc(PayloadDisposition, inherited.len);
        defer allocator.free(statuses);
        var unknown = false;
        for (inherited, statuses) |uuid, *disposition| {
            var record = (try destination.store.loadPayload(allocator, uuid)) orelse {
                unknown = true;
                disposition.* = .unknown;
                continue;
            };
            defer record.deinit();
            if (!std.mem.eql(u8, &try lander.records.payloadUuid(record.value()), &uuid)) return error.PayloadRecordIdentityMismatch;
            disposition.* = try payloadDisposition(record.value());
        }
        if (unknown) {
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

        switch (outcome.value) {
            .ready => |ready| {
                try self.updateRetryState(ready.retry_state, null);
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

fn payloadDisposition(value: std.json.Value) !PayloadDisposition {
    const status = try lander.types.field(value, "status");
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
    try client.checkChain(config.source.chain_id);
    const block: evm.provider.BlockRef = switch (config.source.reorg) {
        .blocks => |blocks| .{ .number = (try client.blockNumber()) -| blocks },
        .tag => |tag| blk: {
            if (!std.mem.eql(u8, tag, "finalized")) return error.UnsupportedFinalityTag;
            break :blk .finalized;
        },
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
