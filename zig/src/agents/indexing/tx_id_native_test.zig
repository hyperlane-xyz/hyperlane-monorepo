//! Real EVM wire parsing + production RocksDB; no daemon or production endpoint.
const std = @import("std");
const protocol = @import("../../protocol/root.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const src = @import("../scraper/source.zig");
const origin = @import("../evm_origin.zig");
const Queue = @import("tx_id_queue.zig").Queue;
const Companion = @import("tx_id_companion.zig").Companion;
const A = std.mem.Allocator;
const ORIGIN: u32 = 9913371;
const DESTINATION: u32 = 9913372;
fn hash(last: u8) [32]u8 {
    var value: [32]u8 = @splat(0);
    value[31] = last;
    return value;
}
fn pad(last: u8) [64]u8 {
    var value: [64]u8 = @splat(0);
    value[63] = last;
    return value;
}
const contracts: src.Contracts = .{ .mailbox = hash(1), .hook = hash(2), .paymaster = hash(3) };
const Wire = struct {
    arena: std.heap.ArenaAllocator,
    messages: [2]protocol.Message = undefined,
    dispatches: [2]std.json.Value = undefined,
    receipts: [2]std.json.Value = undefined,
    header: std.json.Value = undefined,
    count: usize,
    failures: [2]?anyerror = @splat(null),
    receipt_reads: [2]usize = @splat(0),
    fn value(a: A, input: anytype) !std.json.Value {
        const encoded = try std.json.Stringify.valueAlloc(a, input, .{});
        return (try std.json.parseFromSlice(std.json.Value, a, encoded, .{ .allocate = .alloc_always })).value;
    }
    fn init(a: A, count: usize) !Wire {
        var self: Wire = .{ .arena = std.heap.ArenaAllocator.init(a), .count = count };
        errdefer self.arena.deinit();
        const b = self.arena.allocator();
        const block_hash = try abi.hexAlloc(b, &hash(5));
        self.header = try value(b, .{ .number = "0x5", .hash = block_hash, .parentHash = try abi.hexAlloc(b, &hash(4)), .timestamp = "0x3e8" });
        for (0..count) |i| {
            const message: protocol.Message = .{ .origin = ORIGIN, .destination = DESTINATION, .nonce = @intCast(i), .sender = hash(6), .recipient = hash(7), .body = "tx-id companion canonical message" };
            self.messages[i] = message;
            const encoded = try message.encodeAlloc(b);
            const dispatch_data = try b.alloc(u8, 64 + ((encoded.len + 31) / 32) * 32);
            @memset(dispatch_data, 0);
            std.mem.writeInt(u256, dispatch_data[0..32], 32, .big);
            std.mem.writeInt(u256, dispatch_data[32..64], encoded.len, .big);
            @memcpy(dispatch_data[64..][0..encoded.len], encoded);
            var destination: [32]u8 = @splat(0);
            std.mem.writeInt(u256, &destination, DESTINATION, .big);
            const tx = try abi.hexAlloc(b, &hash(@intCast(i + 10)));
            const tx_index = try abi.quantityAlloc(b, i);
            self.dispatches[i] = try value(b, .{ .address = try abi.hexAlloc(b, contracts.mailbox[12..]), .topics = &.{ try abi.hexAlloc(b, &abi.dispatch_topic), try abi.hexAlloc(b, &message.sender), try abi.hexAlloc(b, &destination), try abi.hexAlloc(b, &message.recipient) }, .data = try abi.hexAlloc(b, dispatch_data), .blockNumber = "0x5", .blockHash = block_hash, .transactionHash = tx, .transactionIndex = tx_index, .logIndex = try abi.quantityAlloc(b, i * 3), .removed = false });
            var insert_data: [64]u8 = @splat(0);
            insert_data[0..32].* = message.id();
            std.mem.writeInt(u256, insert_data[32..64], i, .big);
            const insertion = try value(b, .{ .address = try abi.hexAlloc(b, contracts.hook[12..]), .topics = &.{try abi.hexAlloc(b, &abi.insertion_topic)}, .data = try abi.hexAlloc(b, &insert_data), .blockNumber = "0x5", .blockHash = block_hash, .transactionHash = tx, .transactionIndex = tx_index, .logIndex = try abi.quantityAlloc(b, i * 3 + 1), .removed = false });
            var payment_data: [64]u8 = @splat(0);
            std.mem.writeInt(u256, payment_data[0..32], 1000, .big);
            std.mem.writeInt(u256, payment_data[32..64], 500, .big);
            const gas = try value(b, .{ .address = try abi.hexAlloc(b, contracts.paymaster[12..]), .topics = &.{ try abi.hexAlloc(b, &abi.gas_payment_topic), try abi.hexAlloc(b, &message.id()), try abi.hexAlloc(b, &destination) }, .data = try abi.hexAlloc(b, &payment_data), .blockNumber = "0x5", .blockHash = block_hash, .transactionHash = tx, .transactionIndex = tx_index, .logIndex = try abi.quantityAlloc(b, i * 3 + 2), .removed = false });
            self.receipts[i] = try value(b, .{ .transactionHash = tx, .blockNumber = "0x5", .blockHash = block_hash, .transactionIndex = tx_index, .status = "0x1", .logs = &.{ self.dispatches[i], insertion, gas } });
        }
        return self;
    }
    fn read(context: *anyopaque, a: A, bytes: []const u8, _: rpc.Options) !rpc.WireResponse {
        const self: *Wire = @ptrCast(@alignCast(context));
        const request = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        defer request.deinit();
        const method = request.value.object.get("method").?.string;
        const params = request.value.object.get("params").?.array.items;
        const result: std.json.Value = if (std.mem.eql(u8, method, "eth_getBlockByNumber")) self.header else if (std.mem.eql(u8, method, "eth_call")) result: {
            var count: [32]u8 = @splat(0);
            count[31] = @intCast(self.count);
            break :result .{ .string = try abi.hexAlloc(a, &count) };
        } else if (std.mem.eql(u8, method, "eth_getLogs")) result: {
            const address = params[0].object.get("address").?.string;
            var events = std.json.Array.init(a);
            if (std.mem.endsWith(u8, address, "01")) try events.appendSlice(self.dispatches[0..self.count]);
            break :result .{ .array = events };
        } else if (std.mem.eql(u8, method, "eth_getTransactionReceipt")) result: {
            const tx = try abi.fixedHex(32, params[0].string);
            if (tx[31] < 10 or tx[31] >= 10 + self.count) return error.UnexpectedFixtureTx;
            const index: usize = tx[31] - 10;
            self.receipt_reads[index] += 1;
            if (self.failures[index]) |err| return err;
            break :result self.receipts[index];
        } else return error.UnexpectedCompanionRpc;
        defer if (result == .string) a.free(result.string);
        defer if (result == .array) {
            var array = result.array;
            array.deinit();
        };
        const encoded = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = request.value.object.get("id").?, .result = result }, .{});
        return .{ .bytes = encoded, .len = encoded.len };
    }
};
pub const Harness = struct {
    allocator: A,
    directory: std.testing.TmpDir,
    path: []u8,
    database: @import("../../db/rocks.zig").Database,
    database_open: bool = true,
    wire: Wire,
    chain: @import("../../settings/types.zig").Chain = undefined,
    client: rpc.RpcClient,
    service: *origin.Service,
    queue: Queue,
    adapter: @import("../scraper/evm.zig").Evm,
    companion: Companion,
    cancel: std.atomic.Value(bool) = .init(false),
    pub fn init(a: A, count: usize, capacity: usize) !*Harness {
        const self = try a.create(Harness);
        errdefer a.destroy(self);
        self.allocator = a;
        self.directory = std.testing.tmpDir(.{});
        errdefer self.directory.cleanup();
        self.path = try self.directory.dir.realpathAlloc(a, ".");
        errdefer a.free(self.path);
        self.database = try @import("../../db/rocks.zig").Database.open(a, self.path, .{});
        errdefer self.database.deinit();
        self.wire = try Wire.init(a, count);
        errdefer self.wire.arena.deinit();
        self.client = try rpc.RpcClient.init(a, "https://fixture", .{ .exchange = .{ .context = &self.wire, .fetch_fn = Wire.read } });
        errdefer self.client.deinit();
        self.chain.name = "test1";
        self.chain.protocol = .ethereum;
        self.chain.contracts = .{ .mailbox = contracts.mailbox, .merkle_tree_hook = contracts.hook, .interchain_gas_paymaster = contracts.paymaster, .validator_announce = hash(4) };
        self.chain.domain = ORIGIN;
        self.chain.index = .{ .from = 0, .chunk = 5, .interval = 1 };
        const driver = try a.create(origin.Service);
        errdefer a.destroy(driver);
        driver.* = .{ .allocator = a, .chain = &self.chain, .store = @import("../store.zig").Store.init(a, &self.database, self.chain.name), .history = undefined, .indexer = try @import("../../evm/indexer.zig").Indexer.init(a, &self.client, .{ .chain_id = 1, .domain = ORIGIN, .mailbox = contracts.mailbox[12..].*, .hook = contracts.hook[12..].*, .paymaster = contracts.paymaster[12..].*, .reorg_period = .none }), .progress = undefined, .gas_enabled = true };
        driver.history = @import("../origin.zig").Origin.init(a, &driver.store, ORIGIN, contracts.hook, null);
        driver.indexer.chain_checked = true;
        driver.progress = .{ .{ .store = &driver.store, .stream = .dispatch }, .{ .store = &driver.store, .stream = .insertion } };
        self.service = driver;
        self.queue = try Queue.init(a, capacity, .{ .tree = true, .gas = true });
        self.service.store.dispatch_notifications = self.queue.observer();
        self.adapter = .{ .rpc_client = &self.client, .contracts = contracts, .domain = ORIGIN };
        self.companion = .{ .allocator = a, .queue = &self.queue, .store = &self.service.store, .contracts = contracts, .domain = ORIGIN, .source = self.adapter.interface() };
        self.cancel = .init(false);
        self.database_open = true;
        return self;
    }
    pub fn deinit(self: *Harness) void {
        self.companion.deinit();
        self.queue.deinit();
        self.service.deinit();
        self.client.deinit();
        self.wire.arena.deinit();
        if (self.database_open) self.database.deinit();
        self.allocator.free(self.path);
        self.directory.cleanup();
        self.allocator.destroy(self);
    }
    fn index(self: *Harness) !void {
        for (0..3) |_| _ = try self.service.tick(0, &self.cancel);
    }
    fn payment(self: *Harness, selected: usize) !?@import("../../db/codec.zig").GasPaymentData {
        return self.service.store.payment(.{ .message_id = self.wire.messages[selected].id(), .destination = DESTINATION });
    }
};
test "transaction-ID EVM recovers omitted range gas and tree from actual receipt without advancing range watermarks" {
    const self = try Harness.init(std.testing.allocator, 1, 2);
    defer self.deinit();
    try self.index();
    try std.testing.expect((try self.payment(0)) == null);
    try std.testing.expect((try self.service.store.insertionByIndex(0)) == null);
    const watermark = try self.service.store.gasWatermark();
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
    try std.testing.expectEqual(@as(u256, 1000), (try self.payment(0)).?.gas_amount);
    try std.testing.expectEqual(self.wire.messages[0].id(), (try self.service.store.insertionByIndex(0)).?.message_id);
    try std.testing.expectEqual(watermark, try self.service.store.gasWatermark());
    try std.testing.expectEqual(@as(usize, 0), self.queue.count());
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    _ = try self.service.tick(1000, &self.cancel);
    var tree = protocol.IncrementalMerkle.init();
    try tree.ingest(self.wire.messages[0].id());
    const checkpoint: protocol.Checkpoint = .{ .mailbox_domain = ORIGIN, .merkle_tree_hook_address = contracts.hook, .root = tree.root(), .index = 0, .message_id = self.wire.messages[0].id() };
    try std.testing.expect((try self.service.history.proof(0, checkpoint)).verify(checkpoint.root));
    try self.queue.admit(.{ .transaction = pad(10), .block_number = 5 });
    _ = try self.companion.tick(1001, &self.cancel);
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
}
test "transaction-ID receipt failure rotates to healthy queued transaction and retries missing neighbor" {
    const self = try Harness.init(std.testing.allocator, 2, 2);
    defer self.deinit();
    try self.index();
    self.wire.failures[0] = error.TransactionReceiptUnavailable;
    _ = try self.companion.tick(100, &self.cancel);
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expect((try self.payment(0)) == null);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(1)).?.payment);
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    _ = try self.service.tick(1000, &self.cancel); // range owner remains usable
    _ = try self.companion.tick(2099, &self.cancel);
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    self.wire.failures[0] = null;
    _ = try self.companion.tick(2200, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
}
test "transaction-ID producer persists more rows than queue capacity without losing notification or cursor ownership" {
    const self = try Harness.init(std.testing.allocator, 2, 1);
    defer self.deinit();
    const blocked = try self.service.tick(0, &self.cancel);
    try std.testing.expectEqual(@as(u64, 10), blocked.next_delay_ms);
    try std.testing.expect(self.service.retained != null);
    try std.testing.expectEqual(@as(usize, 1), self.service.retained.?.offset);
    try std.testing.expect(self.service.cursors[0].?.pending != null);
    self.wire.failures[0] = error.PendingReadIo;
    const suspended = try self.companion.tick(100, &self.cancel);
    try std.testing.expect(suspended.pending_read);
    const lease_generation = self.companion.current.?.lease.generation;
    _ = try self.service.tick(101, &self.cancel);
    try std.testing.expectEqual(@as(usize, 1), self.service.retained.?.offset);
    _ = try self.companion.tick(102, &self.cancel);
    try std.testing.expectEqual(lease_generation, self.companion.current.?.lease.generation);
    try std.testing.expect(self.service.cursors[0].?.pending != null);
    self.wire.failures[0] = null;
    _ = try self.companion.tick(103, &self.cancel);
    _ = try self.service.tick(103, &self.cancel);
    try std.testing.expect(self.service.retained == null);
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(1)).?.payment);
}
test "transaction-ID bad receipt validates all metadata before mutation and cancellation never consumes queued work" {
    const self = try Harness.init(std.testing.allocator, 1, 2);
    defer self.deinit();
    try self.index();
    self.wire.receipts[0].object.getPtr("status").?.* = .{ .string = "0x0" };
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expect((try self.payment(0)) == null);
    try std.testing.expect((try self.service.store.insertionByIndex(0)) == null);
    try std.testing.expectEqual(@as(usize, 0), self.queue.count());
    try std.testing.expect(self.queue.replayAt() != null);
    self.cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, self.companion.tick(3000, &self.cancel));
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    self.cancel.store(false, .release);
    self.wire.receipts[0].object.getPtr("status").?.* = .{ .string = "0x1" };
    _ = try self.companion.tick(3000, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
}

