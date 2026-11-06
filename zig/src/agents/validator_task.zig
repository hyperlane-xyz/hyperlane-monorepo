//! Native operational validator job. Credential and signer factories are
//! injected by the process owner; local jobs perform no identity discovery.
const std = @import("std");
const settings = @import("../settings/root.zig");
const config = @import("validator/config.zig");
const role = @import("validator/evm.zig");
const generic = @import("validator/generic.zig");
const rocks = @import("../db/rocks.zig");
const Curl = @import("../net/curl.zig");
const cloud = @import("../cloud/root.zig");
const supervisor = @import("../runtime/supervisor.zig");
const metrics = @import("../ops/metrics.zig");
const A = std.mem.Allocator;
const AnnouncementWorker = @import("validator/announcement_task.zig");
const Mailbox = @import("validator/mailbox.zig").Mailbox;
const DatabaseOwner = @import("origin_tasks.zig").DatabaseOwner;
const http_api = @import("validator/http.zig");
const readiness = @import("validator/readiness.zig");
pub const Credentials = AnnouncementWorker.Credentials;
pub const ChainSigner = AnnouncementWorker.ChainSigner;
pub const Options = struct { curl_library: []const u8, request_timeout_ms: u32 = 20000, job_timeout_ms: u64 = 120000, metrics: ?*metrics.Registry = null, environment: ?*const std.process.EnvMap = null, allow_insecure_loopback: bool = false };
pub const Task = struct {
    allocator: A,
    settings: *const settings.Settings,
    options: Options,
    native: ?Curl.Client = null,
    http: cloud.http.HttpTransport,
    credentials: ?Credentials,
    database_owner: *DatabaseOwner,
    database: ?*rocks.Database = null,
    mailbox: Mailbox,
    readiness: readiness.State,
    api: http_api.Controller,
    last_api_error: ?anyerror = null,
    announcement: *AnnouncementWorker.Worker,
    stream_wake: std.atomic.Value(bool) = .init(false),
    effects_halted: std.atomic.Value(bool) = .init(false),
    checkpoint_cancel: ?*const std.atomic.Value(bool) = null,
    resources: ?*config.Resources = null,
    validator: ?*role.Role = null,
    generic_validator: ?*generic.Role = null,
    empty_environment: std.process.EnvMap,
    date: [16]u8 = undefined,
    backfill_target: ?u32 = null,
    backfill_complete: bool = false,
    reached_consistency: bool = false,
    last_metric_error: ?anyerror = null,
    critical: @import("../ops/critical_metrics.zig").Tracker,
    tip_cache: ?*@import("../net/dynamic_tip_cache.zig").Cache = null,
    pub fn init(a: A, s: *const settings.Settings, options: Options, credentials: ?Credentials, chain_signer: ?ChainSigner) !*Task {
        if (s.role != .validator or options.request_timeout_ms == 0 or options.job_timeout_ms == 0) return error.InvalidValidatorTask;
        const self = try a.create(Task);
        errdefer a.destroy(self);
        const database_owner = try DatabaseOwner.init(a, s.role.validator.db);
        errdefer database_owner.deinit();
        const chain = s.chainByName(s.role.validator.origin_chain) orelse return error.UnknownOriginChain;
        self.* = .{ .allocator = a, .settings = s, .options = options, .http = cloud.http.HttpTransport.init(a), .credentials = credentials, .database_owner = database_owner, .mailbox = .{ .allocator = a, .database = database_owner, .chain_name = chain.name }, .readiness = readiness.State.init(a), .api = undefined, .announcement = undefined, .empty_environment = std.process.EnvMap.init(a), .critical = .{ .registry = options.metrics, .chain = chain.name } };
        self.api = .{ .readiness = &self.readiness, .merkle = .{ .context = self, .list_fn = listInsertions } };
        self.http.allow_insecure_loopback = options.allow_insecure_loopback;
        self.announcement = try AnnouncementWorker.Worker.init(a, s, database_owner, &self.mailbox, .{ .curl_library = options.curl_library, .request_timeout_ms = options.request_timeout_ms, .job_timeout_ms = options.job_timeout_ms, .environment = options.environment, .allow_insecure_loopback = options.allow_insecure_loopback });
        self.announcement.halt_signal = &self.effects_halted;
        self.announcement.setProviders(null, chain_signer);
        return self;
    }
    /// Supervisor must join all jobs before this releases clients/keys/DB.
    pub fn deinit(self: *Task) void {
        if (self.validator) |validator| validator.deinit();
        if (self.generic_validator) |validator| validator.deinit();
        self.empty_environment.deinit();
        self.announcement.deinit();
        if (self.resources) |resources| resources.deinit();
        self.database_owner.deinit();
        self.readiness.deinit();
        self.http.deinit();
        if (self.native) |*native| native.deinit();
        if (self.tip_cache) |cache| cache.deinit();
        self.allocator.destroy(self);
    }
    /// Health construction shares this exact tracker with cursor initialization.
    /// A failed health observation must not record/clear a critical reason.
    pub fn criticalForChain(self: *Task, domain: u32) ?*@import("../ops/critical_metrics.zig").Tracker {
        const chain = self.settings.chainByName(self.settings.role.validator.origin_chain) orelse return null;
        return if (chain.domain == domain) &self.critical else null;
    }
    pub fn descriptor(self: *Task) supervisor.Task {
        return .{ .context = self, .run = run, .failure = failure, .interval_ms = @max(1, self.settings.role.validator.interval *| 1000), .timeout_ms = self.options.job_timeout_ms, .wake = if (self.settings.role.validator.websocket_url != null) &self.stream_wake else null };
    }
    pub fn descriptors(self: *Task) [2]supervisor.Task {
        return .{ self.descriptor(), self.announcement.descriptor() };
    }
    fn failure(err: anyerror) supervisor.FailureAction {
        return switch (err) {
            error.ValidatorHalted, error.ReorgFlagPresent, error.ValidatorIdentityMismatch, error.OperationContextChanged, error.ValidatorCursorInitializationExhausted => .halt_all,
            else => .retry,
        };
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Task = @ptrCast(@alignCast(context));
        const report = self.tick(times, cancel) catch |err| {
            self.httpFailure(err);
            return err;
        };
        self.httpProgress();
        return report;
    }
    pub fn tick(self: *Task, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        var tick_elapsed = try std.time.Timer.start();
        if (cancel.load(.acquire)) return error.RequestCancelled;
        _ = self.stream_wake.swap(false, .acq_rel);
        // Local durability retries do not depend on KMS/storage lease refresh.
        if (self.validatorState()) |current| if (current.halted) try current.retryLocalGuard();
        if (self.tip_cache == null) self.tip_cache = try @import("../net/dynamic_tip_cache.zig").Cache.init(self.allocator, .{});
        if (self.native == null) self.native = try Curl.Client.init(self.allocator, self.options.curl_library);
        self.http.native_curl = &self.native.?;
        self.http.cancel = cancel;
        self.checkpoint_cancel = cancel;
        defer {
            self.http.cancel = null;
            self.checkpoint_cancel = null;
        }
        const now = times.unix_ms / 1000;
        const credentials = if (self.credentials) |provider| try provider.lease(provider.context, now) else config.Credentials{ .transport = self.http.interface(), .http_owner = &self.http, .amz_date = try amzDate(&self.date, now) };
        if (self.database == null) self.database = try self.database_owner.get(cancel);
        if (self.resources == null) self.resources = try config.Resources.open(self.allocator, self.settings, credentials);
        const resources = self.resources.?;
        try resources.refresh(credentials);
        const chain = self.settings.chainByName(self.settings.role.validator.origin_chain) orelse return error.UnknownOriginChain;
        if (chain.protocol != .ethereum) return self.genericTick(now, times.monotonic_ms +| tick_elapsed.read() / std.time.ns_per_ms, cancel);
        if (self.validator == null) self.validator = try role.Role.open(self.allocator, self.settings, self.database.?, .{ .critical = &self.critical, .dynamic_tip_cache = self.tip_cache, .metrics = self.options.metrics, .native_transport = &self.native.?, .multi_library_path = self.options.curl_library, .rpc_timeout_ms = self.options.request_timeout_ms, .cancel = cancel, .readiness = &self.readiness, .stream_wake = &self.stream_wake, .websocket_ca_info = if (self.options.environment) |environment| environment.get("SSL_CERT_FILE") else null, .halt_signal = &self.effects_halted, .signer = resources.signer(), .signer_address = resources.signer_address, .publisher = resources.publisher(), .storage_location = resources.storage_location, .announcer = .{ .context = self, .submit = announce } });
        const validator = self.validator.?;
        validator.runtime.signer = resources.signer();
        validator.setCancellation(cancel);
        defer {
            validator.runtime.signer.cancel = null;
            validator.setCancellation(null);
        }
        const result = validator.tick(now, times.monotonic_ms +| tick_elapsed.read() / std.time.ns_per_ms) catch |err| {
            self.recordMetrics() catch |metric_error| self.metricFailure(metric_error);
            return err;
        };
        const role_completed = tick_elapsed.read();
        if (validator.announcement_ready) if (validator.signed_announcement) |signed| try self.mailbox.completed(signed.value.digest(), cancel);
        self.recordMetrics() catch |err| self.metricFailure(err);
        const source_delay = if (result.next_delay_ms) |delay| @min(self.settings.role.validator.interval *| 1000, delay -| ((tick_elapsed.read() -| role_completed) / std.time.ns_per_ms)) else null;
        return .{ .work = if (result.progress) |progress| progress.published else 0, .next_delay_ms = if (result.indexed_range) 0 else source_delay };
    }
    fn genericTick(self: *Task, now: u64, monotonic_ms: u64, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        var tick_elapsed = try std.time.Timer.start();
        const resources_ = self.resources.?;
        if (self.generic_validator == null) self.generic_validator = try generic.Role.open(self.allocator, self.settings, self.options.environment orelse &self.empty_environment, self.database.?, .{ .critical = &self.critical, .clients = .{ .dynamic_tip_cache = self.tip_cache, .curl_library = self.options.curl_library, .request_timeout_ms = self.options.request_timeout_ms, .allow_insecure_loopback = self.options.allow_insecure_loopback, .metrics = self.options.metrics }, .cancel = cancel, .readiness = &self.readiness, .stream_wake = &self.stream_wake, .websocket_ca_info = if (self.options.environment) |environment| environment.get("SSL_CERT_FILE") else null, .halt_signal = &self.effects_halted, .signer = resources_.signer(), .signer_address = resources_.signer_address, .publisher = resources_.publisher(), .storage_location = resources_.storage_location, .announcer = .{ .context = self, .submit = announceNative } });
        const validator = self.generic_validator.?;
        validator.runtime.signer = resources_.signer();
        validator.setCancellation(cancel);
        defer {
            validator.runtime.signer.cancel = null;
            validator.setCancellation(null);
        }
        const result = validator.tick(now, monotonic_ms +| tick_elapsed.read() / std.time.ns_per_ms) catch |err| {
            self.recordMetrics() catch |metric_error| self.metricFailure(metric_error);
            return err;
        };
        const role_completed = tick_elapsed.read();
        if (validator.announcement_ready) if (validator.signed_announcement) |signed| try self.mailbox.completed(signed.value.digest(), cancel);
        self.recordMetrics() catch |err| self.metricFailure(err);
        const source_delay = if (result.next_delay_ms) |delay| @min(self.settings.role.validator.interval *| 1000, delay -| ((tick_elapsed.read() -| role_completed) / std.time.ns_per_ms)) else null;
        return .{ .work = if (result.progress) |progress| progress.published else 0, .next_delay_ms = if (result.indexed_range or result.audit_pending) 0 else source_delay };
    }
    /// Detach the route and drain HTTP workers before deinitializing this Task.
    /// Called after all role jobs join, before teardown, for shutdown diagnostics.
    pub fn hasUnpersistedGuard(self: *Task) bool {
        if (self.validator) |value| if (value.state.hasUnpersistedGuard()) return true;
        if (self.generic_validator) |value| if (value.state.hasUnpersistedGuard()) return true;
        return false;
    }
    pub fn httpHandler(self: *Task) @import("../ops/http.zig").Handler {
        return self.api.handler();
    }
    fn listInsertions(context: *anyopaque, a: A, start: u32, end: u32, budget: *http_api.RowBudget, cancel: *const std.atomic.Value(bool)) ![]http_api.Insertion {
        const self: *Task = @ptrCast(@alignCast(context));
        const chain = self.settings.chainByName(self.settings.role.validator.origin_chain) orelse return error.UnknownOriginChain;
        var store = @import("store.zig").Store.init(a, try self.database_owner.get(cancel), chain.name);
        var values: std.ArrayList(http_api.Insertion) = .empty;
        errdefer values.deinit(a);
        var index: u64 = start;
        while (index <= end) : (index += 1) {
            if (cancel.load(.acquire)) return error.RequestCancelled;
            const height = store.logBlock(.insertion, @intCast(index)) catch return error.InsertionBlockReadFailed;
            if (try store.insertionByIndex(@intCast(index))) |insertion| {
                try budget.add(height, insertion.leaf_index, 66);
                const text = try std.fmt.allocPrint(a, "0x{s}", .{std.fmt.bytesToHex(insertion.message_id, .lower)});
                try values.append(a, .{ .insertion_block_number = height, .leaf_index = insertion.leaf_index, .message_id = text });
            }
        }
        return values.toOwnedSlice(a);
    }
    fn apiFailure(self: *Task, err: anyerror) void {
        if (self.last_api_error == null or self.last_api_error.? != err) std.log.warn("validator readiness update failed: {s}", .{@errorName(err)});
        self.last_api_error = err;
    }
    fn validatorState(self: *Task) ?*@import("validator.zig").Service {
        return if (self.validator) |value| &value.state else if (self.generic_validator) |value| &value.state else null;
    }
    fn httpProgress(self: *Task) void {
        const current = self.validatorState() orelse return;
        self.readiness.ready("validator_initialization");
        self.readiness.checkpoints(current.fresh_verified_through, current.latest_published);
        const operation = if (self.validator != null) "merkle_tree_hook.latest_checkpoint" else "merkle_tree_hook.tree";
        if (current.tree.count == 0) {
            self.readiness.ready(operation);
            self.readiness.waiting();
        }
    }
    fn httpFailure(self: *Task, err: anyerror) void {
        const current = self.validatorState() orelse {
            self.readiness.blocked("validator_initialization") catch |failure_| self.apiFailure(failure_);
            return;
        };
        self.readiness.checkpoints(current.fresh_verified_through, current.latest_published);
        if (current.halted or err == error.ValidatorHalted or err == error.ReorgFlagPresent) {
            self.readiness.blocked("checkpoint_reorg") catch |failure_| self.apiFailure(failure_);
            return;
        }
        if (current.options.readiness != null) {
            var remote_count: u64 = 0;
            if (self.validator) |value| {
                if (value.round_results) |results| for (results) |result| {
                    if (result.ready) remote_count = @max(remote_count, result.count orelse 0);
                };
            } else if (self.generic_validator) |value| {
                if (value.round) |results| for (results) |result| {
                    if (result.ready) remote_count = @max(remote_count, result.value.?.tree.count);
                };
            }
            if (remote_count > current.tree.count) {
                var insertion_buffer: [80]u8 = undefined;
                const operation = std.fmt.bufPrint(&insertion_buffer, "merkle_tree_insertion[{d}]", .{current.tree.count}) catch unreachable;
                self.readiness.blocked(operation) catch |failure_| self.apiFailure(failure_);
            }
            return;
        }
        if (current.reservation() catch null) |candidate| {
            var buffer: [80]u8 = undefined;
            const operation = std.fmt.bufPrint(&buffer, "checkpoint_submission[{d}]", .{candidate.index}) catch unreachable;
            self.readiness.blocked(operation) catch |failure_| self.apiFailure(failure_);
        } else self.readiness.blocked(if (self.validator != null) "merkle_tree_hook.latest_checkpoint" else "merkle_tree_hook.tree") catch |failure_| self.apiFailure(failure_);
    }
    fn metricFailure(self: *Task, err: anyerror) void {
        // Source Prometheus setters do not affect checkpoint correctness. A
        // bounded registry failure must not replace a signing/fork error.
        if (self.last_metric_error == null or self.last_metric_error.? != err)
            std.log.warn("validator metrics update failed: {s}", .{@errorName(err)});
        self.last_metric_error = err;
    }
    fn recordMetrics(self: *Task) !void {
        const registry = self.options.metrics orelse return;
        const state = if (self.validator) |validator| &validator.state else if (self.generic_validator) |validator| &validator.state else return;
        if (state.fresh_verified_through != null) self.reached_consistency = true;
        if (self.backfill_target == null) {
            if (state.bootstrap_index orelse state.fresh_verified_through) |index| self.backfill_target = index + 1 else {
                var empty: usize = 0;
                if (self.validator) |validator| {
                    if (validator.round_results) |results| for (results) |result| {
                        if (result.ready and result.count == 0) empty += 1;
                    };
                } else if (self.generic_validator) |validator| {
                    if (validator.round) |results| for (results) |result| {
                        if (result.ready and result.value.?.tree.count == 0) empty += 1;
                    };
                }
                const required = if (state.options.consensus) |c| try c.required(state.options.endpoint_count) else 1;
                if (empty >= required) self.backfill_target = 0;
            }
        }
        if (self.backfill_target) |count| {
            if (state.repair_complete and (count == 0 or (state.snapshot_through != null and state.snapshot_through.? >= count - 1))) self.backfill_complete = true;
        }
        const chain = if (self.validator) |validator| validator.chain else self.generic_validator.?.chain;
        const stream = if (self.validator) |validator| validator.stream else self.generic_validator.?.stream;
        try updateValidatorMetrics(registry, .{ .rpc_active = if (stream) |value| value.fallback_active else true, .websocket_active = if (stream) |value| value.controller.activated and value.controller.generation_open else false, .chain = chain.name, .verification_leaves = state.tree.count, .observed = state.fresh_verified_through, .processed = state.latest_published, .consistent = self.reached_consistency, .backfill_complete = self.backfill_complete });
        self.last_metric_error = null;
    }
    fn announce(context: *anyopaque, digest: [32]u8, target: [20]u8, data: []const u8) !void {
        const self: *Task = @ptrCast(@alignCast(context));
        if (self.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
        try self.mailbox.ethereum(digest, target, data, self.checkpoint_cancel orelse return error.MissingValidatorJob);
    }
    fn announceNative(context: *anyopaque, signed: @import("../storage/objects.zig").SignedAnnouncement) !void {
        const self: *Task = @ptrCast(@alignCast(context));
        if (self.effects_halted.load(.acquire)) return error.CheckpointEffectsHalted;
        try self.mailbox.nativeAnnouncement(signed, self.checkpoint_cancel orelse return error.MissingValidatorJob);
    }
};
pub const amzDate = @import("validator/date.zig").amzDate;

test "validator signing date uses current UTC and bounds epoch conversion" {
    var buffer: [16]u8 = undefined;
    try std.testing.expectEqualStrings("19700101T000000Z", try amzDate(&buffer, 0));
    try std.testing.expectEqualStrings("20000229T000000Z", try amzDate(&buffer, 951782400));
    try std.testing.expectEqualStrings("99991231T235959Z", try amzDate(&buffer, 253402300799));
    try std.testing.expectError(error.InvalidClock, amzDate(&buffer, std.math.maxInt(u64)));
}

pub const MetricSnapshot = struct { rpc_active: bool = true, websocket_active: bool = false, chain: []const u8, verification_leaves: u32, observed: ?u32, processed: ?u32, consistent: bool, backfill_complete: bool };
/// Only facts produced by the native worker are emitted. Historical-publication
/// counters and provider/Tokio internals need their own event instrumentation;
/// this adapter never invents estimates for those source metric families.
pub fn updateValidatorMetrics(registry: *metrics.Registry, snapshot: MetricSnapshot) !void {
    const chain = snapshot.chain;
    try registry.update("hyperlane_validator_merkle_tree_leaf_count", &.{ chain, "verification" }, .{ .set_int = snapshot.verification_leaves });
    if (snapshot.observed) |index| try registry.update("hyperlane_latest_checkpoint", &.{ "validator_observed", chain }, .{ .set_int = index });
    if (snapshot.processed) |index| try registry.update("hyperlane_latest_checkpoint", &.{ "validator_processed", chain }, .{ .set_int = index });
    try registry.update("hyperlane_reached_initial_consistency", &.{chain}, .{ .set_int = @intFromBool(snapshot.consistent) });
    try registry.update("hyperlane_backfill_complete", &.{chain}, .{ .set_int = @intFromBool(snapshot.backfill_complete) });
    try registry.update("hyperlane_merkle_tree_hook_sync_source_active", &.{ chain, "rpc" }, .{ .set_int = @intFromBool(snapshot.rpc_active) });
    try registry.update("hyperlane_merkle_tree_hook_sync_source_active", &.{ chain, "websocket" }, .{ .set_int = @intFromBool(snapshot.websocket_active) });
}
test "validator metric adapter uses actual source names labels and durable worker progress" {
    const registry = try metrics.Registry.init(std.testing.allocator, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    try updateValidatorMetrics(registry, .{ .chain = "public-fixture", .verification_leaves = 3, .observed = 2, .processed = 2, .consistent = true, .backfill_complete = true });
    const rendered = try registry.render(std.testing.allocator);
    defer std.testing.allocator.free(rendered);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "phase=\"validator_processed\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "phase=\"verification\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "source=\"rpc\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, rendered, "phase=\"historical_publication\"") == null);
}
