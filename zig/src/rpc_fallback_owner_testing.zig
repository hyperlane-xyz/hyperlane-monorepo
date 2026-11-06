const std = @import("std");
const fixture = @import("evm/pool_testing.zig");
const resources = @import("agents/chain_source.zig");
const chain_fixture = @import("agents/chain_source_testing.zig");
const settings = @import("settings/types.zig");
const rpc = @import("evm/provider.zig");
const http = @import("cloud/http.zig");
const A = std.mem.Allocator;
const a = std.testing.allocator;
const Profile = enum { evm, svm, hedged_call, hedged_immutable };
const Mode = enum { live, clamped, expired, precancel, cancel_pending };
const evm_result = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x25\"}";
const svm_result = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":37}";
const immutable_hash = "0x00000000000000000000000000000000" ++ "00000000000000000000000000000001";

fn chainFor(urls: []const []const u8, profile: Profile) settings.Chain {
    var chain = chain_fixture.chainFor(urls);
    chain.connection.ethereum.consensus = .fallback;
    if (profile == .hedged_call or profile == .hedged_immutable) {
        chain.connection.ethereum.fallback_hedge_delay_ms = 5;
        chain.connection.ethereum.fallback_hedge_timeout_ms = 30000;
    }
    if (profile == .svm) {
        chain.protocol = .sealevel;
        chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    }
    return chain;
}

const Job = struct {
    library: []const u8,
    urls: [2][]const u8,
    profile: Profile,
    cooperative: bool,
    mode: Mode,
    cancel: std.atomic.Value(bool) = .init(false),
    done: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,

    fn run(self: *Job) void {
        self.execute() catch |err| {
            self.failure = err;
        };
        self.done.store(true, .release);
    }
    fn request(self: *Job, network: *resources.Resources) !rpc.RpcResponse {
        return switch (self.profile) {
            .svm => network.clients.sealevel.call("getSlot", .{.{ .commitment = "finalized" }}),
            .evm => network.clients.ethereum.call("eth_blockNumber", .{}),
            .hedged_call => network.clients.ethereum.call("eth_call", .{ .{ .to = "0x0000000000000000000000000000000000000001" }, "latest" }),
            .hedged_immutable => network.clients.ethereum.call("eth_getBalance", .{ "0x0000000000000000000000000000000000000001", .{ .blockHash = immutable_hash } }),
        };
    }
    fn pass(self: *Job, network: *resources.Resources) !rpc.RpcResponse {
        try network.beginReadPass(&self.cancel);
        var failure: ?anyerror = null;
        defer network.endReadPass(failure);
        return self.request(network) catch |err| {
            failure = err;
            return err;
        };
    }
    fn execute(self: *Job) !void {
        var chain = chainFor(&self.urls, self.profile);
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        const owner_ms: u32 = if (self.cooperative and self.mode == .clamped) 300 else if (self.cooperative and self.mode == .expired) 1 else 120000;
        const network = try resources.Resources.open(a, &chain, &env, .{ .curl_library = self.library, .cooperative_reads = self.cooperative, .request_timeout_ms = 20000, .read_attempt_timeout_ms = owner_ms, .rpc_max_response_bytes = 1024 * 1024 });
        defer network.deinit();
        try std.testing.expectEqual(@as(?u32, 20000), network.rpc_pool.?.config.strategy.fallback.attempt_timeout_ms);
        if (self.profile == .hedged_call or self.profile == .hedged_immutable) {
            try std.testing.expectEqual(@as(u32, 30000), network.rpc_pool.?.config.strategy.fallback.hedge.?.attempt_timeout_ms);
            try std.testing.expectEqual(@as(u32, 5), network.rpc_pool.?.config.strategy.fallback.hedge.?.delay_ms);
        } else try std.testing.expect(network.rpc_pool.?.config.strategy.fallback.hedge == null);
        const client = if (self.profile == .svm) &network.clients.sealevel.rpc_client else network.clients.ethereum;
        if (self.cooperative) {
            try std.testing.expect(network.read_replay.?.config.use_owner_timeout);
            // DIRECT scope metadata must not replace a retained replay owner.
            client.options.owner_deadline_ns = 1;
            if (self.mode == .expired) {
                try network.beginReadPass(&self.cancel);
                network.endReadPass(error.PendingReadIo);
                std.Thread.sleep(3 * std.time.ns_per_ms);
            }
        } else {
            const deadline = if (self.mode == .expired) 1 else (try http.rpcNowNs()) + @as(u64, if (self.mode == .clamped) 300 else 120000) * std.time.ns_per_ms;
            // Exercise actual caller-only bindings, without Resources/HTTP
            // deadline fields as an accidental second source of authority.
            try std.testing.expect(network.rpc_deadline_ns == null and network.http.rpc_read_owner == null);
            if (self.profile == .svm) network.clients.sealevel.deadline_ns = deadline else client.options.owner_deadline_ns = deadline;
        }
        if (self.mode == .precancel) self.cancel.store(true, .release);
        var timer = try std.time.Timer.start();
        while (true) {
            var response = self.pass(network) catch |err| {
                if (err == error.PendingReadIo) {
                    std.Thread.sleep(std.time.ns_per_ms);
                    continue;
                }
                if (self.mode == .clamped or self.mode == .expired) {
                    if (err == error.RequestDeadlineExceeded or err == error.SvmRequestDeadline) return;
                } else if ((self.mode == .precancel or self.mode == .cancel_pending) and err == error.RequestCancelled) return;
                return err;
            };
            defer response.deinit();
            if (self.mode != .live) return error.AcceptedExpiredFallbackOwner;
            try std.testing.expect(timer.read() >= (if (self.profile == .hedged_immutable) @as(u64, 20500) else 19500) * std.time.ns_per_ms);
            if (self.profile == .svm) {
                try std.testing.expectEqual(@as(i64, 37), response.value().integer);
                try std.testing.expect(client.options.owner_deadline_ns == (if (self.cooperative) @as(?u64, 1) else null));
            } else try std.testing.expectEqualStrings("0x25", response.value().string);
            return;
        }
    }
};

