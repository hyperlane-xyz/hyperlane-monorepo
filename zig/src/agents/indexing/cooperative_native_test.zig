//! Actual Starknet SDK wire, shared native HTTP,8 scheduler workers and RocksDB.
const std = @import("std");
const service = @import("service.zig");
const db = @import("../../db/root.zig");
const protocol = @import("../../protocol/root.zig");
const cfg = @import("../../settings/types.zig");
const stark = @import("../../starknet/provider.zig");
const codec = @import("../../starknet/codec.zig");
const adapter = @import("../scraper/starknet.zig");
const src = @import("../scraper/source.zig");
const curl = @import("../../net/curl.zig");
const http = @import("../../cloud/http.zig");
const json = @import("../../net/json_rpc.zig");
const Runtime = @import("../../net/http_runtime.zig").Runtime;
const Replay = @import("../../net/http_replay.zig").Replay;
const Budget = @import("../../net/read_replay.zig").ByteBudget;
const supervisor = @import("../../runtime/supervisor.zig");
const fixture = @import("../../evm/pool_testing.zig");
const A = std.mem.Allocator;
var sdk_data: ?*const Sdk = null; // fixture-only immutable during joined server
const Sdk = struct {
    arena: std.heap.ArenaAllocator,
    header: []const u8,
    page: []const u8,
    receipt: []const u8,
    fn init(a: A) !Sdk {
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        return .{ .header = try load(arena.allocator(), "rpc_header"), .page = try load(arena.allocator(), "rpc_page_end"), .receipt = try load(arena.allocator(), "rpc_receipt"), .arena = arena };
    }
    fn load(a: A, kind: []const u8) ![]const u8 {
        const fixture_bytes = try @import("../../testing/fixture.zig").bytes(a, @embedFile("../../starknet/fixtures/sdk.jsonl.gz"), 16 * 1024 * 1024);
        defer a.free(fixture_bytes);
        var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            var value = try std.json.parseFromSlice(std.json.Value, a, line, .{});
            defer value.deinit();
            if (!std.mem.eql(u8, kind, value.value.object.get("kind").?.string)) continue;
            var out: std.ArrayList(u8) = .empty;
            for (value.value.object.get("wire_utf8_chunks").?.array.items) |part| try out.appendSlice(a, part.string);
            return out.toOwnedSlice(a);
        }
        return error.MissingSdkFixture;
    }
};
fn respond(a: A, body: []const u8) ![]u8 {
    const value = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer value.deinit();
    const object = value.value.object;
    const method = object.get("method").?.string;
    const sdk = sdk_data orelse return error.MissingSdkFixture;
    const result = if (std.mem.eql(u8, method, "starknet_chainId")) "\"0x534e5f5345504f4c4941\"" else if (std.mem.eql(u8, method, "starknet_blockNumber")) "10" else if (std.mem.eql(u8, method, "starknet_getBlockWithTxHashes")) sdk.header else if (std.mem.eql(u8, method, "starknet_getTransactionReceipt")) sdk.receipt else if (std.mem.eql(u8, method, "starknet_call")) blk: {
        const address = try stark.felt(object.get("params").?.object.get("request").?.object.get("contract_address").?);
        break :blk if (address.value == 0x1234) "[\"0x3\"]" else "[\"0x2\"]";
    } else if (std.mem.eql(u8, method, "starknet_getEvents")) blk: {
        const filter = object.get("params").?.object.get("filter").?;
        const topic = try stark.felt(filter.object.get("keys").?.array.items[0].array.items[0]);
        break :blk if (topic.value == codec.selector("InsertedIntoTree").value) sdk.page else "{\"events\":[]}";
    } else return error.UnexpectedSdkMethod;
    return std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ object.get("id").?.integer, result });
}
const Group = struct {
    journal: Replay,
    native: curl.Client,
    http: http.HttpTransport,
    endpoint: [1]json.Endpoint,
    provider: stark.Provider = undefined,
    adapter: adapter.Starknet = undefined,
    driver: ?*service.Service = null,
    ready: std.atomic.Value(bool) = .init(false),
    identity_checked: bool = false,
    fn commit(context: *anyopaque) !void {
        const self: *Group = @ptrCast(@alignCast(context));
        try self.journal.commitReadSection();
    }
    fn reserve(context: *anyopaque, bytes: usize) !void {
        const budget: *Budget = @ptrCast(@alignCast(context));
        try budget.reserve(bytes);
    }
    fn release(context: *anyopaque, bytes: usize) void {
        const budget: *Budget = @ptrCast(@alignCast(context));
        budget.release(bytes);
    }
    fn run(context: *anyopaque, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        const self: *Group = @ptrCast(@alignCast(context));
        try self.journal.beginPass(cancel, null);
        self.http.cancel = cancel;
        defer self.http.cancel = null;
        var failure: ?anyerror = null;
        defer self.journal.endPass(failure);
        return self.tick(times, cancel) catch |err| {
            failure = err;
            return err;
        };
    }
    fn tick(self: *Group, times: supervisor.Times, cancel: *const std.atomic.Value(bool)) !supervisor.Report {
        if (!self.identity_checked) {
            try self.provider.checkChain(try codec.Felt.init(0x534e5f5345504f4c4941));
            self.identity_checked = true;
            try self.journal.commitReadSection();
        }
        const report = try self.driver.?.tick(times.monotonic_ms, cancel);
        if (report.insertions == 1) {
            self.ready.store(true, .release);
            return .{ .work = 1, .halt = true };
        }
        return .{ .next_delay_ms = report.next_delay_ms };
    }
    fn deinit(self: *Group, a: A) void {
        if (self.driver) |driver| driver.deinit();
        self.journal.deinit();
        self.http.deinit();
        self.native.deinit();
        a.free(self.endpoint[0].url);
    }
};
test "native generic cooperative origins sixteen SDK readers bypass eight stalled origins and persist canonical insertion proofs" {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    var sdk = try Sdk.init(a);
    defer sdk.arena.deinit();
    sdk_data = &sdk;
    defer sdk_data = null;
    const slow = [_]fixture.Reply{.{ .body = "", .stall = true }};
    const fast = [_]fixture.Reply{.{ .body = "" }};
    var behaviors: [16]fixture.Behavior = undefined;
    for (&behaviors, 0..) |*behavior, i| behavior.* = if (i < 8) .{ .replies = &slow } else .{ .replies = &fast, .response_fn = respond };
    var server = try fixture.Fixture.init(256, &behaviors);
    try server.start();
    defer server.deinit();
    const owner = try Runtime.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 32, .max_pending = 32, .max_response_bytes = 8192, .max_request_bytes = 16384, .max_reserved_bytes = 4 * 1024 * 1024 }, .max_sessions = 32 });
    defer owner.deinit();
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try db.rocks.Database.open(a, path, .{});
    var database_closed = false;
    defer if (!database_closed) database.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var budget: Budget = .{ .maximum = 8 * 1024 * 1024 };
    var groups: [16]Group = undefined;
    var initialized: usize = 0;
    defer for (groups[0..initialized]) |*group| group.deinit(a);
    var names: [16][]const u8 = undefined;
    const contracts: src.Contracts = .{ .mailbox = (try codec.Felt.init(0x111)).toBytes(), .hook = (try codec.Felt.init(0x1234)).toBytes(), .paymaster = .{0} ** 32 };
    for (&groups, 0..) |*group, i| {
        const url = try server.url(a, i);
        errdefer a.free(url);
        group.* = .{ .journal = try Replay.init(a, owner, .{ .max_attempt_ms = 20000, .shared_budget = &budget }), .native = try curl.Client.init(a, library), .http = http.HttpTransport.init(a), .endpoint = .{.{ .url = url }} };
        initialized += 1;
        group.native.send_override = group.journal.override();
        group.http.native_curl = &group.native;
        group.http.allow_insecure_loopback = true;
        group.provider = .{ .allocator = a, .client = try json.Client.init(a, group.http.interface(), &group.endpoint, .{ .max_response_bytes = 8192 }) };
        const domain: u32 = @intCast(100 + i);
        group.adapter = try adapter.Starknet.init(&group.provider, contracts, domain, .none);
        var source = group.adapter.interface();
        source.read_section = .{ .context = group, .commit_fn = Group.commit, .reservation = .{ .context = &budget, .reserve_fn = Group.reserve, .release_fn = Group.release } };
        names[i] = try std.fmt.allocPrint(arena.allocator(), "starknet-native-cooperative-{d}", .{i});
        var chain: cfg.Chain = undefined;
        chain.protocol = .starknet;
        chain.name = names[i];
        chain.domain = domain;
        chain.index = .{ .from = 10, .chunk = 1, .mode = .block, .interval = 1 };
        chain.contracts = .{ .mailbox = contracts.mailbox, .merkle_tree_hook = contracts.hook, .interchain_gas_paymaster = contracts.paymaster, .validator_announce = .{0} ** 32 };
        group.driver = try service.Service.open(a, &chain, source, &database, null, false);
        group.driver.?.indexer.options.enabled_streams = .{ false, true, false };
        _ = try group.driver.?.store.storeInsertion(.{ .leaf_index = 0, .message_id = (try codec.Felt.init(2)).toBytes() }, 10);
        _ = try group.driver.?.store.storeInsertion(.{ .leaf_index = 1, .message_id = (try codec.Felt.init(3)).toBytes() }, 10);
    }
    var tasks: [16]supervisor.Task = undefined;
    for (&tasks, &groups) |*task, *group| task.* = .{ .context = group, .run = Group.run, .interval_ms = 1, .timeout_ms = 20000 };
    const scheduled = try supervisor.Supervisor.start(a, &tasks);
    var stopped = false;
    defer if (!stopped) scheduled.deinit();
    var timer = try std.time.Timer.start();
    while (true) {
        const now = timer.read() / std.time.ns_per_ms;
        _ = try scheduled.tick(.{ .monotonic_ms = now, .unix_ms = now });
        var ready: usize = 0;
        for (groups[8..], 8..) |*group, i| if (group.ready.load(.acquire) and (try scheduled.health(i)).halted) {
            ready += 1;
        };
        if (ready == 8) break;
        if (now > 8000) return error.HealthyGenericOriginStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    for (0..8) |i| {
        try std.testing.expectEqual(@as(u64, 0), (try scheduled.health(i)).failures);
        try std.testing.expect((try scheduled.health(i)).suspended > 0);
    }
    scheduled.stop();
    scheduled.deinit();
    stopped = true;
    var tree = protocol.IncrementalMerkle.init();
    for ([_]u256{ 2, 3, 1 }) |value| try tree.ingest((try codec.Felt.init(value)).toBytes());
    for (groups[8..], 8..) |*group, i| {
        const point: protocol.Checkpoint = .{ .mailbox_domain = @intCast(100 + i), .merkle_tree_hook_address = contracts.hook, .root = tree.root(), .index = 2, .message_id = (try codec.Felt.init(1)).toBytes() };
        try std.testing.expect((try group.driver.?.history.proof(2, point)).verify(tree.root()));
    }
    for (groups[0..initialized]) |*group| group.deinit(a);
    initialized = 0;
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    database.deinit();
    database_closed = true;
    var reopened = try db.rocks.Database.open(a, path, .{});
    defer reopened.deinit();
    for (names[8..]) |name| {
        var store = @import("../store.zig").Store.init(a, &reopened, name);
        try std.testing.expectEqualSlices(u8, &(try codec.Felt.init(1)).toBytes(), &(try store.insertionByIndex(2)).?.message_id);
    }
    try server.check();
}
