const std = @import("std");
const common = @import("health_metrics.zig");
const metrics = @import("../ops/metrics.zig");
const recording = @import("../ops/health_metrics.zig");
const a = std.testing.allocator;
const Fake = struct {
    begin_calls: usize = 0,
    balance_calls: usize = 0,
    chain_calls: usize = 0,
    loads: usize = 0,
    commits: usize = 0,
    pending_balance: bool = false,
    pending_chain: bool = false,
    fail_balance: bool = false,
    fail_chain: bool = false,
    chain_none: bool = false,
    wallet: ?[]const u8 = "wallet1",
    amount: u256 = 1_152_000_000,
    height: u64 = 17,
    gas: ?u256 = 22,
    fn cast(ctx: *anyopaque) *Fake {
        return @ptrCast(@alignCast(ctx));
    }
    fn begin(ctx: *anyopaque, _: *const std.atomic.Value(bool)) !void {
        cast(ctx).begin_calls += 1;
    }
    fn end(_: *anyopaque, _: ?anyerror) void {}
    fn commit(ctx: *anyopaque) !void {
        cast(ctx).commits += 1;
    }
    fn balance(ctx: *anyopaque, _: []const u8) !u256 {
        const self = cast(ctx);
        self.balance_calls += 1;
        if (self.pending_balance) {
            self.pending_balance = false;
            return error.PendingReadIo;
        }
        if (self.fail_balance) return error.BalanceUnavailable;
        return self.amount;
    }
    fn chain(ctx: *anyopaque) !?common.ChainInfo {
        const self = cast(ctx);
        self.chain_calls += 1;
        if (self.pending_chain) {
            self.pending_chain = false;
            return error.PendingReadIo;
        }
        if (self.fail_chain) return error.ChainUnavailable;
        if (self.chain_none) return null;
        return .{ .block_height = self.height, .min_gas_price = self.gas };
    }
    fn walletFn(ctx: *anyopaque) !?[]const u8 {
        const self = cast(ctx);
        self.loads += 1;
        return self.wallet;
    }
    fn provider(self: *Fake) common.Provider {
        return .{ .context = self, .begin_fn = begin, .end_fn = end, .commit_fn = commit, .balance_fn = balance, .chain_fn = chain };
    }
    fn identity(self: *Fake) common.WalletSource {
        return .{ .context = self, .load_fn = walletFn };
    }
};
fn registry(role: metrics.Role) !*metrics.Registry {
    return metrics.Registry.init(a, role, .{ .base_version = "3.0.0" });
}
fn value(wire: []const u8, name: []const u8) !f64 {
    var lines = std.mem.splitScalar(u8, wire, '\n');
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, name) and line.len > name.len and line[name.len] == '{') {
        const start = std.mem.lastIndexOfScalar(u8, line, ' ') orelse return error.NoValue;
        return std.fmt.parseFloat(f64, line[start + 1 ..]);
    };
    return error.AbsentSample;
}

test "Source monitor cadence has two startup passes, fixed60s ticks and skips missed intervals" {
    const r = try registry(.relayer);
    defer r.deinit();
    var fake: Fake = .{};
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "chain", .agent_name = "relayer", .native_decimals = 6 });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectEqual(@as(usize, 0), fake.begin_calls);
    try std.testing.expectEqual(@as(?u64, 0), (try task.step(100, &cancel)).next_delay_ms);
    try std.testing.expectEqual(@as(?u64, 60_000), (try task.step(100, &cancel)).next_delay_ms);
    try std.testing.expectEqual(@as(?u64, 1), (try task.step(60_099, &cancel)).next_delay_ms);
    try std.testing.expectEqual(@as(usize, 2), fake.chain_calls);
    try std.testing.expectEqual(@as(?u64, 60_000), (try task.step(60_100, &cancel)).next_delay_ms);
    // A slow/late update consumes one expired tick; one immediate update then
    // waits for the next anchored boundary, with no unbounded catch-up burst.
    try std.testing.expectEqual(@as(?u64, 0), (try task.step(250_100, &cancel)).next_delay_ms);
    try std.testing.expectEqual(@as(?u64, 50_000), (try task.step(250_100, &cancel)).next_delay_ms);
    try std.testing.expectEqual(@as(usize, 5), fake.chain_calls);
    try std.testing.expectEqual(@as(usize, 0), fake.balance_calls);
}

