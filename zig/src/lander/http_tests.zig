const std = @import("std");
const provider = @import("../evm/provider.zig");
const evm = @import("evm.zig");
const chain = @import("chain.zig");
const types = @import("types.zig");

const Step = struct { method: []const u8, result: []const u8, expect: ?[]const u8 = null };

fn serve(server: *std.net.Server, steps: []const Step, failure: *?anyerror) void {
    serveFallible(server, steps) catch |err| {
        failure.* = err;
    };
}

fn serveFallible(server: *std.net.Server, steps: []const Step) !void {
    for (steps) |step| {
        var waiting = [_]std.posix.pollfd{.{ .fd = server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&waiting, 5000) == 0) return error.FixtureAcceptTimeout;
        const connection = try server.accept();
        defer connection.stream.close();
        var request: [16 * 1024]u8 = undefined;
        var used: usize = 0;
        while (true) {
            var waiting_read = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&waiting_read, 5000) == 0) return error.FixtureReadTimeout;
            const count = try connection.stream.read(request[used..]);
            if (count == 0) return error.UnexpectedEof;
            used += count;
            const header_end = std.mem.indexOf(u8, request[0..used], "\r\n\r\n") orelse continue;
            const length_start = std.ascii.indexOfIgnoreCase(request[0..header_end], "content-length: ") orelse return error.MissingContentLength;
            const value_start = length_start + "content-length: ".len;
            const value_end = std.mem.indexOfPos(u8, request[0..used], value_start, "\r\n") orelse return error.MissingContentLength;
            const length = try std.fmt.parseInt(usize, request[value_start..value_end], 10);
            if (used < header_end + 4 + length) continue;
            const body = request[header_end + 4 ..][0..length];
            var parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, body, .{});
            defer parsed.deinit();
            const method = parsed.value.object.get("method").?.string;
            if (!std.mem.eql(u8, method, step.method)) return error.UnexpectedMethod;
            if (step.expect) |fragment| if (std.mem.indexOf(u8, body, fragment) == null) return error.MissingExpectedRequestField;
            const id = parsed.value.object.get("id").?.integer;
            const response = try std.fmt.allocPrint(std.testing.allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, step.result });
            defer std.testing.allocator.free(response);
            const header = try std.fmt.allocPrint(std.testing.allocator, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{response.len});
            defer std.testing.allocator.free(header);
            try connection.stream.writeAll(header);
            try connection.stream.writeAll(response);
            break;
        }
    }
}

fn port(server: *const std.net.Server) u16 {
    return server.listen_address.getPort();
}

test "loopback EVM code zkSync raw send and receipt outcomes" {
    const hash = "0x11111111111111111111111111111111" ++ "11111111111111111111111111111111";
    const block = "0x22222222222222222222222222222222" ++ "22222222222222222222222222222222";
    const steps = [_]Step{
        .{ .method = "eth_getCode", .result = "\"0x6000\"" },
        .{ .method = "zks_estimateFee", .result = "{\"gas_limit\":\"0x5208\",\"max_fee_per_gas\":\"0x1e\",\"max_priority_fee_per_gas\":\"0x2\",\"gas_per_pubdata_limit\":\"0x320\"}" },
        .{ .method = "eth_sendRawTransaction", .result = try std.fmt.allocPrint(std.testing.allocator, "\"{s}\"", .{hash}) },
        .{ .method = "eth_getTransactionReceipt", .result = try std.fmt.allocPrint(std.testing.allocator, "{{\"transactionHash\":\"{s}\",\"blockNumber\":\"0x1\",\"blockHash\":\"{s}\",\"gasUsed\":\"0x1f4\",\"effectiveGasPrice\":\"0x2\",\"status\":\"0x0\"}}", .{ hash, block }) },
    };
    defer for (steps[2..4]) |step| std.testing.allocator.free(step.result);
    var server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{});
    defer server.deinit();
    const url = try std.fmt.allocPrint(std.testing.allocator, "http://127.0.0.1:{d}/", .{port(&server)});
    defer std.testing.allocator.free(url);
    var rpc = try provider.RpcClient.init(std.testing.allocator, url, .{});
    defer rpc.deinit();
    var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .blocks = 1 }, .allow_std_fixture = true };
    const interface = adapter.interface();
    var failure: ?anyerror = null;
    const thread = try std.Thread.spawn(.{}, serve, .{ &server, &steps, &failure });
    defer thread.join();
    const code = try interface.getCode(std.testing.allocator, @splat(0x35));
    defer std.testing.allocator.free(code);
    try std.testing.expectEqual(@as(usize, 2), code.len);
    const request: types.Request = .{ .legacy = .{ .gas_price = 1, .gas_limit = 21_000, .to = null } };
    const fee = try interface.zksEstimateFee(request, @splat(0x11));
    try std.testing.expectEqual(@as(u256, 30), fee.max_fee_per_gas);
    const returned = try interface.sendRaw(&.{ 1, 2, 3 });
    const receipt = (try interface.receipt(returned)).?;
    try std.testing.expectEqual(@as(?u256, 500), receipt.gas_used);
    try std.testing.expectEqual(@as(?u256, 2), receipt.effective_gas_price);
    try std.testing.expect(!receipt.executed);
    if (failure) |err| return err;
}

