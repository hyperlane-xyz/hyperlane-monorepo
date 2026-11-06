//! Role-lifetime common health monitors. Supervisor must drain before deinit;
//! role settings, Registry and borrowed HTTP runtime/budget outlive the set.
const std = @import("std");
const settings = @import("../settings/root.zig");
const metrics = @import("../ops/metrics.zig");
const supervisor = @import("../runtime/supervisor.zig");
const source = @import("chain_source.zig");
const monitor = @import("health_metrics.zig");
const provider = @import("health_provider.zig");
const critical = @import("../ops/critical_metrics.zig");
const public_identity = @import("public_identity.zig");
const A = std.mem.Allocator;

/// The lane publishes only an already initialized public signer address.
/// Neither callback reads signer state, keys, mutable clients or network.
pub const PublicWallet = struct {
    mutex: std.Thread.Mutex = .{},
    bytes: [256]u8 = undefined,
    len: usize = 0,
    pub fn publish(self: *PublicWallet, text: []const u8) !void {
        if (text.len == 0 or text.len > self.bytes.len) return error.InvalidHealthWalletAddress;
        self.mutex.lock();
        defer self.mutex.unlock();
        @memcpy(self.bytes[0..text.len], text);
        self.len = text.len;
    }
    pub fn interface(self: *PublicWallet) monitor.WalletSource {
        return .{ .context = self, .load_into_fn = loadInto };
    }
    fn loadInto(context: *anyopaque, out: []u8) !?[]const u8 {
        const self: *PublicWallet = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.len == 0) return null;
        if (out.len < self.len) return error.InvalidHealthWalletBuffer;
        @memcpy(out[0..self.len], self.bytes[0..self.len]);
        return out[0..self.len];
    }
};
pub const Wallets = struct {
    context: *anyopaque,
    get_fn: *const fn (*anyopaque, u32) anyerror!?monitor.WalletSource,
};
pub const Criticals = struct {
    context: *anyopaque,
    get_fn: *const fn (*anyopaque, u32) anyerror!?*critical.Tracker,
};
pub const Options = struct { source: source.Options, wallets: ?Wallets = null, criticals: ?Criticals = null, identity_options: public_identity.Options = .{} };
/// One serialized monitor owns this lazy provider. Constructor failure is local
/// to its Supervisor task; no mutable role clients or signing owners are read.
const Node = struct {
    allocator: A,
    chain: *const settings.Chain,
    environment: *const std.process.EnvMap,
    options: source.Options,
    adapter: ?*provider.Adapter = null,
    monitor_task: ?*monitor.CommonMonitorTask = null,
    critical_state: ?*critical.Tracker = null,
    identity: ?public_identity.Resolver = null,
    public_wallet: PublicWallet = .{},
    identity_ready: bool = false,
    unix_seconds: u64 = 0,
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self = cast(context);
        self.unix_seconds = times.unix_ms / 1000;
        return self.monitor_task.?.step(times.monotonic_ms, cancel);
    }
    fn stop(context: *anyopaque) void {
        // Published before Supervisor starts and immutable through its join.
        cast(context).monitor_task.?.stop();
    }
    fn interface(self: *Node) monitor.Provider {
        return .{ .context = self, .begin_fn = begin, .end_fn = end, .commit_fn = commit, .balance_fn = balance, .chain_fn = chainInfo };
    }
    fn cast(context: *anyopaque) *Node {
        return @ptrCast(@alignCast(context));
    }
    fn begin(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self = cast(context);
        if (cancel.load(.acquire)) return error.RequestCancelled;
        if (self.adapter == null) {
            self.adapter = provider.Adapter.openFromSettings(self.allocator, self.chain, self.environment, self.options) catch |err| {
                if (self.critical_state) |tracker| tracker.record(.destination_metrics);
                return err;
            };
        }
        if (cancel.load(.acquire)) return error.RequestCancelled;
        const value = self.adapter.?.interface();
        try value.begin_fn(value.context, cancel);
        if (!self.identity_ready) if (self.identity) |*identity| {
            var text: [256]u8 = undefined;
            const resolved = identity.resolve(self.adapter.?.owner, cancel, self.unix_seconds, &text) catch |err| {
                if (err != error.PendingReadIo and err != error.PendingIo and err != error.RequestCancelled) if (self.critical_state) |tracker| tracker.record(.destination_metrics);
                return err;
            };
            if (resolved) |address| try self.public_wallet.publish(address);
            self.identity_ready = true;
        };
        if (self.critical_state) |tracker| tracker.clear(.destination_metrics);
    }
    fn end(context: *anyopaque, failure: ?anyerror) void {
        const self = cast(context);
        if (self.identity) |*identity| identity.endPass(failure);
        if (self.adapter) |adapter| {
            const value = adapter.interface();
            value.end_fn(value.context, failure);
        }
    }
    fn commit(context: *anyopaque) !void {
        const value = cast(context).adapter.?.interface();
        try value.commit_fn(value.context);
    }
    fn balance(context: *anyopaque, text: []const u8) !u256 {
        const value = cast(context).adapter.?.interface();
        return value.balance_fn(value.context, text);
    }
    fn chainInfo(context: *anyopaque) !?monitor.ChainInfo {
        const value = cast(context).adapter.?.interface();
        return value.chain_fn(value.context);
    }
    fn deinit(self: *Node) void {
        if (self.identity) |*identity| identity.deinit();
        if (self.adapter) |adapter| adapter.deinit();
    }
};
pub const Set = struct {
    allocator: A,
    monitors: []*monitor.CommonMonitorTask = &.{},
    nodes: []Node = &.{},
    tasks: []supervisor.Task = &.{},
    initialized: usize = 0,
    owned_runtime: ?*source.HttpRuntime.Runtime = null,
    read_budget: source.ReadReplay.ByteBudget = .{},
    pub fn open(a: A, configured: *const settings.Settings, environment: *const std.process.EnvMap, registry: *metrics.Registry, role_tasks: []const supervisor.Task, options: Options) !*Set {
        // Settings.chains is already the selected relayer/scraper chain set.
        const count: usize = if (configured.role == .validator) 1 else configured.chains.len;
        if (count == 0 or count > 1024 or role_tasks.len > 4096 - count) return error.InvalidHealthTaskCount;
        const self = try a.create(Set);
        self.* = .{ .allocator = a };
        errdefer self.deinit();
        self.monitors = try a.alloc(*monitor.CommonMonitorTask, count);
        self.nodes = try a.alloc(Node, count);
        self.tasks = try a.alloc(supervisor.Task, role_tasks.len + count);
        @memcpy(self.tasks[0..role_tasks.len], role_tasks);
        var source_options = options.source;
        if (source_options.http_runtime == null) {
            self.owned_runtime = try source.HttpRuntime.Runtime.start(a, .{ .multi = .{ .library_path = source_options.curl_library, .max_concurrent = 8, .max_pending = 8, .max_response_bytes = 8 * 1024 * 1024, .max_request_bytes = 1024 * 1024, .max_reserved_bytes = 64 * 1024 * 1024 }, .max_sessions = 8 });
            source_options.http_runtime = self.owned_runtime;
        }
        if (source_options.read_budget == null) source_options.read_budget = &self.read_budget;
        source_options.metrics = registry;
        source_options.rpc_parallelism = 2;
        for (0..count) |index| {
            const chain = if (configured.role == .validator)
                configured.chainByName(configured.role.validator.origin_chain) orelse return error.UnknownOriginChain
            else
                &configured.chains[index];
            self.nodes[index] = .{ .allocator = a, .chain = chain, .environment = environment, .options = source_options, .critical_state = if (options.criticals) |v| try v.get_fn(v.context, chain.domain) else null };
            errdefer self.nodes[index].deinit();
            if (configured.role == .scraper and chain.signer != null) self.nodes[index].identity = try public_identity.Resolver.init(a, configured, chain, environment, options.identity_options);
            const wallet = if (configured.role == .validator) null else if (self.nodes[index].identity != null) self.nodes[index].public_wallet.interface() else if (options.wallets) |wallets| try wallets.get_fn(wallets.context, chain.domain) else null;
            const task = try monitor.CommonMonitorTask.open(a, registry, self.nodes[index].interface(), .{ .protocol = chain.protocol, .chain = chain.name, .agent_name = @tagName(configured.role), .native_decimals = chain.native_token.decimals, .wallet = wallet });
            self.monitors[index] = task;
            self.nodes[index].monitor_task = task;
            var descriptor = task.descriptor();
            descriptor.context = &self.nodes[index];
            descriptor.run = Node.run;
            descriptor.stop_fn = Node.stop;
            self.tasks[role_tasks.len + index] = descriptor;
            self.initialized += 1;
        }
        return self;
    }
    pub fn descriptors(self: *Set) []const supervisor.Task {
        return self.tasks;
    }
    /// Supervisor stop/join precedes this call, including error unwind.
    pub fn deinit(self: *Set) void {
        for (self.monitors[0..self.initialized]) |task| task.deinit();
        for (self.nodes[0..self.initialized]) |*node| node.deinit();
        if (self.owned_runtime) |runtime| runtime.deinit();
        std.debug.assert(self.read_budget.used == 0);
        self.allocator.free(self.tasks);
        self.allocator.free(self.monitors);
        self.allocator.free(self.nodes);
        self.allocator.destroy(self);
    }
};
