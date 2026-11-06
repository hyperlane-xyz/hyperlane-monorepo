//! Operational EVM validator role. Call open/tick inside a bounded I/O worker;
//! deinit only after its worker has stopped. HTTP cancellation is borrowed.
const std = @import("std");
const settings = @import("../../settings/root.zig");
const service = @import("../validator.zig");
const driver = @import("driver.zig");
const rpc = @import("../../evm/provider.zig");
const indexing = @import("../../evm/indexer.zig");
const announce = @import("../../evm/announce.zig");
const abi = @import("../../evm/codecs.zig");
const objects = @import("../../storage/objects.zig");
const rocks = @import("../../db/rocks.zig");
const native = @import("../store.zig");
const cursor = @import("../../runtime/sequence_cursor.zig");
const Curl = @import("../../net/curl.zig");
const votes = @import("votes.zig");
const stream_binding = @import("stream.zig");
const A = std.mem.Allocator;
const RpcMetrics = @import("../../ops/rpc_metrics.zig");
const fetch_backoff = @import("../indexing/fetch_backoff.zig");
const fetch_observation = @import("../../runtime/indexing_observer.zig");
const tick_clock = @import("tick_clock.zig");
const cursor_initialization = @import("cursor_init.zig");
const Critical = @import("../../ops/critical_metrics.zig");
const IndexMetrics = @import("../../ops/indexing_metrics.zig");
pub const Announcer = struct {
    context: *anyopaque,
    /// Durable idempotency key is the announcement digest. The transaction
    /// owner (lander) persists signed bytes/nonce before broadcasting.
    submit: *const fn (*anyopaque, [32]u8, abi.Address, []const u8) anyerror!void,
};
pub const Runtime = struct {
    critical: ?*Critical.Tracker = null,
    dynamic_tip_cache: ?*@import("../../net/dynamic_tip_cache.zig").Cache = null,
    stream_wake: ?*std.atomic.Value(bool) = null,
    websocket_ca_info: ?[]const u8 = null,
    halt_signal: ?*std.atomic.Value(bool) = null,
    readiness: ?*@import("readiness.zig").State = null,
    metrics: ?*@import("../../ops/metrics.zig").Registry = null,
    native_transport: ?*Curl.Client = null,
    multi_library_path: ?[]const u8 = null,
    allow_std_transport_for_tests: bool = false,
    cancel: ?*const std.atomic.Value(bool) = null,
    rpc_timeout_ms: u32 = 20000,
    connect_timeout_ms: u32 = 5000,
    signer: service.Signer,
    signer_address: [20]u8,
    publisher: service.Publisher,
    storage_location: []const u8,
    announcer: ?Announcer = null,
};
pub const Tick = struct { next_delay_ms: ?u64 = null, announcement_pending: bool = false, indexed_range: bool = false, progress: ?driver.Progress = null };
const Slot = struct { client: *rpc.RpcClient, indexer: indexing.Indexer, last_error: ?anyerror = null, last_vote: ?service.Checkpoint = null };
pub const Role = struct {
    allocator: A,
    settings: *const settings.Settings,
    chain: *const settings.Chain,
    runtime: Runtime,
    rpc_native: ?*Curl.Client = null,
    primary_metrics: ?*RpcMetrics.Recorder = null,
    index_metrics: ?IndexMetrics.Adapter = null,
    quorum_metrics: ?*RpcMetrics.Recorder = null,
    slots: []Slot,
    state: service.Service,
    stream: ?*stream_binding.Bridge = null,
    stream_cadence: @import("stream_cadence.zig").Cadence = .{},
    store: native.Store,
    sequence_store: native.SequenceStore,
    sequence_cursor: ?cursor.Cursor = null,
    fetch_retry: fetch_backoff.State = .{},
    index_due_ms: ?u64 = null,
    cycle_clock: tick_clock.Clock = .{},
    cursor_initialization: cursor_initialization.State = .{},
    stream_initialization: cursor_initialization.State = .{},
    canonical: std.AutoHashMap(u32, service.Observation),
    primary: ?usize = null,
    read_preferred: usize = 0,
    consensus: bool,
    announcement_written: bool = false,
    announcement_ready: bool = false,
    signed_announcement: ?objects.SignedAnnouncement = null,
    next_announcement_ms: u64 = 0,
    next_audit_ms: u64 = 0,
    round_results: ?[]votes.Result = null,
    /// Opens local state only; RPC chain checks and announcement I/O happen in tick.
    pub fn open(a: A, s: *const settings.Settings, database: *rocks.Database, runtime: Runtime) !*Role {
        if (s.role != .validator) return error.ExpectedValidatorSettings;
        const role = s.role.validator;
        const chain = s.chainByName(role.origin_chain) orelse return error.UnknownOriginChain;
        if (chain.protocol != .ethereum) return error.ExpectedEthereumOrigin;
        if (role.lightweight and role.websocket_url == null) return error.LightweightRequiresWebsocket;
        if (runtime.native_transport != null and runtime.multi_library_path == null) return error.NativeVoteTransportRequired;
        if (runtime.native_transport == null and !runtime.allow_std_transport_for_tests) return error.NativeTransportRequired;
        for (role.rpcs) |endpoint| {
            if (endpoint.public and !role.allow_public_rpcs) return error.PublicRpcRequiresOptIn;
        }
        var actual_runtime = runtime;
        var owned_native: ?*Curl.Client = null;
        var primary_metrics: ?*RpcMetrics.Recorder = null;
        var quorum_metrics: ?*RpcMetrics.Recorder = null;
        errdefer {
            if (owned_native) |value| {
                value.deinit();
                a.destroy(value);
            }
            if (primary_metrics) |value| value.deinit();
            if (quorum_metrics) |value| value.deinit();
        }
        if (runtime.metrics) |registry| if (runtime.multi_library_path) |library| {
            primary_metrics = try RpcMetrics.Recorder.init(a, registry, .{ .chain = chain.name, .role = .primary, .operation = .contract_sync });
            quorum_metrics = try RpcMetrics.Recorder.init(a, registry, .{ .chain = chain.name, .role = if (role.checkpoint_consensus != null) .quorum else .primary, .operation = .validator_checkpoint });
            try primary_metrics.?.addEndpoints(chain.rpc_urls);
            try quorum_metrics.?.addEndpoints(chain.rpc_urls);
            owned_native = try a.create(Curl.Client);
            owned_native.?.* = Curl.Client.init(a, library) catch |err| {
                a.destroy(owned_native.?);
                owned_native = null;
                return err;
            };
            owned_native.?.observer = primary_metrics.?.nativeObserver();
            actual_runtime.native_transport = owned_native;
        };
        const config: indexing.Config = .{ .chain_id = try std.fmt.parseInt(u256, chain.chain_id, 10), .domain = chain.domain, .mailbox = try evmAddress(chain.contracts.mailbox), .hook = try evmAddress(chain.contracts.merkle_tree_hook), .paymaster = try evmAddress(chain.contracts.interchain_gas_paymaster), .reorg_period = period(chain.reorg) };
        const self = try a.create(Role);
        errdefer a.destroy(self);
        var slots: std.array_list.Managed(Slot) = .init(a);
        defer slots.deinit();
        errdefer {
            for (slots.items) |slot| {
                slot.client.deinit();
                a.destroy(slot.client);
            }
        }
        const consensus = role.checkpoint_consensus != null;
        if (consensus) {
            for (role.rpcs) |endpoint| try addSlot(a, &slots, endpoint.url, config, actual_runtime);
        } else {
            for (chain.rpc_urls) |url| try addSlot(a, &slots, url, config, actual_runtime);
        }
        if (slots.items.len == 0) return error.EmptyEndpointPool;
        if (slots.items.len > 256) return error.InvalidVotePool;
        for (slots.items) |slot| {
            if (primary_metrics) |value| try value.addEndpoints(&.{slot.client.url});
            if (quorum_metrics) |value| try value.addEndpoints(&.{slot.client.url});
        }
        const voting_slots = if (consensus) slots.items.len else 1;
        const state = try service.Service.open(a, database, .{ .domain_name = chain.name, .domain = chain.domain, .hook = chain.contracts.merkle_tree_hook, .signer_address = runtime.signer_address, .readiness = runtime.readiness, .halt_signal = runtime.halt_signal, .endpoint_count = voting_slots, .consensus = if (role.checkpoint_consensus) |c| switch (c) {
            .quorum => .quorum,
            .majority => .majority,
        } else null, .reorg_period = config.reorg_period });
        const owned = try slots.toOwnedSlice();
        self.* = .{ .allocator = a, .settings = s, .chain = chain, .runtime = actual_runtime, .rpc_native = owned_native, .primary_metrics = primary_metrics, .quorum_metrics = quorum_metrics, .slots = owned, .state = state, .store = native.Store.init(a, database, chain.name), .sequence_store = undefined, .canonical = .init(a), .consensus = consensus };
        self.sequence_store = .{ .store = &self.store, .stream = .insertion };
        if (runtime.metrics) |registry| self.index_metrics = .{ .registry = registry, .chain = chain.name };
        if (primary_metrics) |sink| sink.providerCreated(owned.len);
        return self;
    }
    fn addSlot(a: A, list: *std.array_list.Managed(Slot), url: []const u8, config: indexing.Config, runtime: Runtime) !void {
        const client = try a.create(rpc.RpcClient);
        errdefer a.destroy(client);
        client.* = try rpc.RpcClient.init(a, url, .{ .native_transport = runtime.native_transport, .cancel = runtime.cancel, .timeout_ms = runtime.rpc_timeout_ms, .connect_timeout_ms = runtime.connect_timeout_ms, .max_log_range = 2000 });
        errdefer client.deinit();
        for (list.items) |slot| {
            if (std.mem.eql(u8, slot.client.endpoint.identity, client.endpoint.identity)) {
                client.deinit();
                a.destroy(client);
                return;
            }
        }
        try list.append(.{ .client = client, .indexer = try indexing.Indexer.init(a, client, config) });
    }
    pub fn deinit(self: *Role) void {
        if (self.stream) |stream| stream.deinit();
        self.state.deinit();
        if (self.sequence_cursor) |*c| c.deinit();
        self.canonical.deinit();
        if (self.round_results) |results| self.allocator.free(results);
        for (self.slots) |slot| {
            slot.client.deinit();
            self.allocator.destroy(slot.client);
        }
        if (self.primary_metrics) |sink| sink.providerDropped(self.slots.len);
        self.allocator.free(self.slots);
        if (self.rpc_native) |value| {
            value.deinit();
            self.allocator.destroy(value);
        }
        if (self.primary_metrics) |value| value.deinit();
        if (self.quorum_metrics) |value| value.deinit();
        const a = self.allocator;
        self.* = undefined;
        a.destroy(self);
    }
    fn checked(self: *Role, index: usize) !*Slot {
        const slot = &self.slots[index];
        if (!slot.indexer.chain_checked) try slot.indexer.check();
        return slot;
    }
    fn primarySlot(self: *Role) !*Slot {
        if (self.round_results) |results| {
            const start = self.primary orelse 0;
            for (0..results.len) |offset| {
                const i = (start + offset) % results.len;
                if (results[i].ready) {
                    self.primary = i;
                    return &self.slots[i];
                }
            }
            return error.NoHealthyEvmEndpoint;
        }

        if (self.primary) |index| {
            if (self.checked(index)) |slot| return slot else |err| self.slots[index].last_error = err;
        }
        for (self.slots, 0..) |*slot, index| {
            self.primary = index;
            if (self.checked(index)) |ready| return ready else |err| slot.last_error = err;
        }
        self.primary = null;
        return error.NoHealthyEvmEndpoint;
    }
    fn startup(self: *Role, now_ms: u64) !bool {
        if (self.announcement_ready) return true;
        try self.state.checkBackendGuard(self.runtime.publisher);
        if (!self.announcement_written) {
            const value: objects.Announcement = .{ .validator = self.runtime.signer_address, .mailbox_address = self.chain.contracts.mailbox, .mailbox_domain = self.chain.domain, .storage_location = self.runtime.storage_location };
            const signature = try self.runtime.signer.digest(value.digest());
            const signed: objects.SignedAnnouncement = .{ .value = value, .signature = objects.Signature.fromBytes(signature) };
            if (!std.mem.eql(u8, &try signed.recover(), &self.runtime.signer_address)) return error.WrongSigner;
            const write = self.runtime.publisher.write_announcement orelse return error.MissingAnnouncementPublisher;
            try write(self.runtime.publisher.context, signed);
            self.signed_announcement = signed;
            self.announcement_written = true;
        }
        if (self.settings.role.validator.skip_announce) {
            self.announcement_ready = true;
            return true;
        }
        const slot = try self.primarySlot();
        var locations = try announce.fetch(slot.client, try evmAddress(self.chain.contracts.validator_announce), &.{self.runtime.signer_address}, .latest, .{});
        defer locations.deinit();
        for (locations.values[0]) |location| {
            if (std.mem.eql(u8, location, self.runtime.storage_location)) {
                self.announcement_ready = true;
                return true;
            }
        }
        if (now_ms >= self.next_announcement_ms) {
            const submitter = self.runtime.announcer orelse return error.MissingAnnouncementTransactionOwner;
            const signed = self.signed_announcement.?;
            const calldata = try announce.announceCalldata(self.allocator, self.runtime.signer_address, self.runtime.storage_location, signed.signature.bytes());
            defer self.allocator.free(calldata);
            try submitter.submit(submitter.context, signed.value.digest(), try evmAddress(self.chain.contracts.validator_announce), calldata);
            self.next_announcement_ms = now_ms +| 60000;
        }
        return false;
    }
    pub fn setCancellation(self: *Role, flag: ?*const std.atomic.Value(bool)) void {
        self.runtime.cancel = flag;
        for (self.slots) |slot| slot.client.options.cancel = flag;
    }
    pub fn tick(self: *Role, unix_timestamp: u64, now_ms: u64) !Tick {
        try self.cycle_clock.begin(now_ms);
        defer self.cycle_clock.end();
        self.index_due_ms = null;
        if (self.index_metrics) |*sink| sink.unix_seconds = unix_timestamp;
        var result = try self.tickInner(unix_timestamp, now_ms);
        if (self.index_due_ms) |due| result.next_delay_ms = due -| self.cycle_clock.now(now_ms);
        return result;
    }
    fn tickInner(self: *Role, unix_timestamp: u64, now_ms: u64) !Tick {
        if (self.settings.role.validator.websocket_url != null) return self.tickStream(unix_timestamp, now_ms);
        if (self.state.halted) {
            try self.state.publishReorg(self.runtime.publisher);
            return error.ValidatorHalted;
        }
        if (self.runtime.cancel) |flag| {
            if (flag.load(.acquire)) return error.Cancelled;
        }
        self.canonical.clearRetainingCapacity();
        for (self.slots) |*slot| slot.last_vote = null;
        try self.collectRound();
        if (!try self.startup(now_ms)) return .{ .announcement_pending = true };
        if (!try self.initializeInsertionCursor(now_ms)) return .{};
        const indexed = try self.indexOneRange(now_ms);
        var progress = driver.tick(&self.state, .{ .context = self, .finalized_height = finalizedHeight, .insertion = insertion, .checkpoint = checkpoint }, self.runtime.signer, self.runtime.publisher, unix_timestamp, .{ .publications = self.settings.role.validator.max_sign_concurrency }) catch |err| {
            if (self.state.halted) try self.state.publishReorg(self.runtime.publisher) else if (err == error.NonmonotonicHistory or err == error.UnverifiedSuffixChanged) _ = try self.auditSignedPrefix(unix_timestamp, now_ms, true);
            return err;
        };
        if (self.round_results) |results| {
            var unavailable: usize = 0;
            var available: usize = 0;
            for (results) |r| {
                if (!r.ready) unavailable += 1 else available += 1;
            }
            progress.unavailable_endpoints = if (self.consensus) unavailable else if (available > 0) 0 else 1;
        }
        if (try self.auditSignedPrefix(unix_timestamp, now_ms, false)) {
            progress.more_observations = true;
            progress.recovery_reset = true;
        }
        return .{ .indexed_range = indexed, .progress = progress };
    }
    fn tickStream(self: *Role, timestamp: u64, now_ms: u64) !Tick {
        if (self.state.halted) {
            if (self.stream) |stream| stream.stop();
            try self.state.publishReorg(self.runtime.publisher);
            return error.ValidatorHalted;
        }
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
        var frames: stream_binding.Progress = .{};
        var round_refreshed = false;
        if (self.stream) |stream| frames = try stream.drive(now_ms, self.runtime.cancel);
        if (self.stream_cadence.due(now_ms, if (self.stream) |stream| stream.fallback_active else true, try self.store.insertionByIndex(self.state.nextVerificationIndex()) != null, self.state.tree.count)) {
            var elapsed = try std.time.Timer.start();
            self.canonical.clearRetainingCapacity();
            for (self.slots) |*slot| slot.last_vote = null;
            // Socket wakes can replay leaves immediately, but never accelerate
            // checkpoint RPC attempts beyond the configured source interval.
            self.collectRound() catch |err| {
                self.stream_cadence.attemptedAt(now_ms +| elapsed.read() / std.time.ns_per_ms, self.settings.role.validator.interval *| 1000);
                return err;
            };
            self.stream_cadence.attemptedAt(now_ms +| elapsed.read() / std.time.ns_per_ms, self.settings.role.validator.interval *| 1000);
            round_refreshed = true;
        }
        if (!try self.startup(now_ms)) return .{ .announcement_pending = true };
        if (self.stream == null) {
            _ = self.state.bootstrap(self.runtime.publisher) catch |err| blk: {
                if (self.state.halted) return err;
                break :blk false;
            };
            if (!try self.stream_initialization.ready(self.cycle_clock.now(now_ms), self.runtime.critical)) {
                self.index_due_ms = self.stream_initialization.retry_at_ms;
                return .{};
            }
            self.stream = stream_binding.Bridge.open(self.allocator, &self.state, &self.store, .{ .context = self, .count_fn = streamCount, .checkpoint_fn = checkpoint, .height_fn = finalizedHeight }, .{ .url = self.settings.role.validator.websocket_url.?, .library_path = self.runtime.multi_library_path orelse return error.NativeVoteTransportRequired, .ca_info = self.runtime.websocket_ca_info, .lightweight = self.settings.role.validator.lightweight, .wake = self.runtime.stream_wake }) catch |err| {
                try self.stream_initialization.failed(err, self.cycle_clock.now(now_ms));
                self.index_due_ms = self.stream_initialization.retry_at_ms;
                return .{};
            };
            self.stream_initialization.succeeded(self.runtime.critical);
        }
        const stream = self.stream.?;
        try stream.probe(now_ms);
        if (stream.fallback_active and !try self.initializeInsertionCursor(now_ms)) return .{};
        const indexed = if (stream.fallback_active) try self.indexOneRange(now_ms) else false;
        if (indexed) try stream.refreshCursor(64);
        if (!stream.fallback_active and !round_refreshed and self.stream_cadence.verified() and try self.store.insertionByIndex(self.state.nextVerificationIndex()) == null and !try self.state.hasPendingPublication()) return .{ .indexed_range = frames.remaining };
        var progress = (if (stream.fallback_active)
            driver.tick(&self.state, .{ .context = self, .finalized_height = finalizedHeight, .insertion = insertion, .checkpoint = checkpoint }, self.runtime.signer, self.runtime.publisher, timestamp, .{ .publications = self.settings.role.validator.max_sign_concurrency })
        else
            stream.tickCheckpoints(self.runtime.signer, self.runtime.publisher, timestamp, self.settings.role.validator.max_sign_concurrency)) catch |err| {
            if (self.state.halted) try self.state.publishReorg(self.runtime.publisher) else if (!self.settings.role.validator.lightweight and (err == error.NonmonotonicHistory or err == error.UnverifiedSuffixChanged)) {
                _ = try self.auditSignedPrefix(timestamp, now_ms, true);
                try stream.forceFallback();
            }
            return err;
        };
        var empty_ready: usize = 0;
        if (self.round_results) |results| for (results) |result| {
            if (result.ready and result.count == 0) empty_ready += 1;
        };
        const required = if (self.state.options.consensus) |consensus| try consensus.required(self.state.options.endpoint_count) else 1;
        self.stream_cadence.processed(self.state.fresh_verified_through != null, progress.more_observations, self.state.tree.count == 0 and empty_ready >= required);
        if (!self.settings.role.validator.lightweight and try self.auditSignedPrefix(timestamp, now_ms, false)) {
            progress.more_observations = true;
            progress.recovery_reset = true;
            try stream.forceFallback();
        }
        return .{ .indexed_range = indexed or frames.insertions > 0 or frames.remaining or (progress.more_observations and try self.store.insertionByIndex(self.state.nextVerificationIndex()) != null) or progress.published == self.settings.role.validator.max_sign_concurrency, .progress = progress };
    }
    fn streamCount(context: *anyopaque) !u32 {
        const self: *Role = @ptrCast(@alignCast(context));
        const slot = try self.primarySlot();
        return (try slot.indexer.countTip(.insertion)).count orelse error.MissingEvmCount;
    }
    fn collectRound(self: *Role) !void {
        const library = self.runtime.multi_library_path orelse return;
        defer if (self.runtime.readiness) |status| {
            const healthy = if (self.round_results) |results| quorumReady(self, results) else false;
            if (healthy) status.ready("merkle_tree_hook.latest_checkpoint") else status.blocked("merkle_tree_hook.latest_checkpoint") catch |err| std.log.warn("validator readiness update failed: {s}", .{@errorName(err)});
        };
        if (self.round_results) |results| {
            self.allocator.free(results);
            self.round_results = null;
        }
        if (!self.consensus) return self.collectClassic(library);
        const endpoints = try self.allocator.alloc(votes.Endpoint, if (!self.consensus and self.chain.connection.ethereum.consensus == .single) 1 else self.slots.len);
        defer self.allocator.free(endpoints);
        for (endpoints, 0..) |*endpoint, i| endpoint.* = .{ .client = self.slots[i].client, .chain_checked = self.slots[i].indexer.chain_checked };
        const results = try votes.collect(self.allocator, endpoints, .{ .recorder = self.quorum_metrics, .library_path = library, .chain_id = self.slots[0].indexer.config.chain_id, .domain = self.chain.domain, .hook = self.slots[0].indexer.config.hook, .hook_hash = self.chain.contracts.merkle_tree_hook, .reorg_period = self.slots[0].indexer.config.reorg_period, .timeout_ms = self.runtime.rpc_timeout_ms, .connect_timeout_ms = self.runtime.connect_timeout_ms, .cancel = self.runtime.cancel }, self, quorumReady);
        self.round_results = results;
        for (results, 0..) |result, i| {
            self.slots[i].indexer.chain_checked = result.chain_checked;
            self.slots[i].last_vote = if (result.ready) result.checkpoint else null;
            self.slots[i].last_error = result.failure;
        }
        self.primary = null;
        for (0..results.len) |offset| {
            const i = (self.read_preferred + offset) % results.len;
            if (results[i].ready) {
                self.primary = i;
                break;
            }
        }
    }
    fn voteConfig(self: *Role, library: []const u8) votes.Config {
        return .{ .recorder = self.quorum_metrics, .library_path = library, .chain_id = self.slots[0].indexer.config.chain_id, .domain = self.chain.domain, .hook = self.slots[0].indexer.config.hook, .hook_hash = self.chain.contracts.merkle_tree_hook, .reorg_period = self.slots[0].indexer.config.reorg_period, .timeout_ms = self.runtime.rpc_timeout_ms, .connect_timeout_ms = self.runtime.connect_timeout_ms, .cancel = self.runtime.cancel };
    }
    fn identityReady(_: *anyopaque, results: []const votes.Result) bool {
        for (results) |result| if (result.identity_ready) return true;
        return false;
    }
    fn collectClassic(self: *Role, library: []const u8) !void {
        const single = self.chain.connection.ethereum.consensus == .single;
        const length = if (single) @as(usize, 1) else self.slots.len;
        const results = try self.allocator.alloc(votes.Result, self.slots.len);
        errdefer self.allocator.free(results);
        @memset(results, .{});
        var start = if (single) @as(usize, 0) else self.primary orelse self.read_preferred;
        var known_identity = false;
        for (self.slots[0..length]) |slot| known_identity = known_identity or slot.indexer.chain_checked;
        if (!known_identity) {
            // Startup readiness may race only identity probes. Checkpoint data
            // retains source fallback priority; no competing eth_call result can
            // mask the selected endpoint's semantics.
            const endpoints = try self.allocator.alloc(votes.Endpoint, length);
            defer self.allocator.free(endpoints);
            for (endpoints, 0..) |*endpoint, i| endpoint.* = .{ .client = self.slots[i].client, .chain_checked = false };
            var config = self.voteConfig(library);
            config.identity_only = true;
            const identities = try votes.collect(self.allocator, endpoints, config, self, identityReady);
            defer self.allocator.free(identities);
            var selected: ?usize = null;
            for (0..length) |offset| {
                const index = (start + offset) % length;
                self.slots[index].indexer.chain_checked = identities[index].chain_checked;
                self.slots[index].last_error = identities[index].failure;
                if (selected == null and identities[index].identity_ready) selected = index;
            }
            start = selected orelse {
                self.primary = null;
                self.round_results = results;
                return;
            };
        }
        for (0..length) |offset| {
            const index = (start + offset) % length;
            const slot = &self.slots[index];
            const endpoints = [_]votes.Endpoint{.{ .client = slot.client, .chain_checked = slot.indexer.chain_checked }};
            const observed = try votes.collect(self.allocator, &endpoints, self.voteConfig(library), self, quorumReady);
            defer self.allocator.free(observed);
            results[index] = observed[0];
            slot.indexer.chain_checked = observed[0].chain_checked;
            slot.last_error = observed[0].failure;
            slot.last_vote = if (observed[0].ready) observed[0].checkpoint else null;
            if (observed[0].ready) {
                self.primary = index;
                self.read_preferred = index;
                self.round_results = results;
                return;
            }
            // A failed data read, not elapsed hedge time or a competing answer,
            // permits rotating the priority for this normal single-vote mode.
            self.primary = null;
            self.read_preferred = (index + 1) % length;
        }
        self.primary = null;
        self.round_results = results;
    }
    fn quorumReady(ctx: *anyopaque, results: []const votes.Result) bool {
        const self: *Role = @ptrCast(@alignCast(ctx));
        // Classic fallback authenticates a single live endpoint. It has no
        // required-th quorum index, so unfinished fallback slots cannot improve
        // its quorum and must not delay an already complete valid response.
        if (!self.consensus) {
            for (results) |result| if (result.ready) return true;
            return false;
        }
        const required = if (self.state.options.consensus) |c| c.required(self.state.options.endpoint_count) catch return false else 1;
        var empty: usize = 0;
        var candidate: ?u32 = null;
        for (results) |result| {
            if (!result.ready) continue;
            if (result.count == 0) {
                empty += 1;
                continue;
            }
            const c = result.checkpoint orelse continue;
            var agreeing: usize = 0;
            var matching_at_or_after: usize = 0;
            for (results) |other| {
                if (!other.ready) continue;
                if (other.checkpoint) |v| {
                    if (v.index == c.index and std.mem.eql(u8, &v.root, &c.root)) agreeing += 1;
                    if (v.index >= c.index) {
                        const local = self.state.checkpoint(v.index) catch continue;
                        if (std.mem.eql(u8, &local.root, &v.root)) matching_at_or_after += 1;
                    }
                }
            }
            if (agreeing >= required or matching_at_or_after >= required) candidate = @max(candidate orelse 0, c.index);
        }
        if (candidate == null and empty < required) return false;
        // Cancel outstanding slots only when they cannot advance the required-th
        // matching checkpoint. A fast stale quorum must not hide a higher live
        // quorum; a single stalled slot cannot delay an already maximal quorum.
        return !canAdvance(results, required, candidate);
    }
    fn canAdvance(results: []const votes.Result, required: usize, candidate: ?u32) bool {
        var possible_higher: usize = 0;
        for (results) |result| {
            if (!result.ready) {
                if (result.failure == null) possible_higher += 1;
            } else if (result.checkpoint) |c| {
                if (candidate == null or c.index > candidate.?) possible_higher += 1;
            }
        }
        return possible_higher >= required;
    }
    fn indexObserver(self: *Role) ?fetch_observation.Observer {
        return if (self.index_metrics) |*sink| sink.interface() else null;
    }
    fn physicalFailure(self: *Role, client: *rpc.RpcClient, err: anyerror) anyerror {
        if (err != error.RequestDeadlineExceeded) return err;
        if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return err;
        // These clients have no cooperative read journal/override. Code28 from
        // native curl is a completed per-request timeout, not an owner deadline.
        if (client.options.exchange == null) if (client.options.native_transport) |transport| if (transport.send_override == null) return error.ConnectionTimedOut;
        return err;
    }
    fn indexedOptions(self: *Role, client: *rpc.RpcClient) void {
        client.options.indexer_tip_cache = self.runtime.dynamic_tip_cache != null;
        client.options.dynamic_tip_cache = self.runtime.dynamic_tip_cache;
        client.options.native_cache_observer = if (self.primary_metrics) |sink| sink.nativeCacheObserver() else null;
    }
    fn indexedCountTip(self: *Role, index: usize) !indexing.CountTip {
        const slot = &self.slots[index];
        const saved = slot.client.options;
        defer slot.client.options = saved;
        self.indexedOptions(slot.client);
        return slot.indexer.countTip(.insertion);
    }
    fn initializeInsertionCursor(self: *Role, now_ms: u64) !bool {
        if (self.cursor_initialization.initialized) return true;
        if (!try self.cursor_initialization.ready(self.cycle_clock.now(now_ms), self.runtime.critical)) {
            self.index_due_ms = self.cursor_initialization.retry_at_ms;
            return false;
        }
        self.constructInsertionCursor() catch |err| {
            try self.cursor_initialization.failed(err, self.cycle_clock.now(now_ms));
            self.index_due_ms = self.cursor_initialization.retry_at_ms;
            return false;
        };
        self.cursor_initialization.succeeded(self.runtime.critical);
        return true;
    }
    fn constructInsertionCursor(self: *Role) !void {
        var failure: anyerror = error.NoHealthyEvmEndpoint;
        for (0..self.slots.len) |offset| {
            if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            const index = (self.read_preferred + offset) % self.slots.len;
            // The same round already started every identity slot concurrently.
            // A stalled/unverified slot must not reintroduce serial20s startup
            // head-of-line blocking before an authenticated healthy quorum.
            if (self.round_results) |results| if (!results[index].ready) continue;
            _ = self.checked(index) catch |err| {
                const actual = self.physicalFailure(self.slots[index].client, err);
                if (!fetch_observation.retryable(actual)) return err;
                failure = actual;
                continue;
            };
            const tip = self.indexedCountTip(index) catch |err| {
                const actual = self.physicalFailure(self.slots[index].client, err);
                if (!fetch_observation.retryable(actual)) return err;
                failure = actual;
                continue;
            };
            const count = tip.count orelse return error.MissingEvmCount;
            // Native progress is lazy per missing sequence; validate the first
            // persisted backward target at initialization, not at metric render.
            if (count > 0) _ = try self.store.backwardProgress(.insertion, count - 1);
            self.sequence_cursor = try cursor.Cursor.init(self.allocator, count, tip.tip, .{ .chunk = @min(self.chain.index.chunk, 1999), .lowest = self.chain.index.from, .mode = .block, .idle_ms = try std.math.mul(u64, self.chain.index.interval, 1000) });
            self.read_preferred = index;
            return;
        }
        return failure;
    }
    fn indexOneRange(self: *Role, now_ms: u64) !bool {
        var selected: ?usize = null;
        var tip: indexing.CountTip = undefined;
        if (self.round_results) |results| {
            const primary = try self.primarySlot();
            const index = self.primary.?;
            const result = results[index];
            tip = .{ .count = result.count, .tip = std.math.cast(u32, result.head.?.number) orelse return error.IndexHeightOutOfRange, .block_hash = result.head.?.hash };
            selected = index;
            _ = primary;
        } else {
            for (self.slots, 0..) |*slot, index| {
                _ = self.checked(index) catch |err| {
                    slot.last_error = err;
                    continue;
                };
                tip = self.indexedCountTip(index) catch |err| {
                    slot.last_error = err;
                    continue;
                };
                selected = index;
                break;
            }
        }
        const index = selected orelse return error.NoHealthyEvmEndpoint;
        self.primary = index;
        const count = tip.count orelse return error.MissingEvmCount;
        if (self.sequence_cursor == null) self.sequence_cursor = try cursor.Cursor.init(self.allocator, count, tip.tip, .{ .chunk = @min(self.chain.index.chunk, 1999), .lowest = self.chain.index.from, .mode = .block, .idle_ms = try std.math.mul(u64, self.chain.index.interval, 1000) });
        const c = &self.sequence_cursor.?;
        const observed_now = self.cycle_clock.now(now_ms);
        fetch_observation.completed(self.indexObserver(), .insertion, c, null, count, observed_now);
        const action = try c.plan(count, tip.tip, observed_now, self.sequence_store.interface());
        if (action != .query) {
            self.index_due_ms = switch (action) {
                .sleep_until_ms => |due| due,
                .yield => observed_now,
                .query => unreachable,
            };
            return false;
        }
        const query = action.query;
        if (self.fetch_retry.remainingDelay(query.range, observed_now)) |remaining| {
            try c.failed(query.token);
            self.index_due_ms = observed_now +| @min(remaining, 5000);
            return false;
        }
        if (self.fetch_retry.retryEligible(query.range, observed_now)) if (self.indexObserver()) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = .insertion, .delay_ms = 0 } });
        var batch = self.fetchInsertionRange(index, query.range, tip.tip) catch |err| {
            try c.failed(query.token);
            if (!fetch_observation.retryable(err)) return err;
            const completed_now = self.cycle_clock.now(observed_now);
            const delay = self.fetch_retry.recordFailure(query.range, completed_now);
            if (self.indexObserver()) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = .insertion, .delay_ms = delay, .retry = true } });
            self.index_due_ms = completed_now +| @min(delay, 5000);
            self.rotateReader();
            std.log.warn("validator insertion range fetch failed; retry in {d}ms: {s}", .{ delay, @errorName(err) });
            return false;
        };
        if (self.fetch_retry.recordSuccess(query.range)) if (self.indexObserver()) |sink| sink.notify(.{ .fetch_backoff = .{ .stream = .insertion, .delay_ms = 0 } });
        defer batch.deinit();
        const positions = batch.storeObserved(&self.store, self.indexObserver()) catch |err| {
            try c.failed(query.token);
            return err;
        };
        defer self.allocator.free(positions);
        errdefer c.failed(query.token) catch {};
        // Indexer.fetch validated address/topic/ABI, canonical block membership
        // and the range's final hash fence. Reuse only this tick's fully stored
        // observations; another round clears the map before any new RPC vote.
        for (batch.logs) |log| {
            const event = try log.event();
            if (event != .insertion) return error.UnexpectedStreamEvent;
            if (log.block_number > tip.tip) return error.UnfinalizedObservation;
            if (self.canonical.count() < 4096) try self.canonical.put(event.insertion.index, .{ .message_id = event.insertion.message_id, .block_height = log.block_number, .block_hash = log.block_hash });
        }
        try c.update(query.token, positions, self.cycle_clock.now(observed_now), self.sequence_store.interface());
        try self.store.storeCursor(.insertion, batch.through.number);
        fetch_observation.completed(self.indexObserver(), .insertion, c, null, count, self.cycle_clock.now(observed_now));
        return true;
    }
    /// One logical range failure is recorded only after ordinary errors from
    /// every eligible event reader. Checkpoint voting stays per endpoint.
    fn fetchInsertionRange(self: *Role, preferred: usize, range: cursor.Range, finalized_height: u64) !indexing.Batch {
        var failure: anyerror = error.NoHealthyEvmEndpoint;
        for (0..self.slots.len) |offset| {
            if (self.runtime.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
            const index = (preferred + offset) % self.slots.len;
            if (self.round_results) |results| {
                if (!results[index].ready or results[index].head.?.number < range.to) continue;
            }
            const slot = self.checked(index) catch |err| {
                const actual = self.physicalFailure(self.slots[index].client, err);
                if (!fetch_observation.retryable(actual)) return err;
                self.slots[index].last_error = actual;
                failure = actual;
                continue;
            };
            const saved = slot.client.options;
            defer slot.client.options = saved;
            self.indexedOptions(slot.client);
            const batch = slot.indexer.fetch(.insertion, range, finalized_height) catch |err| {
                const actual = self.physicalFailure(slot.client, err);
                if (!fetch_observation.retryable(actual)) return err;
                slot.last_error = actual;
                failure = actual;
                continue;
            };
            self.primary = index;
            self.read_preferred = index;
            return batch;
        }
        return failure;
    }
    fn auditSignedPrefix(self: *Role, timestamp: u64, now_ms: u64, force: bool) !bool {
        const required = if (self.state.options.consensus) |c| try c.required(self.state.options.endpoint_count) else 1;
        var disagreement = false;
        for (self.slots) |slot| {
            const vote_value = slot.last_vote orelse continue;
            if (vote_value.index >= self.state.tree.count) continue;
            const record = self.state.checkpoint(vote_value.index) catch continue;
            if (std.mem.eql(u8, &record.root, &vote_value.root)) continue;
            var agreeing: usize = 0;
            for (self.slots) |other| {
                if (other.last_vote) |v| {
                    if (v.index == vote_value.index and std.mem.eql(u8, &v.root, &vote_value.root)) agreeing += 1;
                }
            }
            if (agreeing >= required) disagreement = true;
        }
        if (!force and !disagreement and now_ms < self.next_audit_ms) return false;
        const index = self.state.verified_through orelse self.state.signed_watermark orelse {
            if (force or disagreement) {
                const reset = try self.state.resetUnverifiedSuffix();
                if (reset) self.rotateReader();
                return reset;
            }
            return false;
        };
        const local = try self.state.checkpoint(index);
        const roots = try self.allocator.alloc(?[32]u8, self.slots.len);
        defer self.allocator.free(roots);
        @memset(roots, null);
        for (self.slots, 0..) |*slot, i| {
            if (slot.last_vote == null) continue;
            roots[i] = @import("prefix.zig").at(&slot.indexer, index) catch |err| {
                slot.last_error = err;
                continue;
            };
        }
        for (roots) |candidate| {
            const root = candidate orelse continue;
            if (std.mem.eql(u8, &root, &local.root)) continue;
            var agreeing: usize = 0;
            for (roots) |other| {
                if (other) |r| {
                    if (std.mem.eql(u8, &root, &r)) agreeing += 1;
                }
            }
            if (agreeing >= required) {
                self.state.verifyCommitted(index, root, timestamp) catch |err| {
                    if (self.state.halted) try self.state.publishReorg(self.runtime.publisher);
                    return err;
                };
            }
        }
        var matching: usize = 0;
        for (roots) |candidate| {
            if (candidate) |root| {
                if (std.mem.eql(u8, &root, &local.root)) matching += 1;
            }
        }
        self.next_audit_ms = now_ms +| 60000;
        if (matching >= required and (force or disagreement)) {
            const reset = try self.state.resetUnverifiedSuffix();
            if (reset) self.rotateReader();
            return reset;
        }
        return false;
    }
    fn rotateReader(self: *Role) void {
        self.read_preferred = ((self.primary orelse self.read_preferred) + 1) % self.slots.len;
        self.primary = null;
        self.canonical.clearRetainingCapacity();
    }
    fn finalizedHeight(ctx: *anyopaque, _: objects.ReorgPeriod) !u64 {
        const self: *Role = @ptrCast(@alignCast(ctx));
        const slot = try self.primarySlot();
        if (self.round_results) |results| return results[self.primary.?].head.?.number;
        return (try slot.indexer.finalized()).number;
    }
    fn insertion(ctx: *anyopaque, index: u32, finalized_height: u64) !?service.Observation {
        const self: *Role = @ptrCast(@alignCast(ctx));
        if (self.canonical.get(index)) |known| return known;
        if (try self.store.insertionByIndex(index) == null) return null;
        if (self.stream) |stream| if (stream.fallback_active) return self.streamRecoveryInsertion(index, finalized_height);
        const block = try self.store.logBlock(.insertion, index) orelse return null;
        if (block > finalized_height) return null;
        const height = std.math.cast(u32, block) orelse return error.IndexHeightOutOfRange;
        const slot = try self.primarySlot();
        var batch = slot.indexer.fetch(.insertion, .{ .from = height, .to = height }, finalized_height) catch |err| {
            self.rotateReader();
            return err;
        };
        defer batch.deinit();
        const positions = try batch.store(&self.store);
        defer self.allocator.free(positions);
        var wanted: ?service.Observation = null;
        for (batch.logs) |log| {
            const event = try log.event();
            if (event != .insertion) return error.UnexpectedStreamEvent;
            const value: service.Observation = .{ .message_id = event.insertion.message_id, .block_height = log.block_number, .block_hash = log.block_hash };
            if (event.insertion.index == index) wanted = value;
            if (self.canonical.count() < 4096) try self.canonical.put(event.insertion.index, value);
        }
        return wanted;
    }
    fn streamRecoveryInsertion(self: *Role, index: u32, finalized_height: u64) !?service.Observation {
        const slot = try self.primarySlot();
        const head = try slot.client.blockHeader(.{ .number = finalized_height });
        const block = try @import("prefix.zig").insertionBlock(&slot.indexer, index, head);
        var batch = try slot.indexer.fetch(.insertion, .{ .from = block, .to = block }, finalized_height);
        defer batch.deinit();
        const positions = try batch.store(&self.store);
        defer self.allocator.free(positions);
        var wanted: ?service.Observation = null;
        for (batch.logs) |log| {
            const event = try log.event();
            if (event != .insertion) return error.UnexpectedStreamEvent;
            const observation: service.Observation = .{ .message_id = event.insertion.message_id, .block_height = log.block_number, .block_hash = log.block_hash };
            if (event.insertion.index == index) wanted = observation;
            if (self.canonical.count() < 4096) try self.canonical.put(event.insertion.index, observation);
        }
        return wanted;
    }
    fn checkpoint(ctx: *anyopaque, slot_index: usize, _: objects.ReorgPeriod) !?service.Checkpoint {
        const self: *Role = @ptrCast(@alignCast(ctx));
        if (self.round_results) |results| {
            if (self.consensus) {
                if (slot_index >= results.len) return error.EndpointPoolChanged;
                return if (results[slot_index].ready) results[slot_index].checkpoint else null;
            }
            if (slot_index != 0) return error.EndpointPoolChanged;
            for (results) |result| {
                if (result.ready) return result.checkpoint;
            }
            return null;
        }
        if (self.consensus) return self.vote(slot_index);
        if (slot_index != 0) return error.EndpointPoolChanged;
        const single = self.chain.connection.ethereum.consensus == .single;
        for (0..if (single) @as(usize, 1) else self.slots.len) |i| {
            const value = self.vote(i) catch |err| {
                self.slots[i].last_error = err;
                continue;
            };
            return value;
        }
        return error.NoHealthyEvmEndpoint;
    }
    fn vote(self: *Role, index: usize) !?service.Checkpoint {
        const slot = try self.checked(index);
        const tip = try slot.indexer.countTip(.insertion);
        const count = tip.count orelse return error.MissingEvmCount;
        if (count == 0) return null;
        const c = try slot.client.latestCheckpoint(slot.indexer.config.hook, .{ .number = tip.tip });
        if (@as(u64, c.index) + 1 != count) return error.CheckpointCountMismatch;
        if (!std.mem.eql(u8, &(try slot.client.blockHeader(.{ .number = tip.tip })).hash, &tip.block_hash)) return error.IndexingReorg;
        const value: service.Checkpoint = .{ .mailbox_domain = self.chain.domain, .merkle_tree_hook_address = self.chain.contracts.merkle_tree_hook, .root = c.root, .index = c.index, .message_id = @splat(0) };
        slot.last_vote = value;
        slot.last_error = null;
        return value;
    }
};