test "monitor retains wallet snapshot/stage over PIO, queries next details without repeating balance" {
    const r = try registry(.relayer);
    defer r.deinit();
    var fake: Fake = .{ .pending_chain = true };
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "trx", .agent_name = "relayer", .native_decimals = 6, .wallet = fake.identity() });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.PendingReadIo, task.step(0, &cancel));
    fake.wallet = "wallet2";
    _ = try task.step(1, &cancel);
    try std.testing.expectEqual(@as(usize, 1), fake.balance_calls);
    try std.testing.expectEqual(@as(usize, 1), fake.loads);
    const wire = try r.render(a);
    defer a.free(wire);
    try std.testing.expectEqual(@as(f64, 1152), try value(wire, "hyperlane_wallet_balance"));
    try std.testing.expect(std.mem.indexOf(u8, wire, "wallet_address=\"wallet1\",wallet_name=\"relayer\",token_address=\"none\",token_symbol=\"Native\",token_name=\"Native\"") != null);
}

test "failed wallet does not suppress chain, failed chain preserves real prior samples and absent block omits sample" {
    const r = try registry(.scraper);
    defer r.deinit();
    var fake: Fake = .{ .fail_balance = true };
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "chain", .agent_name = "scraper", .native_decimals = 18, .wallet = fake.identity() });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    _ = try task.step(0, &cancel);
    var wire = try r.render(a);
    try std.testing.expectError(error.AbsentSample, value(wire, "hyperlane_wallet_balance"));
    try std.testing.expectEqual(@as(f64, 17), try value(wire, "hyperlane_block_height"));
    a.free(wire);
    fake.fail_balance = false;
    fake.fail_chain = true;
    fake.height = 200;
    _ = try task.step(0, &cancel);
    wire = try r.render(a);
    try std.testing.expectEqual(@as(f64, 17), try value(wire, "hyperlane_block_height"));
    try std.testing.expectEqual(@as(f64, 22), try value(wire, "hyperlane_gas_price"));
    a.free(wire);
    const r2 = try registry(.validator);
    defer r2.deinit();
    fake.chain_none = true;
    fake.fail_chain = false;
    const no_block = try common.CommonMonitorTask.open(a, r2, fake.provider(), .{ .chain = "chain", .agent_name = "validator", .native_decimals = 6 });
    defer no_block.deinit();
    _ = try no_block.step(0, &cancel);
    wire = try r2.render(a);
    defer a.free(wire);
    try std.testing.expectError(error.AbsentSample, value(wire, "hyperlane_block_height"));
}

test "validator no wallet callback or eager identity work; late identity is loaded only on cadence; identity rotation bounded" {
    const r = try registry(.validator);
    defer r.deinit();
    var fake: Fake = .{ .wallet = null };
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "chain", .agent_name = "validator", .native_decimals = 6 });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    _ = try task.step(0, &cancel);
    _ = try task.step(0, &cancel);
    try std.testing.expectEqual(@as(usize, 0), fake.loads);
    const r2 = try registry(.relayer);
    defer r2.deinit();
    const late = try common.CommonMonitorTask.open(a, r2, fake.provider(), .{ .chain = "chain", .agent_name = "relayer", .native_decimals = 6, .wallet = fake.identity() });
    defer late.deinit();
    try std.testing.expectEqual(@as(usize, 0), fake.loads);
    _ = try late.step(0, &cancel);
    fake.wallet = "ready";
    _ = try late.step(0, &cancel);
    try std.testing.expectEqual(@as(usize, 1), fake.balance_calls);
    fake.wallet = "changed";
    _ = try late.step(60_000, &cancel);
    try std.testing.expectEqual(@as(usize, 1), fake.balance_calls);
    try std.testing.expectEqual(error.HealthWalletIdentityChanged, late.last_failure.?);
    late.stop();
    try std.testing.expectError(error.RequestCancelled, late.step(120_000, &cancel));
}

