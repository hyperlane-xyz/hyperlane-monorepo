const std = @import("std");
const pool = @import("evm/pool.zig");
const testing = @import("evm/pool_testing.zig");
const provider = @import("evm/provider.zig");
const A = std.mem.Allocator;

const Urls = struct {
    items: [][]const u8,
    fn init(allocator: A, fixture: *testing.Fixture, count: usize) !Urls {
        const items = try allocator.alloc([]const u8, count);
        var initialized: usize = 0;
        errdefer {
            for (items[0..initialized]) |url| allocator.free(url);
            allocator.free(items);
        }
        for (items, 0..) |*url, index| {
            url.* = try fixture.url(allocator, index);
            initialized += 1;
        }
        return .{ .items = items };
    }
    fn deinit(self: *Urls, allocator: A) void {
        for (self.items) |url| allocator.free(url);
        allocator.free(self.items);
    }
};

fn fetch(pool_: *pool.Pool, body: []const u8, timeout_ms: u32) !pool.WireResponse {
    return pool_.fetch(std.testing.allocator, body, timeout_ms, @min(timeout_ms, 50), null, 1024 * 1024);
}

fn exchange(context: *anyopaque, allocator: A, body: []const u8, options: provider.Options) anyerror!provider.WireResponse {
    const client: *pool.Pool = @ptrCast(@alignCast(context));
    const response = try client.fetch(allocator, body, options.timeout_ms, options.connect_timeout_ms, options.cancel, options.max_response_bytes);
    return .{ .bytes = response.bytes, .len = response.len };
}

fn waitAccepted(fixture: *testing.Fixture, expected: usize) !void {
    var timer = try std.time.Timer.start();
    while (fixture.acceptedCount() < expected) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureAcceptTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

fn waitEventCount(log: *EventLog, kind: pool.EventKind, expected: usize) !void {
    var timer = try std.time.Timer.start();
    while (log.count(kind) < expected) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.ObserverEventTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

fn behaviors(comptime count: usize, replies: []const testing.Reply, stalled: usize) [count]testing.Behavior {
    var result: [count]testing.Behavior = undefined;
    for (&result, 0..) |*behavior, index| behavior.* = .{ .replies = if (index < stalled) &.{.{ .body = "", .stall = true }} else replies };
    return result;
}

const EventLog = struct {
    mutex: std.Thread.Mutex = .{},
    events: [512]pool.Event = undefined,
    len: usize = 0,

    fn record(context: *anyopaque, event: pool.Event) void {
        const self: *EventLog = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        if (self.len < self.events.len) {
            self.events[self.len] = event;
            self.len += 1;
        }
    }

    fn observer(self: *EventLog) pool.Observer {
        return .{ .context = self, .event_fn = record };
    }

    fn count(self: *EventLog, kind: pool.EventKind) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        var result: usize = 0;
        for (self.events[0..self.len]) |event| if (event.kind == kind) {
            result += 1;
        };
        return result;
    }

    fn hasEndpoint(self: *EventLog, kind: pool.EventKind, index: u16) bool {
        self.mutex.lock();
        defer self.mutex.unlock();
        for (self.events[0..self.len]) |event| if (event.kind == kind and event.endpoint_index == index) return true;
        return false;
    }
};

const TestClock = struct {
    now_ms: std.atomic.Value(u64) = .init(0),
    fn now(context: *anyopaque) u64 {
        const self: *TestClock = @ptrCast(@alignCast(context));
        return self.now_ms.load(.acquire);
    }
    fn clock(self: *TestClock) pool.Clock {
        return .{ .context = self, .now_ms_fn = now };
    }
};

fn testEntropy(_: *anyopaque, minimum: u32, _: u32) u32 {
    return if (minimum == 1) 500 else 20_000;
}

const WorkJob = struct {
    client: *pool.Pool,
    body: []const u8,
    timeout_ms: u32 = 5000,
    response: ?pool.WireResponse = null,
    failure: ?anyerror = null,

    fn run(self: *WorkJob) void {
        const response = self.client.fetch(std.testing.allocator, self.body, self.timeout_ms, 50, null, 1024 * 1024) catch |err| {
            self.failure = err;
            return;
        };
        self.response = response;
    }

    fn deinit(self: *WorkJob) void {
        if (self.response) |response| std.testing.allocator.free(response.bytes);
    }
};

test "native single deduplicates canonical identities and returns owned response" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const replies = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
    var fixture = try testing.Fixture.init(1, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    const duplicate = try allocator.dupe(u8, urls.items[0]);
    defer allocator.free(duplicate);
    const both = [_][]const u8{ urls.items[0], duplicate };
    const client = try pool.Pool.start(allocator, testing.config(library, &both, .{ .single = .{} }));
    defer client.deinit();
    try std.testing.expectEqual(@as(usize, 1), client.endpointCount());
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes[0..response.len]);
    try fixture.check();
}

