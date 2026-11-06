//! Exact raw-JSON transaction relevance rules from Sealevel LogMetaComposer:
//! successful transaction, static+ALT keys, top-level+inner compiled instruction,
//! requested program/PDA and fully decoded dispatch/process/payment variant.
const std = @import("std");
const p = @import("provider.zig");
const b58 = @import("../altvm/base58.zig");
const borsh = @import("borsh.zig");
pub const Kind = enum { dispatch, delivery, gas };
pub const Found = struct { hash: [64]u8, index: u64 };
pub fn find(a: std.mem.Allocator, block: std.json.Value, program: [32]u8, pda: [32]u8, kind: Kind) !?Found {
    const list = try p.field(block, "transactions");
    if (list == .null) return error.SvmNoTransactions;
    if (list != .array) return error.InvalidSvmResponse;
    var found: ?Found = null;
    for (list.array.items, 0..) |item, index| {
        const meta = try p.field(item, "meta");
        if (meta == .null) continue;
        if (try p.field(meta, "err") != .null) continue;
        const transaction = try p.field(item, "transaction");
        if (transaction != .object) continue;
        const signatures = try p.field(transaction, "signatures");
        if (signatures != .array or signatures.array.items.len == 0) continue;
        const signature_text = try p.string(signatures.array.items[0]);
        if (signature_text.len < 64 or signature_text.len > 88) continue;
        const signature = b58.decode(a, signature_text) catch |err| {
            if (err == error.OutOfMemory) return err;
            continue;
        };
        defer a.free(signature);
        if (signature.len != 64) continue;
        const message = try p.field(transaction, "message");
        const keys = try p.field(message, "accountKeys");
        if (keys != .array) return error.InvalidSvmResponse;
        if (keys.array.items.len > 256) return error.SvmTooManyAccountKeys;
        var all: std.ArrayList([32]u8) = .empty;
        defer all.deinit(a);
        for (keys.array.items) |key| {
            if (key != .string) return error.SvmRawTransactionRequired;
            try all.append(a, try p.decodeKey(a, key.string));
        }
        if (meta.object.get("loadedAddresses")) |loaded| if (loaded != .null) {
            for ([_][]const u8{ "writable", "readonly" }) |name| {
                const entries = try p.field(loaded, name);
                if (entries != .array) return error.InvalidSvmResponse;
                if (entries.array.items.len > 256 - all.items.len) return error.SvmTooManyAccountKeys;
                for (entries.array.items) |key| try all.append(a, try p.decodeKey(a, try p.string(key)));
            }
        };
        if (all.items.len > 256) return error.SvmTooManyAccountKeys;
        var program_index: ?usize = null;
        var pda_index: ?usize = null;
        for (all.items, 0..) |key, i| {
            if (std.mem.eql(u8, &program, &key)) program_index = i;
            if (std.mem.eql(u8, &pda, &key)) pda_index = i;
        }
        if (program_index == null or pda_index == null) continue;
        var relevant = try instructions(a, try p.field(message, "instructions"), program_index.?, pda_index.?, kind);
        if (!relevant) if (meta.object.get("innerInstructions")) |inner| if (inner != .null) {
            if (inner != .array) return error.InvalidSvmResponse;
            for (inner.array.items) |group| {
                if (try instructions(a, try p.field(group, "instructions"), program_index.?, pda_index.?, kind)) {
                    relevant = true;
                    break;
                }
            }
        };
        if (!relevant) continue;
        if (found != null) return error.SvmAmbiguousTransaction;
        found = .{ .hash = signature[0..64].*, .index = index };
    }
    return found;
}
fn instructions(a: std.mem.Allocator, values: std.json.Value, program: usize, pda: usize, kind: Kind) !bool {
    if (values != .array) return error.InvalidSvmResponse;
    for (values.array.items) |ixn| {
        if (ixn != .object or ixn.object.get("programIdIndex") == null) continue;
        if (try p.uint(try p.field(ixn, "programIdIndex")) != program) continue;
        const accounts = try p.field(ixn, "accounts");
        if (accounts != .array) return error.InvalidSvmResponse;
        var has = false;
        for (accounts.array.items) |index| if (try p.uint(index) == pda) {
            has = true;
            break;
        };
        if (!has) continue;
        const instruction_text = try p.string(try p.field(ixn, "data"));
        // A transaction is limited to1232 wire bytes. Bound quadratic base58
        // conversion before allocating, even when JSON-RPC returns malicious data.
        if (instruction_text.len > 1700) continue;
        const decoded = b58.decode(a, instruction_text) catch |err| {
            if (err == error.OutOfMemory) return err;
            continue;
        };
        defer a.free(decoded);
        if (matches(decoded, kind)) return true;
    }
    return false;
}
pub fn matches(bytes: []const u8, kind: Kind) bool {
    var r: borsh.Reader = .{ .bytes = bytes };
    const tag = r.uint(u8) catch return false;
    switch (kind) {
        .dispatch => {
            if (tag != 4) return false;
            _ = r.take(68) catch return false;
            _ = r.vec() catch return false;
        },
        .delivery => {
            if (tag != 1) return false;
            _ = r.vec() catch return false;
            _ = r.vec() catch return false;
        },
        .gas => {
            if (tag != 3) return false;
            _ = r.take(44) catch return false;
        },
    }
    r.end() catch return false;
    return true;
}
test "scraper SVM instruction variants reject every truncation wrong tag and trailing byte" {
    var dispatch: [73]u8 = .{0} ** 73;
    dispatch[0] = 4;
    var payment: [45]u8 = .{0} ** 45;
    payment[0] = 3;
    var delivery: [9]u8 = .{0} ** 9;
    delivery[0] = 1;
    inline for (.{ .{ dispatch, Kind.dispatch }, .{ payment, Kind.gas }, .{ delivery, Kind.delivery } }) |case| {
        const bytes = case[0];
        try std.testing.expect(matches(&bytes, case[1]));
        for (0..bytes.len) |length| try std.testing.expect(!matches(bytes[0..length], case[1]));
    }
    try std.testing.expect(!matches(&dispatch, .gas));
    try std.testing.expect(!matches(&payment, .dispatch));
}

