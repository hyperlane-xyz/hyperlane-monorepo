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