test "provider exchange adapter preserves root typed response validation" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const replies = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
    var fixture = try testing.Fixture.init(1, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .single = .{} }));
    defer client.deinit();
    var rpc = try provider.RpcClient.init(allocator, "http://fixture.invalid/rpc", .{ .exchange = .{ .context = client, .fetch_fn = exchange }, .timeout_ms = 1000, .connect_timeout_ms = 50, .max_response_bytes = 1024 * 1024 });
    defer rpc.deinit();
    try std.testing.expectEqual(@as(u64, 1), try rpc.chainId());
    try std.testing.expectEqual(@as(i64, 2), rpc.next_id);
    try fixture.check();
}

test "native quorum fans out beyond eight stalled peers and wins early while denominator stays fixed" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const replies = testing.oneReply(testing.chain_id_ok);
    const behavior_list = behaviors(12, &replies, 8);
    var fixture = try testing.Fixture.init(12, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 12);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 4 } }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
    try waitAccepted(&fixture, 12);
    try std.testing.expectEqual(@as(usize, 12), fixture.acceptedCount());
    try fixture.check();
}

test "native quorum failed and pending slots cannot lower configured denominator" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const replies = testing.oneReply(testing.chain_id_ok);
    const behavior_list = behaviors(12, &replies, 8);
    var fixture = try testing.Fixture.init(12, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 12);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 9, .retry_delay_ms = 1, .max_attempts = 1 } }));
    defer client.deinit();
    try std.testing.expectError(error.RequestDeadlineExceeded, fetch(client, testing.chain_id_body, 100));
    try waitAccepted(&fixture, 12);
    try fixture.check();
}

test "native quorum detects impossible agreement without waiting for deadline" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const reply_lists = [_][1]testing.Reply{
        testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":1}"),
        testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":2}"),
        testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":3}"),
        testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":4}"),
    };
    const behavior_list = [_]testing.Behavior{ .{ .replies = &reply_lists[0] }, .{ .replies = &reply_lists[1] }, .{ .replies = &reply_lists[2] }, .{ .replies = &reply_lists[3] } };
    var fixture = try testing.Fixture.init(4, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 4);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 3, .max_attempts = 1 } }));
    defer client.deinit();
    try std.testing.expectError(error.NoQuorumReached, fetch(client, testing.chain_id_body, 1000));
    try fixture.check();
}

test "hedged fallback refills after retryable hedge and preserves exact request" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByHash\",\"params\":[\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\",false]}";
    const retry = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x2\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}");
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &.{.{ .body = "", .stall = true }} },
        .{ .replies = &retry },
        .{ .replies = &ok },
    };
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{ .hedge = .{ .delay_ms = 5, .attempt_timeout_ms = 100 } } }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(ok[0].body, response.bytes);
    try waitAccepted(&fixture, 3);
    for (fixture.records[0..3]) |*record| try std.testing.expectEqualStrings(body, record.bodyText());
    try fixture.check();
}