test "transaction-ID generic producer retains frame beyond queue and completed-dedup capacities with full-width IDs" {
    const a = std.testing.allocator;
    const self = try Harness.init(a, 1, 1);
    defer self.deinit();
    const fixture = @import("testing.zig");
    const base = fixture.events();
    var logs: [4]src.Event = undefined;
    for (&logs, 0..) |*event, i| {
        event.* = base[0];
        event.data.dispatch.nonce = @intCast(i);
        event.tx_hash = @splat(@intCast(i + 1));
        event.tx_index = i;
    }
    var chain: fixture.Chain = .{ .logs = &logs, .count = 4 };
    var store = @import("../store.zig").Store.init(a, &self.database, "full-width-generic");
    var queue = try Queue.init(a, 1, .{ .tree = true, .gas = true });
    defer queue.deinit();
    store.dispatch_notifications = queue.observer();
    var core: @import("source.zig").Core(@TypeOf(store)) = .{ .allocator = a, .source = chain.interface(), .store = &store, .options = .{ .transaction_notifications = true, .domain = 10, .contracts = fixture.contracts, .chunk = 5, .lowest = 1, .gas_enabled = false } };
    defer core.deinit();
    var report = try core.tick(0, null);
    for (0..4) |i| {
        if (i < 3) {
            try std.testing.expectEqual(@as(u64, 10), report.next_delay_ms);
            try std.testing.expectEqual(i + 1, core.current.?.persisted);
            try std.testing.expect(core.cursors[0].?.pending != null);
        }
        const lease = queue.take(i).?;
        const expected: [64]u8 = @splat(@intCast(i + 1));
        try std.testing.expectEqual(expected, lease.notice.transaction);
        try queue.complete(lease); // every completion evicts the previous cache row
        if (i < 3) report = try core.tick(i + 1, null);
    }
    try std.testing.expectEqual(@as(usize, 4), report.messages);
    try std.testing.expect(core.current == null);
    try std.testing.expect(core.cursors[0].?.pending == null);
    try std.testing.expectEqual(@as(usize, 0), queue.count());
}

