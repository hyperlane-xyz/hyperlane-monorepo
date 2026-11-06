const std = @import("std");
const scraper = @import("starknet.zig");
const provider = @import("../../starknet/provider.zig");
const codec = @import("../../starknet/codec.zig");
const rpc = @import("../../net/json_rpc.zig");
const http = @import("../../cloud/http.zig");
const a = std.testing.allocator;
fn fixture(kind: []const u8) ![]u8 {
    const fixture_bytes = try @import("../../testing/fixture.zig").bytes(a, @embedFile("../../starknet/fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
        defer parsed.deinit();
        if (!std.mem.eql(u8, kind, try rpc.string(try rpc.field(parsed.value, "kind")))) continue;
        var bytes: std.ArrayList(u8) = .empty;
        errdefer bytes.deinit(a);
        for ((try rpc.field(parsed.value, "wire_utf8_chunks")).array.items) |part| try bytes.appendSlice(a, try rpc.string(part));
        return bytes.toOwnedSlice(a);
    }
    return error.MissingStarknetScraperFixture;
}
const Step = struct { method: []const u8, response: []const u8, topic: ?codec.Felt = null };
const Server = struct {
    listener: std.net.Server,
    steps: []const Step,
    stop: std.atomic.Value(bool) = std.atomic.Value(bool).init(false),
    failure: ?anyerror = null,
    fn serve(self: *Server) void {
        self.run() catch |err| {
            if (err != error.TestCancelled) self.failure = err;
        };
    }
    fn accept(self: *Server) !std.net.Server.Connection {
        while (!self.stop.load(.acquire)) {
            return self.listener.accept() catch |err| switch (err) {
                error.WouldBlock => {
                    std.Thread.sleep(std.time.ns_per_ms);
                    continue;
                },
                else => return err,
            };
        }
        return error.TestCancelled;
    }
    fn run(self: *Server) !void {
        for (self.steps) |step| {
            const connection = try self.accept();
            defer connection.stream.close();
            var buffer: [32768]u8 = undefined;
            var used: usize = 0;
            var id: i64 = 0;
            while (true) {
                if (used == buffer.len) return error.RequestTooLarge;
                const read = connection.stream.read(buffer[used..]) catch |err| switch (err) {
                    error.WouldBlock => {
                        if (self.stop.load(.acquire)) return error.TestCancelled;
                        std.Thread.sleep(std.time.ns_per_ms);
                        continue;
                    },
                    else => return err,
                };
                if (read == 0) return error.UnexpectedEof;
                used += read;
                const end = std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n") orelse continue;
                var lines = std.mem.splitSequence(u8, buffer[0..end], "\r\n");
                _ = lines.next();
                var length: ?usize = null;
                while (lines.next()) |line| {
                    const colon = std.mem.indexOfScalar(u8, line, ':') orelse return error.BadHeader;
                    if (std.ascii.eqlIgnoreCase(line[0..colon], "content-length")) length = try std.fmt.parseInt(usize, std.mem.trim(u8, line[colon + 1 ..], " \t"), 10);
                }
                const size = length orelse return error.MissingBody;
                if (size > buffer.len - end - 4) return error.RequestTooLarge;
                if (used - end - 4 < size) continue;
                var parsed = try std.json.parseFromSlice(std.json.Value, a, buffer[end + 4 ..][0..size], .{});
                defer parsed.deinit();
                try std.testing.expectEqualStrings(step.method, try rpc.string(try rpc.field(parsed.value, "method")));
                id = try rpc.integer(i64, try rpc.field(parsed.value, "id"));
                const params = try rpc.field(parsed.value, "params");
                if (std.mem.eql(u8, step.method, "starknet_call")) try std.testing.expectEqualStrings("0xaa", try rpc.string(try rpc.field(try rpc.field(params, "block_id"), "block_hash")));
                if (step.topic) |topic| {
                    const filter = try rpc.field(params, "filter");
                    const keys = try rpc.field(filter, "keys");
                    try std.testing.expectEqual(topic.value, (try provider.felt(keys.array.items[0].array.items[0])).value);
                    try std.testing.expectEqual(@as(u64, 10), try rpc.integer(u64, try rpc.field(try rpc.field(filter, "from_block"), "block_number")));
                }
                break;
            }
            const body = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id, step.response });
            defer a.free(body);
            var header: [160]u8 = undefined;
            try connection.stream.writeAll(try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: {d}\r\n\r\n", .{body.len}));
            try connection.stream.writeAll(body);
        }
    }
};
test "Starknet scraper concrete HTTP source pins counters by hash and derives canonical receipt event identity" {
    const block = try fixture("rpc_header");
    defer a.free(block);
    const page = try fixture("rpc_page_end");
    defer a.free(page);
    const receipt = try fixture("rpc_receipt");
    defer a.free(receipt);
    var server: Server = .{ .listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{ .force_nonblocking = true }), .steps = &.{
        .{ .method = "starknet_getBlockWithTxHashes", .response = block },                                        .{ .method = "starknet_call", .response = "[\"0x2\"]" },                                                 .{ .method = "starknet_call", .response = "[\"0x3\"]" },
        .{ .method = "starknet_blockNumber", .response = "10" },                                                  .{ .method = "starknet_getEvents", .response = "{\"events\":[]}", .topic = codec.selector("Dispatch") }, .{ .method = "starknet_blockNumber", .response = "10" },
        .{ .method = "starknet_getEvents", .response = "{\"events\":[]}", .topic = codec.selector("ProcessId") }, .{ .method = "starknet_blockNumber", .response = "10" },                                                 .{ .method = "starknet_getEvents", .response = page, .topic = codec.selector("InsertedIntoTree") },
        .{ .method = "starknet_getTransactionReceipt", .response = receipt },                                     .{ .method = "starknet_getBlockWithTxHashes", .response = block },
    } };
    defer server.listener.deinit();
    const url = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{server.listener.listen_address.getPort()});
    defer a.free(url);
    var transport = http.HttpTransport.init(a);
    defer transport.deinit();
    transport.allow_insecure_loopback = true;
    var p: provider.Provider = .{ .allocator = a, .client = try rpc.Client.init(a, transport.interface(), &.{.{ .url = url }}, .{}) };
    var source = try scraper.Starknet.init(&p, .{ .mailbox = (try codec.Felt.init(0x111)).toBytes(), .hook = (try codec.Felt.init(0x1234)).toBytes(), .paymaster = .{0} ** 32 }, 100, .none);
    const thread = try std.Thread.spawn(.{}, Server.serve, .{&server});
    var joined = false;
    defer if (!joined) {
        server.stop.store(true, .release);
        thread.join();
    };
    const interface = source.interface();
    try std.testing.expect(interface.historical_counts);
    const header = try interface.header(.{ .height = 10 });
    try std.testing.expectEqual(@as(u64, 10), header.height);
    try std.testing.expectEqual([2]u32{ 2, 3 }, (try interface.counts(header.hash)).?);
    var batch = try interface.events(a, 10, 10, .{0} ** 4);
    defer batch.deinit();
    try std.testing.expectEqual(@as(usize, 1), batch.events.len);
    try std.testing.expectEqual(@as(u64, 1), batch.events[0].tx_index);
    try std.testing.expectEqual(@as(u64, 1), batch.events[0].log_index);
    try std.testing.expectEqual(@as(u32, 2), batch.events[0].data.insertion.index);
    try std.testing.expectError(error.UnsupportedStarknetReorgTag, interface.header(.safe));
    server.stop.store(true, .release);
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
}