test "hedged fallback per-attempt timeouts bound all stalled providers" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByHash\",\"params\":[\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\",false]}";
    const behavior_list = behaviors(2, &.{}, 2);
    var fixture = try testing.Fixture.init(4, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{ .retry_delay_ms = 1, .hedge = .{ .delay_ms = 2, .attempt_timeout_ms = 15 } } }));
    defer client.deinit();
    try std.testing.expectError(error.AllRpcProvidersFailed, fetch(client, body, 500));
    try std.testing.expectEqual(@as(usize, 4), fixture.acceptedCount());
    try fixture.check();
}

test "raw transaction multicast sends identical bytes and first success cancels losers" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[\"0xdeadbeef\"]}";
    const ok = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1234\"}");
    const behavior_list = behaviors(3, &ok, 1);
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{} }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(ok[0].body, response.bytes);
    try waitAccepted(&fixture, 3);
    for (fixture.records[0..3]) |*record| try std.testing.expectEqualStrings(body, record.bodyText());
    try fixture.check();
}

test "structured reverts and estimate errors are nonretryable raw envelopes" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const cases = [_]struct { method: []const u8, message: []const u8 }{
        .{ .method = "eth_call", .message = "execution reverted: rate limit application reason" },
        .{ .method = "eth_estimateGas", .message = "temporary provider failure" },
        .{ .method = "eth_sendRawTransaction", .message = "already known" },
    };
    for (cases) |case| {
        const body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{s}\",\"params\":[]}}", .{case.method});
        defer allocator.free(body);
        const error_body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{{\"code\":3,\"message\":\"{s}\",\"data\":{{\"reason\":\"0x1234\"}}}}}}", .{case.message});
        defer allocator.free(error_body);
        const replies = testing.oneReply(error_body);
        const behavior_list = behaviors(2, &replies, 0);
        var fixture = try testing.Fixture.init(1, &behavior_list);
        defer fixture.deinit();
        try fixture.start();
        var urls = try Urls.init(allocator, &fixture, 2);
        defer urls.deinit(allocator);
        const strategy: pool.Strategy = if (std.mem.eql(u8, case.method, "eth_sendRawTransaction")) .{ .single = .{} } else .{ .fallback = .{} };
        const selected_urls = if (strategy == .single) urls.items[0..1] else urls.items;
        const client = try pool.Pool.start(allocator, testing.config(library, selected_urls, strategy));
        defer client.deinit();
        const response = try fetch(client, body, 1000);
        defer allocator.free(response.bytes);
        try std.testing.expectEqualStrings(error_body, response.bytes);
        try std.testing.expectEqual(@as(usize, 1), fixture.acceptedCount());
        var parsed = try std.json.parseFromSlice(std.json.Value, allocator, response.bytes, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(@as(i64, 3), parsed.value.object.get("error").?.object.get("code").?.integer);
        try std.testing.expectEqualStrings("0x1234", parsed.value.object.get("error").?.object.get("data").?.object.get("reason").?.string);
        try fixture.check();
    }
}

test "fallback retries transient RPC error then succeeds at next provider" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const temporary = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &temporary }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{} }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
    try fixture.check();
}

test "single retries malformed JSON and mismatched IDs but never accepts them" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const sequences = [_][3][]const u8{
        .{ "not json", testing.chain_id_ok, testing.chain_id_ok },
        .{ "{\"jsonrpc\":\"2.0\",\"id\":2,\"result\":\"0x2\"}", testing.chain_id_ok, testing.chain_id_ok },
    };
    for (sequences) |sequence| {
        const replies = [_]testing.Reply{ .{ .body = sequence[0] }, .{ .body = sequence[1] } };
        const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
        var fixture = try testing.Fixture.init(2, &behavior_list);
        defer fixture.deinit();
        try fixture.start();
        var urls = try Urls.init(allocator, &fixture, 1);
        defer urls.deinit(allocator);
        const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .single = .{ .max_attempts = 2, .retry_delay_ms = 1 } }));
        defer client.deinit();
        const response = try fetch(client, testing.chain_id_body, 1000);
        defer allocator.free(response.bytes);
        try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
        try fixture.check();
    }
}

