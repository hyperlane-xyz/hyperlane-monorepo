//! Fixture-only integration helper. Rust creates a disposable native database,
//! Zig compares every row and atomically mutates typed state, Rust reads it back.
const std = @import("std");
const rocks = @import("rocks.zig");
const codec = @import("codec.zig");
const json = @import("json.zig");
const keys = @import("keys.zig");
const fixtures = @import("fixture.zig");
const allocator = std.heap.smp_allocator;
comptime {
    _ = @import("bzip2_glue.zig");
}

fn compare(db: *rocks.Database, manifest: std.json.Value) !void {
    const records = manifest.object.get("records") orelse return error.MissingRecords;
    if (records != .array) return error.InvalidRecords;
    var iterator = try db.prefix(allocator, "");
    defer iterator.deinit();
    var count: usize = 0;
    while (try iterator.next(allocator)) |row| {
        var entry = row;
        defer entry.deinit();
        if (count >= records.array.items.len) return error.UnexpectedDatabaseRow;
        const expected = records.array.items[count];
        if (expected != .object) return error.InvalidExpectedRow;
        const key = try fixtures.hexBytes(allocator, expected.object.get("key") orelse return error.MissingKey);
        defer allocator.free(key);
        const value = try fixtures.hexBytes(allocator, expected.object.get("value") orelse return error.MissingValue);
        defer allocator.free(value);
        if (!std.mem.eql(u8, key, entry.key)) return error.KeyMismatch;
        if (!std.mem.eql(u8, value, entry.value)) return error.ValueMismatch;
        count += 1;
    }
    if (count != records.array.items.len) return error.MissingDatabaseRows;
    const output = try std.fmt.allocPrint(allocator, "{{\"verified_rows\":{d},\"reader\":\"Zig native RocksDB C API\"}}\n", .{count});
    defer allocator.free(output);
    try std.fs.File.stdout().writeAll(output);
}

fn mutate(db: *rocks.Database, manifest: std.json.Value) !void {
    const domain = manifest.object.get("domain") orelse return error.MissingDomain;
    if (domain != .string or !std.mem.eql(u8, domain.string, "arbitrum")) return error.NotInteropFixture;
    const message_id = try fixtures.hexBytes(allocator, manifest.object.get("message_id") orelse return error.MissingMessageId);
    defer allocator.free(message_id);
    if (message_id.len != 32) return error.InvalidMessageId;
    const typed: rocks.Typed = .{ .database = db, .domain_name = domain.string };
    var batch = try typed.batch(allocator);
    defer batch.deinit();
    const nonce = try codec.encode(allocator, @as(u32, 42));
    defer allocator.free(nonce);
    try batch.put(keys.Table.nonce_processed.prefix(), nonce, &.{1});
    const pending_prefix = try keys.pendingDestination(allocator, 1);
    defer allocator.free(pending_prefix);
    try batch.delete(pending_prefix, nonce);
    try batch.delete(keys.Table.terminally_dropped_message_by_id.prefix(), message_id);
    const gas_key = try codec.encode(allocator, codec.GasPaymentKey{ .message_id = message_id[0..32].*, .destination = 1 });
    defer allocator.free(gas_key);
    const gas_value = try codec.encode(allocator, codec.GasPaymentData{ .payment = 321, .gas_amount = 654 });
    defer allocator.free(gas_value);
    try batch.put(keys.Table.gas_payment_for_message_id.prefix(), gas_key, gas_value);
    const retry_state: json.RetryState = .{ .retry_count = 7, .next_attempt_at_millis = null, .retry_delay_millis = null, .reason = null };
    const retry = try retry_state.toJson(allocator);
    defer allocator.free(retry);
    try batch.put(keys.Table.pending_message_retry_state.prefix(), message_id, retry);
    const retry_count = try codec.encode(allocator, @as(u32, 7));
    defer allocator.free(retry_count);
    try batch.put(keys.Table.pending_message_retry_count.prefix(), message_id, retry_count);
    const cursor = try codec.encode(allocator, codec.BackwardCursor{ .sequence = 7, .block = 987 });
    defer allocator.free(cursor);
    try batch.put(keys.Table.message_backward_cursor.prefix(), retry_count, cursor);
    try batch.commit();
    try std.fs.File.stdout().writeAll("{\"mutated\":true,\"atomic\":true,\"wal_sync\":true}\n");
}

pub fn main() !void {
    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);
    if (args.len != 4) return error.ExpectedOperationPathManifest;
    const input = try std.fs.cwd().readFileAlloc(allocator, args[3], 16 * 1024 * 1024);
    defer allocator.free(input);
    const parsed = try std.json.parseFromSlice(std.json.Value, allocator, input, .{});
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidManifest;
    const fixture_id = parsed.value.object.get("fixture_id") orelse return error.NotInteropFixture;
    if (fixture_id != .string or !std.mem.eql(u8, fixture_id.string, "ziggy-rust-rocksdb-interop-v1")) return error.NotInteropFixture;
    const write = std.mem.eql(u8, args[1], "mutate");
    if (!write and !std.mem.eql(u8, args[1], "compare")) return error.UnknownOperation;
    var diagnostic: rocks.Diagnostic = .{};
    var db = rocks.Database.open(allocator, args[2], .{ .create_if_missing = false, .read_only = !write, .sync = true, .diagnostic = &diagnostic }) catch |err| {
        std.debug.print("Native fixture DB error: {s}\n", .{diagnostic.message()});
        return err;
    };
    defer db.deinit();
    if (write) try mutate(&db, parsed.value) else try compare(&db, parsed.value);
}
