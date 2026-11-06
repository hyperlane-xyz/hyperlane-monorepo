//! Common Source monitor on the existing cooperative Supervisor. Each task owns
//! one provider/read journal; no I/O thread or per-request worker is introduced.
const std = @import("std");
const supervisor = @import("../runtime/supervisor.zig");
const samples = @import("../ops/health_metrics.zig");
const metrics = @import("../ops/metrics.zig");
const A = std.mem.Allocator;
pub const interval_ms: u64 = 60_000;
pub const ChainInfo = samples.ChainInfo;
pub const Provider = struct {
    context: *anyopaque,
    begin_fn: *const fn (*anyopaque, *const std.atomic.Value(bool)) anyerror!void,
    end_fn: *const fn (*anyopaque, ?anyerror) void,
    commit_fn: *const fn (*anyopaque) anyerror!void,
    balance_fn: *const fn (*anyopaque, []const u8) anyerror!u256,
    chain_fn: *const fn (*anyopaque) anyerror!?ChainInfo,
};
/// Must ONLY return an already-resolved public identity. No signer/key/cloud
/// lookup. Returned bytes are borrowed during load_fn and immediately copied.
pub const WalletSource = struct {
    context: *anyopaque,
    /// For immutable role-lifetime public bytes only.
    load_fn: ?*const fn (*anyopaque) anyerror!?[]const u8 = null,
    /// Copy under the publisher's lock into out; return a slice INSIDE out.
    /// Preferred for mutable publication. Takes precedence over load_fn.
    load_into_fn: ?*const fn (*anyopaque, out: []u8) anyerror!?[]const u8 = null,
};
pub const Options = struct { protocol: @import("../settings/types.zig").Protocol = .ethereum, chain: []const u8, agent_name: []const u8, native_decimals: u32, wallet: ?WalletSource = null, timeout_ms: u32 = 120_000 };
const Stage = enum { idle, wallet, chain };
pub const CommonMonitorTask = struct {
    allocator: A,
    provider: Provider,
    recorder: samples.Recorder,
    options: Options,
    cancelled: std.atomic.Value(bool) = .init(false),
    stage: Stage = .idle,
    next_due_ms: ?u64 = null,
    next_tick_ms: u64 = 0,
    wallet_text: [256]u8 = undefined,
    wallet_len: usize = 0,
    cycle_wallet: bool = false,
    wallet_snapshotted: bool = false,
    failures: u64 = 0,
    last_failure: ?anyerror = null,
    pub fn open(a: A, registry: *metrics.Registry, provider: Provider, options: Options) !*CommonMonitorTask {
        if (options.chain.len == 0 or options.chain.len > 256 or options.agent_name.len == 0 or options.agent_name.len > 64 or options.native_decimals > 255 or options.timeout_ms == 0 or options.timeout_ms > 300_000) return error.InvalidHealthMonitorConfig;
        if (options.wallet) |wallet| if (wallet.load_fn == null and wallet.load_into_fn == null) return error.InvalidHealthWalletSource;
        const chain = try a.dupe(u8, options.chain);
        errdefer a.free(chain);
        const agent_name = try a.dupe(u8, options.agent_name);
        errdefer a.free(agent_name);
        const self = try a.create(CommonMonitorTask);
        self.* = .{ .allocator = a, .provider = provider, .options = options, .recorder = .{ .registry = registry, .chain = chain, .agent_name = agent_name, .native_decimals = options.native_decimals, .protocol = options.protocol } };
        self.options.chain = chain;
        self.options.agent_name = agent_name;
        return self;
    }
    /// Stop/drain Supervisor first; then destroy task, provider fork, registry.
    pub fn deinit(self: *CommonMonitorTask) void {
        self.provider.end_fn(self.provider.context, error.RequestCancelled);
        self.allocator.free(self.options.chain);
        self.allocator.free(self.options.agent_name);
        self.allocator.destroy(self);
    }
    pub fn descriptor(self: *CommonMonitorTask) supervisor.Task {
        return .{ .context = self, .run = run, .interval_ms = interval_ms, .timeout_ms = self.options.timeout_ms, .stop_fn = stopCallback };
    }
    fn stopCallback(context: *anyopaque) void {
        const self: *CommonMonitorTask = @ptrCast(@alignCast(context));
        self.cancelled.store(true, .release);
    }
    pub fn stop(self: *CommonMonitorTask) void {
        self.cancelled.store(true, .release);
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) anyerror!supervisor.Report {
        const self: *CommonMonitorTask = @ptrCast(@alignCast(context));
        return self.step(times.monotonic_ms, cancel);
    }
    fn warning(self: *CommonMonitorTask, err: anyerror) void {
        self.failures +|= 1;
        self.last_failure = err;
        // Never print address, URL, remote response or provider error text.
        std.log.warn("Common health metric update failed: {s}", .{@errorName(err)});
    }
    fn control(err: anyerror) bool {
        return err == error.PendingReadIo or err == error.PendingIo or err == error.RequestCancelled or err == error.OutOfMemory or err == error.RequestDeadlineExceeded or err == error.ReadReplayDeadline or err == error.SvmRequestDeadline;
    }
    fn snapshotWallet(self: *CommonMonitorTask) void {
        self.cycle_wallet = false;
        const source = self.options.wallet orelse return;
        var snapshot: [256]u8 = undefined;
        const text = (if (source.load_into_fn) |load| load(source.context, &snapshot) else source.load_fn.?(source.context)) catch |err| {
            self.warning(err);
            return;
        };
        const address = text orelse return;
        if (source.load_into_fn != null) {
            const start = @intFromPtr(&snapshot);
            const ptr = @intFromPtr(address.ptr);
            if (ptr < start or ptr - start > snapshot.len or address.len > snapshot.len - (ptr - start)) {
                self.warning(error.InvalidHealthWalletBuffer);
                return;
            }
        }
        if (address.len == 0 or address.len > self.wallet_text.len) {
            self.warning(error.InvalidHealthWalletAddress);
            return;
        }
        if (self.wallet_len == 0) {
            @memcpy(self.wallet_text[0..address.len], address);
            self.wallet_len = address.len;
        } else if (!std.mem.eql(u8, self.wallet_text[0..self.wallet_len], address)) {
            // Role identities are immutable for a task lifetime. Recreate the
            // task on rotation rather than permit unbounded historical series.
            self.warning(error.HealthWalletIdentityChanged);
            return;
        }
        self.cycle_wallet = true;
    }
    /// Caller-injected monotonic time; no sleeps and no periodic busy polling.
    pub fn step(self: *CommonMonitorTask, now_ms: u64, cancel: *const std.atomic.Value(bool)) anyerror!supervisor.Report {
        if (self.cancelled.load(.acquire) or cancel.load(.acquire)) {
            self.provider.end_fn(self.provider.context, error.RequestCancelled);
            self.stage = .idle;
            return error.RequestCancelled;
        }
        if (self.stage == .idle) {
            if (self.next_due_ms) |due| {
                if (now_ms < due) return .{ .next_delay_ms = due - now_ms };
            } else self.next_tick_ms = now_ms;
            self.wallet_snapshotted = false;
            self.stage = .wallet;
        }
        var failure: ?anyerror = null;
        defer self.provider.end_fn(self.provider.context, failure);
        errdefer |err| {
            failure = err;
            if (err != error.PendingReadIo and err != error.PendingIo) self.stage = .idle;
        }
        try self.provider.begin_fn(self.provider.context, &self.cancelled);
        if (self.stage == .wallet) {
            // A configured scraper identity is resolved by supervised begin.
            // Snapshot after it succeeds, once per cycle across I/O resumes.
            if (!self.wallet_snapshotted) {
                self.snapshotWallet();
                self.wallet_snapshotted = true;
            }
            if (self.cycle_wallet) {
                const amount: ?u256 = self.provider.balance_fn(self.provider.context, self.wallet_text[0..self.wallet_len]) catch |err| blk: {
                    if (control(err)) return @as(anyerror!supervisor.Report, err);
                    self.warning(err);
                    break :blk null;
                };
                if (amount) |value| self.recorder.balance(self.wallet_text[0..self.wallet_len], value) catch |err| self.warning(err);
            }
            self.stage = .chain;
            try self.provider.commit_fn(self.provider.context);
        }
        const info = self.provider.chain_fn(self.provider.context) catch |err| blk: {
            if (control(err)) return @as(anyerror!supervisor.Report, err);
            self.warning(err);
            break :blk null;
        };
        if (info) |value| self.recorder.chainInfo(value) catch |err| self.warning(err);
        self.stage = .idle;
        try self.provider.commit_fn(self.provider.context);
        // Match interval(period), MissedTickBehavior::Skip, tick AFTER update.
        // Its first tick is already ready: Source performs two startup updates.
        if (self.next_tick_ms <= now_ms) {
            const skipped = (now_ms - self.next_tick_ms) / interval_ms + 1;
            self.next_tick_ms +|= skipped *| interval_ms;
            self.next_due_ms = now_ms;
        } else {
            self.next_due_ms = self.next_tick_ms;
            self.next_tick_ms +|= interval_ms;
        }
        return .{ .work = 1, .next_delay_ms = self.next_due_ms.? - now_ms };
    }
};