test "single exhausts bounded retries on persistent bad JSON" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const replies = testing.oneReply("not json");
    const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .single = .{ .max_attempts = 2, .retry_delay_ms = 1 } }));
    defer client.deinit();
    try std.testing.expectError(error.RpcPoolRetriesExhausted, fetch(client, testing.chain_id_body, 1000));
    try std.testing.expectEqual(@as(usize, 2), fixture.acceptedCount());
    try fixture.check();
}

test "endpoint authorization headers stay isolated across multicast" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[\"0xdeadbeef\"]}";
    const replies = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1234\"}");
    const behavior_list = behaviors(2, &replies, 0);
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var plain = try Urls.init(allocator, &fixture, 2);
    defer plain.deinit(allocator);
    const first = try std.fmt.allocPrint(allocator, "{s}?custom_rpc_header=X-Api-Key:first", .{plain.items[0]});
    defer allocator.free(first);
    const second = try std.fmt.allocPrint(allocator, "{s}?custom_rpc_header=X-Api-Key:second", .{plain.items[1]});
    defer allocator.free(second);
    const urls = [_][]const u8{ first, second };
    const client = try pool.Pool.start(allocator, testing.config(library, &urls, .{ .fallback = .{} }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try waitAccepted(&fixture, 2);
    try std.testing.expectEqualStrings("first", fixture.records[0].apiKeyText());
    try std.testing.expectEqualStrings("second", fixture.records[1].apiKeyText());
    try std.testing.expectEqual(@as(usize, 0), fixture.records[0].authorizationText().len);
    try std.testing.expectEqual(@as(usize, 0), fixture.records[1].authorizationText().len);
    try fixture.check();
}

test "quorum normalization keeps large integers exact and ignores key order" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const first = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":9007199254740993,\"unit\":1.0,\"o\":{\"a\":1,\"b\":2}}}");
    const second = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"o\":{\"b\":2,\"a\":1},\"unit\":1e0,\"n\":9007199254740993}}");
    const different = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"n\":9007199254740992,\"unit\":1.0,\"o\":{\"a\":1,\"b\":2}}}");
    const behavior_list = [_]testing.Behavior{ .{ .replies = &first }, .{ .replies = &second }, .{ .replies = &different } };
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2 } }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expect(std.mem.indexOf(u8, response.bytes, "9007199254740993") != null);
    try fixture.check();
}

const CancelJob = struct {
    client: *pool.Pool,
    cancel: *std.atomic.Value(bool),
    failure: ?anyerror = null,
    fn run(self: *CancelJob) void {
        const response = self.client.fetch(std.testing.allocator, testing.chain_id_body, 5000, 50, self.cancel, 1024 * 1024) catch |err| {
            self.failure = err;
            return;
        };
        std.testing.allocator.free(response.bytes);
    }
};

test "external cancellation retires native owner without peer worker threads" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const behavior_list = behaviors(1, &.{}, 1);
    var fixture = try testing.Fixture.init(1, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .single = .{} }));
    var cancel = std.atomic.Value(bool).init(false);
    var job = CancelJob{ .client = client, .cancel = &cancel };
    const thread = try std.Thread.spawn(.{}, CancelJob.run, .{&job});
    try waitAccepted(&fixture, 1);
    cancel.store(true, .release);
    thread.join();
    const cancellation = job.failure orelse return error.MissingCancellation;
    if (cancellation != error.RequestCancelled) return cancellation;
    client.deinit();
    try fixture.check();
}

test "numeric quorum selects threshold-th highest and latest pins subsequent request" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}";
    const reply_lists = [_][2]testing.Reply{
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x65\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" } },
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x66\"}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x65\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" } },
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x65\"}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x65\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" } },
    };
    const behavior_list = [_]testing.Behavior{ .{ .replies = &reply_lists[0] }, .{ .replies = &reply_lists[1] }, .{ .replies = &reply_lists[2] } };
    var fixture = try testing.Fixture.init(6, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2 } }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try waitAccepted(&fixture, 6);
    for (fixture.records[0..6]) |*record| {
        const parsed_body = try std.json.parseFromSlice(std.json.Value, allocator, record.bodyText(), .{});
        defer parsed_body.deinit();
        const method = parsed_body.value.object.get("method").?.string;
        if (std.mem.eql(u8, method, "eth_getBlockByNumber")) {
            const params = parsed_body.value.object.get("params").?.array.items;
            try std.testing.expectEqualStrings("0x65", params[0].string);
        }
    }
    try fixture.check();
}