test "transaction-ID restart rescans durable canonical dispatch and immutable Source Rust oracle decodes repaired rows" {
    const a = std.testing.allocator;
    const oracle = std.process.getEnvVarOwned(a, "ZIGGY_TXID_ORACLE") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(oracle);
    const executable = try std.fs.cwd().readFileAlloc(a, oracle, 256 * 1024 * 1024);
    defer a.free(executable);
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha2.Sha256.hash(executable, &digest, .{});
    const encoded_digest = std.fmt.bytesToHex(digest, .lower);
    try std.testing.expectEqualStrings("8e295002b44b4248d00d6627aaa47a21" ++ "2315f6f837f3a2d652f2e7f6ada69fd9", &encoded_digest);
    const self = try Harness.init(a, 1, 2);
    defer self.deinit();
    try self.index(); // durable dispatch, neither companion result persisted yet
    self.database.deinit();
    self.database_open = false;
    self.database = try @import("../../db/rocks.zig").Database.open(a, self.path, .{});
    self.database_open = true;
    var reopened_store = @import("../store.zig").Store.init(a, &self.database, self.chain.name);
    var reopened_queue = try Queue.init(a, 2, .{ .tree = true, .gas = true });
    defer reopened_queue.deinit();
    var restarted: Companion = .{ .allocator = a, .queue = &reopened_queue, .store = &reopened_store, .contracts = contracts, .domain = ORIGIN, .source = self.adapter.interface() };
    defer restarted.deinit();
    _ = try restarted.tick(100, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try reopened_store.payment(.{ .message_id = self.wire.messages[0].id(), .destination = DESTINATION })).?.payment);
    try std.testing.expectEqual(pad(10), (try reopened_store.dispatchedTransaction(self.wire.messages[0].id())).?);
    try std.testing.expectEqual(self.wire.messages[0].id(), (try reopened_store.insertionByIndex(0)).?.message_id);
    self.database.deinit();
    self.database_open = false;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    const result = try std.process.Child.run(.{ .allocator = a, .argv = &.{ oracle, "relayer-probe", self.path, "9913371", "test1", "9913372", "test2", "1" }, .env_map = &environment, .max_output_bytes = 8 * 1024 * 1024 });
    defer a.free(result.stdout);
    defer a.free(result.stderr);
    if (result.term != .Exited or result.term.Exited != 0) std.debug.print("Rust tx-ID readback failed {any}: {s}\n", .{ result.term, result.stderr });
    try std.testing.expect(result.term == .Exited and result.term.Exited == 0);
    const decoded = try std.json.parseFromSlice(std.json.Value, a, result.stdout, .{});
    defer decoded.deinit();
    const rows = decoded.value.object.get("messages").?.array.items;
    try std.testing.expectEqual(@as(usize, 1), rows.len);
    try std.testing.expect(rows[0].object.get("present").?.bool);
    const processed = rows[0].object.get("processed").?;
    try std.testing.expect(processed == .null or (processed == .bool and !processed.bool));
    try std.testing.expectEqualStrings("500", rows[0].object.get("payment").?.object.get("payment").?.string);
    try std.testing.expectEqualStrings("1000", rows[0].object.get("payment").?.object.get("gas_amount").?.string);
    try std.testing.expect(rows[0].object.get("insertion_id_chunks").? != .null);
    std.debug.print("immutable Rust tx-ID restart readback: {s}\n", .{result.stdout});
}

