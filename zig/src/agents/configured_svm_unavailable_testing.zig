//! Configured native Resources/Pool and actual scraper caller; no native node.
const std = @import("std");
const source = @import("chain_source.zig");
const fixture = @import("../evm/pool_testing.zig");
const settings = @import("../settings/types.zig");
const scraper = @import("scraper/sealevel.zig");
const A = std.mem.Allocator;
fn replyCode(a: A, body: []const u8, code: i64, always_present: bool) ![]u8 {
    var p = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer p.deinit();
    const value = p.value;
    const method = value.object.get("method").?.string;
    if (std.mem.eql(u8, method, "getBlockHeight")) return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = value.object.get("id").?, .result = @as(u64, 10) }, .{});
    try std.testing.expectEqualStrings("getBlock", method);
    const slot = value.object.get("params").?.array.items[0].integer;
    if (slot == 10 and !always_present) return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = value.object.get("id").?, .@"error" = .{ .code = code, .message = "Slot10 was skipped, or missing due to ledger jump" } }, .{});
    try std.testing.expect(slot == 9 or slot == 10);
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = value.object.get("id").?, .result = .{ .blockhash = "11111111111111111111111111111111", .previousBlockhash = "11111111111111111111111111111111", .blockTime = @as(u64, 1) } }, .{});
}
fn reply(a: A, body: []const u8) ![]u8 {
    return replyCode(a, body, -32009, false);
}
fn respond(comptime code: i64, comptime present: bool) *const fn (A, []const u8) anyerror![]u8 {
    return struct {
        fn call(a: A, body: []const u8) ![]u8 {
            return replyCode(a, body, code, present);
        }
    }.call;
}
fn chain(urls: []const []const u8) settings.Chain {
    var value = @import("chain_source_testing.zig").chainFor(urls);
    value.protocol = .sealevel;
    value.index.mode = .sequence;
    value.index.chunk = 1;
    value.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = null, .native_token_decimals = 9 } };
    return value;
}
test "configured SVM unavailable slot permits actual sparse scraper range progress after retries" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var configured = chain(&.{url});
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
    defer adapter.deinit();
    const block = try adapter.base.rangeEnd(0, 10, 10, true);
    try std.testing.expectEqual(@as(u64, 9), block.height);
    try std.testing.expectEqual(@as(usize, 5), server.acceptedCount());
    try server.check();
}

test "configured SVM unavailable all four Source codes retain basic metadata only after retries" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const responders = [_]*const fn (A, []const u8) anyerror![]u8{ respond(-32001, false), respond(-32004, false), respond(-32007, false), respond(-32009, false) };
    for (responders) |reply_fn| {
        const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply_fn }};
        var server = try fixture.Fixture.init(16, &behaviors);
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        var configured = chain(&.{url});
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library });
        defer resources.deinit();
        const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
        defer adapter.deinit();
        const event: @import("scraper/source.zig").Event = .{ .block_number = 10, .block_hash = @splat(0), .address = configured.contracts.mailbox, .tx_hash = null, .sequence = 42, .log_index = 0, .data = .{ .delivery = @splat(4) } };
        const actual = try scraper.NativeTests.resolve(adapter, event, @splat(5), configured.contracts.mailbox, .delivery);
        try std.testing.expect(actual.tx_hash == null);
        try std.testing.expectEqual(@as(u64, 10), actual.block_number);
        try std.testing.expectEqual(@as(u32, 42), actual.sequence.?);
        try std.testing.expectEqual(@as(u64, 0), actual.log_index);
        try std.testing.expectEqual(@as(usize, 4), server.acceptedCount());
        try server.check();
    }
}
fn blockCalls(server: *fixture.Fixture, endpoint: usize) !usize {
    var count: usize = 0;
    for (server.records[0..server.acceptedCount()]) |*record| {
        var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, record.bodyText(), .{});
        defer parsed.deinit();
        if (std.mem.eql(u8, parsed.value.object.get("method").?.string, "getBlock") and record.pathText().len == 2 and record.pathText()[1] == '0' + endpoint) count += 1;
    }
    return count;
}
test "configured SVM unavailable first pruned provider never hides later healthy block" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = "" }}, .response_fn = reply },
        .{ .replies = &.{.{ .body = "" }}, .response_fn = respond(-32009, true) },
    };
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const urls = [_][]u8{ try server.url(a, 0), try server.url(a, 1) };
    defer for (urls) |url| a.free(url);
    var configured = chain(&urls);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
    defer adapter.deinit();
    const block = try adapter.base.rangeEnd(0, 10, 10, true);
    try std.testing.expectEqual(@as(u64, 10), block.height);
    try std.testing.expectEqual(@as(usize, 1), try blockCalls(&server, 0));
    try std.testing.expectEqual(@as(usize, 1), try blockCalls(&server, 1));
    try server.check();
}
fn otherMethod(a: A, body: []const u8) ![]u8 {
    var p = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer p.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = p.value.object.get("id").?, .@"error" = .{ .code = @as(i64, -32009), .message = "unavailable" } }, .{});
}
test "configured SVM unavailable mixed unknown error and other methods never become skipped slots" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = "" }}, .response_fn = reply },
        .{ .replies = &.{.{ .body = "" }}, .response_fn = respond(-32014, false) },
    };
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const urls = [_][]u8{ try server.url(a, 0), try server.url(a, 1) };
    defer for (urls) |url| a.free(url);
    var configured = chain(&urls);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
    defer adapter.deinit();
    try std.testing.expectError(error.AllRpcProvidersFailed, adapter.base.rangeEnd(0, 10, 10, true));
    try std.testing.expect(try blockCalls(&server, 0) >= 1 and try blockCalls(&server, 1) >= 1);
    try server.check();
}