test "safe dynamic tag uses quorum reachable pinned height" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{},\"safe\"]}";
    const reply_lists = [_][2]testing.Reply{
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x64\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xabc\"}" } },
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x66\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xabc\"}" } },
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x65\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xabc\"}" } },
    };
    const behavior_list = [_]testing.Behavior{ .{ .replies = &reply_lists[0] }, .{ .replies = &reply_lists[1] }, .{ .replies = &reply_lists[2] } };
    var fixture = try testing.Fixture.init(6, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2, .dynamic_tag_grace_floor_ms = 1 } }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(reply_lists[0][1].body, response.bytes);
    try waitAccepted(&fixture, 6);
    for (fixture.records[0..6]) |*record| {
        const parsed_body = try std.json.parseFromSlice(std.json.Value, allocator, record.bodyText(), .{});
        defer parsed_body.deinit();
        if (std.mem.eql(u8, parsed_body.value.object.get("method").?.string, "eth_call")) {
            try std.testing.expectEqualStrings("0x65", parsed_body.value.object.get("params").?.array.items[1].string);
        }
    }
    try fixture.check();
}

test "request and response limits reject before native submission" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const behavior_list = behaviors(1, &.{}, 1);
    var fixture = try testing.Fixture.init(0, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .single = .{} });
    config.max_request_bytes = 32;
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    try std.testing.expectError(error.InvalidRpcRequest, fetch(client, testing.chain_id_body, 100));
    try std.testing.expectError(error.InvalidRpcLimit, client.fetch(allocator, testing.chain_id_body, 100, 10, null, config.max_response_bytes + 1));
    try std.testing.expectEqual(@as(usize, 0), fixture.acceptedCount());
}

test "quorum submissions preserve first success when another peer rejects" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    for ([_][]const u8{ "eth_sendRawTransaction", "eth_sendTransaction" }) |method| {
        const body = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{s}\",\"params\":[]}}", .{method});
        defer allocator.free(body);
        const ok = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1234\"}");
        const known = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"already known\"}}");
        const behavior_list = [_]testing.Behavior{ .{ .replies = &ok }, .{ .replies = &known } };
        var fixture = try testing.Fixture.init(2, &behavior_list);
        defer fixture.deinit();
        try fixture.start();
        var urls = try Urls.init(allocator, &fixture, 2);
        defer urls.deinit(allocator);
        const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2, .max_attempts = 1 } }));
        defer client.deinit();
        const response = try fetch(client, body, 1000);
        defer allocator.free(response.bytes);
        try std.testing.expectEqualStrings(ok[0].body, response.bytes);
        try fixture.check();
    }
}

test "sequential fallback finishes current provider round before retry exhaustion" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const temporary = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &temporary }, .{ .replies = &temporary }, .{ .replies = &temporary }, .{ .replies = &temporary }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(5, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 5);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{ .retry_delay_ms = 1 } }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
    try std.testing.expectEqual(@as(usize, 5), fixture.acceptedCount());
    try fixture.check();
}

test "malformed numeric response only fails its own quorum peer" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const invalid = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":null}");
    const ok = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}");
    const behavior_list = [_]testing.Behavior{ .{ .replies = &invalid }, .{ .replies = &ok }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2, .max_attempts = 1 } }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(ok[0].body, response.bytes);
    try fixture.check();
}