fn receiptAllocationSweep(a: A) !void {
    const self = try Harness.init(std.testing.allocator, 1, 2);
    defer self.deinit();
    try self.index();
    self.companion.allocator = a;
    _ = self.companion.tick(100, &self.cancel) catch |err| {
        if (err == error.OutOfMemory) {
            try std.testing.expect((try self.payment(0)) == null);
            try std.testing.expect((try self.service.store.insertionByIndex(0)) == null);
            try std.testing.expectEqual(@as(usize, 1), self.queue.count());
        }
        return err;
    };
}
test "transaction-ID receipt allocation failures never persist an unvalidated partial receipt or leak ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, receiptAllocationSweep, .{});
}
test "transaction-ID disabled stream mask cancels retained reads and makes no receipt requests" {
    const self = try Harness.init(std.testing.allocator, 1, 2);
    defer self.deinit();
    try self.index();
    self.wire.failures[0] = error.PendingReadIo;
    const pending = try self.companion.tick(100, &self.cancel);
    try std.testing.expect(pending.pending_read);
    try std.testing.expect(self.companion.current != null);
    const reads = self.wire.receipt_reads;
    try std.testing.expect(self.companion.setMask(.{}, 101));
    try std.testing.expect(self.companion.current == null);
    try std.testing.expectEqual(@as(usize, 0), self.queue.count());
    _ = try self.companion.tick(102, &self.cancel);
    try self.queue.admit(.{ .transaction = pad(10), .block_number = 5 });
    _ = try self.companion.tick(103, &self.cancel);
    try std.testing.expectEqual(reads, self.wire.receipt_reads);
    try std.testing.expect((try self.payment(0)) == null);
    self.wire.failures[0] = null;
    try std.testing.expect(self.companion.setMask(.{ .tree = true, .gas = true }, 104));
    _ = try self.companion.tick(104, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
}
test "transaction-ID missing transaction metadata never synthesizes a receipt identity" {
    const self = try Harness.init(std.testing.allocator, 1, 2);
    defer self.deinit();
    var message = self.wire.messages[0];
    message.nonce = 5;
    _ = try self.service.store.storeMessage(message, 5, null);
    _ = try self.service.store.storeMessage(message, 5, @splat(0));
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expectEqual(@as(usize, 0), self.queue.count());
    try std.testing.expectEqual([2]usize{ 0, 0 }, self.wire.receipt_reads);
    try std.testing.expect((try self.service.store.dispatchedTransaction(message.id())) == null);
}

test "transaction-ID startup scanner crosses bounded completion eviction without requeueing its completed prefix" {
    const self = try Harness.init(std.testing.allocator, 1, 1);
    defer self.deinit();
    var store = @import("../store.zig").Store.init(std.testing.allocator, &self.database, "startup-scan");
    for (0..4) |i| {
        var message = self.wire.messages[0];
        message.nonce = @intCast(i);
        _ = try store.storeMessage(message, 5, pad(@intCast(i + 10)));
    }
    const Recorder = struct {
        seen: [8]u8 = @splat(0),
        count: usize = 0,
        fn transaction(context: *anyopaque, a: A, tx: [64]u8) !src.Batch {
            const recorder: *@This() = @ptrCast(@alignCast(context));
            if (recorder.count == recorder.seen.len) return error.UnexpectedRepeatedPrefix;
            recorder.seen[recorder.count] = tx[63];
            recorder.count += 1;
            return .{ .arena = std.heap.ArenaAllocator.init(a), .events = &.{}, .through = 5 };
        }
        fn header(_: *anyopaque, _: src.Selector, _: bool) !src.Header {
            return error.UnexpectedHeader;
        }
        fn events(_: *anyopaque, _: A, _: u64, _: u64, _: [4]u32) !src.Batch {
            return error.UnexpectedRange;
        }
    };
    var recorder: Recorder = .{};
    var queue = try Queue.init(std.testing.allocator, 1, .{ .tree = true, .gas = true });
    defer queue.deinit();
    var companion: Companion = .{ .allocator = std.testing.allocator, .store = &store, .queue = &queue, .contracts = contracts, .domain = ORIGIN, .source = .{ .context = &recorder, .header_fn = Recorder.header, .events_fn = Recorder.events, .transaction_fn = Recorder.transaction } };
    defer companion.deinit();
    for (0..8) |i| _ = try companion.tick(i, &self.cancel);
    try std.testing.expectEqual(@as(usize, 4), recorder.count);
    try std.testing.expectEqualSlices(u8, &.{ 13, 12, 11, 10 }, recorder.seen[0..4]);
    try std.testing.expect(companion.scan_nonce == null);
    try std.testing.expectEqual(@as(usize, 0), queue.count());
}

test "transaction-ID permanently missing prefix yields capacity to healthy later dispatch and remains recoverable" {
    const self = try Harness.init(std.testing.allocator, 2, 1);
    defer self.deinit();
    _ = try self.service.tick(0, &self.cancel);
    try std.testing.expect(self.service.retained != null);
    self.wire.failures[0] = error.TransactionReceiptUnavailable;
    _ = try self.companion.tick(100, &self.cancel);
    try std.testing.expectEqual(@as(usize, 0), self.queue.count());
    _ = try self.service.tick(101, &self.cancel);
    try std.testing.expect(self.service.retained == null);
    _ = try self.companion.tick(102, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(1)).?.payment);
    try std.testing.expect((try self.payment(0)) == null);
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    self.wire.failures[0] = null;
    for (2200..2206) |now| _ = try self.companion.tick(now, &self.cancel);
    try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
    try std.testing.expect(self.queue.replayAt() == null);
    const reads = self.wire.receipt_reads;
    for (10000..10004) |now| _ = try self.companion.tick(now, &self.cancel);
    try std.testing.expectEqual(reads, self.wire.receipt_reads); // idle has no periodic history scan
}
test "transaction-ID failed receipt processed before cooldown retires replay hint without immediate rescan loop" {
    const self = try Harness.init(std.testing.allocator, 1, 1);
    defer self.deinit();
    try self.index();
    self.wire.failures[0] = error.TransactionReceiptUnavailable;
    _ = try self.companion.tick(100, &self.cancel);
    try self.service.store.markProcessed(self.wire.messages[0]);
    _ = try self.companion.tick(2200, &self.cancel);
    try std.testing.expect(self.queue.replayAt() == null);
    try std.testing.expectEqual(@as(u64, 1000), self.queue.nextDelay(2200));
    try std.testing.expectEqual(@as(usize, 1), self.wire.receipt_reads[0]);
    _ = try self.companion.tick(10000, &self.cancel);
    try std.testing.expect(self.companion.scan_nonce == null);
    try std.testing.expectEqual(@as(u64, 1000), self.queue.nextDelay(10000));
}