const pool = @import("../evm/pool.zig");
const rpc = @import("../evm/provider.zig");
const Bridge = struct {
    fn fetch(raw: *anyopaque, a: A, body: []const u8, options: rpc.Options) !rpc.WireResponse {
        const owner: *pool.Pool = @ptrCast(@alignCast(raw));
        const value = try owner.fetch(a, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes);
        return .{ .bytes = value.bytes, .len = value.len };
    }
};
test "configured SVM unavailable single and quorum retain existing retry distinction" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = otherMethod }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .single = .{ .max_attempts = 2, .retry_delay_ms = 1 } } });
    defer owner.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .protocol = .sealevel, .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
    defer client.deinit();
    try std.testing.expectError(error.RpcError, client.call("getBlock", .{ @as(u64, 10), .{ .commitment = "finalized" } }));
    try std.testing.expectEqual(@as(?i64, -32009), client.last_rpc_error_code);
    try std.testing.expectEqual(@as(usize, 2), server.acceptedCount());
    try std.testing.expectError(error.RpcPoolRetriesExhausted, client.call("getTransaction", .{"public-fixture"}));
    const quorum = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .quorum = .{ .max_attempts = 1 } } });
    defer quorum.deinit();
    client.options.exchange = .{ .context = quorum, .fetch_fn = Bridge.fetch };
    try std.testing.expectError(error.NoQuorumReached, client.call("getBlock", .{ @as(u64, 10), .{ .commitment = "finalized" } }));
    try server.check();
}
test "configured SVM unavailable mixed transport schema HTTP and rate limits never grant sparse progress" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const cases = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = "", .stall = true }} },
        .{ .replies = &.{.{ .body = "{}", .status = 503 }} },
        .{ .replies = &.{.{ .body = "{\"jsonrpc\":\"2.0\",\"error\":null}" }} },
        .{ .replies = &.{.{ .body = "{}", .status = 429 }} },
    };
    for (cases) |bad| {
        const behaviors = [_]fixture.Behavior{ .{ .replies = &.{.{ .body = "" }}, .response_fn = reply }, bad };
        var server = try fixture.Fixture.init(32, &behaviors);
        try server.start();
        defer server.deinit();
        const urls = [_][]u8{ try server.url(a, 0), try server.url(a, 1) };
        defer for (urls) |url| a.free(url);
        var configured = chain(&urls);
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library, .request_timeout_ms = 100, .read_attempt_timeout_ms = 1000 });
        defer resources.deinit();
        const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
        defer adapter.deinit();
        if (adapter.base.rangeEnd(0, 10, 10, true)) |_| return error.MixedFailureGrantedSparseProgress else |err| {
            try std.testing.expect(err != error.SvmBlockUnavailable and err != error.ScraperNoCanonicalBlock);
            try std.testing.expect(err == error.AllRpcProvidersFailed or err == error.RequestDeadlineExceeded);
        }
        try std.testing.expect(try blockCalls(&server, 0) >= 1);
        try server.check();
    }
}
const Counts = struct {
    completed: std.atomic.Value(usize) = .init(0),
    fn event(raw: *anyopaque, value: pool.Event) void {
        const self: *Counts = @ptrCast(@alignCast(raw));
        if (value.kind == .upstream_completed and std.mem.eql(u8, value.method, "getBlock")) {
            _ = self.completed.fetchAdd(1, .release);
        }
    }
};
test "configured SVM unavailable retained original error drains on cancel and original deadline" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var counts: Counts = .{};
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .fallback = .{ .retry_delay_ms = 5000 } }, .observer = .{ .context = &counts, .event_fn = Counts.event } });
    defer owner.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"getBlock\",\"params\":[10,{\"commitment\":\"finalized\"}]}";
    const handle = try owner.submit(body, 5000, 100, 4096);
    var timer = try std.time.Timer.start();
    while (counts.completed.load(.acquire) == 0) {
        if (timer.read() > std.time.ns_per_s) return error.ExpectedRetainedNegativeNotObserved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expect(try owner.poll(handle, a) == null);
    owner.cancel(handle);
    try std.testing.expectError(error.RequestDeadlineExceeded, owner.fetch(a, body, 50, 50, null, 4096));
    try server.check();
}
test "configured SVM unavailable retained negative obeys existing byte quota" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = largeReply }};
    var server = try fixture.Fixture.init(16, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const quota = try (@import("../net/curl_multi.zig").Config{ .library_path = library, .max_response_bytes = 65536, .max_request_bytes = 1024 }).maxReservationPerRequest();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .fallback = .{} }, .max_response_bytes = 65536, .max_request_bytes = 1024, .max_reserved_bytes = quota });
    defer owner.deinit();
    const body = "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"getBlock\",\"params\":[10,{\"commitment\":\"finalized\"}]}";
    if (owner.fetch(a, body, 1000, 100, null, 65536)) |value| {
        a.free(value.bytes);
        return error.ExpectedRetainedEnvelopeQuotaFailure;
    } else |err| try std.testing.expectEqual(error.RpcPoolByteBudgetExceeded, err);
    try server.check();
}

