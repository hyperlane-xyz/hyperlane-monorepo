//! RPC-owned native physical timeouts versus the actual absolute caller budget.
const std = @import("std");
const http = @import("../cloud/http.zig");
const curl = @import("curl.zig");
const fixtures = @import("rpc_timeout_fixture.zig");
const common = @import("../agents/scraper/receipts_common.zig");
const a = std.testing.allocator;
fn response(allocator: std.mem.Allocator, body: []const u8) ![]u8 {
    if (body.len == 0) return allocator.dupe(u8, "37");
    var parsed = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
    defer parsed.deinit();
    if (parsed.value == .object) if (parsed.value.object.get("id")) |id| return std.json.Stringify.valueAlloc(allocator, .{ .jsonrpc = "2.0", .id = id, .result = 37 }, .{});
    return allocator.dupe(u8, "{\"block_header\":{\"raw_data\":{\"number\":37,\"timestamp\":1000}},\"blockID\":\"" ++ "00000000000000000000000000000000" ++ "00000000000000000000000000000001" ++ "\"}");
}
const Family = enum { starknet, tron, aleo };
fn read(allocator: std.mem.Allocator, transport: http.Transport, endpoints: []const @import("endpoint.zig").Endpoint, family: Family) !u64 {
    switch (family) {
        .starknet => {
            var client: @import("../starknet/provider.zig").Provider = .{ .allocator = allocator, .client = try @import("json_rpc.zig").Client.init(allocator, transport, endpoints, .{}) };
            return client.blockNumber();
        },
        .tron => {
            const values = try allocator.alloc(@import("../tron/rpc.zig").Endpoint, endpoints.len);
            defer allocator.free(values);
            for (endpoints, values) |input, *out| out.* = .{ .url = input.url, .headers = input.headers };
            var pool: @import("../tron/rpc.zig").Pool = .{ .allocator = allocator, .transport = transport, .endpoints = values };
            var result = try pool.wallet("/wallet/getnowblock", .{});
            defer result.deinit();
            return (try @import("../tron/provider.zig").Block.parse(result.value())).number;
        },
        .aleo => {
            var client = try @import("../aleo/rest.zig").Client.init(allocator, transport, endpoints, 0);
            var result = try client.get(&.{ "block", "height", "latest" }, &.{});
            defer result.deinit();
            return @import("json_rpc.zig").integer(u64, result.value());
        },
    }
}
const Job = struct {
    family: Family,
    library: []const u8,
    endpoints: []const @import("endpoint.zig").Endpoint,
    retry_timeout: bool = true,
    failure: ?anyerror = null,
    fn run(self: *Job) void {
        self.execute() catch |err| {
            self.failure = err;
        };
    }
    fn execute(self: *Job) !void {
        var native = try curl.Client.init(a, self.library);
        defer native.deinit();
        var transport = http.HttpTransport.init(a);
        defer transport.deinit();
        transport.native_curl = &native;
        transport.allow_insecure_loopback = true;
        transport.timeout_ms = 20000; // Actual production physical request limit.
        transport.connect_timeout_ms = 5000;
        var cancel: std.atomic.Value(bool) = .init(false);
        transport.cancel = &cancel;
        transport.rpc_read_owner = .{ .retry_physical_timeout = self.retry_timeout, .deadline_ns = (try http.rpcNowNs()) + 120000 * std.time.ns_per_ms };
        if (self.retry_timeout) {
            try std.testing.expectEqual(@as(u64, 37), try read(a, transport.interface(), self.endpoints, self.family));
        } else try std.testing.expectError(error.RequestDeadlineExceeded, read(a, transport.interface(), self.endpoints, self.family));
    }
};
test "RPC timeout actual20s physical limit reaches healthy second peer with live120s owner for Starknet Tron Aleo" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = "" }}, .response_fn = response } };
    var server = try fixtures.Fixture.init(7, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    const endpoints = [_]@import("endpoint.zig").Endpoint{ .{ .url = first }, .{ .url = second } };
    var jobs = [_]Job{ .{ .family = .starknet, .library = library, .endpoints = &endpoints }, .{ .family = .tron, .library = library, .endpoints = &endpoints }, .{ .family = .aleo, .library = library, .endpoints = &endpoints }, .{ .family = .starknet, .library = library, .endpoints = &endpoints, .retry_timeout = false } };
    var threads: [4]std.Thread = undefined;
    var started: usize = 0;
    errdefer {
        server.stop.store(true, .release);
        for (threads[0..started]) |thread| thread.join();
    }
    for (&jobs, &threads) |*job, *thread| {
        thread.* = try std.Thread.spawn(.{}, Job.run, .{job});
        started += 1;
    }
    for (threads) |thread| thread.join();
    started = 0;
    for (jobs) |job| if (job.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 4), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 3), server.pathHits(1));
    try server.check();
}

