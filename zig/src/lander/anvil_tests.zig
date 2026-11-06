const std = @import("std");
const provider = @import("../evm/provider.zig");
const evm = @import("evm.zig");
const abi = @import("../evm/codecs.zig");
const multicall = @import("multicall.zig");

fn readDeployment(allocator: std.mem.Allocator) ![]u8 {
    const source = std.fs.cwd().readFileAlloc(allocator, "rust/main/utils/run-locally/src/ethereum/multicall.rs", 2 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => try std.fs.cwd().readFileAlloc(allocator, "../rust/main/utils/run-locally/src/ethereum/multicall.rs", 2 * 1024 * 1024),
        else => return err,
    };
    defer allocator.free(source);
    const marker = "SIGNED_DEPLOY_MULTICALL_TX: &str = \"";
    const start = std.mem.indexOf(u8, source, marker) orelse return error.MissingDeployment;
    const remainder = source[start + marker.len ..];
    const end = std.mem.indexOf(u8, remainder, "\";") orelse return error.MissingDeployment;
    return allocator.dupe(u8, remainder[0..end]);
}

fn freePort() !u16 {
    var server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{});
    defer server.deinit();
    return server.listen_address.getPort();
}

test "local Anvil Multicall3 returns positional allowFailure results" {
    const allocator = std.testing.allocator;
    const version = std.process.Child.run(.{ .allocator = allocator, .argv = &.{ "anvil", "--version" }, .max_output_bytes = 4096 }) catch |err| switch (err) {
        error.FileNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(version.stdout);
    defer allocator.free(version.stderr);
    if (version.term != .Exited or version.term.Exited != 0) return error.AnvilVersionProbeFailed;
    const port = try freePort();
    const port_text = try std.fmt.allocPrint(allocator, "{d}", .{port});
    defer allocator.free(port_text);
    var child = std.process.Child.init(&.{ "anvil", "--host", "127.0.0.1", "--port", port_text, "--silent" }, allocator);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    try child.spawn();
    var reaped = false;
    defer {
        _ = child.kill() catch {};
        if (!reaped) _ = child.wait() catch {};
    }
    const url = try std.fmt.allocPrint(allocator, "http://127.0.0.1:{d}/", .{port});
    defer allocator.free(url);
    var rpc = try provider.RpcClient.init(allocator, url, .{ .timeout_ms = 2_000, .connect_timeout_ms = 100 });
    defer rpc.deinit();
    var adapter: evm.Evm = .{ .rpc = &rpc, .reorg = .{ .blocks = 0 }, .allow_std_fixture = true };
    const interface = adapter.interface();
    var ready = false;
    for (0..100) |_| {
        _ = rpc.chainId() catch {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            continue;
        };
        ready = true;
        break;
    }
    if (!ready) return error.AnvilUnavailable;
    var response = try rpc.call("anvil_setBalance", .{ "0x05f32B3cC3888453ff71B01135B34FF8e41263F2", "0xde0b6b3a7640000" });
    response.deinit();
    const deployment = try readDeployment(allocator);
    defer allocator.free(deployment);
    var deployed = try rpc.call("eth_sendRawTransaction", .{deployment});
    deployed.deinit();
    const multicall_address: [20]u8 = .{ 0xcA, 0x11, 0xbd, 0xe0, 0x59, 0x77, 0xb3, 0x63, 0x11, 0x67, 0x02, 0x88, 0x62, 0xbE, 0x2a, 0x17, 0x39, 0x76, 0xCA, 0x11 };
    var has_code = false;
    for (0..100) |_| {
        const code = try interface.getCode(allocator, multicall_address);
        defer allocator.free(code);
        if (code.len > 0) {
            has_code = true;
            break;
        }
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }
    try std.testing.expect(has_code);
    const latest = try interface.latestBlock();
    const valid = abi.selector("getBlockNumber()");
    const calls = [_]multicall.Call{
        .{ .to = multicall_address, .data = &valid },
        .{ .to = multicall_address, .data = &.{ 0xde, 0xad, 0xbe, 0xef } },
    };
    var encoded = try multicall.encode(allocator, &calls);
    defer encoded.deinit(allocator);
    const raw = try interface.call(allocator, .{ .from = @splat(0x11), .to = multicall_address, .calldata = encoded.calldata }, latest.number);
    defer allocator.free(raw);
    const results = try multicall.decode(allocator, raw, 2);
    defer allocator.free(results);
    try std.testing.expect(results[0].success);
    try std.testing.expect(!results[1].success);
    try std.testing.expect(results[0].return_data.len >= 32);
    reaped = true;
    _ = try child.kill();
    _ = try child.wait();
}