test "Starknet scraper factory consumes typed committed settings and owns endpoint strings" {
    const settings = @import("../../settings/root.zig");
    const Reject = struct {
        fn send(_: *anyopaque, _: std.mem.Allocator, _: http.Request) anyerror!http.Response {
            return error.UnexpectedNetworkRequest;
        }
    };
    var token: u8 = 0;
    var loaded = try settings.Settings.load(a, .scraper, .{ .defaults_dir = defaultsDir(), .arguments = &.{ "--chainsToScrape=starknet", "--db=postgresql://localhost/disposable" } });
    var live = true;
    defer if (live) loaded.deinit();
    var chain = loaded.chains[0];
    chain.contracts.mailbox = (try codec.Felt.init(0x111)).toBytes();
    chain.contracts.merkle_tree_hook = (try codec.Felt.init(0x1234)).toBytes();
    chain.contracts.interchain_gas_paymaster = .{0} ** 32;
    chain.reorg = .{ .blocks = 1 };
    var factory = try scraper.Factory.init(a, .{ .context = &token, .send_fn = Reject.send }, &chain);
    defer factory.deinit();
    const expected = try a.dupe(u8, factory.provider.client.endpoints[0].url);
    defer a.free(expected);
    loaded.deinit();
    live = false;
    try std.testing.expectEqualStrings(expected, factory.provider.client.endpoints[0].url);
    const interface = try factory.interface();
    try std.testing.expect(interface.historical_counts);
    try std.testing.expectError(error.UnsupportedStarknetReorgTag, interface.header(.safe));
    try std.testing.expectError(error.UnexpectedNetworkRequest, interface.indexingTip());
    chain.index.chunk = 0;
    try std.testing.expectError(error.InvalidScraperChunk, scraper.Factory.init(a, .{ .context = &token, .send_fn = Reject.send }, &chain));
}

fn defaultsDir() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/config";
    return "rust/main/config";
}