test "RPC timeout real owner clamp equal expiry and cancellation never try second peer" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = "" }}, .response_fn = response } };
    var server = try fixtures.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    const endpoints = [_]@import("endpoint.zig").Endpoint{ .{ .url = first }, .{ .url = second } };
    var native = try curl.Client.init(a, library);
    defer native.deinit();
    var transport = http.HttpTransport.init(a);
    defer transport.deinit();
    transport.native_curl = &native;
    transport.allow_insecure_loopback = true;
    transport.timeout_ms = 20000;
    for ([_]struct { physical_ms: u32, owner_ms: u64 }{ .{ .physical_ms = 20000, .owner_ms = 50 }, .{ .physical_ms = 100, .owner_ms = 100 } }) |limits| {
        transport.timeout_ms = limits.physical_ms;
        transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) + limits.owner_ms * std.time.ns_per_ms };
        try std.testing.expectError(error.RequestDeadlineExceeded, read(a, transport.interface(), &endpoints, .starknet));
    }
    // An ordinary credentials/storage owner has no RPC aggregate authority.
    transport.rpc_read_owner = null;
    transport.timeout_ms = 50;
    try std.testing.expectError(error.RequestDeadlineExceeded, read(a, transport.interface(), &endpoints, .starknet));
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) - 1 };
    try std.testing.expectError(error.RequestDeadlineExceeded, read(a, transport.interface(), &endpoints, .starknet));
    var cancel: std.atomic.Value(bool) = .init(true);
    transport.cancel = &cancel;
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) + std.time.ns_per_s };
    try std.testing.expectError(error.RequestCancelled, read(a, transport.interface(), &endpoints, .starknet));
    try std.testing.expectEqual(@as(usize, 0), server.pathHits(1));
}

test "RPC timeout cancellation during actual native pending request aborts without healthy peer" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{ .{ .replies = &.{.{ .body = "", .stall = true }} }, .{ .replies = &.{.{ .body = "" }}, .response_fn = response } };
    var server = try fixtures.Fixture.init(2, &behaviors);
    try server.start();
    defer server.deinit();
    const first = try server.url(a, 0);
    defer a.free(first);
    const second = try server.url(a, 1);
    defer a.free(second);
    const endpoints = [_]@import("endpoint.zig").Endpoint{ .{ .url = first }, .{ .url = second } };
    var native = try curl.Client.init(a, library);
    defer native.deinit();
    var transport = http.HttpTransport.init(a);
    defer transport.deinit();
    transport.native_curl = &native;
    transport.allow_insecure_loopback = true;
    transport.timeout_ms = 20000;
    var cancel: std.atomic.Value(bool) = .init(false);
    transport.cancel = &cancel;
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) + 120 * std.time.ns_per_s };
    const Stop = struct {
        fn run(fixture: *fixtures.Fixture, flag: *std.atomic.Value(bool)) void {
            var waited: usize = 0;
            while (fixture.pathHits(0) == 0 and waited < 5000) : (waited += 1) std.Thread.sleep(std.time.ns_per_ms);
            flag.store(true, .release);
        }
    };
    const stopper = try std.Thread.spawn(.{}, Stop.run, .{ &server, &cancel });
    defer stopper.join();
    try std.testing.expectError(error.RequestCancelled, read(a, transport.interface(), &endpoints, .starknet));
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 0), server.pathHits(1));
}