/// Called only by the native RocksDB regression aggregate.
pub const NativeTests = if (@import("builtin").is_test) struct {
    pub fn fetchBackoff() !void {
        try @import("fetch_backoff_test.zig").evm(Role, Role.indexOneRange, Role.initializeInsertionCursor);
    }
    pub fn fetchBackoffResponseVariants(comptime use_native: bool) !void {
        try @import("fetch_backoff_test.zig").evmResponseVariants(Role, Role.indexOneRange, Role.initializeInsertionCursor, use_native);
    }
    pub fn fetchBackoffHeaderVariants(comptime use_native: bool) !void {
        try @import("fetch_backoff_test.zig").evmHeaderVariants(Role, Role.indexOneRange, Role.initializeInsertionCursor, use_native);
    }
} else struct {};
fn evmAddress(hash: [32]u8) !abi.Address {
    if (!std.mem.allEqual(u8, hash[0..12], 0)) return error.NonEvmContractAddress;
    return hash[12..32].*;
}
fn period(value: @import("../../settings/types.zig").Reorg) objects.ReorgPeriod {
    return switch (value) {
        .blocks => |n| if (n == 0) .none else .{ .blocks = n },
        .tag => |t| .{ .tag = t },
    };
}

test "vote early completion preserves higher mixed-height quorum and tolerates stalled minority" {
    const c: service.Checkpoint = .{ .mailbox_domain = 1, .merkle_tree_hook_address = @splat(0), .root = @splat(1), .index = 9, .message_id = @splat(0) };
    const old: votes.Result = .{ .ready = true, .checkpoint = c };
    var higher = old;
    higher.checkpoint.?.index = 10;
    const pending: votes.Result = .{};
    const failed: votes.Result = .{ .failure = error.RequestDeadlineExceeded };
    try std.testing.expect(!Role.canAdvance(&.{ old, old, pending }, 2, 9));
    try std.testing.expect(Role.canAdvance(&.{ old, higher, pending }, 2, 9));
    try std.testing.expect(!Role.canAdvance(&.{ old, higher, failed }, 2, 9));
    try std.testing.expect(Role.canAdvance(&.{ old, pending, pending }, 2, null));
    try std.testing.expect(!Role.canAdvance(&.{ old, failed, failed }, 2, null));
}

test "classic fallback does not wait for a stalled redundant slot" {
    var role: Role = undefined;
    role.consensus = false;
    const ready: votes.Result = .{ .ready = true, .count = 0 };
    try std.testing.expect(Role.quorumReady(&role, &.{ .{}, ready }));
    try std.testing.expect(!Role.quorumReady(&role, &.{ .{}, .{ .failure = error.WrongChain } }));
}
