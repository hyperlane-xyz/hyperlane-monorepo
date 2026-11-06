//! Compare the port with37 vectors from unmodified production Rust helpers,
//! real Solana SDK compilation/signing and independent core/k256 CCS hashing.
const std = @import("std");
const reveal = @import("reveal.zig");
const sol = @import("../../altvm/solana.zig");
const rpc = @import("../../net/json_rpc.zig");
const protocol = @import("../../protocol/root.zig");
const ccip = @import("../../relayer/ccip.zig");
const tx = @import("../../sealevel/transaction.zig");
const A = std.mem.Allocator;
const V = std.json.Value;
const Key = [32]u8;
fn bytes(a: A, value: V) ![]u8 {
    if (value != .array) return error.InvalidOracleBytes;
    var text: std.ArrayList(u8) = .empty;
    defer text.deinit(a);
    for (value.array.items) |chunk| try text.appendSlice(a, try rpc.string(chunk));
    const result = try a.alloc(u8, text.items.len / 2);
    errdefer a.free(result);
    if (text.items.len % 2 != 0) return error.InvalidOracleBytes;
    _ = try std.fmt.hexToBytes(result, text.items);
    return result;
}
fn key(a: A, value: V) !Key {
    const raw = try bytes(a, value);
    defer a.free(raw);
    if (raw.len != 32) return error.InvalidOracleKey;
    return raw[0..32].*;
}
fn field(value: V, name: []const u8) !V {
    return rpc.field(value, name);
}
fn number(comptime T: type, value: V) !T {
    return std.fmt.parseInt(T, try rpc.string(value), 10);
}
fn equalBytes(a: A, expected: V, actual: []const u8) !void {
    const raw = try bytes(a, expected);
    defer a.free(raw);
    try std.testing.expectEqualSlices(u8, raw, actual);
}
fn accounts(a: A, value: V) ![]sol.AccountMeta {
    if (value != .array) return error.InvalidOracleAccounts;
    const out = try a.alloc(sol.AccountMeta, value.array.items.len);
    errdefer a.free(out);
    for (value.array.items, out) |item, *meta| meta.* = .{ .key = try key(a, try field(item, "pubkey")), .is_signer = (try field(item, "is_signer")).bool, .is_writable = (try field(item, "is_writable")).bool };
    return out;
}
fn instructions(a: A, expected: V, actual: []const sol.Instruction) !void {
    try std.testing.expectEqual(expected.array.items.len, actual.len);
    for (expected.array.items, actual) |item, instruction| {
        try std.testing.expectEqual(try key(a, try field(item, "program_id")), instruction.program);
        try equalBytes(a, try field(item, "data"), instruction.data);
        const metas = try accounts(a, try field(item, "accounts"));
        defer a.free(metas);
        try std.testing.expectEqualSlices(sol.AccountMeta, metas, instruction.accounts);
    }
}
fn buildCase(a: A, kind: []const u8, input: V, expected: V) !void {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    const metas = try accounts(temporary, try field(input, "accounts"));
    const data = try bytes(temporary, try field(input, "data"));
    const salt = try key(temporary, try field(input, "salt"));
    var hash = std.crypto.hash.sha3.Keccak256.init(.{});
    hash.update(&salt);
    hash.update(data);
    var commitment: Key = undefined;
    hash.final(&commitment);
    const commit: reveal.Commit = .{ .id = .{0} ** 32, .program = try key(temporary, try field(input, "program")), .origin = try number(u32, try field(input, "origin")), .sender = try key(temporary, try field(input, "sender")), .user_salt = try key(temporary, try field(input, "user_salt")), .recipient = try key(temporary, try field(input, "recipient")), .commitment = commitment };
    const ccs: reveal.Ccs = .{ .arena = undefined, .data = data, .salt = salt, .accounts = metas };
    var pool: ?reveal.Pool = null;
    const pool_data = try field(input, "pool_data");
    if (pool_data != .null) {
        const raw = try bytes(temporary, pool_data);
        pool = reveal.Pool.decode(metas[5].key, reveal.raydium, raw) catch |failure| {
            if (expected.object.get("error") != null and failure == error.TruncatedRevealPool) return;
            return failure;
        };
    }
    const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{7} ** 32)).public_key.toBytes();
    var built = reveal.build(a, commit, ccs, payer, pool) catch |failure| {
        if (expected.object.get("error") != null and failure == error.RevealPoolRequired) return;
        return failure;
    };
    defer built.deinit();
    var closed: ?reveal.Instructions = null;
    defer if (closed) |*value| value.deinit();
    const selected = if (std.mem.eql(u8, kind, "close")) blk: {
        const close = built.close orelse {
            try std.testing.expect(expected.object.get("error") != null);
            return;
        };
        closed = try reveal.closeInstructions(a, commit, payer, close);
        break :blk closed.?.values;
    } else built.values;
    try std.testing.expect(expected.object.get("error") == null);
    try equalBytes(a, try field(expected, "commitment"), &commit.commitment);
    try std.testing.expectEqual(try key(a, try field(expected, "payer")), payer);
    try instructions(a, try field(expected, "instructions"), selected);
    const units = try number(u32, try field(expected, "compute_units"));
    try std.testing.expectEqual(@as(u32, if (std.mem.eql(u8, kind, "close")) reveal.close_units else reveal.reveal_units), units);
    var budget = tx.BudgetInstructions.init(payer, .{ .compute_units = units, .compute_unit_price_micro_lamports = 0 }, .rpc);
    const first = budget.instructions(.rpc, selected[0]);
    const full = try temporary.alloc(sol.Instruction, selected.len + 2);
    @memcpy(full[0..2], first[0..2]);
    @memcpy(full[2..], selected);
    var message: [4096]u8 = undefined;
    const compiled = try sol.compileLegacy(payer, .{8} ** 32, full, &message);
    try equalBytes(a, try field(expected, "message"), compiled.bytes);
    var wire: [4096]u8 = undefined;
    const signed = try sol.signTransaction(compiled, &.{.{7} ** 32}, &wire);
    try equalBytes(a, try field(expected, "signed_transaction"), signed);
    try equalBytes(a, try field(expected, "signature"), signed[1..65]);
}
test "SVM reveal matches37 actual production Rust helper and Solana SDK full wire fixtures" {
    const a = std.testing.allocator;
    const fixture_bytes = try @import("../../testing/fixture.zig").bytes(a, @embedFile("fixtures/reveal.jsonl.gz"), 16 * 1024 * 1024);
    defer a.free(fixture_bytes);
    var lines = std.mem.splitScalar(u8, fixture_bytes, '\n');
    var count: usize = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        var parsed = try std.json.parseFromSlice(V, a, line, .{ .duplicate_field_behavior = .@"error" });
        defer parsed.deinit();
        const value = parsed.value;
        const kind = try rpc.string(try field(value, "kind"));
        const input = try field(value, "input");
        const expected = try field(value, "expected");
        if (std.mem.eql(u8, kind, "tick")) {
            const current = try number(i32, try field(input, "current"));
            const spacing = try number(i16, try field(input, "spacing"));
            if (expected.object.get("error") != null) try std.testing.expectError(error.InvalidRevealTickSpacing, reveal.tickStart(current, spacing)) else {
                const start = try reveal.tickStart(current, spacing);
                try std.testing.expectEqual(try number(i32, try field(expected, "start")), start);
                try std.testing.expectEqual(try key(a, try field(expected, "address")), try reveal.tickArray(try key(a, try field(input, "pool")), start));
            }
        } else if (std.mem.eql(u8, kind, "pda")) {
            const commit: reveal.Commit = .{ .id = .{0} ** 32, .recipient = .{0} ** 32, .program = try key(a, try field(input, "program")), .origin = try number(u32, try field(input, "origin")), .sender = try key(a, try field(input, "sender")), .user_salt = try key(a, try field(input, "user_salt")), .commitment = try key(a, try field(input, "commitment")) };
            try std.testing.expectEqual(try key(a, try field(expected, "pending")), (try commit.pending()).key);
            try std.testing.expectEqual(try key(a, try field(expected, "fee_payer")), (try reveal.feePayer(commit.program)).key);
            try std.testing.expectEqual(try key(a, try field(expected, "ata")), try reveal.associated(try key(a, try field(input, "owner")), try key(a, try field(input, "mint")), try key(a, try field(input, "token_program"))));
        } else if (std.mem.eql(u8, kind, "ccs")) {
            const commitment = try bytes(a, try field(input, "commitment"));
            defer a.free(commitment);
            const sender = try bytes(a, try field(input, "sender"));
            defer a.free(sender);
            const url = try rpc.string(try field(input, "url"));
            const request_hash = ccip.requestHash(sender[0..20].*, commitment, url);
            const digest = protocol.ethSignedMessageHash(request_hash);
            try equalBytes(a, try field(expected, "signing_hash"), &request_hash);
            try equalBytes(a, try field(expected, "digest"), &digest);
            const signature = try bytes(a, try field(expected, "signature"));
            defer a.free(signature);
            try std.testing.expectEqual(try protocol.signature.secretKeyAddress(.{0x11} ** 32), try protocol.signature.recover(digest, signature[0..65].*));
            if (commitment.len == 32) {
                const commit: reveal.Commit = .{ .id = .{0} ** 32, .program = .{0} ** 32, .origin = 0, .sender = .{0} ** 32, .commitment = commitment[0..32].*, .user_salt = .{0} ** 32, .recipient = .{0} ** 32 };
                try std.testing.expect(std.mem.endsWith(u8, url, "/calldata"));
                try std.testing.expectEqual(digest, try reveal.authenticationHash(a, url[0 .. url.len - "/calldata".len], commit, sender[0..20].*, false));
            }
        } else if (std.mem.eql(u8, kind, "build") or std.mem.eql(u8, kind, "close")) try buildCase(a, kind, input, expected) else return error.UnknownRevealOracleKind;
        count += 1;
    }
    try std.testing.expectEqual(@as(usize, 37), count);
}