const Fake = struct {
    owner: ?*http.HttpTransport = null,
    failure: ?anyerror = null,
    seen_owner: ?http.RpcReadOwner = null,
    timeout_ms: u32 = 0,
    called: usize = 0,
    fn send(ctx: *anyopaque, allocator: std.mem.Allocator, request: curl.Request) !curl.Response {
        const self: *Fake = @ptrCast(@alignCast(ctx));
        self.called += 1;
        self.timeout_ms = request.timeout_ms;
        self.seen_owner = if (self.owner) |owner| owner.rpc_read_owner else null;
        if (self.failure) |err| return err;
        const body = try allocator.dupe(u8, "37");
        errdefer allocator.free(body);
        const headers = try allocator.alloc(curl.Header, 0);
        errdefer allocator.free(headers);
        return .{ .allocator = allocator, .body = body, .headers = headers, .header_storage = try allocator.alloc(u8, 0), .status = 200, .http_version = 2 };
    }
};
test "RPC timeout injected controls OOM halt nested owner and nonRPC optout preserve provenance" {
    var fake: Fake = .{};
    var native: curl.Client = .{ .library = undefined, .api = undefined, .send_override = .{ .context = &fake, .send_fn = Fake.send } };
    var transport = http.HttpTransport.init(a);
    defer transport.deinit();
    transport.native_curl = &native;
    transport.timeout_ms = 20000;
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) + 120 * std.time.ns_per_s };
    fake.owner = &transport;
    const request: http.Request = .{ .method = .POST, .url = "https://fixture.invalid/rpc", .body = "{}" };
    for ([_]anyerror{ error.RequestDeadlineExceeded, error.OutOfMemory, error.ResponseHeadersTooLarge, error.RequestCancelled }) |err| {
        fake.failure = err;
        try std.testing.expectError(err, transport.interface().send(a, request));
    }
    var halt: std.atomic.Value(bool) = .init(true);
    transport.rpc_read_owner.?.halt = &halt;
    const before = fake.called;
    try std.testing.expectError(error.CheckpointEffectsHalted, transport.interface().send(a, request));
    try std.testing.expectEqual(before, fake.called);
    halt.store(false, .release);
    const parent_deadline = (try http.rpcNowNs()) + 100 * std.time.ns_per_ms;
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = parent_deadline, .halt = &halt };
    var wrapper: common.DeadlineTransport = .{ .owner = &transport, .deadline_ns = (try http.rpcNowNs()) + 500 * std.time.ns_per_ms, .allow_std_fixture = true, .rpc_read = true };
    fake.failure = error.RequestDeadlineExceeded;
    try std.testing.expectError(error.RequestDeadlineExceeded, wrapper.interface().send(a, request));
    try std.testing.expectEqual(parent_deadline, fake.seen_owner.?.deadline_ns);
    try std.testing.expect(fake.seen_owner.?.halt == &halt);
    try std.testing.expectEqual(parent_deadline, transport.rpc_read_owner.?.deadline_ns);
    wrapper.rpc_read = false; // Prover/auth keep the true deadline, not RPC retries.
    try std.testing.expectError(error.RequestDeadlineExceeded, wrapper.interface().send(a, request));
    try std.testing.expect(!fake.seen_owner.?.retry_physical_timeout);
    try std.testing.expectEqual(parent_deadline, fake.seen_owner.?.deadline_ns);
    try std.testing.expect(fake.seen_owner.?.halt == &halt);
    try std.testing.expectEqual(parent_deadline, transport.rpc_read_owner.?.deadline_ns);
    try std.testing.expect(transport.rpc_read_owner.?.retry_physical_timeout);
    transport.rpc_read_owner.?.retry_physical_timeout = false;
    wrapper.rpc_read = true;
    try std.testing.expectError(error.RequestDeadlineExceeded, wrapper.interface().send(a, request));
    try std.testing.expect(!fake.seen_owner.?.retry_physical_timeout);
    try std.testing.expectEqual(parent_deadline, fake.seen_owner.?.deadline_ns);
    wrapper.rpc_read = false;
    halt.store(true, .release);
    const before_halted_non_rpc = fake.called;
    try std.testing.expectError(error.CheckpointEffectsHalted, wrapper.interface().send(a, request));
    try std.testing.expectEqual(before_halted_non_rpc, fake.called);
    halt.store(false, .release);
    transport.rpc_read_owner.?.deadline_ns = 1;
    try std.testing.expectError(error.ScraperReceiptDeadline, wrapper.interface().send(a, request));
    try std.testing.expectEqual(before_halted_non_rpc, fake.called);
}
fn allocate(allocator: std.mem.Allocator) !void {
    var fake: Fake = .{};
    var native: curl.Client = .{ .library = undefined, .api = undefined, .send_override = .{ .context = &fake, .send_fn = Fake.send } };
    var transport = http.HttpTransport.init(allocator);
    defer transport.deinit();
    transport.native_curl = &native;
    transport.rpc_read_owner = .{ .retry_physical_timeout = true, .deadline_ns = (try http.rpcNowNs()) + std.time.ns_per_s };
    var result = try transport.interface().send(allocator, .{ .method = .POST, .url = "https://fixture.invalid/rpc", .body = "{}" });
    result.deinit();
}
test "RPC timeout owner response allocation failures preserve OOM and release native result" {
    try std.testing.checkAllAllocationFailures(a, allocate, .{});
}