test "loopback estimation serializes access lists" {
    const allocator = std.testing.allocator;
    const expected = "\"accessList\":[{\"address\":\"0x1111111111111111111111111111111111111111\",\"storageKeys\":[\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\"]}]";
    const steps = [_]Step{.{ .method = "zks_estimateFee", .result = "{\"gas_limit\":\"0x5208\",\"max_fee_per_gas\":\"0x1e\",\"max_priority_fee_per_gas\":\"0x2\",\"gas_per_pubdata_limit\":\"0x320\"}", .expect = expected }};
    var server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{});
    defer server.deinit();
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/", .{port(&server)});
    defer allocator.free(url);
    var rpc = try provider.RpcClient.init(allocator, url, .{});
    defer rpc.deinit();
    var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .blocks = 1 }, .allow_std_fixture = true };
    const interface = adapter.interface();
    var failure: ?anyerror = null;
    const thread = try std.Thread.spawn(.{}, serve, .{ &server, &steps, &failure });
    defer thread.join();
    const key: types.Hash = @splat(0x22);
    const access = [_]@import("../evm/transaction.zig").AccessTuple{.{ .address = @splat(0x11), .storage_keys = &.{key} }};
    const request: types.Request = .{ .eip2930 = .{ .chain_id = 1, .gas_price = 1, .gas_limit = 21_000, .to = null, .access_list = &access } };
    const fee = try interface.zksEstimateFee(request, @splat(0x11));
    try std.testing.expectEqual(@as(u256, 30), fee.max_fee_per_gas);
    if (failure) |err| return err;
}

// Captures the actual production Chain RPC boundary without a socket or node.
const FinalityRpc = struct {
    steps: []const Step,
    index: usize = 0,

    fn exchange(self: *FinalityRpc) provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, body: []const u8, _: provider.Options) !provider.WireResponse {
        const self: *FinalityRpc = @ptrCast(@alignCast(context));
        if (self.index >= self.steps.len) return error.UnexpectedFinalityRpc;
        const step = self.steps[self.index];
        self.index += 1;
        var request = try std.json.parseFromSlice(std.json.Value, allocator, body, .{});
        defer request.deinit();
        try std.testing.expectEqualStrings(step.method, request.value.object.get("method").?.string);
        if (step.expect) |expected| {
            const params = try std.json.Stringify.valueAlloc(allocator, request.value.object.get("params").?, .{});
            defer allocator.free(params);
            try std.testing.expectEqualStrings(expected, params);
        }
        const response = try std.fmt.allocPrint(allocator, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ request.value.object.get("id").?.integer, step.result });
        return .{ .bytes = response, .len = response.len };
    }
};

