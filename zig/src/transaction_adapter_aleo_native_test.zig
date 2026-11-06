const std = @import("std");
const Adapter = @import("agents/scraper/aleo.zig").Adapter;
const src = @import("agents/scraper/source.zig");
const events = @import("aleo/events.zig");
const provider = @import("aleo/provider.zig");
const rest = @import("aleo/rest.zig");
const crypto = @import("aleo/crypto.zig");
const mock = @import("cloud/testing.zig");
const json = @import("net/json_rpc.zig");
const authority_fixture = @import("transaction_adapter_aleo_authority_native_test.zig");
const queue = @import("agents/indexing/tx_id_queue.zig");
const Companion = @import("agents/indexing/tx_id_companion.zig").Companion;
const Core = @import("agents/indexing/source.zig").Core;
const Store = @import("agents/store.zig").Store;
const rocks = @import("db/rocks.zig");
const codec = @import("db/codec.zig");
const keys = @import("db/keys.zig");
const A = std.mem.Allocator;
const height = 12618649;
const Mode = enum { success, rejected, bad_metadata, wrong_hash, reorg, missing, pending, cancel, empty };
const Decoder = struct {
    native: events.NativeDecoder,
    mode: Mode,
    target: []const u8,
    fn interface(self: *Decoder) events.Decoder {
        return .{ .context = self, .decode_fn = decode };
    }
    fn decode(context: *anyopaque, a: A, wire: []const u8) !events.Block {
        const self: *Decoder = @ptrCast(@alignCast(context));
        var block = try self.native.interface().decode(a, wire);
        errdefer block.deinit();
        if (self.mode == .rejected or self.mode == .bad_metadata) {
            for ((try json.field(block.value, "transactions")).array.items) |*transaction| {
                if (!std.mem.eql(u8, self.target, try json.string(try json.field(transaction.*, "id")))) continue;
                if (self.mode == .rejected) {
                    try transaction.object.put("accepted", .{ .bool = false });
                } else {
                    try transaction.object.put("index", .{ .string = "bad" });
                }
            }
        }
        return block;
    }
};
fn setting(a: A, name: []const u8) ![]u8 {
    return std.process.getEnvVarOwned(a, name) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
fn fixturePath(a: A) ![]u8 {
    const prefix: []const u8 = blk: {
        std.fs.cwd().access("rust/main/config", .{}) catch break :blk "../rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
        break :blk "rust/main/chains/hyperlane-aleo/src/indexer/mock_responses/delivery_block.json";
    };
    return a.dupe(u8, prefix);
}
fn aleoBatch(a: A, native: *crypto.Crypto, executable: []const u8, library: []const u8, mode: Mode) !src.Batch {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const memory = arena.allocator();
    const path = try fixturePath(memory);
    const block = try std.fs.cwd().readFileAlloc(memory, path, 16 * 1024 * 1024);
    var raw = try std.json.parseFromSlice(std.json.Value, memory, block, .{ .allocate = .alloc_always });
    defer raw.deinit();
    const block_text = try json.string(try json.field(raw.value, "block_hash"));
    var transaction_bytes: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&transaction_bytes, "042cb7ff55639abdda73ace1fbf728dc4" ++ "8a314137842274742ae64060cd4480c");
    const transaction = try native.idText(memory, .transaction, transaction_bytes);
    const other_hash = "ab1w5wd9dz9zu70sd6ck2h0a2zut35p0shuqd5f9vmeg2fcgtmw3g9qkjr635";
    const altered = blk: {
        var parsed = try std.json.parseFromSlice(std.json.Value, memory, block, .{ .allocate = .alloc_always });
        defer parsed.deinit();
        try parsed.value.object.put("block_hash", .{ .string = other_hash });
        break :blk try std.json.Stringify.valueAlloc(memory, parsed.value, .{});
    };
    const find_suffix = try std.fmt.allocPrint(memory, "/find/blockHash/{s}", .{transaction});
    const block_suffix = try std.fmt.allocPrint(memory, "/block/hash/{s}", .{block_text});
    const location = try std.json.Stringify.valueAlloc(memory, block_text, .{});
    const canonical = if (mode == .wrong_hash) altered else block;
    const after = if (mode == .reorg) altered else block;
    const steps = [_]mock.Step{
        .{ .method = .GET, .suffix = find_suffix, .response = location, .status = if (mode == .missing) 404 else 200 },
        .{ .method = .GET, .suffix = block_suffix, .response = block },
        .{ .method = .GET, .suffix = "/block/12618649", .response = canonical },
        .{ .method = .GET, .suffix = "/dispatch_event_index/12618649u32", .response = "null" },
        .{ .method = .GET, .suffix = "/process_event_index/12618649u32", .response = if (mode == .empty) "null" else "\"1u32\"" },
        .{ .method = .GET, .suffix = "/process_events/1u32", .response = "\"[306532680884196914369041306889957777502u128,248078813986496060276330224523516710975u128]\"" },
        .{ .method = .GET, .suffix = "/block/12618649", .response = after },
    };
    const empty_steps = [_]mock.Step{ steps[0], steps[1], steps[2], steps[3], steps[4], steps[6] };
    var script: mock.Mock = .{ .steps = if (mode == .missing) steps[0..1] else if (mode == .rejected or mode == .bad_metadata or mode == .wrong_hash) steps[0..3] else if (mode == .empty) &empty_steps else &steps };
    const Pending = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.PendingReadIo;
        }
    };
    const Cancel = struct {
        fn send(_: *anyopaque, _: A, _: @import("cloud/http.zig").Request) !@import("cloud/http.zig").Response {
            return error.RequestCancelled;
        }
    };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, if (mode == .pending) @import("cloud/http.zig").Transport{ .context = undefined, .send_fn = Pending.send } else if (mode == .cancel) @import("cloud/http.zig").Transport{ .context = undefined, .send_fn = Cancel.send } else script.transport(), &.{.{ .url = "https://fixture" }}, 1), .native = native };
    var decoder: Decoder = .{ .native = .{ .executable = executable, .library = library, .network = 1, .limits = .{ .timeout_ms = 30000 } }, .mode = mode, .target = transaction };
    const hook = try native.address("aleo1479wmm58gcyg28z37dvua77l53dwrmwct80k4ruf906ulp7smupsyg6ak2");
    var adapter: Adapter = .{ .provider = &client, .configuration = .{ .mailbox = "test_mailbox.aleo", .hook_manager = "test_hook_manager.aleo", .ism_manager = "test_ism_manager.aleo", .validator_announce = "test_validator_announce.aleo", .hook = hook, .domain = 1617853565 }, .decoder = decoder.interface(), .paymaster = .{0} ** 32 };
    var batch = try adapter.interface().transactionEvents(a, .{0} ** 32 ++ transaction_bytes);
    if (mode == .success or mode == .empty) {
        errdefer batch.deinit();
        try script.expectDone();
    }
    return batch;
}
test "Aleo native transaction companion filters the exact accepted delivery and preserves production metadata" {
    const a = std.testing.allocator;
    const crypto_path = try setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    var batch = try aleoBatch(a, &native, executable, vm_path, .success);
    defer batch.deinit();
    try std.testing.expectEqual(@as(u64, height), batch.through);
    try std.testing.expectEqual(@as(usize, 1), batch.events.len);
    const event = batch.events[0];
    try std.testing.expectEqual(@as(u64, 0), event.tx_index);
    try std.testing.expectEqual(@as(u64, 1), event.log_index);
    try std.testing.expectEqual(@as(?u32, 1), event.sequence);
    var expected_hash: [32]u8 = undefined;
    _ = try std.fmt.hexToBytes(&expected_hash, "042cb7ff55639abdda73ace1fbf728dc4" ++ "8a314137842274742ae64060cd4480c");
    try std.testing.expectEqualSlices(u8, &(.{0} ** 32 ++ expected_hash), &event.tx_hash.?);
}
test "Aleo native transaction companion accepts an empty accepted receipt and propagates cancellation and invalid IDs" {
    const a = std.testing.allocator;
    const crypto_path = try setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    var empty = try aleoBatch(a, &native, executable, vm_path, .empty);
    defer empty.deinit();
    try std.testing.expectEqual(@as(u64, height), empty.through);
    try std.testing.expectEqual(@as(usize, 0), empty.events.len);
    try std.testing.expectError(error.RequestCancelled, aleoBatch(a, &native, executable, vm_path, .cancel));
    var script: mock.Mock = .{ .steps = &.{} };
    var client: provider.Provider = .{ .client = try rest.Client.init(a, script.transport(), &.{.{ .url = "https://fixture" }}, 1), .native = &native };
    var adapter: Adapter = .{ .provider = &client, .configuration = undefined, .decoder = undefined, .paymaster = .{0} ** 32 };
    try std.testing.expectError(error.UnsupportedAleoTransactionId, adapter.interface().transactionEvents(a, .{1} ** 64));
    try std.testing.expectError(error.UnsupportedAleoTransactionId, adapter.interface().transactionEvents(a, .{0} ** 64));
}
test "Aleo native transaction companion rejects rejected missing malformed and noncanonical transactions" {
    const a = std.testing.allocator;
    const crypto_path = try setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    try std.testing.expectError(error.AleoTransactionRejected, aleoBatch(a, &native, executable, vm_path, .rejected));
    try std.testing.expectError(error.InvalidJsonRpcResult, aleoBatch(a, &native, executable, vm_path, .bad_metadata));
    try std.testing.expectError(error.NoncanonicalAleoTransaction, aleoBatch(a, &native, executable, vm_path, .wrong_hash));
    try std.testing.expectError(error.NoncanonicalAleoTransaction, aleoBatch(a, &native, executable, vm_path, .reorg));
    try std.testing.expectError(error.AleoHttpStatus, aleoBatch(a, &native, executable, vm_path, .missing));
    try std.testing.expectError(error.PendingReadIo, aleoBatch(a, &native, executable, vm_path, .pending));
}

