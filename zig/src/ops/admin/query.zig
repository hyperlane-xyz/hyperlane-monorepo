const std = @import("std");

pub const Map = struct {
    arena: std.heap.ArenaAllocator,
    pairs: []Pair,

    pub const Pair = struct { name: []const u8, value: []const u8 };

    pub fn deinit(self: *Map) void {
        self.arena.deinit();
        self.* = undefined;
    }
    pub fn get(self: Map, name: []const u8) ?[]const u8 {
        var index = self.pairs.len;
        while (index > 0) {
            index -= 1;
            if (std.mem.eql(u8, self.pairs[index].name, name)) return self.pairs[index].value;
        }
        return null;
    }
};

pub fn parse(backing: std.mem.Allocator, raw: []const u8) !Map {
    var arena = std.heap.ArenaAllocator.init(backing);
    errdefer arena.deinit();
    const a = arena.allocator();
    var pairs = std.array_list.Managed(Map.Pair).init(a);
    errdefer pairs.deinit();
    var parts = std.mem.splitScalar(u8, raw, '&');
    while (parts.next()) |part| {
        if (part.len == 0) continue;
        const equals = std.mem.indexOfScalar(u8, part, '=');
        const encoded_name = if (equals) |index| part[0..index] else part;
        const encoded_value = if (equals) |index| part[index + 1 ..] else "";
        const name = try decode(a, encoded_name);
        const value = try decode(a, encoded_value);
        try pairs.append(.{ .name = name, .value = value });
    }
    const owned = try pairs.toOwnedSlice();
    return .{ .arena = arena, .pairs = owned };
}

fn decode(a: std.mem.Allocator, raw: []const u8) ![]u8 {
    const mutable = try a.dupe(u8, raw);
    for (mutable) |*byte| {
        if (byte.* == '+') byte.* = ' ';
    }
    return std.Uri.percentDecodeBackwards(mutable, mutable);
}

pub fn unsigned(value: []const u8, comptime T: type) !T {
    if (value.len == 0) return error.InvalidQueryValue;
    return std.fmt.parseInt(T, value, 10) catch error.InvalidQueryValue;
}

test "query parser decodes source parameters" {
    const a = std.testing.allocator;
    var params = try parse(a, "domain_id=1&nonce_start=10&nonce_end=10");
    defer params.deinit();
    try std.testing.expectEqual(@as(u32, 1), try unsigned(params.get("domain_id").?, u32));
    try std.testing.expectEqual(@as(u32, 10), try unsigned(params.get("nonce_start").?, u32));
    try std.testing.expectEqual(@as(u32, 10), try unsigned(params.get("nonce_end").?, u32));
    var duplicate = try parse(a, "domain_id=1&domain_id=2");
    defer duplicate.deinit();
    try std.testing.expectEqual(@as(u32, 2), try unsigned(duplicate.get("domain_id").?, u32));
}