test "EVM finality five configured tags resolve one numeric nonce snapshot" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "latest", "finalized", "safe", "earliest", "pending" }) |tag| {
        const params = try std.fmt.allocPrint(a, "[\"{s}\",false]", .{tag});
        defer a.free(params);
        // Preserve the common RPC header validator. Pending may have a null
        // hash; nonce resolution still consumes only its explicit number.
        const steps = [_]Step{
            .{ .method = "eth_getBlockByNumber", .result = if (std.mem.eql(u8, tag, "pending")) "{\"number\":\"0xa\",\"hash\":null,\"parentHash\":\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\",\"timestamp\":\"0x1\"}" else "{\"number\":\"0xa\",\"hash\":\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\",\"parentHash\":\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\",\"timestamp\":\"0x1\"}", .expect = params },
            .{ .method = "eth_getTransactionCount", .result = "\"0x7\"", .expect = "[\"0x1111111111111111111111111111111111111111\",\"0xa\"]" },
        };
        var fixture: FinalityRpc = .{ .steps = &steps };
        var rpc = try provider.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.exchange() });
        defer rpc.deinit();
        var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .tag = tag }, .allow_std_fixture = true };
        try std.testing.expectEqual(@as(u256, 7), try adapter.interface().accountNonceFinalized(@splat(0x11)));
        try std.testing.expectEqual(steps.len, fixture.index);
    }
}

test "EVM finality rejects invalid tags and absent pending block numbers" {
    const a = std.testing.allocator;
    for ([_][]const u8{ "", "Safe", "LATEST", "0xa", "safe ", "unknown" }) |tag| {
        var fixture: FinalityRpc = .{ .steps = &.{} };
        var rpc = try provider.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.exchange() });
        defer rpc.deinit();
        var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .tag = tag }, .allow_std_fixture = true };
        try std.testing.expectError(error.InvalidEvmReorgTag, adapter.interface().accountNonceFinalized(@splat(0x11)));
        try std.testing.expectEqual(@as(usize, 0), fixture.index);
    }
    for ([_]struct { result: []const u8, failure: anyerror }{
        .{ .result = "null", .failure = error.InvalidLanderRecord },
        .{ .result = "{}", .failure = error.RpcResponseDecode },
        .{ .result = "{\"number\":null,\"hash\":null,\"parentHash\":\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\",\"timestamp\":\"0x1\"}", .failure = error.InvalidRpcResult },
        .{ .result = "{\"number\":true,\"hash\":null,\"parentHash\":\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\",\"timestamp\":\"0x1\"}", .failure = error.RpcResponseDecode },
    }) |bad| {
        const steps = [_]Step{.{ .method = "eth_getBlockByNumber", .result = bad.result, .expect = "[\"pending\",false]" }};
        var fixture: FinalityRpc = .{ .steps = &steps };
        var rpc = try provider.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.exchange() });
        defer rpc.deinit();
        var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .tag = "pending" }, .allow_std_fixture = true };
        try std.testing.expectError(bad.failure, adapter.interface().accountNonceFinalized(@splat(0x11)));
        try std.testing.expectEqual(steps.len, fixture.index); // no nonce request
    }
}

test "EVM finality numeric depth preserves zero and saturating subtraction" {
    const a = std.testing.allocator;
    for ([_]struct { depth: u32, expected: []const u8 }{
        .{ .depth = 0, .expected = "[\"0x1111111111111111111111111111111111111111\",\"0xa\"]" },
        .{ .depth = 3, .expected = "[\"0x1111111111111111111111111111111111111111\",\"0x7\"]" },
        .{ .depth = 20, .expected = "[\"0x1111111111111111111111111111111111111111\",\"0x0\"]" },
    }) |case| {
        const steps = [_]Step{
            .{ .method = "eth_blockNumber", .result = "\"0xa\"", .expect = "[]" },
            .{ .method = "eth_getTransactionCount", .result = "\"0x7\"", .expect = case.expected },
        };
        var fixture: FinalityRpc = .{ .steps = &steps };
        var rpc = try provider.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.exchange() });
        defer rpc.deinit();
        var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .blocks = case.depth }, .allow_std_fixture = true };
        try std.testing.expectEqual(@as(u256, 7), try adapter.interface().accountNonceFinalized(@splat(0x11)));
        try std.testing.expectEqual(steps.len, fixture.index);
    }
}