fn withNative(a: A, context: anytype, comptime run: anytype) !void {
    const crypto_path = try authority_fixture.setting(a, "HYPERLANE_ALEO_CRYPTO_LIBRARY");
    defer a.free(crypto_path);
    const vm_path = try authority_fixture.setting(a, "HYPERLANE_ALEO_VM_LIBRARY");
    defer a.free(vm_path);
    const executable = try authority_fixture.setting(a, "HYPERLANE_ALEO_VM_WORKER");
    defer a.free(executable);
    var native = try crypto.Crypto.init(crypto_path);
    defer native.deinit();
    try authority_fixture.withAuthorityFixture(a, &native, executable, vm_path, context, run);
}
fn payloadId() [32]u8 {
    var id: [32]u8 = undefined;
    std.mem.writeInt(u128, id[0..16], 1, .little);
    std.mem.writeInt(u128, id[16..32], 2, .little);
    return id;
}
fn gasMetaPresent(a: A, store: *Store, transaction: [64]u8) !bool {
    const encoded = try codec.encode(a, codec.GasPaymentMeta{ .transaction_id = transaction, .log_index = 0 });
    defer a.free(encoded);
    const value = try store.typed.get(a, keys.Table.gas_payment_meta_processed.prefix(), encoded);
    if (value) |bytes| a.free(bytes);
    return value != null;
}
const ForwardedSource = struct {
    batch: ?src.Batch,
    authority_source: src.Source,
    header_value: ?src.Header = null,
    fn interface(self: *ForwardedSource) src.Source {
        return .{ .context = self, .header_fn = header, .events_fn = rangeEvents, .transaction_fn = fetch, .transaction_authority_fn = authority };
    }
    fn authority(context: *anyopaque) !src.TransactionAuthority {
        const self: *ForwardedSource = @ptrCast(@alignCast(context));
        return self.authority_source.transactionAuthority(undefined);
    }
    fn header(context: *anyopaque, _: src.Selector, _: bool) !src.Header {
        const self: *ForwardedSource = @ptrCast(@alignCast(context));
        return self.header_value orelse error.MissingForwardedHeader;
    }
    fn take(self: *ForwardedSource) !src.Batch {
        const batch = self.batch orelse return error.UnexpectedForwardedRead;
        self.batch = null;
        return batch;
    }
    fn fetch(context: *anyopaque, _: A, _: [64]u8) !src.Batch {
        const self: *ForwardedSource = @ptrCast(@alignCast(context));
        return self.take();
    }
    fn rangeEvents(context: *anyopaque, _: A, _: u64, _: u64, _: [4]u32) !src.Batch {
        const self: *ForwardedSource = @ptrCast(@alignCast(context));
        return self.take();
    }
};
const ConsumerProof = struct {
    fn run(_: void, adapter: *Adapter, script: *mock.Mock, transaction_bytes: [32]u8) !void {
        const a = std.testing.allocator;
        const transaction: [64]u8 = .{0} ** 32 ++ transaction_bytes;
        var directory = std.testing.tmpDir(.{});
        defer directory.cleanup();
        const path = try directory.dir.realpathAlloc(a, ".");
        defer a.free(path);
        var database = try rocks.Database.open(a, path, .{});
        defer database.deinit();
        var store = Store.init(a, &database, "aleo-actual-consumer-fixture");
        const logical: src.Contracts = .{ .mailbox = try adapter.provider.native.programAddress(adapter.configuration.mailbox), .hook = adapter.configuration.hook, .paymaster = adapter.paymaster };
        var pending = try queue.Queue.init(a, 4, .{ .tree = true, .gas = true });
        defer pending.deinit();
        var companion: Companion = .{ .allocator = a, .store = &store, .queue = &pending, .contracts = logical, .domain = adapter.configuration.domain, .source = adapter.interface() };
        defer companion.deinit();
        try pending.admit(.{ .transaction = transaction, .block_number = height });
        var cancel: std.atomic.Value(bool) = .init(false);
        const first = try companion.tick(0, &cancel);
        try std.testing.expectEqual(@as(usize, 3), first.work);
        try script.expectDone();
        const id = payloadId();
        const payment = (try store.payment(.{ .message_id = id, .destination = 2000 })).?;
        try std.testing.expectEqual(@as(u256, 2500), payment.payment);
        try std.testing.expectEqual(@as(u256, 1000), payment.gas_amount);
        try std.testing.expectEqual(id, (try store.insertionByIndex(0)).?.message_id);
        try std.testing.expectEqual(@as(?u64, height), try store.logBlock(.gas, 0));
        try std.testing.expectEqual(@as(?u64, height), try store.logBlock(.insertion, 0));
        try std.testing.expectEqual(@as(?u32, null), try store.gasWatermark());
        try std.testing.expect(try gasMetaPresent(a, &store, transaction));
        script.index = 0;
        var replay_queue = try queue.Queue.init(a, 4, .{ .tree = true, .gas = true });
        defer replay_queue.deinit();
        var replay: Companion = .{ .allocator = a, .store = &store, .queue = &replay_queue, .contracts = logical, .domain = adapter.configuration.domain, .source = adapter.interface() };
        defer replay.deinit();
        try replay_queue.admit(.{ .transaction = transaction, .block_number = height });
        const second = try replay.tick(1, &cancel);
        try std.testing.expectEqual(@as(usize, 1), second.work);
        try script.expectDone();
        try std.testing.expectEqual(@as(u256, 2500), (try store.payment(.{ .message_id = id, .destination = 2000 })).?.payment);
        try std.testing.expectEqual(id, (try store.insertionByIndex(0)).?.message_id);
        try std.testing.expectEqual(@as(?u32, null), try store.gasWatermark());
        try std.testing.expect(try gasMetaPresent(a, &store, transaction));
    }
};
test "Aleo actual same-index batch reaches common Companion and real Rocks idempotently" {
    try withNative(std.testing.allocator, {}, ConsumerProof.run);
}
const ConflictProof = struct {
    fn run(_: void, adapter: *Adapter, script: *mock.Mock, transaction_bytes: [32]u8) !void {
        const a = std.testing.allocator;
        const transaction: [64]u8 = .{0} ** 32 ++ transaction_bytes;
        var batch = try adapter.interface().transactionEvents(a, transaction);
        errdefer batch.deinit();
        try script.expectDone();
        var conflict: src.Event = undefined;
        for (batch.events) |event| if (event.data == .gas) {
            conflict = event;
            conflict.data.gas.payment += 1;
        };
        const events_copy = try batch.arena.allocator().alloc(src.Event, batch.events.len + 1);
        @memcpy(events_copy[0..batch.events.len], batch.events);
        events_copy[batch.events.len] = conflict;
        batch.events = events_copy;
        var forwarded: ForwardedSource = .{ .batch = batch, .authority_source = adapter.interface() };
        defer if (forwarded.batch) |*owned| owned.deinit();
        var directory = std.testing.tmpDir(.{});
        defer directory.cleanup();
        const path = try directory.dir.realpathAlloc(a, ".");
        defer a.free(path);
        var database = try rocks.Database.open(a, path, .{});
        defer database.deinit();
        var store = Store.init(a, &database, "aleo-conflict-consumer-fixture");
        var pending = try queue.Queue.init(a, 4, .{ .tree = true, .gas = true });
        defer pending.deinit();
        const logical: src.Contracts = .{ .mailbox = try adapter.provider.native.programAddress(adapter.configuration.mailbox), .hook = adapter.configuration.hook, .paymaster = adapter.paymaster };
        var companion: Companion = .{ .allocator = a, .store = &store, .queue = &pending, .contracts = logical, .domain = adapter.configuration.domain, .source = forwarded.interface() };
        defer companion.deinit();
        try pending.admit(.{ .transaction = transaction, .block_number = height });
        var cancel: std.atomic.Value(bool) = .init(false);
        const report = try companion.tick(0, &cancel);
        try std.testing.expectEqual(error.ConflictingTransactionReceiptLog, report.failure.?);
        try std.testing.expectEqual(@as(usize, 0), report.work);
        try std.testing.expectEqual(@as(?@import("db/codec.zig").GasPaymentData, null), try store.payment(.{ .message_id = payloadId(), .destination = 2000 }));
        try std.testing.expectEqual(@as(?@import("db/codec.zig").MerkleInsertion, null), try store.insertionByIndex(0));
        try std.testing.expect(!try gasMetaPresent(a, &store, transaction));
        try std.testing.expectEqual(@as(?u32, null), try store.gasWatermark());
    }
};
test "Aleo same-kind emitter index conflict rejects before any Rocks writes" {
    try withNative(std.testing.allocator, {}, ConflictProof.run);
}
const CoreProof = struct {
    fn run(_: void, adapter: *Adapter, script: *mock.Mock, transaction_bytes: [32]u8) !void {
        const a = std.testing.allocator;
        var batch = try adapter.interface().transactionEvents(a, .{0} ** 32 ++ transaction_bytes);
        errdefer batch.deinit();
        try script.expectDone();
        const first = batch.events[0];
        var forwarded: ForwardedSource = .{ .batch = batch, .authority_source = adapter.interface(), .header_value = .{ .height = first.block_number, .hash = first.block_hash, .parent = .{0} ** 32, .timestamp = 0 } };
        defer if (forwarded.batch) |*owned| owned.deinit();
        var directory = std.testing.tmpDir(.{});
        defer directory.cleanup();
        const path = try directory.dir.realpathAlloc(a, ".");
        defer a.free(path);
        var database = try rocks.Database.open(a, path, .{});
        defer database.deinit();
        var store = Store.init(a, &database, "aleo-core-authority-fixture");
        const logical: src.Contracts = .{ .mailbox = try adapter.provider.native.programAddress(adapter.configuration.mailbox), .hook = adapter.configuration.hook, .paymaster = adapter.paymaster };
        var core: Core(Store) = .{ .allocator = a, .source = forwarded.interface(), .store = &store, .options = .{ .domain = adapter.configuration.domain, .contracts = logical, .chunk = 1, .lowest = 0 } };
        defer core.deinit();
        var ranged = try core.fetchInsertionRange(.{ .from = height, .to = height }, height, null);
        defer ranged.deinit();
        try std.testing.expectEqual(@as(usize, 1), ranged.events.len);
        try std.testing.expectEqual(@as(u64, 0), ranged.events[0].log_index);
        try std.testing.expectEqual(payloadId(), ranged.events[0].data.insertion.message_id);
        try std.testing.expectEqual(try adapter.provider.native.programAddress(adapter.configuration.hook_manager), ranged.events[0].address);
        try std.testing.expect(!std.mem.eql(u8, &logical.hook, &ranged.events[0].address));
    }
};
test "Aleo actual Core range accepts program emitter authority over logical hook" {
    try withNative(std.testing.allocator, {}, CoreProof.run);
}
