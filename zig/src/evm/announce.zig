//! ValidatorAnnounce ABI shared by readers and validator startup.
const std = @import("std");
const abi = @import("codecs.zig");
const rpc = @import("provider.zig");
const A = std.mem.Allocator;
pub const Limits = struct { max_validators: usize = 256, max_per_validator: usize = 256, max_total_locations: usize = 4096, max_location_bytes: usize = 50 * 1024, max_total_bytes: usize = 2 * 1024 * 1024 };
pub const Locations = struct {
    arena: std.heap.ArenaAllocator,
    values: [][][]const u8,
    pub fn deinit(self: *Locations) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub fn locationsCalldata(a: A, validators: []const abi.Address) ![]u8 {
    if (validators.len > 256) return error.TooManyValidators;
    const data = try a.alloc(u8, 68 + 32 * validators.len);
    @memset(data, 0);
    data[0..4].* = abi.selector("getAnnouncedStorageLocations(address[])");
    std.mem.writeInt(u256, data[4..36], 32, .big);
    std.mem.writeInt(u256, data[36..68], validators.len, .big);
    for (validators, 0..) |address, i| @memcpy(data[80 + i * 32 ..][0..20], &address);
    return data;
}
pub fn announceCalldata(a: A, validator: abi.Address, location: []const u8, signature: [65]u8) ![]u8 {
    if (!std.unicode.utf8ValidateSlice(location)) return error.InvalidAnnouncementString;
    const tail = try abi.processCalldata(a, location, &signature);
    defer a.free(tail);
    const data = try a.alloc(u8, try std.math.add(usize, tail.len, 32));
    errdefer a.free(data);
    @memset(data, 0);
    data[0..4].* = abi.selector("announce(address,string,bytes)");
    data[16..36].* = validator;
    std.mem.writeInt(u256, data[36..68], 96, .big);
    std.mem.writeInt(u256, data[68..100], try abi.uintWord(usize, tail[36..68]) + 32, .big);
    @memcpy(data[100..], tail[68..]);
    return data;
}
pub const AnnouncementCall = struct { validator: abi.Address, location: []const u8, signature: [65]u8 };
/// Borrowed strict canonical ABI view for the persistent validator mailbox.
pub fn decodeAnnouncementCall(bytes: []const u8) !AnnouncementCall {
    if (bytes.len < 260 or (bytes.len - 4) % 32 != 0 or !std.mem.eql(u8, bytes[0..4], &abi.selector("announce(address,string,bytes)")) or !std.mem.allEqual(u8, bytes[4..16], 0) or try abi.uintWord(usize, bytes[36..68]) != 96) return error.InvalidAbi;
    const length = try abi.uintWord(usize, bytes[100..132]);
    if (length > bytes.len - 132) return error.InvalidAbi;
    const pad = (32 - length % 32) % 32;
    const end = try std.math.add(usize, 132, try std.math.add(usize, length, pad));
    if (end > bytes.len or bytes.len - end != 128 or try abi.uintWord(usize, bytes[68..100]) != end - 4 or !std.mem.allEqual(u8, bytes[132 + length .. end], 0) or !std.unicode.utf8ValidateSlice(bytes[132..][0..length]) or try abi.uintWord(usize, bytes[end..][0..32]) != 65 or !std.mem.allEqual(u8, bytes[end + 97 ..], 0)) return error.InvalidAbi;
    return .{ .validator = bytes[16..36].*, .location = bytes[132..][0..length], .signature = bytes[end + 32 ..][0..65].* };
}
pub fn fetch(client: *rpc.RpcClient, contract: abi.Address, validators: []const abi.Address, block: rpc.BlockRef, limits: Limits) !Locations {
    const calldata = try locationsCalldata(client.allocator, validators);
    defer client.allocator.free(calldata);
    const bytes = try client.ethCall(contract, calldata, block);
    defer client.allocator.free(bytes);
    return decodeLocations(client.allocator, bytes, validators.len, limits);
}
/// Canonical offsets prohibit overlapping/aliased strings, nonzero padding and
/// trailing data. Owned UTF8 strings remain valid after the RPC buffer is freed.
pub fn decodeLocations(a: A, bytes: []const u8, expected: usize, limits: Limits) !Locations {
    if (expected > 256 or expected > limits.max_validators or bytes.len > limits.max_total_bytes) return error.AnnouncementLimit;
    if (bytes.len < 64 or bytes.len % 32 != 0 or try abi.uintWord(usize, bytes[0..32]) != 32 or try abi.uintWord(usize, bytes[32..64]) != expected) return error.InvalidAbi;
    if (expected > (bytes.len - 64) / 32) return error.InvalidAbi;
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const values = try alloc.alloc([][]const u8, expected);
    var cursor: usize = 64 + expected * 32;
    var total: usize = 0;
    for (values, 0..) |*list, i| {
        if (try abi.uintWord(usize, bytes[64 + i * 32 ..][0..32]) != cursor - 64 or bytes.len - cursor < 32) return error.InvalidAbi;
        const count = try abi.uintWord(usize, bytes[cursor..][0..32]);
        cursor += 32;
        const base = cursor;
        if (count > limits.max_per_validator or count > limits.max_total_locations - total) return error.AnnouncementLimit;
        if (count > (bytes.len - cursor) / 32) return error.InvalidAbi;
        total += count;
        list.* = try alloc.alloc([]const u8, count);
        cursor += count * 32;
        for (list.*, 0..) |*location, j| {
            if (try abi.uintWord(usize, bytes[base + j * 32 ..][0..32]) != cursor - base or bytes.len - cursor < 32) return error.InvalidAbi;
            const len = try abi.uintWord(usize, bytes[cursor..][0..32]);
            cursor += 32;
            if (len > limits.max_location_bytes) return error.AnnouncementLimit;
            if (len > bytes.len - cursor) return error.InvalidAbi;
            const padding = (32 - len % 32) % 32;
            if (padding > bytes.len - cursor - len or !std.mem.allEqual(u8, bytes[cursor + len ..][0..padding], 0) or !std.unicode.utf8ValidateSlice(bytes[cursor..][0..len])) return error.InvalidAbi;
            location.* = try alloc.dupe(u8, bytes[cursor..][0..len]);
            cursor += len + padding;
        }
    }
    if (cursor != bytes.len) return error.InvalidAbi;
    return .{ .arena = arena, .values = values };
}
fn fixtureHex(a: A, value: std.json.Value) ![]u8 {
    var joined: std.array_list.Managed(u8) = .init(a);
    if (value == .string) try joined.appendSlice(value.string) else for (value.array.items) |p| try joined.appendSlice(p.string);
    const text = joined.items;
    const raw = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
    if (raw.len % 2 != 0) return error.InvalidHex;
    const out = try a.alloc(u8, raw.len / 2);
    _ = try std.fmt.hexToBytes(out, raw);
    return out;
}
test "7 independent Foundry announcement ABI fixtures with truncations offsets padding UTF8 and aggregate bounds" {
    const testing = std.testing;
    const fixture_bytes = try @import("../testing/fixture.zig").bytes(testing.allocator, @embedFile("fixtures/announcements.jsonl.gz"), 16 * 1024 * 1024);
    defer testing.allocator.free(fixture_bytes);
    var lines = std.mem.tokenizeScalar(u8, fixture_bytes, '\n');
    while (lines.next()) |line| {
        var arena = std.heap.ArenaAllocator.init(testing.allocator);
        defer arena.deinit();
        const a = arena.allocator();
        const parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
        const v = parsed.value.object;
        const calldata = try fixtureHex(a, v.get("calldata").?);
        if (std.mem.eql(u8, v.get("kind").?.string, "locations")) {
            const raw = try fixtureHex(a, v.get("wire").?);
            const expected = v.get("locations").?.array.items;
            const vs = try a.alloc(abi.Address, expected.len);
            for (v.get("validators").?.array.items, 0..) |address, i| vs[i] = (try fixtureHex(a, address))[0..20].*;
            const encoded = try locationsCalldata(a, vs);
            try testing.expectEqualSlices(u8, calldata, encoded);
            var locations = try decodeLocations(testing.allocator, raw, expected.len, .{});
            defer locations.deinit();
            for (expected, locations.values) |entry, list| {
                try testing.expectEqual(entry.array.items.len, list.len);
                for (entry.array.items, list) |str, value| try testing.expectEqualStrings(str.string, value);
            }
            for (0..raw.len / 32) |i| {
                if (decodeLocations(testing.allocator, raw[0 .. i * 32], expected.len, .{})) |result| {
                    var owned = result;
                    owned.deinit();
                    return error.AcceptedTruncation;
                } else |_| {}
            }
            try testing.expectError(error.AnnouncementLimit, decodeLocations(testing.allocator, raw, expected.len, .{ .max_total_bytes = raw.len - 1 }));
            if (expected.len > 0) {
                const altered = try a.dupe(u8, raw);
                altered[95] = 0;
                try testing.expectError(error.InvalidAbi, decodeLocations(testing.allocator, altered, expected.len, .{}));
            }
        } else {
            const address = (try fixtureHex(a, v.get("validator").?))[0..20].*;
            const signature = (try fixtureHex(a, v.get("signature").?))[0..65].*;
            const data = try announceCalldata(a, address, v.get("location").?.string, signature);
            try testing.expectEqualSlices(u8, calldata, data);
            const decoded = try decodeAnnouncementCall(data);
            try testing.expectEqualSlices(u8, &address, &decoded.validator);
            try testing.expectEqualStrings(v.get("location").?.string, decoded.location);
            try testing.expectEqualSlices(u8, &signature, &decoded.signature);
            for (0..data.len) |len| try testing.expectError(error.InvalidAbi, decodeAnnouncementCall(data[0..len]));
            const changed = try a.dupe(u8, data);
            changed[changed.len - 1] = 1;
            try testing.expectError(error.InvalidAbi, decodeAnnouncementCall(changed));
        }
    }
}