fn largeResponse(allocator: A, marker: u8, size: usize) ![]u8 {
    const prefix = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"";
    const suffix = "\"}";
    const bytes = try allocator.alloc(u8, size);
    @memset(bytes, 'a');
    @memcpy(bytes[0..prefix.len], prefix);
    bytes[prefix.len] = marker;
    @memcpy(bytes[size - suffix.len ..], suffix);
    return bytes;
}

test "retained quorum responses enforce pool byte budget" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const first = try largeResponse(allocator, 'a', 100_000);
    defer allocator.free(first);
    const second = try largeResponse(allocator, 'b', 100_000);
    defer allocator.free(second);
    const third = try largeResponse(allocator, 'c', 100_000);
    defer allocator.free(third);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &.{.{ .body = first }} }, .{ .replies = &.{.{ .body = second }} }, .{ .replies = &.{.{ .body = third }} } };
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .quorum = .{ .threshold = 3, .max_attempts = 1 } });
    config.max_reserved_bytes = 500_000;
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    try std.testing.expectError(error.RpcPoolByteBudgetExceeded, client.fetch(allocator, testing.chain_id_body, 1000, 50, null, 120_000));
}

test "hedge configuration preserves sequential fallback for nonallowlisted methods" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const temporary = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &temporary }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{ .hedge = .{ .delay_ms = 1, .attempt_timeout_ms = 100 } } }));
    defer client.deinit();
    const response = try fetch(client, testing.chain_id_body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(1));
    try fixture.check();
}

test "dynamic tag grace cancels stale preflight before pinned fanout" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{},\"safe\"]}";
    const reply_lists = [_][2]testing.Reply{
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x64\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xabc\"}" } },
        .{ .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x65\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}" }, .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0xabc\"}" } },
        .{ .{ .body = "", .stall = true }, .{ .body = "", .stall = true } },
    };
    const behavior_list = [_]testing.Behavior{ .{ .replies = &reply_lists[0] }, .{ .replies = &reply_lists[1] }, .{ .replies = &reply_lists[2] } };
    var fixture = try testing.Fixture.init(5, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 3);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .quorum = .{ .threshold = 2, .dynamic_tag_grace_floor_ms = 1 } }));
    defer client.deinit();
    const response = try fetch(client, body, 1000);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(reply_lists[0][1].body, response.bytes);
    try waitAccepted(&fixture, 5);
    try std.testing.expectEqual(@as(usize, 2), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), fixture.pathHits(1));
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(2));
    try fixture.check();
}

test "fallback deprioritizes provider after ten failures across requests" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const temporary = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &temporary }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(21, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .retry_delay_ms = 1, .max_block_time_ms = 1_000_000 } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    for (0..11) |_| {
        const response = try fetch(client, testing.chain_id_body, 1000);
        allocator.free(response.bytes);
    }
    try std.testing.expectEqual(@as(usize, 10), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 11), fixture.pathHits(1));
    try std.testing.expect(events.hasEndpoint(.provider_deprioritized, 0));
    try fixture.check();
}

test "low block-height probe deprioritizes after preserving main response" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const main_replies = testing.oneReply(testing.chain_id_ok);
    const probe_replies = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x0\"}");
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &main_replies, .probe_replies = &probe_replies },
        .{ .replies = &main_replies, .probe_replies = &probe_replies },
    };
    var fixture = try testing.Fixture.init(4, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 0, .probe_timeout_ms = 100 } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    std.Thread.sleep(2 * std.time.ns_per_ms);
    for (0..2) |_| {
        const response = try fetch(client, testing.chain_id_body, 1000);
        allocator.free(response.bytes);
    }
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(1));
    try std.testing.expectEqual(@as(usize, 1), fixture.probeHits(0));
    try std.testing.expectEqual(@as(usize, 1), fixture.probeHits(1));
    try std.testing.expect(events.hasEndpoint(.provider_deprioritized, 0));
    try std.testing.expect(events.hasEndpoint(.provider_deprioritized, 1));
    try fixture.check();
}