fn largeReply(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .@"error" = .{ .code = @as(i64, -32009), .message = "skipped", .data = @as([]const u8, "p" ** 32768) } }, .{});
}

test "configured SVM unavailable mixed known codes require both providers and full retry exhaustion" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = "" }}, .response_fn = respond(-32004, false) },
        .{ .replies = &.{.{ .body = "" }}, .response_fn = respond(-32009, false) },
    };
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const urls = [_][]u8{ try server.url(a, 0), try server.url(a, 1) };
    defer for (urls) |url| a.free(url);
    var configured = chain(&urls);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library });
    defer resources.deinit();
    const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
    defer adapter.deinit();
    const event: @import("scraper/source.zig").Event = .{ .block_number = 10, .block_hash = @splat(0), .address = configured.contracts.mailbox, .tx_hash = null, .sequence = 42, .log_index = 0, .data = .{ .delivery = @splat(4) } };
    const actual = try scraper.NativeTests.resolve(adapter, event, @splat(5), configured.contracts.mailbox, .delivery);
    try std.testing.expect(actual.tx_hash == null and actual.block_number == 10 and actual.log_index == 0);
    try std.testing.expectEqual(@as(usize, 2), try blockCalls(&server, 0));
    try std.testing.expectEqual(@as(usize, 2), try blockCalls(&server, 1));
    try server.check();
}
fn rateMessage(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .@"error" = .{ .code = @as(i64, -32009), .message = "rate limit" } }, .{});
}
test "configured SVM unavailable known code with rate limit message retains rate policy" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = rateMessage }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .single = .{ .max_attempts = 1 } } });
    defer owner.deinit();
    var client = try rpc.RpcClient.init(a, url, .{ .protocol = .sealevel, .exchange = .{ .context = owner, .fetch_fn = Bridge.fetch } });
    defer client.deinit();
    try std.testing.expectError(error.RpcPoolRetriesExhausted, client.call("getBlock", .{ @as(u64, 10), .{ .commitment = "finalized" } }));
    try std.testing.expect(client.last_rpc_error_code == null);
    try server.check();
}
fn badProbe(a: A, body: []const u8) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    if (std.mem.eql(u8, parsed.value.object.get("method").?.string, "getBlockHeight")) return a.dupe(u8, "{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32014,\"message\":\"node unhealthy\"}}");
    return reply(a, body);
}
test "configured SVM unavailable stale provider failed health probe blocks unresolvable shortcut" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{
        .{ .replies = &.{.{ .body = "" }}, .response_fn = badProbe },
        .{ .replies = &.{.{ .body = "" }}, .response_fn = reply },
    };
    var server = try fixture.Fixture.init(48, &behaviors);
    try server.start();
    defer server.deinit();
    const urls = [_][]u8{ try server.url(a, 0), try server.url(a, 1) };
    defer for (urls) |url| a.free(url);
    var configured = chain(&urls);
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const owner = try pool.Pool.start(a, .{ .library_path = library, .urls = &urls, .height_protocol = .sealevel, .strategy = .{ .fallback = .{ .max_block_time_ms = 0, .attempt_timeout_ms = 20000 } } });
    defer owner.deinit();
    const resources = try source.Resources.open(a, &configured, &environment, .{ .curl_library = library, .borrowed_rpc_pool = owner });
    defer resources.deinit();
    const adapter = try scraper.Adapter.fromChain(a, resources.clients.sealevel, &configured);
    defer adapter.deinit();
    try std.testing.expectError(error.AllRpcProvidersFailed, adapter.base.rangeEnd(0, 10, 10, true));
    var probes: usize = 0;
    for (server.records[0..server.acceptedCount()]) |*record| {
        var parsed = try std.json.parseFromSlice(std.json.Value, a, record.bodyText(), .{});
        defer parsed.deinit();
        if (std.mem.eql(u8, parsed.value.object.get("method").?.string, "getBlockHeight")) probes += 1;
    }
    try std.testing.expect(probes > 0);
    try server.check();
}

