const std = @import("std");
const solana = @import("solana.zig");
const Case = struct {
    case: usize,
    payer: u8,
    blockhash: u8,
    instructions: []const struct { program: u8, accounts: []const struct { key: u8, is_signer: bool, is_writable: bool }, data: []const u8 },
    tables: []const struct { key: u8, addresses: []const u8 },
    legacy: []const u8,
    v0: []const u8,
};
fn unhex(allocator: std.mem.Allocator, hex: []const u8) ![]u8 {
    const bytes = try allocator.alloc(u8, hex.len / 2);
    _ = try std.fmt.hexToBytes(bytes, hex);
    return bytes;
}

test "128 seeded compiler cases match actual Rust legacy and v0 SDK bytes" {
    const fixture = try @import("../testing/fixture.zig").parse(struct { cases: []const Case }, std.testing.allocator, @embedFile("fixtures/compiler.json.gz"), .{ .ignore_unknown_fields = true });
    defer fixture.deinit();
    for (fixture.value.cases) |case| {
        errdefer std.debug.print("Solana compiler oracle failed seed=0x526574687a696767 case={d}\n", .{case.case});
        var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
        defer arena.deinit();
        const allocator = arena.allocator();
        const instructions = try allocator.alloc(solana.Instruction, case.instructions.len);
        for (instructions, case.instructions) |*instruction, input| {
            const metas = try allocator.alloc(solana.AccountMeta, input.accounts.len);
            for (metas, input.accounts) |*meta, account| meta.* = .{ .key = .{account.key} ** 32, .is_signer = account.is_signer, .is_writable = account.is_writable };
            instruction.* = .{ .program = .{input.program} ** 32, .accounts = metas, .data = try unhex(allocator, input.data) };
        }
        const tables = try allocator.alloc(solana.LookupTable, case.tables.len);
        for (tables, case.tables) |*table, input| {
            const keys = try allocator.alloc(solana.Key, input.addresses.len);
            for (keys, input.addresses) |*key, byte| key.* = .{byte} ** 32;
            table.* = .{ .key = .{input.key} ** 32, .addresses = keys };
        }
        var output: [8192]u8 = undefined;
        const legacy = try solana.compileLegacy(.{case.payer} ** 32, .{case.blockhash} ** 32, instructions, &output);
        try std.testing.expectEqualSlices(u8, try unhex(allocator, case.legacy), legacy.bytes);
        const v0 = try solana.compileV0(.{case.payer} ** 32, .{case.blockhash} ** 32, instructions, tables, &output);
        try std.testing.expectEqualSlices(u8, try unhex(allocator, case.v0), v0.bytes);
    }
}