test "probe timeout is nonfatal and main failure still falls back" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const temporary = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"error\":{\"code\":-32000,\"message\":\"temporary\"}}");
    const ok = testing.oneReply(testing.chain_id_ok);
    const stalled_probe = testing.oneReply("");
    var stalled = stalled_probe;
    stalled[0].stall = true;
    const high_probe = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}");
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &temporary, .probe_replies = &stalled },
        .{ .replies = &ok, .probe_replies = &high_probe },
    };
    var fixture = try testing.Fixture.init(8, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 0, .probe_timeout_ms = 20 } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    std.Thread.sleep(2 * std.time.ns_per_ms);
    for (0..2) |_| {
        const response = try fetch(client, testing.chain_id_body, 1000);
        defer allocator.free(response.bytes);
        try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
    }
    try waitAccepted(&fixture, 8);
    try std.testing.expectEqual(@as(usize, 2), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), fixture.probeHits(0));
    try std.testing.expectEqual(@as(usize, 2), events.count(.probe_timed_out));
    try std.testing.expect(events.hasEndpoint(.provider_failed, 0));
    try fixture.check();
}

test "concurrent stale snapshots share one probe and increasing height preserves priority" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const main_replies = testing.oneReply(testing.chain_id_ok);
    const probe_replies = [_]testing.Reply{
        .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x64\"}", .delay_ms = 100 },
        .{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x65\"}" },
    };
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &main_replies, .probe_replies = &probe_replies },
        .{ .replies = &main_replies },
    };
    var fixture = try testing.Fixture.init(5, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 0, .probe_timeout_ms = 500 } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    std.Thread.sleep(2 * std.time.ns_per_ms);
    var first = WorkJob{ .client = client, .body = testing.chain_id_body };
    var second = WorkJob{ .client = client, .body = testing.chain_id_body };
    defer first.deinit();
    defer second.deinit();
    const first_thread = try std.Thread.spawn(.{}, WorkJob.run, .{&first});
    const second_thread = try std.Thread.spawn(.{}, WorkJob.run, .{&second});
    first_thread.join();
    second_thread.join();
    if (first.failure) |err| return err;
    if (second.failure) |err| return err;
    std.Thread.sleep(2 * std.time.ns_per_ms);
    const third = try fetch(client, testing.chain_id_body, 1000);
    allocator.free(third.bytes);
    try waitAccepted(&fixture, 5);
    try std.testing.expectEqual(@as(usize, 3), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), fixture.probeHits(0));
    try std.testing.expectEqual(@as(usize, 0), fixture.pathHits(1));
    try std.testing.expectEqual(@as(usize, 2), events.count(.probe_started));
    try std.testing.expectEqual(@as(usize, 0), events.count(.provider_deprioritized));
    try fixture.check();
}

test "hedged read starts background probe and next round uses reordered priority" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByHash\",\"params\":[\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\",false]}";
    const main_replies = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"number\":\"0x2\",\"hash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000001\",\"parentHash\":\"0x00000000000000000000000000000000" ++ "00000000000000000000000000000000\",\"timestamp\":\"0x1\"}}");
    const low_probe = [_]testing.Reply{.{ .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x0\"}", .delay_ms = 20 }};
    const high_probe = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}");
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &main_replies, .probe_replies = &low_probe },
        .{ .replies = &main_replies, .probe_replies = &high_probe },
    };
    var fixture = try testing.Fixture.init(4, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 0, .probe_timeout_ms = 100, .hedge = .{ .delay_ms = 100, .attempt_timeout_ms = 100 } } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    std.Thread.sleep(2 * std.time.ns_per_ms);
    const first = try fetch(client, body, 1000);
    allocator.free(first.bytes);
    try waitEventCount(&events, .provider_deprioritized, 1);
    const second = try fetch(client, body, 1000);
    defer allocator.free(second.bytes);
    try waitAccepted(&fixture, 4);
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(1));
    try std.testing.expectEqual(@as(usize, 1), fixture.probeHits(0));
    try std.testing.expectEqual(@as(usize, 1), fixture.probeHits(1));
    try fixture.check();
}

