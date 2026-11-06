//! Operational origin lanes. Each lane exclusively owns its mutable network
//! clients; destination workers borrow only the locked canonical store/history.
const std = @import("std");
const settings = @import("../settings/types.zig");
const resources = @import("chain_source.zig");
const native = @import("store.zig");
const history = @import("origin.zig");
const ethereum = @import("evm_origin.zig");
const generic = @import("indexing/service.zig");
const rocks = @import("../db/rocks.zig");
const remote = @import("../relayer/remote_checkpoints.zig");
const supervisor = @import("../runtime/supervisor.zig");
const announcements = @import("announcement_source.zig");
const readers = @import("../relayer/announced_readers.zig");
const loader = @import("loader.zig");
const A = std.mem.Allocator;
const indexing_metrics = @import("../ops/indexing_metrics.zig");
const initialization = @import("../ops/init_metrics.zig");
const critical_metrics = @import("../ops/critical_metrics.zig");
const authority = @import("../runtime/authority_gate.zig");
const tx_queue = @import("indexing/tx_id_queue.zig");
const tx_companion = @import("indexing/tx_id_companion.zig");

pub const DatabaseOwner = struct {
    allocator: A,
    path: []const u8,
    value: ?rocks.Database = null,
    mutex: std.Thread.Mutex = .{},
    pub fn init(a: A, path: []const u8) !*DatabaseOwner {
        const self = try a.create(DatabaseOwner);
        errdefer a.destroy(self);
        self.* = .{ .allocator = a, .path = try a.dupe(u8, path) };
        return self;
    }
    pub fn get(self: *DatabaseOwner, cancel: *const std.atomic.Value(bool)) !*rocks.Database {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        self.mutex.lock();
        defer self.mutex.unlock();
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.value == null) self.value = try rocks.Database.open(self.allocator, self.path, .{ .sync = true });
        return &self.value.?;
    }
    /// Destroy only after all source, destination and API jobs have joined.
    pub fn deinit(self: *DatabaseOwner) void {
        if (self.value) |*value| value.deinit();
        self.allocator.free(self.path);
        self.allocator.destroy(self);
    }
};
pub const Handle = struct { chain: *const settings.Chain, store: *native.Store, history: *history.Origin };
pub const Options = struct { source: resources.Options, tx_id_indexing_enabled: bool = true, gas_enabled: bool = true, job_timeout_ms: u64 = 120000, allow_local_checkpoints: bool = false, cache_announcements: bool = true };
const Implementation = union(enum) { none, ethereum: *ethereum.Service, generic: *generic.Service };
pub const Slot = struct {
    allocator: A,
    chain: *const settings.Chain,
    environment: *const std.process.EnvMap,
    database: *DatabaseOwner,
    checkpoints: *remote.Engine,
    options: Options,
    network: ?*resources.Resources = null,
    discovery_network: ?*resources.Resources = null,
    discovery_factory: ?announcements.Factory = null,
    discovery: ?readers.Registry = null,
    implementation: Implementation = .none,
    destinations: []const u32,
    migration: ?loader.Loader = null,
    metrics: ?indexing_metrics.Adapter = null,
    initialization_metrics: ?initialization.Adapter = null,
    announcement_init_timer: ?std.time.Timer = null,
    gas_enforcer_observed: std.atomic.Value(bool) = .init(false),
    /// Role-owned shared chain tracker, also used by destination/health owners.
    critical: ?*critical_metrics.Tracker = null,
    initialization_failures: u8 = 0,
    ready: std.atomic.Value(bool) = .init(false),
    authority: authority.Gate = .{},
    transaction_queue: ?tx_queue.Queue = null,
    transaction_companion: ?tx_companion.Companion = null,
    transaction_network: ?*resources.Resources = null,

    /// Acquisition never waits behind native I/O during lazy initialization.
    /// Published pointers remain stable until owner shutdown after every join.
    pub fn handle(self: *Slot) ?Handle {
        if (!self.ready.load(.acquire)) return null;
        return switch (self.implementation) {
            .none => unreachable,
            .ethereum => |value| .{ .chain = self.chain, .store = &value.store, .history = &value.history },
            .generic => |value| .{ .chain = self.chain, .store = &value.store, .history = &value.history },
        };
    }
    /// Native policies are owned by each destination/origin lane. Keep the
    /// Source per-origin gauge bounded to the first actual successful policy
    /// construction, rather than overwriting it as other destinations start.
    pub fn observeGasEnforcer(self: *Slot, elapsed_ns: u64) void {
        const adapter = if (self.initialization_metrics) |*value| value else return;
        if (self.gas_enforcer_observed.swap(true, .acq_rel)) return;
        adapter.observer().completed(.gas_payment_enforcer, elapsed_ns);
    }
    fn ensure(self: *Slot, cancel: *const std.atomic.Value(bool)) !void {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        errdefer |err| if (err != error.PendingReadIo and err != error.PendingIo) {
            self.announcement_init_timer = null;
        };
        if (self.network == null) {
            var options = self.options.source;
            options.cooperative_reads = true;
            options.operation = .contract_sync;
            options.rpc_role = if (self.chain.connection == .ethereum and self.chain.connection.ethereum.consensus == .quorum) .quorum else .primary;
            self.network = try resources.Resources.open(self.allocator, self.chain, self.environment, options);
        }
        const network = self.network.?;
        network.setCancellation(cancel);
        try network.beginReadPass(cancel);
        const database = try self.database.get(cancel);
        if (self.implementation == .none) {
            if (self.chain.protocol == .ethereum) {
                const client = if (network.rpc_client) |*value| value else return error.MissingEvmSourceClient;
                const value = try ethereum.Service.open(self.allocator, self.chain, client, database, self.checkpoints, self.options.gas_enabled);
                errdefer value.deinit();
                try value.indexer.check();
                try client.commitReadSection();
                if (self.metrics) |*adapter| value.observer = adapter.interface();
                if (self.initialization_metrics) |*adapter| value.observeInitialization(adapter.observer());
                self.implementation = .{ .ethereum = value };
            } else {
                const value = try generic.Service.open(self.allocator, self.chain, try network.source(), database, self.checkpoints, self.options.gas_enabled);
                if (self.initialization_metrics) |*adapter| value.observeInitialization(adapter.observer());
                self.implementation = .{ .generic = value };
            }
        }
        switch (self.implementation) {
            .ethereum => |value| value.critical = self.critical,
            .generic => |value| value.indexer.critical = self.critical,
            .none => unreachable,
        }
        if (self.options.tx_id_indexing_enabled and transactionSupported(self.chain.protocol)) {
            if (self.transaction_queue == null) {
                self.transaction_queue = try tx_queue.Queue.init(self.allocator, 1024, .{ .tree = true, .gas = self.options.gas_enabled });
                self.transaction_queue.?.wake = &self.authority.wake;
            }
            const store = switch (self.implementation) {
                .ethereum => |value| &value.store,
                .generic => |value| &value.store,
                .none => unreachable,
            };
            if (self.transaction_companion == null) self.transaction_companion = .{
                .allocator = self.allocator,
                .store = store,
                .queue = &self.transaction_queue.?,
                .domain = self.chain.domain,
                .contracts = .{ .mailbox = self.chain.contracts.mailbox, .hook = self.chain.contracts.merkle_tree_hook, .paymaster = self.chain.contracts.interchain_gas_paymaster },
            };
            store.dispatch_notifications = self.transaction_queue.?.observer();
            if (self.metrics) |*adapter| self.transaction_companion.?.observer = adapter.interface();
            if (self.implementation == .generic) self.implementation.generic.indexer.options.transaction_notifications = true;
        }
        if (self.metrics) |*adapter| switch (self.implementation) {
            .generic => |value| {
                value.indexer.observer = adapter.interface();
                value.history.observer = adapter.interface();
            },
            .ethereum => |value| value.history.observer = adapter.interface(),
            .none => unreachable,
        };
        if (!self.ready.load(.acquire)) {
            if (self.discovery == null and self.announcement_init_timer == null and self.initialization_metrics != null) self.announcement_init_timer = std.time.Timer.start() catch null;
            if (self.discovery_network == null) {
                var options = self.options.source;
                options.cooperative_reads = true;
                options.operation = .relayer_metadata;
                options.rpc_role = if (self.chain.connection == .ethereum and self.chain.connection.ethereum.consensus == .quorum) .quorum else .primary;
                self.discovery_network = try resources.Resources.open(self.allocator, self.chain, self.environment, options);
            }
            if (self.discovery_factory == null) self.discovery_factory = announcements.Factory.init(self.discovery_network.?);
            if (self.discovery == null) {
                self.discovery = try readers.Registry.initSource(self.allocator, self.discovery_factory.?.interface(), &self.discovery_network.?.native, self.checkpoints, .{ .domain = self.chain.domain, .allow_local = self.options.allow_local_checkpoints, .ignore_reorg_reports = self.chain.ignore_reorg_reports, .cache_ttl_ms = if (self.options.cache_announcements) 120000 else 0 });
                if (self.initialization_metrics) |*adapter| if (self.announcement_init_timer) |*timer| adapter.observer().completed(.validator_announce, timer.read());
                self.announcement_init_timer = null;
            }
            switch (self.implementation) {
                .none => unreachable,
                .ethereum => |value| value.history.discovery = self.discovery.?.interface(),
                .generic => |value| value.history.discovery = self.discovery.?.interface(),
            }
            if (self.migration == null) {
                const store = switch (self.implementation) {
                    .none => unreachable,
                    .ethereum => |value| &value.store,
                    .generic => |value| &value.store,
                };
                self.migration = try loader.Loader.init(self.allocator, store, self.destinations, .{});
            }
            self.ready.store(true, .release);
            self.initialization_failures = 0;
            if (self.critical) |tracker| tracker.clear(.origin);
        }
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Slot = @ptrCast(@alignCast(context));
        self.authority.wake.store(false, .release);
        if (self.metrics) |*adapter| adapter.unix_seconds = times.unix_ms / 1000;
        var failure: ?anyerror = null;
        defer if (self.network) |network| {
            network.endReadPass(failure);
            network.setCancellation(null);
        };
        return self.cycle(times, cancel) catch |err| {
            failure = err;
            if (err != error.PendingReadIo and err != error.PendingIo and err != error.RequestCancelled and err != error.OutOfMemory and err != error.RequestDeadlineExceeded and err != error.ReadReplayDeadline) {
                if (!self.ready.load(.acquire)) {
                    self.initialization_failures +|= 1;
                    if (self.initialization_failures >= 5) if (self.critical) |tracker| tracker.record(.origin);
                } else if (classify(err) == .halt_all) {
                    if (self.critical) |tracker| tracker.record(.merkle_tree_db_loader);
                }
            }
            return err;
        };
    }
    fn cycle(self: *Slot, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        try self.ensure(cancel);
        if (self.discovery) |*registry| try registry.maintain(cancel);
        const command = self.authority.snapshot();
        const enabled = command.requested.enabled();
        const aborted = switch (self.implementation) {
            .none => unreachable,
            .ethereum => |value| value.setStreamMask(enabled),
            .generic => |value| value.indexer.setStreamMask(enabled),
        };
        if (aborted) {
            self.network.?.endReadPass(error.RequestCancelled);
            try self.network.?.beginReadPass(cancel);
        }
        if (self.transaction_companion) |*companion| if (companion.setMask(.{ .tree = enabled[1], .gas = enabled[2] and self.options.gas_enabled }, times.monotonic_ms)) {
            if (self.transaction_network) |network| network.endReadPass(error.RequestCancelled);
        };
        _ = self.authority.acknowledge(command.generation, command.requested);
        // Drain/rotate receipt work BEFORE a retained producer retries a full
        // notification queue. Separate borrowed journals preserve healthy range
        // progress while an individual receipt read suspends.
        const companion_report = try self.runCompanion(times.monotonic_ms, cancel);
        var report = switch (self.implementation) {
            .none => unreachable,
            .ethereum => |value| result: {
                if (!value.hasEnabledStreams()) {
                    const leaves = try value.history.sync(64);
                    break :result supervisor.Report{ .work = leaves, .next_delay_ms = if (leaves == 64) 0 else 100 };
                }
                const tick = try value.tick(times.monotonic_ms, cancel);
                break :result supervisor.Report{ .work = tick.messages + tick.insertions + tick.payments + tick.prover_leaves, .next_delay_ms = tick.next_delay_ms };
            },
            .generic => |value| result: {
                if (!value.indexer.hasEnabledStreams()) {
                    const leaves = try value.history.sync(64);
                    break :result supervisor.Report{ .work = leaves, .next_delay_ms = if (leaves == 64) 0 else 100 };
                }
                const tick = try value.tick(times.monotonic_ms, cancel);
                break :result supervisor.Report{ .work = tick.messages + tick.insertions + tick.payments + tick.prover_leaves, .next_delay_ms = tick.next_delay_ms };
            },
        };
        report.work +|= companion_report.work;
        report.next_delay_ms = @min(report.next_delay_ms orelse self.chain.index.interval *| 1000, companion_report.next_delay_ms);
        report.work +|= try self.migration.?.migrate();
        if (!self.migration.?.migrationComplete()) report.next_delay_ms = 0;
        return report;
    }
    fn runCompanion(self: *Slot, now_ms: u64, cancel: *const std.atomic.Value(bool)) anyerror!tx_companion.Report {
        const companion = if (self.transaction_companion) |*value| value else return .{ .next_delay_ms = std.math.maxInt(u64) };
        var active_pass = false;
        var failure: ?anyerror = null;
        defer if (active_pass) self.transaction_network.?.endReadPass(failure);
        errdefer |err| {
            failure = err;
        }
        if (self.transaction_network) |network| {
            try network.beginReadPass(cancel);
            active_pass = true;
        }
        var report = try companion.tick(now_ms, cancel);
        if (report.needs_source) {
            if (cancel.load(.acquire)) {
                companion.abort(now_ms);
                return error.RequestCancelled;
            }
            if (self.transaction_network == null) self.transaction_network = try self.network.?.forkReadFor(self.allocator, .contract_sync);
            const network = self.transaction_network.?;
            if (!active_pass) {
                try network.beginReadPass(cancel);
                active_pass = true;
            }
            const source_outcome = network.source();
            if (source_outcome) |_| {} else |err| {
                failure = err;
                if (err == error.PendingReadIo) return .{ .pending_read = true, .failure = err, .next_delay_ms = 10 };
            }
            companion.source = try source_outcome;
            report = try companion.tick(now_ms, cancel);
        }
        failure = report.failure;
        return report;
    }
    fn transactionSupported(protocol: settings.Protocol) bool {
        return switch (protocol) {
            .ethereum, .cosmos, .cosmosnative, .tron, .radix, .aleo => true,
            .sealevel, .starknet => false,
        };
    }
    fn classify(err: anyerror) supervisor.FailureAction {
        return switch (err) {
            error.StoredInsertionIndexMismatch, error.StoredReverseIndexMismatch, error.MerkleRootMismatch => .halt_all,
            else => .retry,
        };
    }
    fn descriptor(self: *Slot) supervisor.Task {
        return .{ .context = self, .run = run, .failure = classify, .interval_ms = @max(1, self.chain.index.interval *| 1000), .timeout_ms = self.options.job_timeout_ms, .wake = &self.authority.wake };
    }
    fn deinit(self: *Slot) void {
        if (self.migration) |*value| value.deinit();
        if (self.discovery) |*registry| registry.deinit();
        if (self.transaction_companion) |*companion| companion.deinit();
        if (self.transaction_network) |network| network.deinit();
        if (self.transaction_queue) |*queue| queue.deinit();
        switch (self.implementation) {
            .none => {},
            .ethereum => |value| value.deinit(),
            .generic => |value| value.deinit(),
        }
        if (self.network) |network| network.deinit();
        if (self.discovery_network) |network| network.deinit();
    }
};
pub const Set = struct {
    allocator: A,
    slots: []Slot,
    tasks: []supervisor.Task,
    destinations: []u32,
    pub fn open(a: A, chains: []const settings.Chain, environment: *const std.process.EnvMap, database: *DatabaseOwner, checkpoints: *remote.Engine, options: Options) !*Set {
        if (chains.len == 0 or chains.len > 4096 or options.job_timeout_ms == 0 or options.job_timeout_ms > 3600000) return error.InvalidOriginTasks;
        const self = try a.create(Set);
        errdefer a.destroy(self);
        const slots = try a.alloc(Slot, chains.len);
        errdefer a.free(slots);
        const tasks = try a.alloc(supervisor.Task, chains.len);
        errdefer a.free(tasks);
        const domains = try a.alloc(u32, chains.len);
        errdefer a.free(domains);
        for (chains, domains) |chain, *domain| domain.* = chain.domain;
        for (chains, slots, tasks) |*chain, *slot, *task| {
            slot.* = .{ .allocator = a, .chain = chain, .environment = environment, .database = database, .checkpoints = checkpoints, .options = options, .destinations = domains };
            if (options.source.metrics) |registry| slot.metrics = .{ .registry = registry, .chain = chain.name };
            if (options.source.metrics) |registry| slot.initialization_metrics = .{ .registry = registry, .chain = chain.name, .role = .origin };
            task.* = slot.descriptor();
        }
        self.* = .{ .allocator = a, .slots = slots, .tasks = tasks, .destinations = domains };
        return self;
    }
    pub fn descriptors(self: *Set) []const supervisor.Task {
        return self.tasks;
    }
    /// The supervisor and every destination/API consumer must join first.
    pub fn deinit(self: *Set) void {
        for (self.slots) |*slot| slot.deinit();
        self.allocator.free(self.slots);
        self.allocator.free(self.tasks);
        self.allocator.free(self.destinations);
        self.allocator.destroy(self);
    }
};