fn matrix(mode: Mode) !void {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const count: usize = if (mode == .live) 7 else 6;
    var behavior: [14]fixture.Behavior = undefined;
    var replies: [14][1]fixture.Reply = undefined;
    for (0..count) |i| {
        const profile: Profile = if (i == 6) .hedged_immutable else switch (i / 2) {
            0 => .evm,
            1 => .svm,
            else => .hedged_call,
        };
        replies[i * 2] = .{.{ .body = "", .stall = true }};
        replies[i * 2 + 1] = .{.{ .body = if (profile == .svm) svm_result else evm_result, .delay_ms = if (profile == .hedged_immutable) 21000 else 0 }};
        behavior[i * 2] = .{ .replies = &replies[i * 2] };
        behavior[i * 2 + 1] = .{ .replies = &replies[i * 2 + 1] };
    }
    var server = try fixture.Fixture.init(count * 2, behavior[0 .. count * 2]);
    try server.start();
    defer server.deinit();
    var jobs: [7]Job = undefined;
    var threads: [7]std.Thread = undefined;
    var initialized: usize = 0;
    defer for (jobs[0..initialized]) |*job| for (job.urls) |url| a.free(url);
    for (0..count) |i| {
        const first = try server.url(a, i * 2);
        errdefer a.free(first);
        const second = try server.url(a, i * 2 + 1);
        jobs[i] = .{ .library = library, .urls = .{ first, second }, .profile = if (i == 6) .hedged_immutable else switch (i / 2) {
            0 => .evm,
            1 => .svm,
            else => .hedged_call,
        }, .cooperative = i != 6 and i % 2 == 1, .mode = mode };
        initialized += 1;
    }
    var started: usize = 0;
    errdefer {
        for (jobs[0..started]) |*job| job.cancel.store(true, .release);
        for (threads[0..started]) |thread| thread.join();
    }
    for (0..count) |i| {
        threads[i] = try std.Thread.spawn(.{}, Job.run, .{&jobs[i]});
        started += 1;
    }
    var timer = try std.time.Timer.start();
    var canceled = false;
    while (true) {
        const all_done = for (jobs[0..count]) |*job| {
            if (!job.done.load(.acquire)) break false;
        } else true;
        if (all_done) break;
        if (mode == .cancel_pending and !canceled and server.acceptedCount() == count) {
            for (jobs[0..count]) |*job| job.cancel.store(true, .release);
            canceled = true;
        }
        if (timer.read() > 45 * std.time.ns_per_s) return error.FallbackMatrixFixtureDeadline;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    for (threads[0..started]) |thread| thread.join();
    started = 0;
    for (jobs[0..count]) |job| if (job.failure) |err| return err;
    try server.check();
    for (0..count) |i| {
        try std.testing.expectEqual(@as(usize, if (mode == .precancel or mode == .expired) 0 else 1), server.pathHits(i * 2));
        try std.testing.expectEqual(@as(usize, if (mode == .live) 1 else 0), server.pathHits(i * 2 + 1));
        if (mode == .live) {
            var pair: [2]?*const fixture.Record = .{ null, null };
            for (server.records[0..server.acceptedCount()]) |*record| {
                const index = try std.fmt.parseInt(usize, record.pathText()[1..], 10);
                if (index == i * 2) pair[0] = record else if (index == i * 2 + 1) pair[1] = record;
            }
            try std.testing.expectEqualStrings(pair[0].?.bodyText(), pair[1].?.bodyText());
        }
    }
}

test "fallback owner actual Resources EVM SVM and configured sequential methods retain full20s plus immutable hedge30s" {
    try matrix(.live);
}
test "fallback owner actual direct client-only Clock and retained replay clamp before second peer" {
    try matrix(.clamped);
}
test "fallback owner actual expired clocks never admit peers" {
    try matrix(.expired);
}
test "fallback owner actual precancel never admits peers" {
    try matrix(.precancel);
}
test "fallback owner actual accepted request cancellation drains without second peer" {
    try matrix(.cancel_pending);
}

test "fallback owner EVM metadata fork selects retained owner and drops direct callback deadline" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = evm_result }} }, .{ .replies = &.{.{ .body = evm_result }} } };
    var server = try fixture.Fixture.init(0, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    var chain = chainFor(&.{ first, second }, .evm);
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const network = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .request_timeout_ms = 20000 });
    defer network.deinit();
    network.clients.ethereum.options.owner_deadline_ns = 1;
    var origin: struct {} = .{};
    var source: @import("relayer/evm_source.zig").Source(@TypeOf(origin)) = .{ .allocator = a, .client = network.clients.ethereum, .block_number = 1, .origin = &origin };
    var cancel: std.atomic.Value(bool) = .init(false);
    const child = try source.fork(a, &cancel);
    defer child.deinitFork();
    try std.testing.expect(child.replay.?.config.use_owner_timeout);
    try std.testing.expect(child.client.options.owner_deadline_ns == null);
    try std.testing.expect(child.client.options.async_pool == network.rpc_pool);
    try child.beginPass(&cancel);
    child.endPass(null);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
}