test "scraper SVM transaction relevance matches nine actual production Rust fixtures including ALTs inner instructions and reverted siblings" {
    const a = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../agents/scraper/fixtures/svm-meta-production.json.gz"), .{});
    defer parsed.deinit();
    const blocks = try p.field(parsed.value, "blocks");
    const cases = try p.field(parsed.value, "cases");
    for (cases.array.items) |case| {
        const name = try p.string(try p.field(case, "block"));
        const block = try p.field(blocks, name);
        const program = try p.decodeKey(a, try p.string(try p.field(case, "program")));
        const pda = try p.decodeKey(a, try p.string(try p.field(case, "pda")));
        const kind = std.meta.stringToEnum(Kind, try p.string(try p.field(case, "kind"))).?;
        const expected = try p.field(case, "index");
        const found = try find(a, block, program, pda, kind);
        if (expected == .null) {
            try std.testing.expect(found == null);
        } else {
            try std.testing.expect(found != null);
            try std.testing.expectEqual(try p.uint(expected), found.?.index);
            const transactions = try p.field(block, "transactions");
            const transaction = try p.field(transactions.array.items[@intCast(found.?.index)], "transaction");
            const signatures = try p.field(transaction, "signatures");
            const signature = try b58.decode(a, try p.string(signatures.array.items[0]));
            defer a.free(signature);
            try std.testing.expectEqualSlices(u8, signature, &found.?.hash);
        }
    }
}

fn allocationFind(a: std.mem.Allocator, block: std.json.Value, program: [32]u8, pda: [32]u8, kind: Kind) !void {
    if (try find(a, block, program, pda, kind) == null) return error.ExpectedFixtureTransaction;
}
test "SVM log meta allocation failure cannot become permanently unknown signers" {
    const a = std.testing.allocator;
    const parsed = try @import("../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../agents/scraper/fixtures/svm-meta-production.json.gz"), .{});
    defer parsed.deinit();
    const cases = (try p.field(parsed.value, "cases")).array.items;
    const blocks = try p.field(parsed.value, "blocks");
    const case = cases[0];
    if ((try p.field(case, "index")) == .null) return error.ExpectedFoundFixture;
    const block = try p.field(blocks, try p.string(try p.field(case, "block")));
    const program = try p.decodeKey(a, try p.string(try p.field(case, "program")));
    const pda = try p.decodeKey(a, try p.string(try p.field(case, "pda")));
    const kind = std.meta.stringToEnum(Kind, try p.string(try p.field(case, "kind"))).?;
    try std.testing.checkAllAllocationFailures(a, allocationFind, .{ block, program, pda, kind });
}
