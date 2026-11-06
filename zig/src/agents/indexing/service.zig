//! Operational native relayer origin over a concrete protocol Source. Source
//! and chain settings are borrowed; callers own bounded network transports and
//! bind per-job cancellation to those clients before calling tick.
const std = @import("std");
const settings = @import("../../settings/types.zig");
const source = @import("../scraper/source.zig");
const worker = @import("source.zig");
const rocks = @import("../../db/rocks.zig");
const native = @import("../store.zig");
const origin = @import("../origin.zig");
const remote = @import("../../relayer/remote_checkpoints.zig");
const initialization = @import("../../ops/init_metrics.zig");
pub const Service = struct {
    allocator: std.mem.Allocator,
    store: native.Store,
    history: origin.Origin,
    indexer: worker.Core(native.Store),
    prover_init_ns: ?u64 = null,
    pub fn open(a: std.mem.Allocator, chain: *const settings.Chain, provider: source.Source, database: *rocks.Database, checkpoints: ?*remote.Engine, gas_enabled: bool) !*Service {
        if (chain.protocol == .ethereum) return error.UseConcreteEvmOrigin;
        if ((chain.index.mode == .sequence) != provider.sequence_mode) return error.OriginIndexModeMismatch;
        if (chain.index.chunk > 65535 or chain.index.interval == 0) return error.InvalidOriginIndexOptions;
        const self = try a.create(Service);
        errdefer a.destroy(self);
        self.allocator = a;
        self.store = native.Store.init(a, database, chain.name);
        var timer = std.time.Timer.start() catch null;
        self.history = origin.Origin.init(a, &self.store, chain.domain, chain.contracts.merkle_tree_hook, checkpoints);
        self.prover_init_ns = if (timer) |*clock| clock.read() else null;
        self.indexer = .{ .allocator = a, .source = provider, .store = &self.store, .options = .{ .source_fetch_backoff = true, .cursor_bootstrap = true, .domain = chain.domain, .contracts = .{ .mailbox = chain.contracts.mailbox, .hook = chain.contracts.merkle_tree_hook, .paymaster = chain.contracts.interchain_gas_paymaster }, .chunk = chain.index.chunk, .cooperative_max_range = if (chain.protocol == .aleo) 2 else 32, .lowest = if (chain.protocol == .cosmos or chain.protocol == .cosmosnative) @max(1, chain.index.from) else chain.index.from, .interval_ms = chain.index.interval *| 1000, .configured_interval_ms = if (chain.index.configured_interval) |value| value *| 1000 else null, .gas_enabled = gas_enabled } };
        return self;
    }
    pub fn observeInitialization(self: *Service, observer: initialization.Observer) void {
        self.indexer.initialization_observer = observer;
        if (self.prover_init_ns) |elapsed| observer.completed(.prover_sync, elapsed);
        self.prover_init_ns = null;
    }
    pub fn deinit(self: *Service) void {
        self.indexer.deinit();
        self.history.deinit();
        self.allocator.destroy(self);
    }
    /// One bounded stream range; the native store remains the sole mutation
    /// owner. Prover sync takes at most64 leaves to preserve scheduler fairness.
    pub fn tick(self: *Service, now_ms: u64, cancel: ?*const std.atomic.Value(bool)) !worker.Report {
        var report = try self.indexer.tick(now_ms, cancel);
        report.prover_leaves = try self.history.sync(64);
        if (report.prover_leaves == 64) report.next_delay_ms = 0;
        return report;
    }
};