test "fallback owner actual protected estimate scope carries short Clock and restores its client" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = evm_result }} } };
    var server = try fixture.Fixture.init(2, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    var chain = chainFor(&.{ first, second }, .evm);
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const network = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .request_timeout_ms = 20000 });
    defer network.deinit();
    const client = network.clients.ethereum;
    const original = client.options;
    {
        var scope = try @import("agents/relayer/rpc_budget.zig").Scope.init(client, 300);
        scope.attach();
        defer scope.deinit();
        try std.testing.expectError(error.RequestDeadlineExceeded, client.call("eth_blockNumber", .{}));
    }
    try std.testing.expect(client.options.owner_deadline_ns == original.owner_deadline_ns);
    try std.testing.expect(client.options.exchange.?.context == original.exchange.?.context);
    try std.testing.expectEqual(original.timeout_ms, client.options.timeout_ms);
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 0), server.pathHits(1));
}

test "fallback owner configured hedge preserves nonretryable eth_call envelope without second peer" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const remote = "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":3,\"message\":\"execution reverted\",\"data\":\"0x12\"}}";
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = remote }} }, .{ .replies = &.{.{ .body = evm_result }} } };
    var server = try fixture.Fixture.init(2, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    var chain = chainFor(&.{ first, second }, .hedged_call);
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const network = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .request_timeout_ms = 20000 });
    defer network.deinit();
    network.clients.ethereum.options.owner_deadline_ns = (try http.rpcNowNs()) + 120 * std.time.ns_per_s;
    var response = try network.clients.ethereum.callEnvelope("eth_call", .{ .{ .to = "0x0000000000000000000000000000000000000001" }, "latest" });
    defer response.deinit();
    try std.testing.expect(response.isError());
    try std.testing.expectEqual(@as(?i64, 3), network.clients.ethereum.last_rpc_error_code);
    try std.testing.expectEqualStrings(remote, response.bytes);
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 0), server.pathHits(1));
}

test "fallback owner producer opt-in leaves single quorum and independent native votes unchanged" {
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = evm_result }} }, .{ .replies = &.{.{ .body = evm_result }} } };
    var server = try fixture.Fixture.init(0, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    for ([_]settings.Consensus{ .single, .quorum }) |consensus| {
        var chain = chainFor(&.{ first, second }, .evm);
        chain.connection.ethereum.consensus = consensus;
        const network = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .cooperative_reads = true });
        defer network.deinit();
        try std.testing.expect(!network.read_replay.?.config.use_owner_timeout);
        try std.testing.expect(network.rpc_pool.?.config.strategy != .fallback);
        try std.testing.expectEqual(@as(usize, if (consensus == .single) 1 else 2), network.rpc_pool.?.endpointCount());
    }
    var chain = chainFor(&.{ first, second }, .evm);
    const vote = try resources.Resources.open(a, &chain, &env, .{ .curl_library = library, .direct_native_transport = true });
    defer vote.deinit();
    try std.testing.expect(vote.rpc_pool == null and vote.read_replay == null);
    try std.testing.expect(vote.clients.ethereum.options.async_pool == null);
    try std.testing.expectEqual(@as(usize, 0), server.acceptedCount());
}