test "health samples use configured decimals, Source unsupported gas zero after success, and maxU256 stays finite" {
    const r = try registry(.relayer);
    defer r.deinit();
    const recorder: recording.Recorder = .{ .registry = r, .chain = "trx", .agent_name = "relayer", .native_decimals = 6, .protocol = .tron };
    try recorder.balance("wallet", 1_152_000_000);
    try recorder.chainInfo(.{ .block_height = 10 });
    var wire = try r.render(a);
    try std.testing.expectEqual(@as(f64, 1152), try value(wire, "hyperlane_wallet_balance"));
    try std.testing.expectEqual(@as(f64, 0), try value(wire, "hyperlane_gas_price"));
    a.free(wire);
    try recorder.balance("wallet", std.math.maxInt(u256));
    wire = try r.render(a);
    defer a.free(wire);
    try std.testing.expect(std.math.isFinite(try value(wire, "hyperlane_wallet_balance")));
}

test "health pending wallet snapshot survives identity change and cancellation emits no fabricated samples" {
    const r = try registry(.relayer);
    defer r.deinit();
    var fake: Fake = .{ .pending_balance = true };
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "chain", .agent_name = "relayer", .native_decimals = 6, .wallet = fake.identity() });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    try std.testing.expectError(error.PendingReadIo, task.step(0, &cancel));
    const before = try r.render(a);
    defer a.free(before);
    try std.testing.expectError(error.AbsentSample, value(before, "hyperlane_wallet_balance"));
    fake.wallet = "rotated";
    _ = try task.step(1, &cancel);
    try std.testing.expectEqual(@as(usize, 1), fake.loads);
    const wire = try r.render(a);
    defer a.free(wire);
    try std.testing.expect(std.mem.indexOf(u8, wire, "wallet_address=\"wallet1\"") != null);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, task.step(60_000, &cancel));
    try std.testing.expectEqual(@as(usize, 1), fake.chain_calls);
}

test "health task construction allocation failures release copied labels and never perform identity or RPC work" {
    const r = try registry(.relayer);
    defer r.deinit();
    var fake: Fake = .{};
    const Exercise = struct {
        fn run(allocator: std.mem.Allocator, registry_: *metrics.Registry, fake_: *Fake) !void {
            const task = try common.CommonMonitorTask.open(allocator, registry_, fake_.provider(), .{ .chain = "chain", .agent_name = "relayer", .native_decimals = 18, .wallet = fake_.identity() });
            defer task.deinit();
        }
    };
    try std.testing.checkAllAllocationFailures(a, Exercise.run, .{ r, &fake });
    try std.testing.expectEqual(@as(usize, 0), fake.loads);
    try std.testing.expectEqual(@as(usize, 0), fake.begin_calls);
    try std.testing.expectEqual(@as(usize, 0), fake.balance_calls);
}

test "health mutable public identity is copied under publisher lock into task buffer" {
    const Publisher = struct {
        mutex: std.Thread.Mutex = .{},
        address: [6]u8 = "public".*,
        fn load(ctx: *anyopaque, out: []u8) !?[]const u8 {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            self.mutex.lock();
            defer self.mutex.unlock();
            @memcpy(out[0..6], &self.address);
            @memcpy(&self.address, "rotate");
            return out[0..6];
        }
    };
    const r = try registry(.relayer);
    defer r.deinit();
    var fake: Fake = .{};
    var publisher: Publisher = .{};
    const task = try common.CommonMonitorTask.open(a, r, fake.provider(), .{ .chain = "chain", .agent_name = "relayer", .native_decimals = 6, .wallet = .{ .context = &publisher, .load_into_fn = Publisher.load } });
    defer task.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    _ = try task.step(0, &cancel);
    const wire = try r.render(a);
    defer a.free(wire);
    try std.testing.expect(std.mem.indexOf(u8, wire, "wallet_address=\"public\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, wire, "wallet_address=\"rotate\"") == null);
    try std.testing.expectEqualStrings("rotate", &publisher.address);
}