const FailAfterFirst = struct {
    allocator: *std.testing.FailingAllocator,
    allocator_mutex: *std.Thread.Mutex,
    armed: bool = false,
    fn event(raw: *anyopaque, value: pool.Event) void {
        const self: *FailAfterFirst = @ptrCast(@alignCast(raw));
        // Pool's owner thread has parsed this first response. Retaining it
        // requires no allocation; fail the subsequent retry's allocation.
        if (!self.armed and value.kind == .upstream_completed and std.mem.eql(u8, value.method, "getBlock")) {
            self.allocator_mutex.lock();
            defer self.allocator_mutex.unlock();
            self.armed = true;
            self.allocator.fail_index = self.allocator.alloc_index;
            self.allocator.resize_fail_index = self.allocator.resize_index;
        }
    }
};
test "configured SVM unavailable retained response is freed after subsequent allocation failure" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = reply }};
    var server = try fixture.Fixture.init(8, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var failing = std.testing.FailingAllocator.init(a, .{});
    var synchronized: std.heap.ThreadSafeAllocator = .{ .child_allocator = failing.allocator() };
    var control: FailAfterFirst = .{ .allocator = &failing, .allocator_mutex = &synchronized.mutex };
    {
        const owner = try pool.Pool.start(synchronized.allocator(), .{ .library_path = library, .urls = &.{url}, .height_protocol = .sealevel, .strategy = .{ .fallback = .{ .retry_delay_ms = 1 } }, .observer = .{ .context = &control, .event_fn = FailAfterFirst.event } });
        defer owner.deinit();
        const body = "{\"jsonrpc\":\"2.0\",\"id\":12,\"method\":\"getBlock\",\"params\":[10,{\"commitment\":\"finalized\"}]}";
        if (owner.fetch(a, body, 1000, 100, null, 4096)) |value| {
            a.free(value.bytes);
            return error.AllocationFailureBecameUnresolvable;
        } else |err| try std.testing.expectEqual(error.OutOfMemory, err);
    }
    try std.testing.expect(control.armed and failing.has_induced_failure);
    try std.testing.expectEqual(failing.allocated_bytes, failing.freed_bytes);
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try server.check();
}
