//! Operational relayer ownership. Indexers and destinations run independently;
//! each destination exclusively owns its clients, credentials and transaction lane.
const std = @import("std");
const settings = @import("../settings/root.zig");
const origins = @import("origin_tasks.zig");
const resources = @import("chain_source.zig");
const loader = @import("loader.zig");
const native = @import("store.zig");
const protocol = @import("../protocol/root.zig");
const supervisor = @import("../runtime/supervisor.zig");
const remote = @import("../relayer/remote_checkpoints.zig");
const policy = @import("relay_policy.zig");
const regex = @import("../ops/regex.zig");
const denylist = @import("../ops/runtime_denylist.zig");
const operator_native = @import("../ops/native.zig");
const curl = @import("../net/curl.zig");
const metrics = @import("../ops/metrics.zig");
const lander_metrics = @import("../ops/lander_metrics.zig");
const relayer_metrics = @import("../ops/relayer_metrics.zig");
const stream_metrics = @import("../ops/stream_metrics.zig");
const db_json = @import("../db/json.zig");
const credentials = @import("credentials.zig");
const signing = @import("signer.zig");
const lander = @import("../lander/root.zig");
const evm_lander = @import("../lander/evm.zig");
const destination = @import("destination/root.zig");
const operation = @import("operation.zig");
const native_driver = @import("relayer/native_driver.zig");
const native_group = @import("relayer/native_group.zig");
const common = @import("scraper/receipts_evm.zig");
const origin_signers = @import("origin_signers.zig");
const signer_tasks = @import("origin_signer_tasks.zig");
const evm_prepare = @import("relayer/evm_prepare.zig");
const evm_driver = @import("relayer/evm_driver.zig");
const rpc_budget = @import("relayer/rpc_budget.zig");
const relayer_control = @import("relayer/control.zig");
const http_runtime = @import("../net/http_runtime.zig");
const read_replay = @import("../net/read_replay.zig");
const metadata_parallel = @import("../relayer/metadata_parallel.zig");
const contract_cache = @import("../relayer/contract_cache.zig");
const cache_metrics = @import("../ops/cache_metrics.zig");
const init_metrics = @import("../ops/init_metrics.zig");
const critical_metrics = @import("../ops/critical_metrics.zig");
const dynamic_tip_cache = @import("../net/dynamic_tip_cache.zig");
const health_set = @import("health_set.zig");
const validator_observability = @import("../ops/validator_observability.zig");
const ccip = @import("../relayer/ccip.zig");
const ccip_sessions = @import("relayer/ccip_sessions.zig");
const ccs_signer = @import("relayer/ccs_signer.zig");
const evm_accounting = @import("relayer/evm_accounting.zig");
const payload_links = @import("payload_links.zig");
const lane_owner = @import("../runtime/lane_owner.zig");
const stream_bridge = @import("stream/relayer_bridge.zig");
const stream_wire = @import("stream/protocol.zig");
const A = std.mem.Allocator;
pub const Options = struct {
    curl_library: []const u8,
    metrics: ?*metrics.Registry = null,
    observation_clock: ?operation.ObservationClock = null,
    request_timeout_ms: u32 = 20000,
    job_timeout_ms: u64 = 120000,
    max_active: usize = 4096,
    max_active_bytes: usize = 64 * 1024 * 1024,
    max_retained_bytes: usize = 256 * 1024 * 1024,
    allow_insecure_loopback: bool = false,
};
const OriginLane = struct {
    loader: ?loader.Loader = null,
    policy: ?policy.Policy = null,
    metrics: ?*relayer_metrics.Adapter = null,
    next_rescan_ms: u64 = 0,
    deny_version: u64 = 0,
    fn deinit(self: *OriginLane) void {
        if (self.loader) |*value| value.deinit();
        if (self.policy) |*value| value.deinit();
        if (self.metrics) |value| value.deinit();
    }
};
pub const SenderState = struct { prepare: origin_signers.Prepare = .{}, checked: bool = false, next_lookup_ns: u64 = 0 };
const group_member_metric_bytes = 2 * (@sizeOf([32]u8) + @sizeOf(u64));
const group_metric_entry_bytes = 2 * (@sizeOf([32]u8) + @sizeOf(usize));
const sender_entry_bytes = 2 * (@sizeOf(SenderState) + @sizeOf([32]u8) + @sizeOf(usize));
const Active = struct {
    origin_index: usize,
    lane: ?*Lane = null,
    message: native.OwnedMessage,
    next_ms: u64 = 0,
    retained_bytes: usize,
    /// Existing durable effects may settle without admitting an excluded
    /// canonical message into processed/confirmed operation bookkeeping.
    recovery_only: bool = false,
    sender_state: SenderState = .{},
    evm_driver: ?evm_driver.Driver = null,
    native_submit_queued: ?bool = null,
    native_needs_preparation: ?bool = null,
    native_prepare_admitted: bool = false,
    /// Current prepare/submit pop passed the local live deny checks. Retain
    /// across cooperative IO, but not across a new retry or queue stage.
    native_pop_checked: bool = false,
    native_submit_inflight: bool = false,
    metric_app_context: ?[]u8 = null,
    first_seen_unix_seconds: u64 = 0,
    metric_status: db_json.Status = .FirstPrepareAttempt,
    metric_active: bool = true,
    pending_tracked: bool = false,
    metadata_started_ms: ?u64 = null,
    metadata_timer: ?std.time.Timer = null,
    metadata_unix_seconds: u64 = 0,
    now_monotonic_ms: u64 = 0,
    now_unix_seconds: u64 = 0,
    confirmed: bool = false,
    submitted_generation: ?u64 = null,
    restored_submitted: bool = false,
    native_group_id: ?[32]u8 = null,
    fn deinit(self: *Active) void {
        if (self.evm_driver) |*value| value.deinit();
        if (self.metric_app_context) |value| self.lane.?.owner.allocator.free(value);
        self.message.deinit();
    }
};
const GroupFrame = struct {
    allocator: A,
    actors: []*destination.operation.Operation,
    messages: []native.OwnedMessage,
    origins: []usize,
    count: usize = 0,
    fn init(a: A, maximum: usize) !GroupFrame {
        const actors = try a.alloc(*destination.operation.Operation, maximum);
        errdefer a.free(actors);
        const messages = try a.alloc(native.OwnedMessage, maximum);
        errdefer a.free(messages);
        return .{ .allocator = a, .actors = actors, .messages = messages, .origins = try a.alloc(usize, maximum) };
    }
    fn deinit(self: *GroupFrame) void {
        for (self.actors[0..self.count]) |actor| actor.deinit();
        for (self.messages[0..self.count]) |*message| message.deinit();
        self.allocator.free(self.actors);
        self.allocator.free(self.messages);
        self.allocator.free(self.origins);
    }
};
pub const Lane = struct {
    owner: *TaskSet,
    public_wallet: health_set.PublicWallet = .{},
    validator_observation: ?validator_observability.Active = null,
    initialization_metrics: ?init_metrics.Adapter = null,
    critical_state: ?*critical_metrics.Tracker = null,
    destination_initialized: bool = false,
    mailbox_timer: ?std.time.Timer = null,
    mailbox_reported: bool = false,
    dispatcher_timer: ?std.time.Timer = null,
    chain: *const settings.Chain,
    origins: []OriginLane,
    control: *relayer_control.Control,
    worker: lane_owner.Owner,
    network: ?*resources.Resources = null,
    protected_network: ?*resources.Resources = null,
    protected_adapter: ?evm_lander.Evm = null,
    protected_checked: bool = false,
    credential_manager: ?*credentials.Manager = null,
    ccip_owner: ?ccip_sessions.Owner = null,
    ccs_owner: ?*ccs_signer.Owner = null,
    signer: ?*signing.DigestSigner = null,
    native_destination: ?*destination.Factory = null,
    evm_adapter: ?evm_lander.Evm = null,
    transactions: ?lander.Service = null,
    lander_metrics: ?lander_metrics.Adapter = null,
    idle_cancel: std.atomic.Value(bool) = .init(false),
    active: std.ArrayList(*Active) = .empty,
    active_bytes: usize = 0,
    next_active: usize = 0,
    next_origin: usize = 0,
    next_reveal_origin: usize = 0,
    context: ?[32]u8 = null,
    native_batch_admission: ?bool = null,
    native_group_gc_cursor: [32]u8 = @splat(0),
    native_group_current_first: bool = false,
    native_group_deadline_ns: ?u64 = null,
    native_group_senders: std.AutoHashMapUnmanaged([32]u8, SenderState) = .empty,
    native_group_last_error: ?anyerror = null,
    native_group_epoch: ?u64 = null,
    native_group_reported: std.AutoHashMapUnmanaged([32]u8, u8) = .empty,
    native_group_member_reported: std.AutoHashMapUnmanaged([32]u8, u64) = .empty,
    telemetry_failures: std.atomic.Value(u64) = .init(0),

    fn deinit(self: *Lane) void {
        self.worker.deinit();
        for (self.active.items) |item| {
            self.finishActiveMetrics(item, .cancelled);
            self.owner.release(item.retained_bytes);
            item.deinit();
            self.owner.allocator.destroy(item);
        }
        self.active.deinit(self.owner.allocator);
        self.clearGroupSenders();
        self.clearGroupMetricState();
        for (self.origins) |*item| item.deinit();
        self.owner.allocator.free(self.origins);
        self.control.deinit();
        if (self.transactions) |*value| value.deinit();
        if (self.native_destination) |value| value.deinit();
        if (self.ccip_owner) |*value| value.deinit();
        if (self.ccs_owner) |value| value.deinit();
        if (self.signer) |value| value.deinit();
        if (self.credential_manager) |value| value.deinit();
        if (self.protected_network) |value| value.deinit();
        if (self.network) |value| value.deinit();
    }
    fn sign(context: *anyopaque, digest: [32]u8) ![65]u8 {
        const self: *Lane = @ptrCast(@alignCast(context));
        if (self.owner.effects_halted.load(.acquire)) return error.RequestCancelled;
        return self.signer.?.signDigest(&digest);
    }
    fn stop(context: *anyopaque) void {
        const self: *Lane = @ptrCast(@alignCast(context));
        self.owner.effects_halted.store(true, .release);
        self.worker.requestStop();
    }
    fn ensure(self: *Lane, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !void {
        const a = self.owner.allocator;
        if (!self.mailbox_reported and self.mailbox_timer == null and self.initialization_metrics != null) self.mailbox_timer = std.time.Timer.start() catch null;
        errdefer |err| if (err != error.PendingReadIo) {
            self.mailbox_timer = null;
            self.dispatcher_timer = null;
        };
        if (self.network == null) self.network = try resources.Resources.open(a, self.chain, self.owner.environment, self.owner.destinationOptions());
        const network = self.network.?;
        network.setCancellation(cancel);
        _ = try network.source();
        if (!self.mailbox_reported) {
            self.initialized(.mailbox, &self.mailbox_timer);
            self.mailbox_reported = true;
        }
        if (self.chain.protocol == .ethereum or self.chain.protocol == .tron) {
            if (self.ccip_owner == null) self.ccip_owner = try ccip_sessions.Owner.init(a, .{ .allow_caching = self.owner.settings.role.relayer.allow_contract_call_caching, .cache_ttl_ms = self.owner.evm_cache.default_ttl_ms, .shared_budget = &self.owner.ccip_budget });
            if (self.ccs_owner == null and self.chain.ccs_signer != null) self.ccs_owner = try ccs_signer.Owner.init(a, self.owner.settings, self.chain, self.owner.environment, .{ .curl_library = self.owner.options.curl_library, .halt = &self.owner.effects_halted, .credential_options = .{ .libcrypto_path = self.owner.environment.get("HYPERLANE_LIBCRYPTO_LIBRARY") orelse if (@import("builtin").os.tag == .macos) "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" else "libcrypto.so.3" } });
        }
        if (self.credential_manager == null) self.credential_manager = try credentials.Manager.init(a, self.owner.settings, self.owner.environment, &network.http, .{ .libcrypto_path = self.owner.environment.get("HYPERLANE_LIBCRYPTO_LIBRARY") orelse if (@import("builtin").os.tag == .macos) "/opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib" else "libcrypto.so.3" });
        const lease = try self.credential_manager.?.lease(times.unix_ms / 1000);
        const signer_config = self.chain.signer orelse return error.MissingTransactionSigner;
        if (self.chain.protocol == .ethereum) {
            if (self.signer == null) {
                var timer = if (self.initialization_metrics != null) std.time.Timer.start() catch null else null;
                // Source init_ccip_signer uses configured chain.signer on EVM/Tron,
                // not the separate CCS signer. It measures failed builds too.
                defer self.initialized(.ccip_signers, &timer);
                self.signer = try signing.DigestSigner.open(a, signer_config, lease);
            }
            try self.signer.?.refresh(lease);
            const signer: lander.Signer = .{ .context = self, .address = self.signer.?.address, .sign_fn = sign };
            if (self.chain.connection.ethereum.mev_submission) |protected| {
                if (self.protected_network == null) {
                    var private_chain = self.chain.*;
                    private_chain.rpc_urls = protected.rpc_urls;
                    private_chain.connection.ethereum.mev_submission = null;
                    var private_options = self.owner.sourceOptions();
                    private_options.request_timeout_ms = 5000;
                    self.protected_network = try resources.Resources.open(a, &private_chain, self.owner.environment, private_options);
                    self.protected_adapter = .{ .rpc = &self.protected_network.?.rpc_client.?, .reorg = self.chain.reorg };
                }
                self.protected_network.?.setCancellation(cancel);
                if (!self.protected_checked) {
                    try self.protected_network.?.rpc_client.?.checkChain(try std.fmt.parseInt(u256, self.chain.chain_id, 0));
                    self.protected_checked = true;
                }
            }
            if (self.transactions == null) {
                if (self.chain.submitter == .lander and self.dispatcher_timer == null and self.initialization_metrics != null) self.dispatcher_timer = std.time.Timer.start() catch null;
                self.evm_adapter = .{ .rpc = &network.rpc_client.?, .reorg = self.chain.reorg };
                self.transactions = try lander.Service.open(a, lander.Store.init(try self.owner.database.get(cancel), self.chain.name), self.evm_adapter.?.interface(), .{
                    .domain_name = self.chain.name,
                    .chain_id = try std.fmt.parseInt(u256, self.chain.chain_id, 0),
                    .signer = signer,
                    .observer = if (self.lander_metrics) |*adapter| adapter.observer() else null,
                    .overrides = self.chain.connection.ethereum.transaction_overrides,
                    .max_batch_size = self.chain.max_batch_size,
                    .max_submit_queue_length = self.chain.max_submit_queue_length,
                    .batch_contract_address = if (self.chain.batch_contract_address) |address_| address_[12..32].* else try @import("../evm/codecs.zig").fixedHex(20, "0xcA11bde05977b3631167028862bE2a173976CA11"),
                    .bypass_batch_simulation = self.chain.bypass_batch_simulation,
                    .mev_submission = if (self.chain.connection.ethereum.mev_submission) |protected| .{
                        .policy = .{ .mailbox = self.chain.contracts.mailbox[12..32].*, .ica_router = protected.ica_router, .additional_ica_routers = protected.additional_ica_routers },
                        .protected_chain = self.protected_adapter.?.interface(),
                        .timeout_ms = 5000,
                    } else null,
                    .arbitrum_nitro = self.chain.technical_stack == .arbitrumnitro,
                    .zksync_stack = self.chain.technical_stack == .zksync,
                    .estimated_block_time_ms = @intFromFloat(@max(1, self.chain.estimated_block_time * 1000)),
                }, &self.idle_cancel);
                self.initialized(.dispatcher_and_entrypoint, &self.dispatcher_timer);
            }
            self.transactions.?.config.signer = signer;
            self.transactions.?.cancel = cancel;
            if (self.context == null) self.context = contextHash(self.chain, self.signer.?.address);
        } else {
            if (self.native_destination == null) {
                const bindings = try a.alloc(destination.OriginBinding, self.owner.settings.chains.len);
                defer a.free(bindings);
                for (bindings, self.owner.settings.chains) |*binding, origin| binding.* = .{ .domain = origin.domain, .hook = origin.contracts.merkle_tree_hook };
                self.native_destination = try destination.Factory.open(a, network, signer_config, lease, .{
                    .origin_bindings = bindings,
                    .regex_engine = if (self.owner.regex_engine) |*value| value else null,
                    .starknet_crypto_library = self.owner.environment.get("HYPERLANE_STARKNET_CRYPTO_LIBRARY"),
                    .aleo_parameter_home = self.owner.environment.get("HYPERLANE_ALEO_PARAMETER_HOME"),
                    .allow_fixture_transport = self.owner.options.allow_insecure_loopback,
                    .enable_reveals = true,
                    .metadata_executor = &self.owner.metadata_executor.executor,
                    .concurrent_svm_estimates = true,
                    .metadata_cache = &self.owner.native_cache,
                    .default_ism_cache = &self.owner.native_default_ism_cache,
                    .initialization_observer = if (self.initialization_metrics) |*value| value.observer() else null,
                    .observation = if (self.validator_observation) |*value| value.observation() else null,
                    .ism_cache_configs = self.owner.settings.role.relayer.ism_cache_configs,
                    .metric_app_contexts = self.owner.settings.role.relayer.metric_app_contexts,
                });
            }
            try self.native_destination.?.refresh(lease);
        }
        // Publish only after the actual lane initialization/refresh succeeded.
        var wallet_text: [256]u8 = undefined;
        const wallet = if (self.signer) |value|
            try std.fmt.bufPrint(&wallet_text, "0x{s}", .{std.fmt.bytesToHex(value.address, .lower)})
        else
            try self.native_destination.?.publicWalletInto(&wallet_text);
        try self.public_wallet.publish(wallet);
    }
    fn initialized(self: *Lane, entity: init_metrics.Entity, timer: *?std.time.Timer) void {
        if (timer.*) |*value| if (self.initialization_metrics) |*adapter| adapter.observer().completed(entity, value.read());
        timer.* = null;
    }
    fn detach(self: *Lane) void {
        if (self.network) |value| value.setCancellation(null);
        if (self.protected_network) |value| value.setCancellation(null);
        if (self.transactions) |*value| value.cancel = &self.idle_cancel;
    }
    fn metricAdapter(self: *Lane, origin_index: usize) ?*relayer_metrics.Adapter {
        return self.origins[origin_index].metrics;
    }
    /// Only optional telemetry calls enter this boundary. Canonical DB reads,
    /// operation transitions, policy/security checks and I/O keep their errors.
    fn telemetryFailure(self: *Lane, err: anyerror) void {
        if (self.telemetry_failures.fetchAdd(1, .monotonic) == 0) std.log.warn("relayer telemetry update failed: {s}", .{@errorName(err)});
    }
    fn appEqual(left: ?[]const u8, right: ?[]const u8) bool {
        if (left == null or right == null) return left == null and right == null;
        return std.mem.eql(u8, left.?, right.?);
    }
    fn queueForStatus(status: db_json.Status) relayer_metrics.Queue {
        if (status == .Confirm) return .confirm_queue;
        if (status == .ReadyToSubmit) return .submit_queue;
        return .prepare_queue;
    }
    fn syncQueueStatus(self: *Lane, item: *Active, status: db_json.Status) void {
        const adapter = self.metricAdapter(item.origin_index) orelse return;
        var count: u64 = 0;
        for (self.active.items) |candidate| {
            if (candidate.metric_active and candidate.origin_index == item.origin_index and std.meta.eql(candidate.metric_status, status) and appEqual(candidate.metric_app_context, item.metric_app_context)) count +|= 1;
        }
        adapter.setQueueLength(queueForStatus(status), status, item.metric_app_context, count) catch |err| self.telemetryFailure(err);
    }
    fn syncPending(self: *Lane, item: *Active) void {
        const adapter = self.metricAdapter(item.origin_index) orelse return;
        if (item.metric_status == .Confirm) {
            if (item.pending_tracked) {
                item.pending_tracked = false;
                _ = adapter.finishPending(item.message.value.id()) catch |err| {
                    self.telemetryFailure(err);
                    return;
                };
            }
            return;
        }
        if (!item.pending_tracked) {
            _ = adapter.recordPending(.{ .message_id = item.message.value.id(), .app_context = item.metric_app_context, .first_seen_unix_seconds = item.first_seen_unix_seconds }) catch |err| {
                self.telemetryFailure(err);
                return;
            };
            item.pending_tracked = true;
        }
    }
    const MetricContext = struct { text: ?[]u8 = null, bytes: usize = 0, enabled: bool = true };
    /// Context labels are optional telemetry ownership, not admission payloads.
    /// A bounded label/allocator failure must not consume the core reservation.
    fn retainMetricContext(self: *Lane, context: ?[]const u8, available: usize) MetricContext {
        const value = context orelse return .{};
        if (value.len > available or !self.owner.reserve(value.len)) {
            self.telemetryFailure(error.MetricMemoryLimit);
            return .{ .enabled = false };
        }
        const owned = self.owner.allocator.dupe(u8, value) catch |err| {
            self.owner.release(value.len);
            self.telemetryFailure(err);
            return .{ .enabled = false };
        };
        return .{ .text = owned, .bytes = value.len };
    }
    fn initializeActiveMetrics(self: *Lane, item: *Active) !void {
        if (item.lane != null) return;
        const origin = self.owner.origins.slots[item.origin_index].handle() orelse return error.OriginNotReady;
        const status = (try origin.store.status(item.message.value.id())) orelse .FirstPrepareAttempt;
        const app_context = try self.origins[item.origin_index].policy.?.appContext(item.message.value);
        item.lane = self;
        item.first_seen_unix_seconds = item.now_unix_seconds;
        item.metric_status = status;
        const retained = self.retainMetricContext(app_context, self.owner.options.max_active_bytes -| self.active_bytes -| self.control.reservedBytes());
        item.metric_app_context = retained.text;
        item.metric_active = retained.enabled;
        item.retained_bytes += retained.bytes;
        self.active_bytes += retained.bytes;
        self.syncActiveMetrics(item, status);
    }
    fn syncActiveMetrics(self: *Lane, item: *Active, status: db_json.Status) void {
        const previous = item.metric_status;
        const changed = !std.meta.eql(previous, status);
        item.metric_status = status;
        if (!item.metric_active) return;
        if (changed) self.syncQueueStatus(item, previous);
        self.syncQueueStatus(item, status);
        self.syncPending(item);
    }
    fn finishActiveMetrics(self: *Lane, item: *Active, outcome: relayer_metrics.WaitEnd) void {
        const adapter = self.metricAdapter(item.origin_index) orelse {
            item.metric_active = false;
            item.pending_tracked = false;
            item.metadata_started_ms = null;
            item.metadata_timer = null;
            return;
        };
        if (item.pending_tracked) {
            item.pending_tracked = false;
            _ = adapter.finishPending(item.message.value.id()) catch |err| failed: {
                self.telemetryFailure(err);
                break :failed false;
            };
        }
        if (item.metric_active) {
            item.metric_active = false;
            self.syncQueueStatus(item, item.metric_status);
        }
        item.metadata_started_ms = null;
        item.metadata_timer = null;
        _ = adapter.finishMetadataWait(item.message.value.id(), outcome, item.now_monotonic_ms) catch |err| {
            self.telemetryFailure(err);
            return;
        };
    }
    fn recordPhase(self: *Lane, item: *Active, phase: relayer_metrics.OperationPhase) void {
        if (!item.metric_active) return;
        const adapter = self.metricAdapter(item.origin_index) orelse return;
        adapter.recordOperation(phase, item.metric_app_context) catch |err| self.telemetryFailure(err);
    }
    fn markGroupMemberSubmitted(self: *Lane, id: [32]u8, generation: u64) bool {
        if (self.native_group_member_reported.getPtr(id)) |old| {
            if (old.* == generation) return false;
            old.* = generation;
            return true;
        }
        if (self.native_group_member_reported.count() >= 4096 or !self.owner.reserve(group_member_metric_bytes)) {
            self.telemetryFailure(error.MetricMemoryLimit);
            return false;
        }
        self.native_group_member_reported.put(self.owner.allocator, id, generation) catch |err| {
            self.owner.release(group_member_metric_bytes);
            self.telemetryFailure(err);
            return false;
        };
        return true;
    }
    fn recordSubmitted(self: *Lane, item: *Active, generation: u64, at: operation.Times) void {
        if (item.submitted_generation == generation) return;
        if (item.restored_submitted) {
            item.restored_submitted = false;
            item.submitted_generation = generation;
            return;
        }
        item.submitted_generation = generation;
        if (self.metricAdapter(item.origin_index) == null) return;
        if (item.native_group_id != null and !self.markGroupMemberSubmitted(item.message.value.id(), generation)) return;
        item.now_monotonic_ms = at.monotonic_ms;
        item.now_unix_seconds = at.unix_ms / 1000;
        self.recordPhase(item, .submitted);
    }
    pub fn clearGroupMetricState(self: *Lane) void {
        self.owner.release(self.native_group_reported.count() * group_metric_entry_bytes);
        self.native_group_reported.deinit(self.owner.allocator);
        self.native_group_reported = .empty;
        self.owner.release(self.native_group_member_reported.count() * group_member_metric_bytes);
        self.native_group_member_reported.deinit(self.owner.allocator);
        self.native_group_member_reported = .empty;
    }
    fn groupEvent(self: *Lane, id: [32]u8, mask: u8) bool {
        if (self.native_group_reported.getPtr(id)) |value| {
            if (value.* & mask != 0) return false;
            value.* |= mask;
            return true;
        }
        if (self.native_group_reported.count() >= 4096 or !self.owner.reserve(group_metric_entry_bytes)) {
            self.telemetryFailure(error.MetricMemoryLimit);
            return false;
        }
        self.native_group_reported.put(self.owner.allocator, id, mask) catch |err| {
            self.owner.release(group_metric_entry_bytes);
            self.telemetryFailure(err);
            return false;
        };
        return true;
    }
    fn groupRetired(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame) void {
        if (self.owner.metric_tracker == null) return;
        if (journal.record.observation_epoch != self.native_group_epoch or journal.record.observation_epoch == null or !self.groupEvent(journal.id, 2)) return;
        for (journal.record.members, frame.actors[0..frame.count]) |member, actor| {
            if (!actor.options.acknowledge_canonical) continue;
            if (actor.value.stage == .delivered) continue;
            var active = false;
            for (self.active.items) |item| if (std.mem.eql(u8, &item.message.value.id(), &actor.options.id)) {
                self.recordPhase(item, .dropped);
                active = true;
                break;
            };
            if (active) continue;
            for (self.owner.origins.slots, 0..) |slot, index| if (slot.chain.domain == member.origin) {
                const adapter = self.metricAdapter(index) orelse break;
                self.control.ensurePolicy(self, index) catch |err| {
                    self.telemetryFailure(err);
                    break;
                };
                var message = actor.store.messageById(actor.options.id) catch |err| {
                    self.telemetryFailure(err);
                    break;
                };
                defer if (message) |*value| value.deinit();
                if (message) |value| {
                    if (!(self.canonicalAdmissionAllowed(index, value.value) catch |err| {
                        self.telemetryFailure(err);
                        break;
                    })) break;
                    const context = self.origins[index].policy.?.appContext(value.value) catch |err| {
                        self.telemetryFailure(err);
                        break;
                    };
                    adapter.recordOperation(.dropped, context) catch |err| self.telemetryFailure(err);
                }
                break;
            };
        }
    }
    fn groupSubmitted(self: *Lane, journal: *const native_group.Journal, fallback: operation.Times) !void {
        if (self.owner.metric_tracker == null) return;
        // Current-process inclusion is an event for EVERY member, even when a
        // lower active cap leaves some outside Active. Historical recovery is
        // state restoration and must not replay the process counter.
        if (journal.record.observation_epoch == null or journal.record.observation_epoch != self.native_group_epoch) return;
        if (!self.groupEvent(journal.id, 1)) return;
        for (journal.record.members) |member| {
            var prepared = destination.types.Prepared.restore(self.owner.allocator, member.intent) catch |err| {
                self.telemetryFailure(err);
                continue;
            };
            defer prepared.deinit();
            var active = false;
            for (self.active.items) |item| if (std.mem.eql(u8, &item.message.value.id(), &prepared.authority.operation_id)) {
                active = true;
                item.restored_submitted = false;
                item.native_group_id = journal.id;
                const observed = self.groupTime(fallback) catch fallback;
                self.recordSubmitted(item, prepared.authority.generation, observed);
                break;
            };
            if (active) continue;
            for (self.owner.origins.slots, 0..) |slot, index| if (slot.chain.domain == member.origin) {
                const adapter = self.metricAdapter(index) orelse break;
                self.control.ensurePolicy(self, index) catch |err| {
                    self.telemetryFailure(err);
                    break;
                };
                var message = self.owner.origins.slots[index].handle().?.store.messageById(prepared.authority.operation_id) catch |err| {
                    self.telemetryFailure(err);
                    break;
                };
                defer if (message) |*value| value.deinit();
                if (message) |value| {
                    if (!(self.canonicalAdmissionAllowed(index, value.value) catch |err| {
                        self.telemetryFailure(err);
                        break;
                    })) break;
                    const context = self.origins[index].policy.?.appContext(value.value) catch |err| {
                        self.telemetryFailure(err);
                        break;
                    };
                    if (self.markGroupMemberSubmitted(prepared.authority.operation_id, prepared.authority.generation)) adapter.recordOperation(.submitted, context) catch |err| self.telemetryFailure(err);
                }
                break;
            };
        }
    }
    fn markConfirmed(self: *Lane, item: *Active) void {
        if (item.confirmed) return;
        item.confirmed = true;
        self.recordPhase(item, .confirmed);
    }
    fn recordProcessed(self: *Lane, item: *Active) void {
        if (!item.metric_active) return;
        const adapter = self.metricAdapter(item.origin_index) orelse return;
        adapter.recordProcessed(item.message.value.nonce) catch |err| self.telemetryFailure(err);
        _ = adapter.finishMetadataWait(item.message.value.id(), .recovered, item.now_monotonic_ms) catch |err| {
            self.telemetryFailure(err);
            return;
        };
    }
    fn metadataObserverFor(item: *Active) ?relayer_metrics.MetadataObserver {
        if (!item.metric_active or item.lane.?.metricAdapter(item.origin_index) == null) return null;
        return .{ .context = item, .start_fn = metadataStart, .complete_fn = metadataComplete };
    }
    fn metadataStart(context: *anyopaque) !void {
        const item: *Active = @ptrCast(@alignCast(context));
        if (item.metadata_started_ms != null) return;
        item.metadata_timer = std.time.Timer.start() catch |err| {
            item.lane.?.telemetryFailure(err);
            return;
        };
        item.metadata_started_ms = item.now_monotonic_ms;
        item.metadata_unix_seconds = item.now_unix_seconds;
    }
    fn metadataComplete(context: *anyopaque, result: relayer_metrics.MetadataResult) !void {
        const item: *Active = @ptrCast(@alignCast(context));
        const lane = item.lane.?;
        if (item.lane.?.owner.options.observation_clock) |clock| {
            if (clock.now()) |observed| {
                item.now_monotonic_ms = observed.monotonic_ms;
                item.now_unix_seconds = observed.unix_ms / 1000;
            } else |err| lane.telemetryFailure(err);
        }
        const duration_ns: ?u64 = if (item.metadata_started_ms != null) if (item.metadata_timer) |*timer| timer.read() else null else null;
        item.metadata_started_ms = null;
        item.metadata_timer = null;
        const adapter = lane.metricAdapter(item.origin_index) orelse return;
        if (duration_ns) |elapsed| adapter.recordMetadataBuild(.{ .app_context = item.metric_app_context, .status = if (result == .success) .success else .failure, .duration_ns = elapsed }) catch |err| lane.telemetryFailure(err);
        switch (result) {
            .success, .failure, .cancelled => _ = adapter.finishMetadataWait(item.message.value.id(), switch (result) {
                .success => .recovered,
                .failure => .ended,
                .cancelled => .cancelled,
                else => unreachable,
            }, item.now_monotonic_ms) catch |err| {
                lane.telemetryFailure(err);
                return;
            },
            .awaiting_validator_signatures => _ = adapter.recordMetadataWait(.{ .message_id = item.message.value.id(), .app_context = item.metric_app_context, .unix_timestamp_seconds = item.metadata_unix_seconds, .monotonic_ms = item.now_monotonic_ms }) catch |err| {
                lane.telemetryFailure(err);
                return;
            },
        }
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Lane = @ptrCast(@alignCast(context));
        return try self.worker.poll(times, cancel) orelse error.PendingReadIo;
    }
    fn cycle(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Lane = @ptrCast(@alignCast(context));
        return self.cycleInner(times, cancel) catch |err| {
            if (err != error.PendingReadIo and err != error.PendingIo) {
                self.native_batch_admission = null;
                for (self.active.items) |item| {
                    item.native_prepare_admitted = false;
                    item.native_pop_checked = false;
                }
            }
            if (classify(err) == .halt_all) self.owner.requestStop();
            return err;
        };
    }
    fn cycleInner(self: *Lane, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        if (self.owner.effects_halted.load(.acquire)) return error.RequestCancelled;
        if (!self.owner.denylist_ready.load(.acquire)) return .{ .next_delay_ms = 100 };
        defer self.detach();
        var work = try self.control.drain(self, times, cancel);
        for (self.origins) |*origin| if (origin.policy) |*value| {
            value.gateway = &self.owner.control_hub.gateway_policy;
        };
        self.ensure(times, cancel) catch |err| {
            if (!self.destination_initialized and err != error.PendingReadIo and err != error.PendingIo and err != error.RequestCancelled and err != error.Cancelled and err != error.RequestDeadlineExceeded and err != error.ReadReplayDeadline and err != error.SvmRequestDeadline) {
                if (self.critical_state) |tracker| tracker.record(.destination);
            }
            return err;
        };
        if (!self.destination_initialized) {
            self.destination_initialized = true;
            if (self.critical_state) |tracker| tracker.clear(.destination);
        }
        if (self.transactions) |*transactions| {
            const report = try transactions.tick(times.unix_ms, .{ .max_build = 4, .max_receipts = 16 });
            work +|= report.built + report.broadcasts + report.finalized;
        }
        if (self.native_destination) |factory| {
            for (0..self.origins.len) |_| {
                const origin_index = self.next_reveal_origin;
                self.next_reveal_origin = (origin_index + 1) % self.origins.len;
                const origin = self.owner.origins.slots[origin_index].handle() orelse continue;
                work +|= try factory.tickReveal(origin.store, .{ .unix_ms = times.unix_ms, .deadline_ns = (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms, .cancel = cancel, .halt = &self.owner.effects_halted }, .{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms });
                break;
            }
        }
        const quantum: usize = @min(32, @max(1, self.chain.max_batch_size));
        for (0..quantum) |_| {
            const loaded = try self.load(times);
            work +|= loaded;
            if (loaded == 0) break;
        }
        work +|= try self.tickNativeGroups(.{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms }, cancel);
        // Source checks the threshold once before popping a preparation batch.
        // Ready/signed/confirm actors still run even when this batch is held.
        try self.beginNativePreparationBatch(times, cancel, quantum);
        defer self.native_batch_admission = null;
        var remaining = @min(quantum, self.active.items.len);
        while (remaining > 0 and self.active.items.len > 0) : (remaining -= 1) {
            self.next_active %= self.active.items.len;
            const index = self.next_active;
            self.next_active = (index + 1) % self.active.items.len;
            const item = self.active.items[index];
            const current_times: supervisor.Times = if (self.owner.options.observation_clock) |clock| updated: {
                const observed = try clock.now();
                break :updated .{ .unix_ms = observed.unix_ms, .monotonic_ms = observed.monotonic_ms };
            } else times;
            if (item.next_ms <= current_times.monotonic_ms) {
                if (try self.advance(item, current_times, cancel)) {
                    try self.releaseCompleted(index);
                }
                work +|= 1;
            }
        }
        var delay_ms: u64 = if (work > 0) 10 else 100;
        // A held preparation is eligible after Source's150ms sleep, rather
        // than after rounding it up to the next100ms owner polling boundary.
        for (self.active.items) |item| if (item.next_ms > times.monotonic_ms) {
            delay_ms = @min(delay_ms, item.next_ms - times.monotonic_ms);
        };
        return .{ .work = work, .next_delay_ms = delay_ms };
    }
    fn groupTime(self: *Lane, fallback: operation.Times) !operation.Times {
        return if (self.owner.options.observation_clock) |clock| clock.now() else fallback;
    }
    fn groupClock(self: *Lane, times: operation.Times, cancel: *const std.atomic.Value(bool)) !destination.Clock {
        return .{ .unix_ms = times.unix_ms, .deadline_ns = self.native_group_deadline_ns orelse (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms, .cancel = cancel, .halt = &self.owner.effects_halted };
    }
    fn senderNowNs(self: *Lane) !u64 {
        return if (self.owner.options.observation_clock) |clock| (try clock.now()).monotonic_ms *| std.time.ns_per_ms else common.nowNs();
    }
    fn originSenderGate(self: *Lane, state: *SenderState, origin_index: usize, message: protocol.Message, clock: destination.Clock, cached_only: bool) !native_driver.GateResult {
        if (!self.owner.denylist.hasAddressRules()) return .allow;
        const current = try self.senderNowNs();
        if (self.owner.signers.cache.cached(message.id())) |cached| {
            var snapshot = cached;
            defer snapshot.deinit();
            var decision = try self.origins[origin_index].policy.?.checkOriginSigners(snapshot.signers());
            defer decision.deinit();
            state.checked = true;
            state.next_lookup_ns = 0;
            _ = state.prepare.complete(current, false, .success);
            return if (decision.denial == null) .allow else .deny;
        }
        if (current < state.next_lookup_ns) return .{ .delay_ms = (state.next_lookup_ns - current +| std.time.ns_per_ms - 1) / std.time.ns_per_ms };
        if (state.prepare.skip_until_ns) |until| {
            if (current >= until) state.checked = false;
        }
        // Warm secondary queue gates remain cache-only. A cold restored actor
        // must first run Source's initial lookup/backoff, even at a cached gate.
        if ((cached_only and state.checked) or state.prepare.begin(current) == .cached_only) return .allow;
        const raw_now = try common.nowNs();
        if (raw_now >= clock.deadline_ns) return error.SourceReadDeadline;
        const utc_now = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
        var snapshot = self.owner.signers.lookup(self.owner.allocator, message, true, false, utc_now +| (clock.deadline_ns - raw_now), clock.cancel) catch |err| {
            if (origin_signers.isControlError(err) or err == error.PendingReadIo or err == error.PendingIo) return err;
            const action = state.prepare.complete(current, false, if (err == error.DispatchHashNotStored) .hash_not_stored else .peer_failure);
            return switch (action) {
                .delay_ns => |delay| delayed: {
                    state.next_lookup_ns = current +| delay;
                    break :delayed .{ .delay_ms = (delay +| std.time.ns_per_ms - 1) / std.time.ns_per_ms };
                },
                .proceed, .cached_only => permitted: {
                    state.checked = true;
                    break :permitted .allow;
                },
                .general_retry => .retry,
                .control => error.OriginSignerControlFlow,
                .lookup => error.OriginSignerInvalidAction,
            };
        };
        defer if (snapshot) |*value| value.deinit();
        state.checked = true;
        state.next_lookup_ns = 0;
        _ = state.prepare.complete(current, false, .success);
        if (snapshot) |value| {
            var decision = try self.origins[origin_index].policy.?.checkOriginSigners(value.signers());
            defer decision.deinit();
            if (decision.denial != null) return .deny;
        }
        return .allow;
    }
    fn groupSenderState(self: *Lane, id: [32]u8) !?*SenderState {
        if (self.native_group_senders.getPtr(id)) |state| return state;
        if (self.native_group_senders.count() >= 4096 or !self.owner.reserve(sender_entry_bytes)) return null;
        errdefer self.owner.release(sender_entry_bytes);
        const entry = try self.native_group_senders.getOrPut(self.owner.allocator, id);
        std.debug.assert(!entry.found_existing);
        entry.value_ptr.* = .{};
        return entry.value_ptr;
    }
    pub fn releaseGroupSender(self: *Lane, id: [32]u8) void {
        if (self.native_group_senders.remove(id)) self.owner.release(sender_entry_bytes);
    }
    pub fn clearGroupSenders(self: *Lane) void {
        self.owner.release(self.native_group_senders.count() * sender_entry_bytes);
        self.native_group_senders.deinit(self.owner.allocator);
        self.native_group_senders = .empty;
    }
    fn groupMemberAllowed(self: *Lane, actor: *destination.operation.Operation, origin_index: usize, message: protocol.Message, times: operation.Times, cancel: *const std.atomic.Value(bool)) !bool {
        try self.control.ensurePolicy(self, origin_index);
        self.origins[origin_index].policy.?.gateway = &self.owner.control_hub.gateway_policy;
        const clock = try self.groupClock(times, cancel);
        var maximum = self.owner.settings.role.relayer.transaction_gas_limit;
        for (self.owner.settings.role.relayer.skip_transaction_gas_limit_for) |domain| if (domain == message.destination) {
            maximum = null;
            break;
        };
        const driver: native_driver.Driver = .{ .options = .{ .maximum_gas = maximum } };
        if (!try driver.submissionAllowed(self.owner.allocator, self.native_destination.?, actor, &self.origins[origin_index].policy.?, message, clock)) return false;
        if (!self.owner.denylist.hasAddressRules()) return true;
        const state = try self.groupSenderState(message.id()) orelse return false;
        return try self.originSenderGate(state, origin_index, message, clock, true) == .allow;
    }
    /// This sweep is intentionally local and last: earlier gas/delivery gates
    /// may await RPC while the shared message denylist is refreshed.
    fn groupLocalAdmissionAllowed(self: *Lane, actors: []const *destination.operation.Operation) !bool {
        for (actors) |actor| {
            var index: ?usize = null;
            for (self.owner.origins.slots, 0..) |slot, candidate| if (slot.chain.domain == actor.options.origin) {
                index = candidate;
                break;
            };
            var message = (try actor.store.messageById(actor.options.id)) orelse return error.StaleCanonicalMessage;
            defer message.deinit();
            if (!try self.canonicalAdmissionAllowed(index orelse return error.MissingNativeGroupOrigin, message.value)) return false;
        }
        return true;
    }
    fn openGroup(self: *Lane, journal: *const native_group.Journal, now: operation.Times, cancel: *const std.atomic.Value(bool)) !GroupFrame {
        var frame = try GroupFrame.init(self.owner.allocator, journal.record.members.len);
        errdefer frame.deinit();
        for (journal.record.members) |member| {
            const clock = try self.groupClock(now, cancel);
            _ = try @import("scraper/receipts_common.zig").milliseconds(clock.deadline_ns);
            if (clock.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            if (self.owner.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
            var found: ?usize = null;
            for (self.owner.origins.slots, 0..) |slot, index| if (slot.chain.domain == member.origin) {
                found = index;
                break;
            };
            const index = found orelse return error.MissingNativeGroupOrigin;
            const origin = self.owner.origins.slots[index].handle() orelse return error.MissingNativeGroupOrigin;
            const id = try @import("../evm/codecs.zig").fixedHex(32, member.id);
            const context = try @import("../evm/codecs.zig").fixedHex(32, member.context);
            var message = (try origin.store.messageById(id)) orelse return error.MissingNativeGroupMessage;
            errdefer message.deinit();
            if (message.value.nonce != member.nonce or message.value.origin != member.origin or message.value.destination != self.chain.domain) return error.InvalidNativeGroup;
            const factory = self.native_destination.?;
            if (!std.mem.eql(u8, &context, &try factory.contextFor(try factory.authorityFor(member.origin, id, 1, .process)))) return error.OperationContextChanged;
            try self.control.ensurePolicy(self, index);
            self.origins[index].policy.?.gateway = &self.owner.control_hub.gateway_policy;
            const actor = try destination.operation.Operation.open(self.owner.allocator, origin.store, .{ .id = id, .context = context, .nonce = member.nonce, .origin = member.origin, .destination = self.chain.domain, .policy = .{ .max_retries = self.owner.settings.role.relayer.max_message_retries }, .acknowledge_canonical = try self.canonicalAdmissionAllowed(index, message.value) }, now);
            frame.messages[frame.count] = message;
            frame.actors[frame.count] = actor;
            frame.origins[frame.count] = index;
            frame.count += 1;
        }
        return frame;
    }
    fn clearGroup(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame) !void {
        return self.updateGroupJournal(journal, frame, null);
    }
    fn updateGroupJournal(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, replacement: ?[]const u8) !void {
        // Only this destination owner writes this namespace. A header update
        // preserves every member/nonce; retirement archives settled ownership.
        var arena = std.heap.ArenaAllocator.init(self.owner.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const stores = try a.alloc(*native.Store, frame.count);
        var count: usize = 0;
        for (frame.actors[0..frame.count]) |actor| {
            var known = false;
            for (stores[0..count]) |previous| if (previous == actor.store) {
                known = true;
                break;
            };
            if (!known) {
                stores[count] = actor.store;
                count += 1;
            }
        }
        std.mem.sort(*native.Store, stores[0..count], {}, struct {
            fn less(_: void, l: *native.Store, r: *native.Store) bool {
                return std.mem.lessThan(u8, l.typed.domain_name, r.typed.domain_name);
            }
        }.less);
        for (stores[0..count]) |store| store.mutex.lock();
        defer {
            var remaining = count;
            while (remaining > 0) {
                remaining -= 1;
                stores[remaining].mutex.unlock();
            }
        }
        const current = try journal.store.get(a, destination.operation.group_record_prefix, &journal.id);
        if (current == null or !std.mem.eql(u8, current.?, journal.wire)) return error.StaleNativeGroupOwner;
        var batch = try journal.store.database.batch();
        defer batch.deinit();
        const nonce = try journal.nonce();
        const reserved = try journal.store.get(a, destination.operation.group_nonce_prefix, &nonce);
        if (reserved == null or !std.mem.eql(u8, reserved.?, &journal.id)) return error.NativeGroupNonceOwnerChanged;
        if (replacement) |wire| {
            if (wire.len == 0 or wire.len > destination.operation.Operation.max_record_bytes) return error.InvalidNativeGroup;
            try batch.put(try @import("../db/keys.zig").scoped(a, journal.store.domain_name, destination.operation.group_record_prefix, &journal.id), wire);
        } else {
            try batch.put(try @import("../db/keys.zig").scoped(a, journal.store.domain_name, destination.operation.group_history_prefix, &journal.id), journal.wire);
            try batch.delete(try @import("../db/keys.zig").scoped(a, journal.store.domain_name, destination.operation.group_record_prefix, &journal.id));
            const current_nonce_owner = try journal.store.get(a, destination.operation.group_current_prefix, "");
            if (current_nonce_owner) |id| if (std.mem.eql(u8, id, &journal.id)) try batch.delete(try @import("../db/keys.zig").scoped(a, journal.store.domain_name, destination.operation.group_current_prefix, ""));
            try batch.delete(try @import("../db/keys.zig").scoped(a, journal.store.domain_name, destination.operation.group_nonce_prefix, &nonce));
        }
        for (frame.actors[0..frame.count]) |actor| {
            try actor.assertFreshLocked();
            const link = try actor.store.typed.get(a, destination.operation.group_link_prefix, &actor.options.id);
            if (link == null or !std.mem.eql(u8, link.?, &journal.id)) return error.NativeGroupMemberNotOwned;
            if (replacement == null) try batch.delete(try @import("../db/keys.zig").scoped(a, actor.store.typed.domain_name, destination.operation.group_link_prefix, &actor.options.id));
        }
        try batch.commitSync();
        if (replacement == null) {
            for (frame.actors[0..frame.count]) |actor| {
                self.releaseGroupSender(actor.options.id);
                if (self.native_group_member_reported.remove(actor.options.id)) self.owner.release(group_member_metric_bytes);
            }
            if (self.native_group_reported.remove(journal.id)) self.owner.release(group_metric_entry_bytes);
        }
    }
    fn abandonGroup(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, now: operation.Times) !void {
        var arena = std.heap.ArenaAllocator.init(self.owner.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const originals = try a.alloc(destination.types.Prepared, frame.count);
        const pointers = try a.alloc(*const destination.types.Prepared, frame.count);
        const intents = try a.alloc([]const u8, frame.count);
        var count: usize = 0;
        defer for (originals[0..count]) |*value| value.deinit();
        for (journal.record.members, 0..) |member, index| {
            originals[index] = try destination.types.Prepared.restore(a, member.original);
            count += 1;
            pointers[index] = &originals[index];
            intents[index] = member.intent;
        }
        try destination.operation.abandonUnsignedGroup(self.owner.allocator, frame.actors[0..frame.count], pointers, intents, .{ .store = journal.store, .id = journal.id, .expected = journal.wire, .value = journal.wire, .manage_nonce = true, .nonce_reservation = try journal.nonce() }, now);
        for (frame.actors[0..frame.count]) |actor| for (self.active.items) |item| if (std.mem.eql(u8, &actor.options.id, &item.message.value.id())) {
            item.native_submit_inflight = false;
            item.native_submit_queued = null;
            item.native_needs_preparation = null;
            break;
        };
    }
    fn groupAccounting(self: *Lane, record: *native_group.Record, receipt: destination.types.Receipt) !void {
        const total = receipt.expenditure orelse return;
        var allocated: destination.types.Expenditure = .{ .gas_used = 0, .tokens_used = 0 };
        for (record.members) |member| {
            var prepared = try destination.types.Prepared.restore(self.owner.allocator, member.intent);
            defer prepared.deinit();
            const share = if (record.members.len > 1) try self.native_destination.?.backend.starknet.memberReceipt(&prepared, receipt) else receipt;
            if (share.expenditure) |spent| {
                allocated.gas_used = try std.math.add(u256, allocated.gas_used, spent.gas_used);
                allocated.tokens_used = try std.math.add(u256, allocated.tokens_used, spent.tokens_used);
            }
        }
        record.whole_expenditure = total;
        record.allocated_expenditure = allocated;
        record.unallocated_expenditure = .{ .gas_used = try std.math.sub(u256, total.gas_used, allocated.gas_used), .tokens_used = try std.math.sub(u256, total.tokens_used, allocated.tokens_used) };
    }
    fn groupFinalCosts(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, receipt: destination.types.Receipt) !void {
        if (!receipt.finalized) return;
        for (journal.record.members, frame.actors[0..frame.count]) |member, actor| {
            if (actor.signed == null) continue;
            var prepared = try destination.types.Prepared.restore(self.owner.allocator, member.intent);
            defer prepared.deinit();
            const part = if (frame.count > 1) try self.native_destination.?.backend.starknet.memberReceipt(&prepared, receipt) else receipt;
            _ = try actor.recordExpenditure(part);
        }
    }
    const GroupRetirement = enum { retired, hold, unspent };
    fn retireGroupNonce(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, signed: *const destination.types.Signed, fallback: operation.Times, cancel: *const std.atomic.Value(bool)) !GroupRetirement {
        const factory = self.native_destination.?;
        var representative = try destination.types.Prepared.restore(self.owner.allocator, journal.record.members[0].intent);
        defer representative.deinit();
        const consumed = factory.starknetConsumedNonceProof(&representative, signed, try self.groupClock(fallback, cancel)) catch |err| {
            try self.groupRpcFailure(err);
            return .hold;
        };
        const base = consumed orelse return .unspent;
        const proofs = try self.owner.allocator.alloc(?destination.types.RetirementProof, frame.count);
        defer self.owner.allocator.free(proofs);
        for (journal.record.members, frame.actors[0..frame.count], 0..) |member, actor, index| {
            if (actor.value.stage == .delivered) {
                proofs[index] = null;
                continue;
            }
            var prepared = try destination.types.Prepared.restore(self.owner.allocator, member.intent);
            defer prepared.deinit();
            proofs[index] = factory.starknetNonceRetirementAt(&prepared, signed, base, try self.groupClock(try self.groupTime(fallback), cancel)) catch |err| {
                try self.groupRpcFailure(err);
                return .hold;
            };
            if (proofs[index] == null) return .hold;
        }
        try journal.retire(frame.actors[0..frame.count], base, proofs, self.native_group_epoch, try self.groupTime(fallback));
        return .retired;
    }
    fn advanceSignedGroup(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, fallback: operation.Times, cancel: *const std.atomic.Value(bool)) !u64 {
        const factory = self.native_destination.?;
        if (journal.record.phase != .signed and journal.record.phase != .included) return error.InvalidNativeGroup;
        const members = try self.owner.allocator.alloc(destination.types.Prepared, frame.count);
        defer self.owner.allocator.free(members);
        var member_count: usize = 0;
        defer for (members[0..member_count]) |*member| member.deinit();
        for (journal.record.members, 0..) |member, index| {
            members[index] = try destination.types.Prepared.restore(self.owner.allocator, member.intent);
            member_count += 1;
        }
        if (members.len > 1) try factory.validateStarknetBatch(members);
        if (journal.record.phase == .included) try self.groupSubmitted(journal, fallback);
        var settled = true;
        var confirmation_due = false;
        for (frame.actors[0..frame.count], journal.record.members) |actor, member| {
            if (actor.intent == null or !std.mem.eql(u8, actor.intent.?, member.intent) or actor.signed == null) return error.NativeSignedGroupMemberChanged;
            if (actor.value.stage != .delivered) settled = false;
            if (actor.value.confirmationReady(fallback.monotonic_ms)) confirmation_due = true;
        }
        if (journal.record.phase == .included and journal.record.receipt_finalized and !confirmation_due and !settled) return 0;
        var signed = try journal.signedValue(self.owner.allocator);
        defer signed.deinit();
        const receipt = factory.reconcile(signed.identity, try self.groupClock(fallback, cancel)) catch |err| {
            try self.groupRpcFailure(err);
            return 0;
        };
        if (receipt) |whole| {
            const observed = try self.groupTime(fallback);
            try self.groupFinalCosts(journal, frame, whole);
            var next = journal.record;
            try self.groupAccounting(&next, whole);
            next.receipt_finalized = whole.finalized;
            var evidence_arena = std.heap.ArenaAllocator.init(self.owner.allocator);
            defer evidence_arena.deinit();
            if (whole.finalized) next.canonical_receipt = .{ .identity = journal.record.identity.?, .height = whole.height, .block_hash = try @import("../evm/codecs.zig").hexAlloc(evidence_arena.allocator(), &whole.block_hash), .success = whole.success };
            if (whole.finalized and !whole.success) {
                next.observation_epoch = self.native_group_epoch;
                try journal.failed(next, frame.actors[0..frame.count], whole, observed);
                return 1;
            }
            if (settled and whole.finalized and journal.record.phase == .included and journal.record.canonical_receipt != null) {
                const previous = journal.record.canonical_receipt.?;
                if (previous.height == whole.height and previous.success == whole.success and std.mem.eql(u8, previous.block_hash, next.canonical_receipt.?.block_hash)) {
                    try self.clearGroup(journal, frame);
                    return 1;
                }
            }
            if (journal.record.phase == .signed) {
                if (whole.success) for (frame.messages[0..frame.count], frame.actors[0..frame.count]) |message, actor| try factory.onDelivered(actor.store, message.value, try self.groupClock(observed, cancel));
                const included_at = try self.groupTime(observed);
                next.phase = .included;
                next.included_unix_ms = included_at.unix_ms;
                next.observation_epoch = if (whole.success) self.native_group_epoch else null;
                const transition: destination.operation.GroupTransition = if (whole.success) .{ .confirming = .{ .unix_ms = included_at.unix_ms +| frame.actors[0].options.policy.confirm_delay_ms, .delay_ms = frame.actors[0].options.policy.confirm_delay_ms } } else .{ .signed = &signed };
                journal.write(next, frame.actors[0..frame.count], transition, included_at) catch |commit_error| {
                    if (whole.success) {
                        var recovered = native_group.Journal.load(self.owner.allocator, journal.store, journal.id) catch return commit_error;
                        defer if (recovered) |*value| value.deinit();
                        if (recovered) |*value| if (value.record.phase == .included) self.groupSubmitted(value, included_at) catch {};
                    }
                    return commit_error;
                };
                if (whole.success) {
                    var committed = (try native_group.Journal.load(self.owner.allocator, journal.store, journal.id)) orelse return error.MissingNativeGroup;
                    defer committed.deinit();
                    try self.groupSubmitted(&committed, included_at);
                }
                return 1;
            }
            const canonical_changed = if (!whole.finalized) false else if (journal.record.canonical_receipt) |previous| previous.height != whole.height or previous.success != whole.success or !std.mem.eql(u8, previous.block_hash, next.canonical_receipt.?.block_hash) else true;
            if (whole.finalized and (!journal.record.receipt_finalized or canonical_changed)) {
                const wire = try std.json.Stringify.valueAlloc(self.owner.allocator, next, .{});
                defer self.owner.allocator.free(wire);
                try self.updateGroupJournal(journal, frame, wire);
                return 1;
            }
            return 0;
        }
        switch (try self.retireGroupNonce(journal, frame, &signed, fallback, cancel)) {
            .retired => return 1,
            .hold => return 0,
            .unspent => {},
        }
        for (frame.actors[0..frame.count], frame.origins[0..frame.count], frame.messages[0..frame.count]) |actor, index, message| if (!try self.groupMemberAllowed(actor, index, message.value, try self.groupTime(fallback), cancel)) return 0;
        var representative = try destination.types.Prepared.restore(self.owner.allocator, journal.record.members[0].intent);
        defer representative.deinit();
        // Exact replay is allowed even after some/all members independently
        // finish; a canonical atomic revert safely consumes the reserved nonce.
        // New executable signing remains prohibited by Persistence.intent.
        var persistence: native_group.Persistence = .{ .journal = journal, .actors = frame.actors[0..frame.count], .now = fallback, .observation_clock = self.owner.options.observation_clock, .cancel = cancel, .halt = &self.owner.effects_halted, .deadline_ns = (try self.groupClock(fallback, cancel)).deadline_ns, .included_rebroadcast = true };
        factory.broadcast(&representative, null, &signed, persistence.interface(), try self.groupClock(try self.groupTime(fallback), cancel)) catch |err| {
            try self.groupRpcFailure(err);
            return 0;
        };
        return 1;
    }
    fn advanceGroupJournal(self: *Lane, journal: *const native_group.Journal, frame: *const GroupFrame, now: operation.Times, cancel: *const std.atomic.Value(bool)) !u64 {
        const factory = self.native_destination.?;
        var work: u64 = 0;
        if (journal.record.phase == .retired) {
            self.groupRetired(journal, frame);
            const proof = journal.record.retirement;
            for (frame.actors[0..frame.count], 0..) |actor, index| {
                if (proof) |evidence| {
                    if (evidence.absent_members[index]) {
                        if (actor.signed != null or actor.intent != null or actor.value.confirmation_started) return error.InvalidNativeGroup;
                    } else if (actor.value.stage != .delivered) return error.InvalidNativeGroup;
                } else if (actor.value.stage != .delivered and (actor.signed != null or actor.intent != null or actor.value.confirmation_started)) return error.InvalidNativeGroup;
            }
            try self.clearGroup(journal, frame);
            work +|= 1;
        } else if (journal.record.phase == .signed or journal.record.phase == .included) {
            work +|= try self.advanceSignedGroup(journal, frame, now, cancel);
        } else {
            var intact = true;
            for (frame.actors[0..frame.count], journal.record.members) |actor, member| if (actor.intent == null or !std.mem.eql(u8, actor.intent.?, member.intent) or !native_driver.queuedForSubmission(actor)) {
                intact = false;
                break;
            };
            if (!intact) {
                try self.abandonGroup(journal, frame, now);
                return work +| 1;
            }
            const prepared = try self.owner.allocator.alloc(destination.types.Prepared, frame.count);
            defer self.owner.allocator.free(prepared);
            var prepared_count: usize = 0;
            defer for (prepared[0..prepared_count]) |*value| value.deinit();
            for (journal.record.members, 0..) |member, index| {
                prepared[index] = try destination.types.Prepared.restore(self.owner.allocator, member.intent);
                prepared_count += 1;
            }
            if (prepared.len > 1) try factory.validateStarknetBatch(prepared);
            for (frame.actors[0..frame.count], frame.origins[0..frame.count], frame.messages[0..frame.count]) |actor, index, message| if (!try self.groupMemberAllowed(actor, index, message.value, try self.groupTime(now), cancel)) {
                try self.abandonGroup(journal, frame, try self.groupTime(now));
                return work +| 1;
            };
            if (!try self.groupLocalAdmissionAllowed(frame.actors[0..frame.count])) {
                try self.abandonGroup(journal, frame, try self.groupTime(now));
                return work +| 1;
            }
            var persistence: native_group.Persistence = .{ .journal = journal, .actors = frame.actors[0..frame.count], .now = now, .observation_clock = self.owner.options.observation_clock, .cancel = cancel, .halt = &self.owner.effects_halted, .deadline_ns = (try self.groupClock(now, cancel)).deadline_ns };
            var signed = try factory.sign(&prepared[0], null, persistence.interface(), try self.groupClock(try self.groupTime(now), cancel));
            signed.deinit();
            return work +| 1;
        }
        return work;
    }
    fn advanceCurrentGroup(self: *Lane, store: @import("../db/rocks.zig").Typed, id: [32]u8, fallback: operation.Times, cancel: *const std.atomic.Value(bool)) !u64 {
        var journal = (try native_group.Journal.load(self.owner.allocator, store, id)) orelse return error.MissingNativeGroup;
        defer journal.deinit();
        if (journal.record.phase != .prepared and journal.record.phase != .signed) return error.NativeGroupNonceOwnerChanged;
        const now = try self.groupTime(fallback);
        var frame = try self.openGroup(&journal, now, cancel);
        defer frame.deinit();
        return self.advanceGroupJournal(&journal, &frame, now, cancel);
    }
    fn groupBudgetRemaining(self: *Lane, cancel: *const std.atomic.Value(bool)) !bool {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.owner.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
        return (try common.nowNs()) < self.native_group_deadline_ns.?;
    }
    fn groupRpcFailure(self: *Lane, err: anyerror) !void {
        if (native_driver.hardFailure(err) or err == error.RocksDB or err == error.NativeAllocation) return err;
        switch (err) {
            error.NativeGroupNonceOwnerChanged, error.NativeGroupMemberNotOwned, error.NativeGroupMemberNotReady, error.NativeGroupIntentChanged, error.StaleNativeGroupOwner, error.NativeSignedTransactionConflict, error.NativeGroupAuthorityChanged, error.DestinationIntentChanged, error.WrongDestinationIdentity, error.InvalidStarknetNonceProof, error.InvalidNativeRetirementProof, error.CheckpointEffectsHalted => return err,
            else => {},
        }
        if (self.native_group_last_error == null or self.native_group_last_error.? != err) std.log.warn("native submission group RPC: {s}", .{@errorName(err)});
        self.native_group_last_error = err;
    }
    /// Recover groups before any ready scalar can sign. Inclusion releases the
    /// account nonce owner; message confirmation remains independently durable.
    pub fn tickNativeGroups(self: *Lane, fallback: operation.Times, cancel: *const std.atomic.Value(bool)) anyerror!u64 {
        if (self.chain.protocol != .starknet) return 0;
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.owner.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
        if (self.native_group_epoch == null) self.native_group_epoch = std.crypto.random.int(u64);
        self.native_group_deadline_ns = (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms;
        defer self.native_group_deadline_ns = null;
        const factory = self.native_destination.?;
        const store: @import("../db/rocks.zig").Typed = .{ .database = try self.owner.database.get(cancel), .domain_name = self.chain.name };
        const current_owner = try store.get(self.owner.allocator, destination.operation.group_current_prefix, "");
        defer if (current_owner) |bytes| self.owner.allocator.free(bytes);
        if (current_owner != null and current_owner.?.len != 32) return error.InvalidNativeGroup;
        const current_first = current_owner != null and self.native_group_current_first;
        // Publish the next pass's priority BEFORE any callback can suspend or
        // consume the common deadline. Neither pending work nor older orphan
        // recovery can starve behind the other's repeatedly slow RPCs.
        if (current_owner != null) self.native_group_current_first = !self.native_group_current_first;
        var work: u64 = 0;
        if (current_owner) |id| if (current_first) {
            work +|= try self.advanceCurrentGroup(store, id[0..32].*, fallback, cancel);
            if (!try self.groupBudgetRemaining(cancel)) return work;
        };
        var cursor = self.native_group_gc_cursor;
        var gc_budget: usize = 2;
        while (gc_budget > 0) : (gc_budget -= 1) {
            if (!try self.groupBudgetRemaining(cancel)) break;
            var entry = (try store.atOrAfter(self.owner.allocator, destination.operation.group_record_prefix, &cursor)) orelse {
                self.native_group_gc_cursor = @splat(0);
                break;
            };
            defer entry.deinit();
            if (entry.key.len != 32) return error.InvalidNativeGroup;
            const id: [32]u8 = entry.key[0..32].*;
            cursor = id;
            var offset = cursor.len;
            while (offset > 0) {
                offset -= 1;
                cursor[offset] +%= 1;
                if (cursor[offset] != 0) break;
            }
            self.native_group_gc_cursor = cursor;
            if (current_owner) |owner| if (std.mem.eql(u8, owner, &id)) continue;
            if (cancel.load(.acquire)) return error.RequestCancelled;
            var journal = (try native_group.Journal.load(self.owner.allocator, store, id)) orelse return error.MissingNativeGroup;
            defer journal.deinit();
            if (journal.record.phase != .included and journal.record.phase != .retired) return error.MissingNativeGroupNonceOwner;
            const now = try self.groupTime(fallback);
            var frame = try self.openGroup(&journal, now, cancel);
            defer frame.deinit();
            work +|= try self.advanceGroupJournal(&journal, &frame, now, cancel);
            if (std.mem.allEqual(u8, &cursor, 0)) break;
        }
        // The pending nonce owner is read directly, independently of bounded
        // old-group recovery. An orphaned lower nonce must keep progressing
        // while a higher pending invoke waits for it.
        if (current_owner) |id| {
            if (!current_first and try self.groupBudgetRemaining(cancel)) work +|= try self.advanceCurrentGroup(store, id[0..32].*, fallback, cancel);
            return work;
        }
        // No transaction owns the account nonce. Pick ready actors in retained
        // FIFO order; no candidate pointer survives a cooperative return.
        const maximum = @min(@as(usize, 4096), @max(1, self.chain.max_batch_size));
        const actors = try self.owner.allocator.alloc(*destination.operation.Operation, @min(maximum, self.active.items.len));
        defer self.owner.allocator.free(actors);
        var count: usize = 0;
        var owned_actor_count: usize = 0;
        defer for (actors[0..owned_actor_count]) |actor| actor.deinit();
        var retain_submission = false;
        defer {
            const requeue_from = if (retain_submission) count else 0;
            for (actors[requeue_from..owned_actor_count]) |actor| for (self.active.items) |item| if (std.mem.eql(u8, &actor.options.id, &item.message.value.id())) {
                item.native_submit_inflight = false;
                item.native_submit_queued = null;
                item.native_needs_preparation = null;
                break;
            };
        }
        errdefer |err| {
            if (err == error.PendingReadIo or err == error.PendingIo) retain_submission = true;
        }
        const now = try self.groupTime(fallback);
        for (self.active.items) |item| {
            const origin = self.owner.origins.slots[item.origin_index].handle() orelse continue;
            const message = item.message.value;
            const actor = try destination.operation.Operation.open(self.owner.allocator, origin.store, .{ .id = message.id(), .context = try factory.contextFor(try factory.authorityFor(message.origin, message.id(), 1, .process)), .nonce = message.nonce, .origin = message.origin, .destination = message.destination, .policy = .{ .max_retries = self.owner.settings.role.relayer.max_message_retries }, .acknowledge_canonical = !item.recovery_only }, now);
            var retained = false;
            defer if (!retained) actor.deinit();
            const link = try origin.store.typed.get(self.owner.allocator, destination.operation.group_link_prefix, &actor.options.id);
            defer if (link) |bytes| self.owner.allocator.free(bytes);
            if (link != null) continue;
            if (actor.signed != null and !actor.value.confirmation_started) return work; // Legacy singleton must drain first.
            if (item.recovery_only) continue;
            if (count == actors.len or actor.value.stage != .ready or actor.intent == null or !native_driver.queuedForSubmission(actor) or actor.value.next_attempt_ms > now.monotonic_ms) continue;
            actors[count] = actor;
            count += 1;
            owned_actor_count += 1;
            retained = true;
            item.native_submit_inflight = true;
            item.native_submit_queued = false;
            if (!try self.groupMemberAllowed(actor, item.origin_index, message, now, cancel)) {
                count -= 1;
                owned_actor_count -= 1;
                retained = false;
                item.native_submit_inflight = false;
                item.native_submit_queued = null;
                item.native_needs_preparation = null;
            }
        }
        if (count == 0) return work;
        const scalar = try self.owner.allocator.alloc(destination.types.Prepared, count);
        defer self.owner.allocator.free(scalar);
        const inputs = try self.owner.allocator.alloc(*const destination.types.Prepared, count);
        defer self.owner.allocator.free(inputs);
        var scalar_count: usize = 0;
        defer for (scalar[0..scalar_count]) |*value| value.deinit();
        for (actors[0..count], 0..) |actor, index| {
            scalar[index] = try destination.types.Prepared.restore(self.owner.allocator, actor.intent.?);
            scalar_count += 1;
            inputs[index] = &scalar[index];
        }
        var batch: ?@import("destination/starknet.zig").PreparedBatch = null;
        defer if (batch) |*value| value.deinit();
        if (count > 1) {
            const batch_outcome = factory.prepareStarknetBatch(inputs, maximum, try self.groupClock(now, cancel));
            if (batch_outcome) |value| {
                batch = value;
            } else |err| {
                if (err != error.StarknetBatchZeroWeight) batch = try batch_outcome;
            }
        }
        var singleton: ?destination.types.Prepared = null;
        defer if (singleton) |*value| value.deinit();
        if (batch == null) {
            singleton = try factory.refreshStarknetPrepared(&scalar[0], try self.groupClock(now, cancel));
            count = 1;
        }
        const replacement = if (batch) |*value| value.members else @as([*]destination.types.Prepared, @ptrCast(&singleton.?))[0..1];
        // Recheck all live gates AFTER the blocking query quote and before the
        // guarded intent barrier. The backend manifest binds original quotes.
        for (actors[0..count]) |actor| {
            var message = (try actor.store.messageById(actor.options.id)) orelse return error.StaleCanonicalMessage;
            defer message.deinit();
            var index: ?usize = null;
            for (self.owner.origins.slots, 0..) |slot, candidate| if (slot.chain.domain == actor.options.origin) {
                index = candidate;
                break;
            };
            if (!try self.groupMemberAllowed(actor, index orelse return error.MissingNativeGroupOrigin, message.value, try self.groupTime(now), cancel)) return work;
        }
        if (!try self.groupLocalAdmissionAllowed(actors[0..count])) return work;
        const journal_outcome = native_group.Journal.create(self.owner.allocator, store, actors[0..count], replacement, try self.groupTime(now));
        if (journal_outcome) |_| {} else |err| {
            if (err == error.NativeGroupNonceAlreadyReserved) return work;
        }
        var journal = try journal_outcome;
        journal.deinit();
        retain_submission = true;
        return work +| 1;
    }
    /// Retire an actor after durable completion. Optional metric failures cannot
    /// interrupt loader, retained payload or actor ownership release.
    pub fn releaseCompleted(self: *Lane, index: usize) !void {
        const item = self.active.items[index];
        if (self.origins[item.origin_index].loader) |*value| try value.release(item.message.value.id(), false);
        self.releaseGroupSender(item.message.value.id());
        self.finishActiveMetrics(item, .ended);
        self.active_bytes -= item.retained_bytes;
        self.owner.release(item.retained_bytes);
        _ = self.active.swapRemove(index);
        item.deinit();
        self.owner.allocator.destroy(item);
    }
    pub fn observeGasEnforcer(self: *Lane, index: usize, elapsed_ns: u64) void {
        self.owner.origins.slots[index].observeGasEnforcer(elapsed_ns);
    }
    fn canonicalAdmissionAllowed(self: *Lane, index: usize, message: protocol.Message) !bool {
        var decision = try self.origins[index].policy.?.check(message);
        defer decision.deinit();
        if (decision.denial != null) return false;
        // Source loader applies cached origin signer rules here, without
        // performing the first origin RPC lookup before pending admission.
        if (self.owner.denylist.hasAddressRules()) {
            if (self.owner.signers.cache.cached(message.id())) |cached| {
                var snapshot = cached;
                defer snapshot.deinit();
                var sender_decision = try self.origins[index].policy.?.checkOriginSigners(snapshot.signers());
                defer sender_decision.deinit();
                if (sender_decision.denial != null) return false;
            }
        }
        return true;
    }
    fn ownsRecovery(self: *Lane, index: usize, message: protocol.Message, times: supervisor.Times) !bool {
        const origin = self.owner.origins.slots[index].handle() orelse return error.OriginNotReady;
        if (self.chain.protocol == .ethereum) {
            var link = (try payload_links.load(self.owner.allocator, origin.store, message.id(), evmContext(self.context orelse return error.DestinationNotInitialized, origin.chain))) orelse return false;
            defer link.deinit();
            const inherited = try payload_links.inheritedUuids(self.owner.allocator, origin.store, message.id());
            defer self.owner.allocator.free(inherited);
            if (inherited.len != 1 or !std.mem.eql(u8, &inherited[0], &link.record().payload.uuid)) return error.PayloadRelationChanged;
            return true;
        }
        const factory = self.native_destination orelse return error.DestinationNotInitialized;
        return destination.operation.Operation.hasSignedRecovery(self.owner.allocator, origin.store, .{
            .id = message.id(),
            .context = try factory.contextFor(try factory.authorityFor(message.origin, message.id(), 1, .process)),
            .nonce = message.nonce,
            .origin = message.origin,
            .destination = message.destination,
            .acknowledge_canonical = false,
            .group_store = .{ .database = origin.store.typed.database, .domain_name = self.chain.name },
        }, .{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms });
    }
    pub fn load(self: *Lane, times: supervisor.Times) !u64 {
        const reserved_slots = self.control.reservedSlots();
        const reserved_bytes = self.control.reservedBytes();
        if (self.active.items.len + reserved_slots >= self.owner.options.max_active or self.active_bytes + reserved_bytes >= self.owner.options.max_active_bytes) return 0;
        for (0..self.origins.len) |_| {
            const index = self.next_origin;
            self.next_origin = (index + 1) % self.origins.len;
            const origin = self.owner.origins.slots[index].handle() orelse continue;
            const lane = &self.origins[index];
            try self.control.ensurePolicy(self, index);
            lane.policy.?.gateway = &self.owner.control_hub.gateway_policy;
            if (lane.loader == null) lane.loader = try loader.Loader.init(self.owner.allocator, origin.store, &.{self.chain.domain}, .{ .max_loaded = self.owner.options.max_active });
            const version = self.owner.denylist.version.load(.acquire);
            if (version != lane.deny_version or times.monotonic_ms >= lane.next_rescan_ms) {
                lane.loader.?.rescan();
                lane.deny_version = version;
                lane.next_rescan_ms = times.monotonic_ms +| 30000;
            }
            var candidate = try lane.loader.?.next() orelse continue;
            var retained = false;
            var committed = false;
            defer if (!retained) candidate.message.deinit();
            errdefer if (!committed) lane.loader.?.release(candidate.message.value.id(), true) catch {};
            const recovery_only = !try self.canonicalAdmissionAllowed(index, candidate.message.value);
            if (recovery_only and !try self.ownsRecovery(index, candidate.message.value, times)) {
                // Preserve canonical/index/retry rows. The cursor already
                // advanced; periodic/rule-change rescan reconsiders this ID.
                try lane.loader.?.release(candidate.message.value.id(), false);
                committed = true;
                continue;
            }
            const app_context = if (recovery_only) null else try lane.policy.?.appContext(candidate.message.value);
            var retained_bytes = try std.math.add(usize, candidate.message.bytes.len, @sizeOf(Active));
            if (retained_bytes > self.owner.options.max_active_bytes - self.active_bytes - reserved_bytes) {
                try lane.loader.?.release(candidate.message.value.id(), true);
                return 0;
            }
            if (!self.owner.reserve(retained_bytes)) {
                try lane.loader.?.release(candidate.message.value.id(), true);
                return 0;
            }
            errdefer if (!committed) self.owner.release(retained_bytes);
            const retained_context = self.retainMetricContext(app_context, self.owner.options.max_active_bytes - self.active_bytes - reserved_bytes - retained_bytes);
            errdefer if (!committed) if (retained_context.text) |value| self.owner.allocator.free(value);
            retained_bytes += retained_context.bytes;
            // Public reserve/authorize/commit spans several owner cycles. Every
            // ordinary append preserves those reserved ArrayList slots.
            try self.active.ensureUnusedCapacity(self.owner.allocator, reserved_slots + 1);
            const item = try self.owner.allocator.create(Active);
            errdefer if (!committed) self.owner.allocator.destroy(item);
            const loaded_status = (try origin.store.status(candidate.message.value.id())) orelse .FirstPrepareAttempt;
            item.* = .{
                .origin_index = index,
                .lane = self,
                .message = candidate.message,
                .retained_bytes = retained_bytes,
                .recovery_only = recovery_only,
                .metric_app_context = retained_context.text,
                .metric_active = !recovery_only and retained_context.enabled,
                .first_seen_unix_seconds = times.unix_ms / 1000,
                .metric_status = loaded_status,
                .restored_submitted = loaded_status == .Confirm and loaded_status.Confirm == .SubmittedBySelf,
            };
            try self.active.append(self.owner.allocator, item);
            self.active_bytes += retained_bytes;
            retained = true;
            committed = true;
            self.syncActiveMetrics(item, item.metric_status);
            return 1;
        }
        return 0;
    }
    /// Preserve an admitted batch across cooperative I/O. A later owner poll
    /// cannot admit another batch until every selected prepare has completed.
    pub fn beginNativePreparationBatch(self: *Lane, times: supervisor.Times, cancel: *const std.atomic.Value(bool), maximum: usize) !void {
        errdefer self.native_batch_admission = null;
        if (cancel.load(.acquire)) return error.RequestCancelled;
        self.native_batch_admission = true;
        if (native_driver.preparationLimit(self.chain) == null) return;
        self.native_batch_admission = false;
        for (self.active.items) |item| if (item.native_prepare_admitted) return;
        if (!try self.nativePreparationAllowed(times, cancel)) return;
        self.native_batch_admission = true;
        if (self.active.items.len == 0) return;
        for (0..@min(maximum, self.active.items.len)) |offset| {
            const item = self.active.items[(self.next_active + offset) % self.active.items.len];
            if (item.next_ms <= times.monotonic_ms and item.native_needs_preparation.?) item.native_prepare_admitted = true;
        }
    }
    pub fn nativePreparationAllowed(self: *Lane, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !bool {
        const limit = native_driver.preparationLimit(self.chain) orelse return true;
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (limit == 0) return false;
        var queued: usize = 0;
        for (self.active.items) |item| {
            if (cancel.load(.acquire)) return error.RequestCancelled;
            if (item.recovery_only) {
                item.native_submit_queued = false;
                item.native_needs_preparation = false;
                continue;
            }
            if (item.native_submit_queued == null or item.native_needs_preparation == null) {
                const origin = self.owner.origins.slots[item.origin_index].handle() orelse return error.OriginNotReady;
                const factory = self.native_destination orelse return error.NativeDestinationNotInitialized;
                const actor = try destination.operation.Operation.open(self.owner.allocator, origin.store, .{
                    .id = item.message.value.id(),
                    .context = try factory.contextFor(try factory.authorityFor(item.message.value.origin, item.message.value.id(), 1, .process)),
                    .nonce = item.message.value.nonce,
                    .origin = item.message.value.origin,
                    .destination = item.message.value.destination,
                    .policy = .{ .max_retries = self.owner.settings.role.relayer.max_message_retries },
                    .acknowledge_canonical = !item.recovery_only,
                }, .{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms });
                defer actor.deinit();
                if (self.chain.protocol == .starknet) {
                    const group_link = try origin.store.typed.get(self.owner.allocator, destination.operation.group_link_prefix, &actor.options.id);
                    defer if (group_link) |bytes| self.owner.allocator.free(bytes);
                    if (group_link != null) item.native_submit_inflight = true;
                }
                item.native_submit_queued = native_driver.queuedForSubmission(actor) and !item.native_submit_inflight;
                item.native_needs_preparation = native_driver.needsPreparation(actor);
            }
            if (item.native_submit_queued.?) queued += 1;
        }
        return queued < limit;
    }
    pub fn advance(self: *Lane, item: *Active, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) anyerror!bool {
        errdefer |err| {
            if (err != error.PendingReadIo and err != error.PendingIo) {
                item.native_prepare_admitted = false;
                item.native_pop_checked = false;
                item.native_submit_inflight = false;
                item.native_submit_queued = null;
                item.native_needs_preparation = null;
            }
        }
        if (cancel.load(.acquire)) return error.RequestCancelled;
        const origin = self.owner.origins.slots[item.origin_index].handle() orelse return false;
        const message = item.message.value;
        if (item.recovery_only) {
            // Reopen through normal admission after a rule change. Once an
            // old effect is safely retired, exclusion must not grant another
            // preparation attempt or an external-delivery-only exemption.
            if (try self.canonicalAdmissionAllowed(item.origin_index, message) or !try self.ownsRecovery(item.origin_index, message, times)) return true;
        }
        item.now_monotonic_ms = times.monotonic_ms;
        item.now_unix_seconds = times.unix_ms / 1000;
        try self.initializeActiveMetrics(item);
        // Receipt admission grants ID authority without changing indexed nonce
        // mappings. A processed marker for another message at this nonce cannot
        // retire an independently admitted receipt message.
        {
            origin.store.mutex.lock();
            defer origin.store.mutex.unlock();
            if (!try origin.store.operationMessageAuthorized(message)) {
                self.finishActiveMetrics(item, .ended);
                return true;
            }
            if (try origin.store.operationComplete(message)) {
                self.finishActiveMetrics(item, .ended);
                return true;
            }
        }
        const now: operation.Times = .{ .unix_ms = times.unix_ms, .monotonic_ms = times.monotonic_ms };
        if (self.chain.protocol == .ethereum) {
            var state = try operation.Operation.open(self.owner.allocator, origin.store, .{
                .id = message.id(),
                .context = evmContext(self.context.?, origin.chain),
                .nonce = message.nonce,
                .destination = message.destination,
                .policy = .{ .max_retries = self.owner.settings.role.relayer.max_message_retries },
                .acknowledge_canonical = !item.recovery_only,
            }, now);
            defer state.deinit();
            self.syncActiveMetrics(item, state.current_status);
            if (item.evm_driver == null) item.evm_driver = evm_driver.Driver.init(self.owner.allocator);
            const previous_cache_bytes = if (item.evm_driver.?.cached_metadata) |bytes| bytes.len else 0;
            defer self.accountCache(item, previous_cache_bytes);
            if (state.current_status == .Retry and state.current_status.Retry == .Manual) {
                item.evm_driver.?.deinit();
                item.evm_driver = evm_driver.Driver.init(self.owner.allocator);
            }
            var sender: Sender = .{ .lane = self, .item = item, .clock = .{ .unix_ms = times.unix_ms, .deadline_ns = (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms, .cancel = cancel, .halt = &self.owner.effects_halted } };
            var ccip_build = try self.beginCcip(origin.store, message, evmContext(self.context.?, origin.chain), times, cancel);
            defer if (ccip_build) |*value| value.deinit();
            var prepare_config = try evm_prepare.Config.fromSettings(self.chain, self.signer.?.address, self.owner.settings.role.relayer.transaction_gas_limit, self.owner.settings.role.relayer.skip_transaction_gas_limit_for);
            prepare_config.metadata_observer = metadataObserverFor(item);
            const was_confirming = state.value.confirmation_started;
            const outcome = item.evm_driver.?.step(self.owner.allocator, &self.transactions.?, &state, origin.history, &self.origins[item.origin_index].policy.?, message, &self.network.?.rpc_client.?, .{
                .source = prepare_config,
                .metadata_cache = &self.owner.evm_cache,
                .default_ism_cache = &self.owner.evm_default_ism_cache,
                .cache_context = .{ .domain_name = self.chain.name, .context_hash = self.context.? },
                .ism_cache_configs = self.owner.settings.role.relayer.ism_cache_configs,
            }, now, .{ .local_admission = .{ .context = &sender, .allowed_fn = Sender.localAdmission }, .origin_sender = .{ .context = &sender, .fetch_fn = Sender.evmFetch }, .private_estimator = if (self.protected_network != null) .{ .context = self, .estimate_fn = privateEstimate } else null, .executor = &self.owner.metadata_executor.executor, .batch_resolver = .{ .context = self, .estimate_fn = batchEstimate }, .cost_receipt_reader = .{ .context = self, .read_fn = finalizedCostReceipt }, .ccip_handler = if (ccip_build) |value| value.binding.handler() else null, .pending_delay = if (ccip_build) |*value| .{ .context = value, .delay_ms_fn = CcipBuild.delay } else null, .cancel = cancel, .observation = if (self.validator_observation) |*value| value.observation() else null, .observation_clock = self.owner.options.observation_clock });
            if (!was_confirming and state.value.confirmation_started and state.current_status == .Confirm and state.current_status.Confirm == .SubmittedBySelf) self.recordPhase(item, .submitted);
            const report = try outcome;
            if (!item.recovery_only and report.state == .delivered and try origin.store.markProcessedIfCanonical(message)) self.recordProcessed(item);
            switch (report.state) {
                .prepared => self.recordPhase(item, .prepared),
                .retried => self.recordPhase(item, .failed),
                .denied, .not_contract => self.recordPhase(item, .dropped),
                .delivered => self.markConfirmed(item),
                else => {},
            }
            self.syncActiveMetrics(item, state.current_status);
            item.next_ms = @max(times.monotonic_ms +| 100, state.value.next_attempt_ms);
            return switch (report.state) {
                .delivered, .not_contract, .denied => true,
                else => false,
            };
        }
        const factory = self.native_destination.?;
        const actor = try destination.operation.Operation.open(self.owner.allocator, origin.store, .{
            .id = message.id(),
            .context = try factory.contextFor(try factory.authorityFor(message.origin, message.id(), 1, .process)),
            .nonce = message.nonce,
            .origin = message.origin,
            .destination = message.destination,
            .policy = .{ .max_retries = self.owner.settings.role.relayer.max_message_retries },
            .acknowledge_canonical = !item.recovery_only,
        }, now);
        defer actor.deinit();
        if (item.restored_submitted) {
            item.submitted_generation = actor.value.generation;
            item.restored_submitted = false;
        }
        defer {
            item.native_submit_queued = native_driver.queuedForSubmission(actor) and !item.native_submit_inflight;
            item.native_needs_preparation = native_driver.needsPreparation(actor);
        }
        self.syncActiveMetrics(item, actor.current_status);
        if (actor.signed == null and now.monotonic_ms < actor.value.next_attempt_ms) {
            item.native_prepare_admitted = false;
            item.next_ms = actor.value.next_attempt_ms;
            return false;
        }
        const prepare_allowed = item.native_prepare_admitted or if (self.native_batch_admission != null and native_driver.preparationLimit(self.chain) != null) false else try self.nativePreparationAllowed(times, cancel);
        if (native_driver.needsPreparation(actor) and prepare_allowed) item.native_prepare_admitted = true;
        if (!prepare_allowed and native_driver.needsPreparation(actor)) {
            if (self.owner.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
            if (cancel.load(.acquire)) return error.RequestCancelled;
            item.next_ms = times.monotonic_ms +| 150;
            return false;
        }
        if (actor.signed == null and !actor.value.confirmation_started and !item.native_pop_checked) {
            // Source evicts a denied operation when the prepare/submit queue
            // actually pops, after its preparation-pressure wait. Loader
            // admission can precede a rule refresh or retry deadline.
            if (!try self.canonicalAdmissionAllowed(item.origin_index, message)) return true;
            item.native_pop_checked = true;
        }
        var maximum = self.owner.settings.role.relayer.transaction_gas_limit;
        for (self.owner.settings.role.relayer.skip_transaction_gas_limit_for) |domain| if (domain == message.destination) {
            maximum = null;
            break;
        };
        var sender: Sender = .{ .lane = self, .item = item, .clock = .{ .unix_ms = times.unix_ms, .deadline_ns = (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms, .cancel = cancel, .halt = &self.owner.effects_halted } };
        var ccip_build = try self.beginCcip(origin.store, message, try factory.identityContext(), times, cancel);
        defer if (ccip_build) |*value| value.deinit();
        factory.ccip_handler = if (ccip_build) |value| value.binding.handler() else null;
        defer factory.ccip_handler = null;
        factory.options.metadata_observer = metadataObserverFor(item);
        defer factory.options.metadata_observer = null;
        const group_link = if (self.chain.protocol == .starknet) try origin.store.typed.get(self.owner.allocator, destination.operation.group_link_prefix, &actor.options.id) else null;
        defer if (group_link) |bytes| self.owner.allocator.free(bytes);
        if (group_link) |bytes| {
            if (bytes.len != 32) return error.InvalidNativeGroup;
            item.native_group_id = bytes[0..32].*;
        } else item.native_group_id = null;
        const driver: native_driver.Driver = .{ .options = .{ .group_owned = group_link != null, .submit_via_group = self.chain.protocol == .starknet, .prepare_allowed = prepare_allowed, .observation_clock = self.owner.options.observation_clock, .maximum_gas = maximum, .signer_gate = .{ .context = &sender, .check_fn = Sender.check }, .pending_delay = if (ccip_build) |*value| .{ .context = value, .delay_ms_fn = CcipBuild.delay } else null } };
        // A ready operation is popped before quote/sign RPCs. Suspended submit
        // work stays outside the preparation threshold until it is requeued.
        if (native_driver.queuedForSubmission(actor) and actor.value.next_attempt_ms <= times.monotonic_ms) item.native_submit_inflight = true;
        const was_confirming = actor.value.confirmation_started;
        const outcome = driver.step(self.owner.allocator, factory, actor, origin.history, &self.origins[item.origin_index].policy.?, message, .{
            .unix_ms = times.unix_ms,
            .deadline_ns = (try common.nowNs()) +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms,
            .cancel = cancel,
            .halt = &self.owner.effects_halted,
        }, now);
        if (!was_confirming and actor.value.confirmation_started and actor.current_status == .Confirm and actor.current_status.Confirm == .SubmittedBySelf) self.recordSubmitted(item, actor.value.generation, now);
        const report = try outcome;
        switch (report.state) {
            .prepared, .retried, .retired, .denied, .not_contract => item.native_pop_checked = false,
            else => {},
        }
        item.native_prepare_admitted = false;
        if (!native_driver.queuedForSubmission(actor)) item.native_submit_inflight = false;
        if (!item.recovery_only and report.state == .delivered and try origin.store.markProcessedIfCanonical(message)) self.recordProcessed(item);
        switch (report.state) {
            .prepared => self.recordPhase(item, .prepared),
            .retried => self.recordPhase(item, .failed),
            .broadcast, .reconciled => if (report.failure != null) self.recordPhase(item, .failed),
            .retired, .not_contract => self.recordPhase(item, .dropped),
            .denied => if (actor.signed == null) self.recordPhase(item, .dropped) else self.recordPhase(item, .failed),
            .delivered => self.markConfirmed(item),
            else => {},
        }
        self.syncActiveMetrics(item, actor.current_status);
        item.next_ms = @max(item.next_ms, @max(times.monotonic_ms +| @as(u64, if (report.state == .backpressured) 150 else 100), actor.value.next_attempt_ms));
        return switch (report.state) {
            .delivered, .not_contract => true,
            .denied => actor.signed == null,
            else => false,
        };
    }
    fn beginCcip(self: *Lane, store: *native.Store, message: protocol.Message, context_hash: [32]u8, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !?CcipBuild {
        const owner = if (self.ccip_owner) |*value| value else return null;
        // CCS' public deadline API is UTC; the lane's timer is monotonic. Convert
        // once at this boundary. Forks retain the value and their own cancel.
        const utc = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
        const deadline = utc +| self.owner.options.job_timeout_ms *| std.time.ns_per_ms;
        const binding = try owner.bind(.{
            .allocator = self.owner.allocator,
            .origin_store = ccip_sessions.OriginStore.fromStore(store),
            .client = if (self.chain.protocol == .ethereum) &self.network.?.rpc_client.? else null,
            .native_lookup = if (self.chain.protocol == .tron) try self.native_destination.?.lookupSource() else null,
            .native = &self.network.?.native,
            .runtime = self.owner.http_runtime,
            .signer_provider = if (self.ccs_owner) |value| value.provider(deadline) else null,
            .signature_cache = &self.owner.ccs_signatures,
            .block_number = 0,
            .now_ms = times.monotonic_ms,
            .cancel = cancel,
            .context_hash = context_hash,
        });
        return .{ .binding = binding, .message = message, .now_ms = times.monotonic_ms };
    }
    fn finalizedCostReceipt(context: *anyopaque, transaction_uuid: [16]u8, transaction_hash: [32]u8) !?evm_accounting.ProjectedReceipt {
        const self: *Lane = @ptrCast(@alignCast(context));
        const proof = (try self.transactions.?.store.loadFinalizedReceipt(self.owner.allocator, transaction_uuid, transaction_hash)) orelse return null;
        return .{ .block_number = proof.block_number, .block_hash = proof.block_hash, .executed = proof.executed, .gas_used = proof.gas_used, .effective_gas_price = proof.effective_gas_price };
    }
    /// Runs only on this destination's serialized owner. Every member can
    /// originate from a distinct namespace; mutable Active lists are irrelevant.
    fn batchEstimate(context: *anyopaque, a: A, message_id: [32]u8, payload_uuid: [16]u8) !?u256 {
        const self: *Lane = @ptrCast(@alignCast(context));
        const destination_context = self.context orelse return error.MissingDestinationContext;
        var found: ?u256 = null;
        for (self.owner.origins.slots) |*slot| {
            const origin = slot.handle() orelse continue;
            var link = try payload_links.load(a, origin.store, message_id, evmContext(destination_context, origin.chain)) orelse continue;
            defer link.deinit();
            const record = link.record();
            if (!std.mem.eql(u8, &record.payload.uuid, &payload_uuid)) return error.CostPayloadAssociationChanged;
            if (found != null) return error.AmbiguousCostPayloadOrigin;
            found = record.estimated_gas orelse return error.MissingNativeOperationEstimate;
        }
        return found;
    }
    fn privateEstimate(context: *anyopaque, a: A, _: protocol.Message, _: []const u8, calldata: []const u8, relayer: [20]u8, arbitrum_nitro: bool) !evm_prepare.Estimate {
        const self: *Lane = @ptrCast(@alignCast(context));
        const network = self.protected_network orelse return error.MissingProtectedEstimator;
        const client = &network.rpc_client.?;
        var budget = try rpc_budget.Scope.init(client, 5000);
        budget.attach();
        defer budget.deinit();
        return evm_prepare.estimateRpc(a, client, self.chain.contracts.mailbox, relayer, calldata, arbitrum_nitro);
    }
    fn accountCache(self: *Lane, item: *Active, previous: usize) void {
        const driver = &item.evm_driver.?;
        var current: usize = if (driver.cached_metadata) |bytes| bytes.len else 0;
        if (current > previous) {
            const additional = current - previous;
            const available = self.owner.options.max_active_bytes -| self.active_bytes -| self.control.reservedBytes();
            if (additional > available or !self.owner.reserve(additional)) {
                // Metadata is an optional preparation cache. Canonical message,
                // sealed payload and all signed transaction journals are retained.
                if (driver.cached_metadata) |bytes| self.owner.allocator.free(bytes);
                driver.cached_metadata = null;
                current = 0;
            } else {
                self.active_bytes += additional;
                item.retained_bytes += additional;
                return;
            }
        }
        const released = previous - current;
        self.active_bytes -= released;
        item.retained_bytes -= released;
        self.owner.release(released);
    }
    fn classify(err: anyerror) supervisor.FailureAction {
        return switch (err) {
            error.OperationContextChanged, error.PayloadLinkContextChanged, error.ValidatorReorg, error.ReorgHalted, error.ReorgFlagPresent, error.RocksDBNativeAbiMismatch, error.RocksDBNativeVersionMismatch => .halt_all,
            else => .retry,
        };
    }
};
fn contextHash(chain: *const settings.Chain, signer: [20]u8) [32]u8 {
    var state = std.crypto.hash.sha2.Sha256.init(.{});
    state.update("hyperlane-zig-evm-destination-v1\x00");
    var domain: [4]u8 = undefined;
    std.mem.writeInt(u32, &domain, chain.domain, .big);
    state.update(&domain);
    state.update(chain.chain_id);
    state.update(&chain.contracts.mailbox);
    state.update(&signer);
    return state.finalResult();
}
fn evmContext(destination_context: [32]u8, origin: *const settings.Chain) [32]u8 {
    var state = std.crypto.hash.sha2.Sha256.init(.{});
    state.update(&destination_context);
    var domain: [4]u8 = undefined;
    std.mem.writeInt(u32, &domain, origin.domain, .big);
    state.update(&domain);
    state.update(&origin.contracts.merkle_tree_hook);
    return state.finalResult();
}
pub const TaskSet = struct {
    allocator: A,
    settings: *const settings.Settings,
    environment: *const std.process.EnvMap,
    options: Options,
    database: *origins.DatabaseOwner,
    checkpoints: *remote.Engine,
    http_runtime: *http_runtime.Runtime,
    read_budget: read_replay.ByteBudget = .{},
    ccip_budget: read_replay.ByteBudget = .{ .maximum = 64 * 1024 * 1024 },
    metadata_executor: *metadata_parallel.Root,
    metric_tracker: ?*relayer_metrics.WaitTracker = null,
    critical_trackers: []critical_metrics.Tracker = &.{},
    dynamic_tip_cache: ?*dynamic_tip_cache.Cache = null,
    cache_metric_adapter: ?cache_metrics.Adapter = null,
    validator_observations: ?validator_observability.Manager = null,
    evm_default_ism_cache: contract_cache.Cache,
    native_default_ism_cache: contract_cache.CacheFor([32]u8).Cache,
    evm_cache: contract_cache.Cache,
    native_cache: contract_cache.CacheFor([32]u8).Cache,
    ccs_signatures: ccip.SignatureCache,
    origins: *origins.Set,
    websocket_bridge: ?*stream_bridge.Bridge = null,
    stream_metric_adapter: ?*stream_metrics.StreamMetrics = null,
    websocket_wake: std.atomic.Value(bool) = .init(false),
    signers: *signer_tasks.Owner,
    control_hub: relayer_control.Hub,
    lanes: []Lane,
    tasks: []supervisor.Task,
    regex_engine: ?regex.Engine = null,
    denylist: denylist.RuntimeDenylist,
    denylist_ready: std.atomic.Value(bool) = .init(false),
    denylist_native: ?curl.Client = null,
    denylist_transport: ?operator_native.DenylistTransport = null,
    denylist_clock: operator_native.Clock = .{},
    denylist_mutex: @import("../runtime/cancel_gate.zig").Gate = .{},
    cache_path: []u8,
    memory_mutex: std.Thread.Mutex = .{},
    retained_bytes: usize = 0,
    effects_halted: std.atomic.Value(bool) = .init(false),
    fn reserve(self: *TaskSet, bytes: usize) bool {
        self.memory_mutex.lock();
        defer self.memory_mutex.unlock();
        if (bytes > self.options.max_retained_bytes - self.retained_bytes) return false;
        self.retained_bytes += bytes;
        return true;
    }
    fn release(self: *TaskSet, bytes: usize) void {
        self.memory_mutex.lock();
        defer self.memory_mutex.unlock();
        std.debug.assert(bytes <= self.retained_bytes);
        self.retained_bytes -= bytes;
    }
    fn configureObservationCapacity(self: *TaskSet, registry: *metrics.Registry) void {
        const manager = if (self.validator_observations) |*value| value else return;
        const series_cap = registry.options.max_series;
        const app_count = std.math.add(usize, self.settings.role.relayer.metric_app_contexts.len, 2) catch series_cap;
        const routes = std.math.mul(usize, self.settings.chains.len, self.settings.chains.len) catch series_cap;
        const contexts = std.math.mul(usize, routes, app_count) catch series_cap;
        manager.max_contexts = @min(series_cap, contexts);
        var chain_bytes: usize = 0;
        for (self.settings.chains) |chain| chain_bytes = @max(chain_bytes, chain.name.len);
        var app_bytes: usize = "default_ism".len;
        for (self.settings.role.relayer.metric_app_contexts) |app| app_bytes = @max(app_bytes, app.name.len);
        const chain_labels = std.math.mul(usize, chain_bytes, 2) catch registry.options.max_storage_bytes;
        const per_context = std.math.add(usize, chain_labels, app_bytes) catch registry.options.max_storage_bytes;
        const label_bytes = std.math.mul(usize, manager.max_contexts, per_context) catch registry.options.max_storage_bytes;
        manager.max_label_bytes = @min(registry.options.max_storage_bytes, label_bytes);
    }
    fn observationUtcMs(_: *anyopaque) u64 {
        return @intCast(@max(0, std.time.milliTimestamp()));
    }
    fn observationDomainName(context: *anyopaque, domain: u32) ![]const u8 {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        for (self.settings.chains) |chain| if (chain.domain == domain) return chain.name;
        return error.UnknownObservationDomain;
    }
    pub fn criticalForDomain(self: *TaskSet, domain: u32) ?*critical_metrics.Tracker {
        if (self.critical_trackers.len == 0) return null;
        for (self.settings.chains, self.critical_trackers) |chain, *tracker| if (chain.domain == domain) return tracker;
        return null;
    }
    pub fn healthCriticals(self: *TaskSet) health_set.Criticals {
        return .{ .context = self, .get_fn = healthCritical };
    }
    fn healthCritical(context: *anyopaque, domain: u32) !?*critical_metrics.Tracker {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        return self.criticalForDomain(domain);
    }
    pub fn healthWallets(self: *TaskSet) health_set.Wallets {
        return .{ .context = self, .get_fn = healthWallet };
    }
    fn healthWallet(context: *anyopaque, domain: u32) !?@import("health_metrics.zig").WalletSource {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        for (self.lanes) |*lane| if (lane.chain.domain == domain) return lane.public_wallet.interface();
        return error.UnknownHealthDestination;
    }
    pub fn sourceOptions(self: *TaskSet) resources.Options {
        return .{ .curl_library = self.options.curl_library, .http_runtime = self.http_runtime, .read_budget = &self.read_budget, .metrics = self.options.metrics, .request_timeout_ms = self.options.request_timeout_ms, .allow_insecure_loopback = self.options.allow_insecure_loopback };
    }
    fn indexingSourceOptions(self: *TaskSet) resources.Options {
        var options = self.sourceOptions();
        options.dynamic_tip_cache = self.dynamic_tip_cache;
        options.indexer_tip_cache = true;
        return options;
    }
    fn destinationOptions(self: *TaskSet) resources.Options {
        var options = self.sourceOptions();
        // Shared by retained metadata forks, including cancelled jobs draining
        // beside their replacements. Indexing resources retain their default2.
        options.rpc_parallelism = 128;
        options.operation = .relayer_delivery;
        return options;
    }
    pub fn open(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, options: Options) !*TaskSet {
        if (configured.role != .relayer or configured.chains.len == 0 or configured.chains.len > 1024 or options.max_active == 0 or options.max_active > 4096 or options.max_active_bytes == 0 or options.max_retained_bytes == 0 or options.job_timeout_ms == 0 or options.job_timeout_ms > 3600000) return error.InvalidRelayerTasks;
        const self = try a.create(TaskSet);
        errdefer a.destroy(self);
        const database = try origins.DatabaseOwner.init(a, configured.role.relayer.db);
        errdefer database.deinit();
        const checkpoints = try remote.Engine.start(a, .{ .multi = .{ .library_path = options.curl_library }, .allow_insecure_loopback = options.allow_insecure_loopback });
        errdefer checkpoints.deinit();
        const http_owner = try http_runtime.Runtime.start(a, .{ .multi = .{ .library_path = options.curl_library, .max_response_bytes = 16 * 1024 * 1024, .max_request_bytes = 16 * 1024 * 1024, .max_reserved_bytes = 512 * 1024 * 1024 }, .max_sessions = 256 });
        errdefer http_owner.deinit();
        const metadata_executor = try metadata_parallel.Root.start(a, .{});
        errdefer metadata_executor.deinit();
        self.* = .{ .http_runtime = http_owner, .metadata_executor = metadata_executor, .evm_cache = undefined, .native_cache = undefined, .evm_default_ism_cache = undefined, .native_default_ism_cache = undefined, .ccs_signatures = undefined, .allocator = a, .settings = configured, .environment = environment, .options = options, .database = database, .checkpoints = checkpoints, .origins = undefined, .signers = undefined, .control_hub = undefined, .lanes = &.{}, .tasks = &.{}, .denylist = undefined, .cache_path = undefined };
        self.dynamic_tip_cache = try dynamic_tip_cache.Cache.init(a, .{});
        errdefer self.dynamic_tip_cache.?.deinit();
        if (options.metrics) |registry| {
            self.critical_trackers = try a.alloc(critical_metrics.Tracker, configured.chains.len);
            for (self.critical_trackers, configured.chains) |*tracker, chain| {
                tracker.* = .{ .registry = registry, .chain = chain.name };
                // Rust relayer reset_critical_errors explicitly resets every
                // configured origin before independent factories start.
                tracker.started();
            }
        }
        errdefer a.free(self.critical_trackers);
        if (options.metrics) |registry| self.metric_tracker = try relayer_metrics.WaitTracker.init(a, registry, .{ .max_active = options.max_active, .max_bytes = @min(options.max_active_bytes, options.max_retained_bytes) });
        errdefer if (self.metric_tracker) |value| value.deinit();
        if (options.metrics) |registry| {
            self.cache_metric_adapter = .{ .registry = registry };
            self.validator_observations = validator_observability.Manager.init(a, registry, .{ .context = self, .now_ms_fn = observationUtcMs });
            self.configureObservationCapacity(registry);
        }
        errdefer if (self.validator_observations) |*manager| manager.deinit();
        // Both address families share one explicit 16MiB role budget.
        self.evm_cache = try contract_cache.Cache.init(a, .{ .enabled = configured.role.relayer.allow_contract_call_caching, .max_bytes = 8 * 1024 * 1024, .environment = environment, .observer = if (self.cache_metric_adapter) |*adapter| adapter.interface(.evm) else null });
        errdefer self.evm_cache.deinit();
        self.native_cache = try contract_cache.CacheFor([32]u8).Cache.init(a, .{ .enabled = configured.role.relayer.allow_contract_call_caching, .max_bytes = 8 * 1024 * 1024, .environment = environment, .observer = if (self.cache_metric_adapter) |*adapter| adapter.interface(.native) else null });
        errdefer self.native_cache.deinit();
        // Source DefaultIsmCache is always on and unmetered, independent of
        // allow_contract_call_caching. One immutable default context per chain.
        var default_cache_bytes: usize = 0;
        for (configured.chains) |chain| default_cache_bytes = try std.math.add(usize, default_cache_bytes, try std.math.add(usize, chain.name.len, 256));
        self.evm_default_ism_cache = try contract_cache.Cache.init(a, .{ .max_entries = configured.chains.len, .max_bytes = default_cache_bytes });
        errdefer self.evm_default_ism_cache.deinit();
        self.native_default_ism_cache = try contract_cache.CacheFor([32]u8).Cache.init(a, .{ .max_entries = configured.chains.len, .max_bytes = default_cache_bytes });
        errdefer self.native_default_ism_cache.deinit();
        self.ccs_signatures = try ccip.SignatureCache.init(a, 1000);
        errdefer self.ccs_signatures.deinit();
        if (environment.get("HYPERLANE_REGEX_LIBRARY")) |path| self.regex_engine = try regex.Engine.init(a, path);
        errdefer if (self.regex_engine) |*value| value.deinit();
        self.denylist = try denylist.RuntimeDenylist.init(a, if (self.regex_engine) |*value| value else null);
        errdefer self.denylist.deinit();
        self.cache_path = try std.fs.path.join(a, &.{ configured.role.relayer.db, "runtime_denylist_cache.json" });
        errdefer a.free(self.cache_path);
        if (configured.role.relayer.runtime_denylist_url) |url| self.denylist.config = .{ .url = url, .cache_path = self.cache_path, .poll_interval_ms = configured.role.relayer.runtime_denylist_poll_interval_seconds *| 1000 } else self.denylist_ready.store(true, .release);
        if (self.denylist.config != null) {
            self.denylist_native = try curl.Client.init(a, options.curl_library);
            self.denylist_transport = .{ .client = &self.denylist_native.? };
            self.denylist.transport = self.denylist_transport.?.interface();
        }
        errdefer if (self.denylist_native) |*value| value.deinit();
        self.origins = try origins.Set.open(a, configured.chains, environment, database, checkpoints, .{ .source = self.indexingSourceOptions(), .gas_enabled = configured.role.relayer.igp_indexing_enabled, .tx_id_indexing_enabled = configured.role.relayer.tx_id_indexing_enabled, .job_timeout_ms = options.job_timeout_ms, .allow_local_checkpoints = configured.role.relayer.allow_local_checkpoint_syncers });
        errdefer self.origins.deinit();
        for (self.origins.slots) |*slot| slot.critical = self.criticalForDomain(slot.chain.domain);
        errdefer if (self.stream_metric_adapter) |value| value.deinit();
        if (configured.role.relayer.websocket_url) |url| {
            if (options.metrics) |registry| self.stream_metric_adapter = try stream_metrics.StreamMetrics.init(a, registry, .{ .max_chains = configured.chains.len });
            self.websocket_bridge = try stream_bridge.Bridge.init(a, .{
                .url = url,
                .origins = self.origins,
                .observer = if (self.stream_metric_adapter) |value| value.interface() else null,
                .controller = .{ .authority_enabled = configured.role.relayer.websocket_authority_enabled },
                .transport = .{
                    .transport = .{ .library_path = options.curl_library, .ca_info = environment.get("SSL_CERT_FILE") },
                    .retry_delay_ns = stream_wire.streamRetryDelay(0, false),
                    .wake = &self.websocket_wake,
                },
            });
        }
        errdefer if (self.websocket_bridge) |bridge| bridge.deinit();
        self.signers = try signer_tasks.Owner.open(a, self.origins, environment, self.sourceOptions());
        errdefer self.signers.deinit();
        self.control_hub = try relayer_control.Hub.init(a, configured, environment, self.origins, self.signers, if (self.regex_engine) |*value| value else null, &self.denylist);
        errdefer self.control_hub.deinit();
        const lanes = try a.alloc(Lane, configured.chains.len);
        errdefer a.free(lanes);
        var initialized: usize = 0;
        errdefer for (lanes[0..initialized]) |*lane| lane.deinit();
        for (configured.chains, lanes) |*chain, *lane| {
            const per_origin = try a.alloc(OriginLane, configured.chains.len);
            @memset(per_origin, .{});
            const control = relayer_control.Control.init(&self.control_hub, chain) catch |err| {
                a.free(per_origin);
                return err;
            };
            lane.* = .{ .owner = self, .chain = chain, .origins = per_origin, .control = control, .worker = undefined };
            if (self.validator_observations) |*manager| lane.validator_observation = .{ .manager = manager, .resolver = .{ .context = self, .name_fn = observationDomainName } };
            lane.lander_metrics = if (options.metrics) |registry| .{ .registry = registry, .destination = chain.name } else null;
            lane.initialization_metrics = if (options.metrics) |registry| .{ .registry = registry, .chain = chain.name, .role = .destination } else null;
            lane.critical_state = self.criticalForDomain(chain.domain);
            lane.worker = lane_owner.Owner.init(lane, Lane.cycle, .{ .timeout_ms = options.job_timeout_ms }) catch |err| {
                control.deinit();
                a.free(per_origin);
                return err;
            };
            initialized += 1;
            for (per_origin, configured.chains) |*origin, source| {
                if (self.metric_tracker) |tracker| origin.metrics = try relayer_metrics.Adapter.init(a, tracker, source.name, chain.name);
            }
        }
        self.lanes = lanes;
        const origin_tasks = self.origins.descriptors();
        const destination_end = origin_tasks.len + lanes.len;
        self.tasks = try a.alloc(supervisor.Task, destination_end + 1 + @intFromBool(self.websocket_bridge != null));
        @memcpy(self.tasks[0..origin_tasks.len], origin_tasks);
        for (lanes, self.tasks[origin_tasks.len..destination_end]) |*lane, *task| task.* = .{ .context = lane, .run = Lane.run, .failure = Lane.classify, .interval_ms = 100, .timeout_ms = options.job_timeout_ms, .wake = lane.control.wake, .stop_fn = Lane.stop };
        self.tasks[destination_end] = .{ .context = self, .run = pollDenylist, .interval_ms = @max(1, configured.role.relayer.runtime_denylist_poll_interval_seconds *| 1000), .timeout_ms = 45000 };
        if (self.websocket_bridge) |bridge| {
            self.tasks[destination_end + 1] = bridge.descriptor();
            self.tasks[destination_end + 1].context = self;
            self.tasks[destination_end + 1].run = pollBridge;
            self.tasks[destination_end + 1].stop_fn = stopBridge;
        }
        return self;
    }
    fn pollBridge(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        if (self.effects_halted.load(.acquire) or cancel.load(.acquire)) return error.RequestCancelled;
        const bridge = self.websocket_bridge orelse return error.MissingRelayerStreamBridge;
        // Socket startup belongs to the supervised I/O worker. Allocation in
        // open() does not create a transport thread on the scheduler owner.
        try bridge.start();
        return stream_bridge.Bridge.poll(bridge, times, cancel);
    }
    fn stopBridge(context: *anyopaque) void {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        if (self.websocket_bridge) |bridge| bridge.requestStop();
    }
    fn pollDenylist(context: *anyopaque, _: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *TaskSet = @ptrCast(@alignCast(context));
        if (self.denylist.config == null) return .{};
        try self.bindDenylist(cancel);
        defer self.unbindDenylist(cancel);
        if (!self.denylist_ready.load(.acquire)) {
            var sleeper: operator_native.Sleeper = .{ .cancel = cancel };
            try self.denylist.initialLoad(self.denylist_clock.interface(), sleeper.interface());
            if (cancel.load(.acquire)) return error.RequestCancelled;
            self.denylist_ready.store(true, .release);
        } else _ = try self.denylist.pollOnce(self.denylist_clock.interface());
        return .{ .work = 1 };
    }
    /// Polling and administrative refresh share this complete operation scope.
    /// Transport and cancellation storage remain stable for every native fetch.
    pub fn bindDenylist(self: *TaskSet, cancel: *const std.atomic.Value(bool)) !void {
        try self.denylist_mutex.lock(cancel);
        if (self.denylist_transport) |*transport| transport.cancel = cancel;
    }
    pub fn unbindDenylist(self: *TaskSet, cancel: *const std.atomic.Value(bool)) void {
        if (self.denylist_transport) |*transport| {
            std.debug.assert(transport.cancel == cancel);
            transport.cancel = null;
        }
        self.denylist_mutex.unlock();
    }
    pub fn requestStop(self: *TaskSet) void {
        self.effects_halted.store(true, .release);
        if (self.websocket_bridge) |bridge| bridge.requestStop();
        for (self.lanes) |*lane| lane.worker.requestStop();
    }
    pub fn descriptors(self: *TaskSet) []const supervisor.Task {
        return self.tasks;
    }
    pub fn deinit(self: *TaskSet) void {
        // Destination owners may be inside a metadata build even after their
        // Supervisor poll returned. Join them before draining metadata forks.
        self.requestStop();
        for (self.lanes) |*lane| lane.worker.deinit();
        self.metadata_executor.deinit();
        for (self.lanes) |*lane| lane.deinit();
        if (self.validator_observations) |*manager| manager.deinit();
        if (self.metric_tracker) |value| value.deinit();
        self.native_default_ism_cache.deinit();
        self.evm_default_ism_cache.deinit();
        self.native_cache.deinit();
        self.evm_cache.deinit();
        self.ccs_signatures.deinit();
        std.debug.assert(self.ccip_budget.used == 0);
        std.debug.assert(self.retained_bytes == 0);
        self.allocator.free(self.lanes);
        self.allocator.free(self.tasks);
        self.control_hub.deinit();
        if (self.websocket_bridge) |bridge| bridge.deinit();
        if (self.stream_metric_adapter) |value| value.deinit();
        self.signers.deinit();
        self.origins.deinit();
        if (self.dynamic_tip_cache) |value| value.deinit();
        self.allocator.free(self.critical_trackers);
        self.http_runtime.deinit();
        std.debug.assert(self.read_budget.used == 0);
        self.checkpoints.deinit();
        self.database.deinit();
        self.denylist.deinit();
        if (self.denylist_native) |*value| value.deinit();
        if (self.regex_engine) |*value| value.deinit();
        self.allocator.free(self.cache_path);
        self.allocator.destroy(self);
    }
};

const CcipBuild = struct {
    binding: *ccip_sessions.Binding,
    message: protocol.Message,
    now_ms: u64,
    fn deinit(self: *CcipBuild) void {
        self.binding.deinit();
    }
    fn delay(context: *anyopaque) u64 {
        const self: *CcipBuild = @ptrCast(@alignCast(context));
        return self.binding.owner.pendingDelayForMessage(self.binding.context.context_hash, self.message, self.now_ms) orelse 1000;
    }
};

/// Job-scoped callback context, consumed synchronously by the retained driver.
const Sender = struct {
    lane: *Lane,
    item: *Active,
    clock: destination.Clock,
    fn localAdmission(context: *anyopaque, message: protocol.Message) !bool {
        const self: *Sender = @ptrCast(@alignCast(context));
        return self.lane.canonicalAdmissionAllowed(self.item.origin_index, message);
    }
    fn snapshot(self: *Sender, a: A, message: protocol.Message, cached_only: bool) !?origin_signers.Cache.Snapshot {
        if (!self.lane.owner.denylist.hasAddressRules()) return null;
        if (cached_only) return self.lane.owner.signers.cache.cached(message.id());
        const current = try common.nowNs();
        if (current >= self.clock.deadline_ns) return error.SourceReadDeadline;
        const utc = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
        return self.lane.owner.signers.lookup(a, message, true, false, utc +| (self.clock.deadline_ns - current), self.clock.cancel);
    }
    fn evmFetch(context: *anyopaque, a: A, _: *native.Store, message: protocol.Message, cached_only: bool) !evm_prepare.SignerLookup {
        const self: *Sender = @ptrCast(@alignCast(context));
        var value = self.snapshot(a, message, cached_only) catch |err| {
            if (err == error.DispatchHashNotStored) return .hash_not_stored;
            return err;
        };
        defer if (value) |*snapshot_| snapshot_.deinit();
        return .{ .signers = try a.dupe([32]u8, if (value) |snapshot_| snapshot_.signers() else &.{}) };
    }
    fn check(context: *anyopaque, a: A, message: protocol.Message, clock: destination.Clock, cached_only: bool) !native_driver.GateResult {
        _ = a;
        const self: *Sender = @ptrCast(@alignCast(context));
        self.clock = clock;
        const result = try self.lane.originSenderGate(&self.item.sender_state, self.item.origin_index, message, clock, cached_only);
        if (result == .delay_ms) self.item.next_ms = @max(self.item.next_ms, self.item.now_monotonic_ms +| result.delay_ms);
        return result;
    }
};

test "effects halt blocks the real destination signer before touching key state" {
    var owner: TaskSet = undefined;
    owner.effects_halted = .init(true);
    var lane: Lane = undefined;
    lane.owner = &owner;
    try std.testing.expectError(error.RequestCancelled, Lane.sign(&lane, @splat(1)));
}

test "metadata cache growth preserves pending public byte reservations and releases evicted bytes" {
    const a = std.testing.allocator;
    const Case = struct { reserved: usize, previous: usize, current: usize, accepted: bool };
    for ([_]Case{
        .{ .reserved = 40, .previous = 0, .current = 30, .accepted = false },
        .{ .reserved = 10, .previous = 0, .current = 30, .accepted = true },
        .{ .reserved = 30, .previous = 10, .current = 30, .accepted = false },
    }) |case| {
        var owner: TaskSet = undefined;
        owner.allocator = a;
        owner.options = .{ .curl_library = "unused", .max_active_bytes = 100, .max_retained_bytes = 1000 };
        owner.memory_mutex = .{};
        owner.retained_bytes = 60 + case.reserved;
        var control: relayer_control.Control = undefined;
        control.relay_reservation = .{ .id = 1, .transaction = @splat(0), .storage = &.{}, .items = &.{}, .retained_bytes = case.reserved, .context = undefined, .drop_fn = undefined };
        var lane: Lane = undefined;
        lane.owner = &owner;
        lane.control = &control;
        lane.active_bytes = 60;
        var item: Active = undefined;
        item.retained_bytes = 60;
        item.evm_driver = evm_driver.Driver.init(a);
        defer item.evm_driver.?.deinit();
        item.evm_driver.?.cached_metadata = try a.alloc(u8, case.current);
        lane.accountCache(&item, case.previous);
        const expected_active = if (case.accepted) 60 + case.current - case.previous else 60 - case.previous;
        try std.testing.expectEqual(expected_active, lane.active_bytes);
        try std.testing.expectEqual(expected_active, item.retained_bytes);
        try std.testing.expectEqual(lane.active_bytes + case.reserved, owner.retained_bytes);
        try std.testing.expect(lane.active_bytes + control.reservedBytes() <= owner.options.max_active_bytes);
        try std.testing.expectEqual(case.accepted, item.evm_driver.?.cached_metadata != null);
    }
}

test "relayer Root tip cache opt-in is confined to origin indexing options" {
    const a = std.testing.allocator;
    const cache = try dynamic_tip_cache.Cache.init(a, .{});
    defer cache.deinit();
    var transport: http_runtime.Runtime = undefined;
    var owner: TaskSet = undefined;
    owner.options = .{ .curl_library = "unused" };
    owner.http_runtime = &transport;
    owner.read_budget = .{};
    owner.dynamic_tip_cache = cache;
    const indexing = owner.indexingSourceOptions();
    try std.testing.expect(indexing.indexer_tip_cache and indexing.dynamic_tip_cache == cache);
    const ordinary = owner.sourceOptions();
    try std.testing.expect(!ordinary.indexer_tip_cache and ordinary.dynamic_tip_cache == null);
    const destination_options = owner.destinationOptions();
    try std.testing.expect(!destination_options.indexer_tip_cache and destination_options.dynamic_tip_cache == null);
}

test "relayer Root always caches unmetered default ISM with contract caching disabled and publishes no wallet before initialization" {
    const a = std.testing.allocator;
    const fixture = @import("../evm/pool_testing.zig");
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "unexpected-constructor-request" }} }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chains = [_]settings.Chain{@import("chain_source_testing.zig").chainFor(&.{url})};
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    for ([_]bool{ false, true }) |enabled| {
        var configured: settings.Settings = undefined;
        configured.chains = &chains;
        var role = std.mem.zeroes(@import("../settings/types.zig").Relayer);
        role.db = path;
        role.allow_contract_call_caching = enabled;
        configured.role = .{ .relayer = role };
        const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
        defer registry.deinit();
        const owner = try TaskSet.open(a, &configured, &environment, .{ .curl_library = library, .metrics = registry, .allow_insecure_loopback = true });
        defer owner.deinit();
        try std.testing.expectEqual(@as(usize, 2), owner.validator_observations.?.max_contexts);
        try std.testing.expectEqual(enabled, owner.evm_cache.entries.len > 0);
        try std.testing.expectEqual(enabled, owner.native_cache.entries.len > 0);
        const context: contract_cache.Context = .{ .domain_name = chains[0].name, .context_hash = @splat(1) };
        try std.testing.expect(try owner.evm_default_ism_cache.put(context, .default_ism, &.{ .address = @splat(2) }, 0));
        try std.testing.expect(try owner.native_default_ism_cache.put(context, .default_ism, &.{ .address = @splat(3) }, 0));
        try std.testing.expectEqual(@as([20]u8, @splat(2)), (try owner.evm_default_ism_cache.get(context, .default_ism, 599_999)).?.address);
        try std.testing.expectEqual(@as([32]u8, @splat(3)), (try owner.native_default_ism_cache.get(context, .default_ism, 599_999)).?.address);
        try std.testing.expect(try owner.evm_default_ism_cache.get(context, .default_ism, 600_000) == null);
        var wallet_text: [256]u8 = undefined;
        const wallet = (try owner.healthWallets().get_fn(owner, chains[0].domain)).?;
        try std.testing.expect(try wallet.load_into_fn.?(wallet.context, &wallet_text) == null);
        try std.testing.expect(owner.origins.slots[0].critical == owner.criticalForDomain(chains[0].domain));
        try std.testing.expect(owner.lanes[0].critical_state == owner.criticalForDomain(chains[0].domain));
        const rendered = try registry.render(a);
        defer a.free(rendered);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_cache_entry_count{") == null);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_hit_count{") == null);
        try std.testing.expect(std.mem.indexOf(u8, rendered, "hyperlane_miss_count{") == null);
        try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
    }
}

test "relayer Root observation capacity follows static routes beyond old 256 lifetime contexts" {
    const a = std.testing.allocator;
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture" });
    defer registry.deinit();
    var configured: settings.Settings = undefined;
    var chains: [18]settings.Chain = undefined;
    var names: [18][16]u8 = undefined;
    for (&chains, &names, 0..) |*chain, *buffer, index| {
        chain.name = try std.fmt.bufPrint(buffer, "chain-{d}", .{index});
        chain.domain = @intCast(index + 1);
    }
    configured.chains = &chains;
    configured.role = .{ .relayer = std.mem.zeroes(@import("../settings/types.zig").Relayer) };
    var owner: TaskSet = undefined;
    owner.settings = &configured;
    owner.validator_observations = validator_observability.Manager.init(a, registry, .{ .context = &owner, .now_ms_fn = TaskSet.observationUtcMs });
    defer owner.validator_observations.?.deinit();
    owner.configureObservationCapacity(registry);
    // 18*18 actual static routes, with both Source default contexts reserved.
    try std.testing.expectEqual(@as(usize, 648), owner.validator_observations.?.max_contexts);
    var active: validator_observability.Active = .{ .manager = &owner.validator_observations.?, .resolver = .{ .context = &owner, .name_fn = TaskSet.observationDomainName } };
    const observation = active.observation();
    for (0..300) |index| try observation.latest_fn(observation.context, chains[index / 18].domain, chains[index % 18].domain, "Unknown", &.{@splat(1)}, &.{@intCast(index)});
    try std.testing.expectEqual(@as(usize, 300), owner.validator_observations.?.contexts.items.len);
    try std.testing.expectEqual(@as(u64, 0), owner.validator_observations.?.failures.load(.acquire));
    const text = try registry.render(a);
    defer a.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    var samples: usize = 0;
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, "hyperlane_observed_validator_latest_index{")) {
        samples += 1;
    };
    try std.testing.expectEqual(@as(usize, 300), samples);
}

test "Root production metadata observer preserves success under registry pressure and drains wait ownership" {
    const a = std.testing.allocator;
    for (0..4) |pressure| {
        var failing = std.testing.FailingAllocator.init(a, .{});
        const registry = try metrics.Registry.init(failing.allocator(), .relayer, .{ .base_version = "fixture" });
        defer registry.deinit();
        const tracker = try relayer_metrics.WaitTracker.init(a, registry, .{ .max_active = 2, .max_bytes = 16384 });
        defer tracker.deinit();
        const adapter = try relayer_metrics.Adapter.init(a, tracker, "origin", "destination");
        defer adapter.deinit();
        var owner: TaskSet = undefined;
        owner.options = .{ .curl_library = "unused" };
        var origin: OriginLane = .{ .metrics = adapter };
        var lane: Lane = .{ .owner = &owner, .chain = undefined, .origins = @as(*[1]OriginLane, &origin), .control = undefined, .worker = undefined };
        const message: protocol.Message = .{ .version = 3, .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(1), .recipient = @splat(2), .body = "public" };
        var item: Active = .{ .origin_index = 0, .lane = &lane, .message = .{ .allocator = a, .bytes = undefined, .value = message }, .retained_bytes = 0, .now_monotonic_ms = 2, .now_unix_seconds = 1 };
        if (pressure < 3) _ = try adapter.recordMetadataWait(.{ .message_id = message.id(), .app_context = null, .unix_timestamp_seconds = 1, .monotonic_ms = 2 });
        const observer = Lane.metadataObserverFor(&item).?;
        try observer.start();
        switch (pressure) {
            0 => registry.options.max_series = 1,
            1 => registry.options.max_storage_bytes = 1,
            2 => failing.fail_index = failing.alloc_index,
            else => tracker.options.max_bytes = 1,
        }
        if (pressure == 3) {
            try std.testing.expectError(error.MetricTrackerLimit, adapter.recordMetadataWait(.{ .message_id = message.id(), .app_context = null, .unix_timestamp_seconds = 1, .monotonic_ms = 2 }));
            try observer.complete(.awaiting_validator_signatures);
            try observer.start();
        }
        // This exact production callback is supplied to both metadata builders.
        // Successful metadata remains success even when histogram/event creation fails.
        try observer.complete(.success);
        try std.testing.expect(lane.telemetry_failures.load(.monotonic) > 0);
        try std.testing.expect(item.metadata_started_ms == null);
        try std.testing.expectEqual(@as(usize, 0), tracker.activeCount());
        try std.testing.expectEqual(@as(usize, 0), tracker.retainedBytes());
        // Repeated cleanup neither resurrects refs nor changes outcome.
        try observer.complete(.success);
        lane.finishActiveMetrics(&item, .ended);
        try std.testing.expectEqual(@as(usize, 0), tracker.activeCount());
        failing.fail_index = std.math.maxInt(usize);
    }
}

pub const NativeTests = if (@import("builtin").is_test) struct {
    pub fn evmOperationContext(destination_context: [32]u8, origin: *const settings.Chain) [32]u8 {
        return evmContext(destination_context, origin);
    }
    pub fn originSenderGate(lane: *Lane, state: *SenderState, origin_index: usize, message: protocol.Message, clock: destination.Clock, cached_only: bool) !native_driver.GateResult {
        return lane.originSenderGate(state, origin_index, message, clock, cached_only);
    }
} else struct {};
