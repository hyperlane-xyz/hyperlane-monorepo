//! Real production Aleo dispatch block + isolated pinned SnarkVM decoder, with
//! deterministic readonly PendingReadIo at the following empty block. This tests
//! retained Core frames, not another native HTTP scheduler claim.
const std = @import("std");
const source = @import("source.zig");
const adapter = @import("aleo.zig");
const events = @import("../../aleo/events.zig");
const rest = @import("../../aleo/rest.zig");
const provider = @import("../../aleo/provider.zig");
const crypto = @import("../../aleo/crypto.zig");
const http = @import("../../cloud/http.zig");
const rpc = @import("../../net/json_rpc.zig");
const Service = @import("../indexing/service.zig").Service;
const db = @import("../../db/root.zig");
const Budget = @import("../../net/read_replay.zig").ByteBudget;
const A = std.mem.Allocator;
const height: u32 = 12529863;
const domain: u32 = 1617853565;
const CountedDecoder = struct {
    native: events.NativeDecoder,
    calls: usize = 0,
    fn decode(ctx: *anyopaque, a: A, bytes: []const u8) !events.Block {
        const self: *CountedDecoder = @ptrCast(@alignCast(ctx));
        self.calls += 1;
        return self.native.interface().decode(a, bytes);
    }
    fn interface(self: *CountedDecoder) events.Decoder {
        return .{ .context = self, .decode_fn = decode };
    }
};
const Fixture = struct {
    block: []const u8,
    next_header: []const u8,
    mailbox: []const u8,
    dispatch: []const u8,
    decoder: *CountedDecoder,
    budget: *Budget,
    suspends: usize = 0,
    commits: usize = 0,
    fn transport(self: *Fixture) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(ctx: *anyopaque, a: A, request: http.Request) !http.Response {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        try std.testing.expectEqual(std.http.Method.GET, request.method);
        const url = request.url;
        const bytes: []const u8 = if (std.mem.endsWith(u8, url, "/block/height/latest")) "12529864" else if (std.mem.endsWith(u8, url, "/mailbox/true?metadata=true")) self.mailbox else if (std.mem.endsWith(u8, url, "/dispatch_event_index/12529863u32")) "\"1u32\"" else if (std.mem.endsWith(u8, url, "/dispatch_event_index/12529864u32")) blk: {
            // The preceding block already left the replay section. Yielding the
            // next scalar read must not rerun its real native VM decoder.
            try std.testing.expectEqual(@as(usize, 1), self.decoder.calls);
            if (self.suspends < 3) {
                self.suspends += 1;
                return error.PendingReadIo;
            }
            break :blk "null";
        } else if (std.mem.endsWith(u8, url, "/dispatch_events/1u32")) self.dispatch else if (std.mem.endsWith(u8, url, "/block/12529863")) self.block else if (std.mem.endsWith(u8, url, "/block/12529864")) self.next_header else if (std.mem.indexOf(u8, url, "/process_event_index/") != null or std.mem.indexOf(u8, url, "/last_event_index/") != null) "null" else return error.UnexpectedAleoCooperativeRead;
        return .{ .allocator = a, .bytes = try a.dupe(u8, bytes), .status = 200 };
    }
    fn commit(ctx: *anyopaque) !void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.commits += 1;
    }
    fn reserve(ctx: *anyopaque, bytes: usize) !void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        try self.budget.reserve(bytes);
    }
    fn release(ctx: *anyopaque, bytes: usize) void {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.budget.release(bytes);
    }
};
fn fixturePath(a: A, suffix: []const u8) ![]u8 {
    const prefix: []const u8 = blk: {
        std.fs.cwd().access("rust/main/config", .{}) catch break :blk "../rust/main/chains/hyperlane-aleo/src/indexer/mock_responses";
        break :blk "rust/main/chains/hyperlane-aleo/src/indexer/mock_responses";
    };
    return std.fs.path.join(a, &.{ prefix, suffix });
}
fn setting(a: A, name: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(a, name) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
test "Aleo cooperative origin keeps completed production native-decoded block through later readonly yields and RocksDB reopen" {
    const a = std.testing.allocator;
    const crypto_path = try setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const path = try fixturePath(temporary, "dispatch_block.json");
    const block = try std.fs.cwd().readFileAlloc(temporary, path, 16 * 1024 * 1024);
    const actual = try std.json.parseFromSliceLeaky(std.json.Value, temporary, block, .{ .allocate = .alloc_always });
    const next_header = try std.json.Stringify.valueAlloc(temporary, .{ .block_hash = try native.idText(temporary, .block, .{7} ** 32), .previous_hash = try rpc.string(try rpc.field(actual, "block_hash")), .header = .{ .metadata = .{ .height = height + 1, .timestamp = @as(u64, 1750000000) } } }, .{});
    // Actual Source mapping data, with an injected observed frontier height.
    const mailbox_path = try fixturePath(temporary, "mailbox_state.json");
    const mailbox_wire = try std.fs.cwd().readFileAlloc(temporary, mailbox_path, 64 * 1024);
    const mailbox_doc = try std.json.parseFromSliceLeaky(std.json.Value, temporary, mailbox_wire, .{ .allocate = .alloc_always });
    const mailbox = try std.json.Stringify.valueAlloc(temporary, .{ .data = try rpc.string(try rpc.field(mailbox_doc, "data")), .height = height + 1 }, .{});
    var row_doc = try @import("../../testing/fixture.zig").parse(std.json.Value, temporary, @embedFile("../../aleo/fixtures/cooperative.jsonl.gz"), .{});
    defer row_doc.deinit();
    const row = row_doc.value;
    var text: std.ArrayList(u8) = .empty;
    for ((try rpc.field(row, "wire_utf8_chunks")).array.items) |chunk| try text.appendSlice(temporary, try rpc.string(chunk));
    const dispatch = try std.json.Stringify.valueAlloc(temporary, text.items, .{});
    var decoder: CountedDecoder = .{ .native = .{ .executable = executable, .library = vm_path, .network = 1, .limits = .{ .timeout_ms = 30000 } } };
    var budget: Budget = .{ .maximum = 1024 * 1024 };
    var network: Fixture = .{ .block = block, .next_header = next_header, .mailbox = mailbox, .dispatch = dispatch, .decoder = &decoder, .budget = &budget };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, network.transport(), &.{.{ .url = "https://fixture" }}, 1), .native = &native };
    const mailbox_address = try native.programAddress("test_mailbox.aleo");
    const hook = try native.address("aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2");
    var concrete: adapter.Adapter = .{ .provider = &client, .configuration = .{ .mailbox = "test_mailbox.aleo", .hook_manager = "test_hook_manager.aleo", .ism_manager = "test_ism_manager.aleo", .validator_announce = "test_validator_announce.aleo", .hook = hook, .domain = domain }, .decoder = decoder.interface(), .paymaster = .{0} ** 32, .max_blocks = 2 };
    var source_ = concrete.interface();
    source_.read_section = .{ .context = &network, .commit_fn = Fixture.commit, .reservation = .{ .context = &network, .reserve_fn = Fixture.reserve, .release_fn = Fixture.release } };
    var directory = std.testing.tmpDir(.{});
    defer directory.cleanup();
    const db_path = try directory.dir.realpathAlloc(a, ".");
    defer a.free(db_path);
    var database = try db.rocks.Database.open(a, db_path, .{});
    var closed = false;
    defer if (!closed) database.deinit();
    var chain: @import("../../settings/types.zig").Chain = undefined;
    chain.protocol = .aleo;
    chain.name = "aleo-cooperative-source-fixture";
    chain.domain = domain;
    chain.index = .{ .from = height, .chunk = 100, .mode = .block, .interval = 1 };
    chain.contracts = .{ .mailbox = mailbox_address, .merkle_tree_hook = hook, .validator_announce = .{0} ** 32, .interchain_gas_paymaster = .{0} ** 32 };
    var driver: ?*Service = try Service.open(a, &chain, source_, &database, null, false);
    defer if (driver) |value| value.deinit();
    driver.?.indexer.options.enabled_streams = .{ true, false, false };
    try std.testing.expectEqual(@as(u32, 2), driver.?.indexer.options.cooperative_max_range);
    var succeeded = false;
    for (0..16) |_| {
        const report = driver.?.tick(0, null) catch |err| {
            if (err != error.PendingReadIo) return err;
            try std.testing.expectEqual(@as(usize, 1), decoder.calls);
            continue;
        };
        if (report.messages != 1) return error.MissingAleoCooperativeDispatch;
        succeeded = true;
        break;
    }
    try std.testing.expect(succeeded);
    try std.testing.expectEqual(@as(usize, 3), network.suspends);
    try std.testing.expectEqual(@as(usize, 1), decoder.calls);
    try std.testing.expect(network.commits >= 4);
    var expected = (try driver.?.store.messageByNonce(1)).?;
    defer expected.deinit();
    const message_id = expected.value.id();
    try std.testing.expectEqual(domain, expected.value.origin);
    try std.testing.expectEqual(@as(u32, 1), expected.value.nonce);
    driver.?.deinit();
    driver = null;
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    database.deinit();
    closed = true;
    var reopened = try db.rocks.Database.open(a, db_path, .{});
    defer reopened.deinit();
    var store = @import("../store.zig").Store.init(a, &reopened, chain.name);
    var restored = (try store.messageByNonce(1)).?;
    defer restored.deinit();
    try std.testing.expectEqual(message_id, restored.value.id());
}