test "shared cooldown survives failed caller and applies deterministic post-wait jitter" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    var clock = TestClock{};
    const replies = [_]testing.Reply{ .{ .status = 429, .body = "" }, .{ .body = testing.chain_id_ok } };
    const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .single = .{ .max_attempts = 1, .retry_delay_ms = 1 } });
    config.clock = clock.clock();
    config.entropy = .{ .context = &clock, .between_fn = testEntropy };
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    try std.testing.expectError(error.RpcPoolRetriesExhausted, fetch(client, testing.chain_id_body, 1000));
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    var second = WorkJob{ .client = client, .body = testing.chain_id_body, .timeout_ms = 50_000 };
    defer second.deinit();
    const thread = try std.Thread.spawn(.{}, WorkJob.run, .{&second});
    try waitEventCount(&events, .cooldown_wait, 1);
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    clock.now_ms.store(20_000, .release);
    try waitEventCount(&events, .cooldown_jitter, 1);
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    clock.now_ms.store(20_500, .release);
    thread.join();
    if (second.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 2), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 1), events.count(.rate_limited));
    try fixture.check();
}

test "active fallback cooldown returns synthetic error without another native hit" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    var events = EventLog{};
    const limited = [_]testing.Reply{.{ .status = 429, .body = "" }};
    const ok = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{ .{ .replies = &limited }, .{ .replies = &ok } };
    var fixture = try testing.Fixture.init(3, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    var config = testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 1_000_000 } });
    config.observer = events.observer();
    const client = try pool.Pool.start(allocator, config);
    defer client.deinit();
    for (0..2) |_| {
        const response = try fetch(client, testing.chain_id_body, 1000);
        allocator.free(response.bytes);
    }
    try std.testing.expectEqual(@as(usize, 1), fixture.pathHits(0));
    try std.testing.expectEqual(@as(usize, 2), fixture.pathHits(1));
    try std.testing.expectEqual(@as(usize, 1), events.count(.rate_limited));
    try fixture.check();
}

fn allocationExercise(allocator: A, library: []const u8) !void {
    const replies = testing.oneReply(testing.chain_id_ok);
    const behavior_list = [_]testing.Behavior{.{ .replies = &replies }};
    var fixture = try testing.Fixture.init(1, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 1);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .single = .{} }));
    defer client.deinit();
    const response = try client.fetch(allocator, testing.chain_id_body, 5000, 100, null, 1024 * 1024);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
}

test "allocator failures release constructor request response and owner resources" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    try std.testing.checkAllAllocationFailures(allocator, allocationExercise, .{library});
}

fn probeAllocationExercise(allocator: A, library: []const u8) !void {
    const main_replies = testing.oneReply(testing.chain_id_ok);
    const probe_replies = testing.oneReply("{\"jsonrpc\":\"2.0\",\"id\":1,\"result\":\"0x1\"}");
    const behavior_list = [_]testing.Behavior{
        .{ .replies = &main_replies, .probe_replies = &probe_replies },
        .{ .replies = &main_replies, .probe_replies = &probe_replies },
    };
    var fixture = try testing.Fixture.init(2, &behavior_list);
    defer fixture.deinit();
    try fixture.start();
    var urls = try Urls.init(allocator, &fixture, 2);
    defer urls.deinit(allocator);
    const client = try pool.Pool.start(allocator, testing.config(library, urls.items, .{ .fallback = .{ .max_block_time_ms = 0, .probe_timeout_ms = 100 } }));
    defer client.deinit();
    std.Thread.sleep(2 * std.time.ns_per_ms);
    const response = try client.fetch(allocator, testing.chain_id_body, 5000, 100, null, 1024 * 1024);
    defer allocator.free(response.bytes);
    try std.testing.expectEqualStrings(testing.chain_id_ok, response.bytes);
}

test "allocator failures release attached probe outcomes" {
    const allocator = std.testing.allocator;
    const library = try testing.nativeLibrary(allocator);
    defer allocator.free(library);
    try std.testing.checkAllAllocationFailures(allocator, probeAllocationExercise, .{library});
}
