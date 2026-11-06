//! Production ValidatorAnnounce Borsh/PDA/instruction boundary. Accepts already
//! signed announcement bytes; transaction signing/submission remains caller-owned.
const std = @import("std");
const solana = @import("../altvm/solana.zig");
const borsh = @import("borsh.zig");
const provider = @import("provider.zig");
pub const Key = [32]u8;
pub fn statePda(program: Key) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_validator_announce", "-", "validator_announce" }, program);
}
pub fn locationsPda(program: Key, validator: [20]u8) !solana.ProgramAddress {
    return solana.findProgramAddress(&.{ "hyperlane_validator_announce", "-", "storage_locations", "-", &validator }, program);
}
pub fn replayId(validator: [20]u8, location: []const u8) [32]u8 {
    var hasher = std.crypto.hash.sha3.Keccak256.init(.{});
    hasher.update(&validator);
    hasher.update(location);
    var hash: [32]u8 = undefined;
    hasher.final(&hash);
    return hash;
}
pub fn replayPda(program: Key, validator: [20]u8, location: []const u8) !solana.ProgramAddress {
    const hash = replayId(validator, location);
    return solana.findProgramAddress(&.{ "hyperlane_validator_announce", "-", "replay_protection", "-", &hash }, program);
}
pub const Decoded = struct { validator: [20]u8, location: []const u8, signature: [65]u8 };
pub fn decodeInstruction(bytes: []const u8) !Decoded {
    var reader: borsh.Reader = .{ .bytes = bytes };
    if (try reader.uint(u8) != 1) return error.WrongAnnounceInstruction;
    const validator = (try reader.take(20))[0..20].*;
    const location = try reader.vec();
    if (location.len > 8192 or !std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementLocation;
    const signature = try reader.vec();
    if (signature.len != 65) return error.InvalidAnnouncementSignature;
    try reader.end();
    return .{ .validator = validator, .location = location, .signature = signature[0..65].* };
}
pub const OwnedInstruction = struct {
    allocator: std.mem.Allocator,
    program: Key,
    accounts: [5]solana.AccountMeta,
    data: []u8,
    pub fn instruction(self: *const OwnedInstruction) solana.Instruction {
        return .{ .program = self.program, .accounts = &self.accounts, .data = self.data };
    }
    pub fn deinit(self: *OwnedInstruction) void {
        self.allocator.free(self.data);
        self.* = undefined;
    }
};
pub fn announce(a: std.mem.Allocator, program: Key, payer: Key, validator: [20]u8, location: []const u8, signature: [65]u8) !OwnedInstruction {
    if (location.len > 8192 or !std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementLocation;
    const state = try statePda(program);
    const storage = try locationsPda(program, validator);
    const replay = try replayPda(program, validator, location);
    const out = try a.alloc(u8, 1 + 20 + 4 + location.len + 4 + 65);
    errdefer a.free(out);
    var writer: borsh.Writer = .{ .out = out };
    try writer.uint(u8, 1);
    try writer.raw(&validator);
    try writer.vec(location);
    try writer.vec(&signature);
    return .{
        .allocator = a,
        .program = program,
        .data = out,
        .accounts = .{
            .{ .key = payer, .is_signer = true, .is_writable = true },
            .{ .key = .{0} ** 32 }, // system program
            .{ .key = state.key },
            .{ .key = storage.key, .is_writable = true },
            .{ .key = replay.key, .is_writable = true },
        },
    };
}
pub const State = struct {
    bump: u8,
    mailbox: Key,
    domain: u32,
    pub fn decode(bytes: []const u8) !State {
        var reader: borsh.Reader = .{ .bytes = bytes };
        try reader.initialized();
        return .{ .bump = try reader.uint(u8), .mailbox = try reader.key(), .domain = try reader.uint(u32) };
    }
};
pub const OwnedLocations = struct {
    arena: std.heap.ArenaAllocator,
    values: []const []const []const u8,
    pub fn deinit(self: *OwnedLocations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub fn decodeLocations(a: std.mem.Allocator, data: []const u8, expected_bump: u8) ![]const []const u8 {
    if (data.len > 10240) return error.InvalidAnnouncementAccountSize;
    var reader: borsh.Reader = .{ .bytes = data };
    try reader.initialized();
    if (try reader.uint(u8) != expected_bump) return error.InvalidAnnouncementBump;
    const count = try reader.uint(u32);
    if (count > (data.len - reader.pos) / 4) return error.TruncatedAccount;
    const values = try a.alloc([]const u8, count);
    var copied: usize = 0;
    errdefer {
        for (values[0..copied]) |value| a.free(value);
        a.free(values);
    }
    for (values) |*value| {
        const bytes = try reader.vec();
        if (!std.unicode.utf8ValidateSlice(bytes)) return error.InvalidAnnouncementLocation;
        value.* = try a.dupe(u8, bytes);
        copied += 1;
    }
    return values;
}
pub fn locations(a: std.mem.Allocator, client: *provider.Client, program: Key, validators: []const [20]u8) !OwnedLocations {
    if (validators.len > 256) return error.InvalidValidatorCount;
    if (client.commitment != .finalized) return error.FinalizedAnnouncementReadsRequired;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const owned = arena.allocator();
    const values = try owned.alloc([]const []const u8, validators.len);
    for (validators, values) |validator, *out| {
        const pda = try locationsPda(program, validator);
        var response = try client.account(pda.key);
        defer response.deinit();
        const account = response.account orelse {
            out.* = &.{};
            continue;
        };
        if (account.executable or !std.mem.eql(u8, &account.owner, &program)) return error.WrongAnnouncementAccountOwner;
        out.* = try decodeLocations(owned, account.data, pda.bump);
    }
    return .{ .arena = arena, .values = values };
}
test "Sealevel announcement instruction accounts data and replay ID roundtrip reject truncation" {
    const a = std.testing.allocator;
    var value = try announce(a, .{3} ** 32, .{4} ** 32, .{5} ** 20, "s3://fixture/region", .{6} ** 65);
    defer value.deinit();
    const decoded = try decodeInstruction(value.data);
    try std.testing.expectEqualStrings("s3://fixture/region", decoded.location);
    const instruction = value.instruction();
    try std.testing.expect(instruction.accounts[0].is_signer and instruction.accounts[0].is_writable);
    try std.testing.expectEqual((try statePda(.{3} ** 32)).key, instruction.accounts[2].key);
    try std.testing.expectEqual((try locationsPda(.{3} ** 32, .{5} ** 20)).key, instruction.accounts[3].key);
    try std.testing.expectEqual((try replayPda(.{3} ** 32, .{5} ** 20, decoded.location)).key, instruction.accounts[4].key);
    for (0..value.data.len) |len| {
        if (decodeInstruction(value.data[0..len])) |_| return error.TruncatedAnnouncementAccepted else |_| {}
    }
}

test "Sealevel announcement bytes accounts and replay PDA match actual production Rust program fixtures" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const a = arena.allocator();
    const fixture = try @import("../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../altvm/fixtures/announcements.json.gz"), .{});
    const fields = fixture.value.object;
    const Helpers = struct {
        fn bytes(allocator: std.mem.Allocator, value: std.json.Value) ![]u8 {
            const text = value.string;
            const out = try allocator.alloc(u8, text.len / 2);
            _ = try std.fmt.hexToBytes(out, text);
            return out;
        }
    };
    var instruction = try announce(a, .{3} ** 32, .{4} ** 32, .{5} ** 20, "s3://fixture/region", .{6} ** 65);
    defer instruction.deinit();
    try std.testing.expectEqualSlices(u8, try Helpers.bytes(a, fields.get("svm_instruction").?), instruction.data);
    const names = [_][]const u8{ "state", "storage", "replay" };
    for (names, instruction.accounts[2..5]) |name, account| try std.testing.expectEqualSlices(u8, try Helpers.bytes(a, fields.get(name).?), &account.key);
    try std.testing.expectEqualSlices(u8, try Helpers.bytes(a, fields.get("replay_id").?), &replayId(.{5} ** 20, "s3://fixture/region"));
    const account = try Helpers.bytes(a, fields.get("svm_account").?);
    const locations_ = try decodeLocations(a, account, @intCast(fields.get("storage_bump").?.integer));
    try std.testing.expectEqual(@as(usize, 2), locations_.len);
    try std.testing.expectEqualStrings("s3://fixture/region", locations_[0]);
    try std.testing.expectEqualStrings("gs://fixture/folder", locations_[1]);
    for (0..account.len) |len| {
        if (decodeLocations(a, account[0..len], @intCast(fields.get("storage_bump").?.integer))) |_| return error.TruncatedAnnouncementAccountAccepted else |_| {}
    }
}