test "transaction-ID protocol authority permits distinct mapping streams but rejects same-stream conflicts and EVM index aliases" {
    const Fake = struct {
        rows: [4]src.Event,
        count: usize = 3,
        namespaced: bool,
        fn header(_: *anyopaque, _: src.Selector, _: bool) !src.Header {
            return error.UnexpectedHeader;
        }
        fn events(_: *anyopaque, _: A, _: u64, _: u64, _: [4]u32) !src.Batch {
            return error.UnexpectedRange;
        }
        fn authority(ctx: *anyopaque) !src.TransactionAuthority {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            return .{ .emitters = .{ .mailbox = hash(20), .hook = hash(21), .paymaster = hash(21) }, .positions = if (self.namespaced) .per_emitter_stream else .global_log_index };
        }
        fn transaction(ctx: *anyopaque, a: A, _: [64]u8) !src.Batch {
            const self: *@This() = @ptrCast(@alignCast(ctx));
            var arena = std.heap.ArenaAllocator.init(a);
            errdefer arena.deinit();
            const rows = try arena.allocator().dupe(src.Event, self.rows[0..self.count]);
            return .{ .arena = arena, .events = rows, .through = 5 };
        }
    };
    for (0..3) |mode| {
        const self = try Harness.init(std.testing.allocator, 1, 1);
        defer self.deinit();
        try self.index();
        const message = self.wire.messages[0];
        const base = src.Event{ .block_number = 5, .block_hash = hash(5), .address = hash(20), .tx_hash = pad(10), .log_index = 0, .data = .{ .dispatch = message } };
        var fake: Fake = .{ .rows = @splat(base), .namespaced = mode != 0 };
        fake.rows[1].address = hash(21);
        fake.rows[1].data = .{ .insertion = .{ .index = 0, .message_id = message.id() } };
        fake.rows[2].address = hash(21);
        fake.rows[2].data = .{ .gas = .{ .message_id = message.id(), .destination = DESTINATION, .gas = 1000, .payment = 500 } };
        if (mode == 2) {
            fake.rows[3] = fake.rows[2];
            fake.rows[3].data.gas.payment = 501;
            fake.count = 4;
        }
        self.companion.source = .{ .context = &fake, .header_fn = Fake.header, .events_fn = Fake.events, .transaction_fn = Fake.transaction, .transaction_authority_fn = Fake.authority };
        const report = try self.companion.tick(100, &self.cancel);
        if (mode == 1) {
            try std.testing.expect(report.failure == null);
            try std.testing.expectEqual(@as(u256, 500), (try self.payment(0)).?.payment);
            try std.testing.expectEqual(message.id(), (try self.service.store.insertionByIndex(0)).?.message_id);
        } else {
            try std.testing.expectEqual(error.ConflictingTransactionReceiptLog, report.failure.?);
            try std.testing.expect((try self.payment(0)) == null);
            try std.testing.expect((try self.service.store.insertionByIndex(0)) == null);
        }
    }
}
