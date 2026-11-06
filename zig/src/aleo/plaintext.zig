//! Bounded Aleo plaintext syntax for public mapping values and function inputs.
//! This parser does not validate curve points or perform cryptographic operations.
const std = @import("std");
pub const Limits = struct { bytes: usize = 1024 * 1024, nodes: usize = 65536, depth: usize = 32 };
pub const Member = struct { name: []const u8, value: Value };
pub const Value = union(enum) {
    boolean: bool,
    integer: struct { value: u128, bits: u8 },
    atom: []const u8,
    array: []const Value,
    object: []const Member,
    pub fn member(self: Value, name: []const u8) !Value {
        if (self != .object) return error.ExpectedAleoStruct;
        for (self.object) |item| if (std.mem.eql(u8, item.name, name)) return item.value;
        return error.MissingAleoMember;
    }
    pub fn number(self: Value, comptime T: type) !T {
        if (self != .integer or self.integer.bits != @bitSizeOf(T)) return error.WrongAleoIntegerType;
        return std.math.cast(T, self.integer.value) orelse error.AleoIntegerOverflow;
    }
    pub fn items(self: Value, count: usize) ![]const Value {
        if (self != .array or self.array.len != count) return error.InvalidAleoArrayLength;
        return self.array;
    }
    pub fn hash(self: Value) ![32]u8 {
        const values = try self.items(2);
        var out: [32]u8 = undefined;
        std.mem.writeInt(u128, out[0..16], try values[0].number(u128), .little);
        std.mem.writeInt(u128, out[16..32], try values[1].number(u128), .little);
        return out;
    }
    pub fn bytes(self: Value, a: std.mem.Allocator, count: usize) ![]u8 {
        const values = try self.items(count);
        const out = try a.alloc(u8, count);
        errdefer a.free(out);
        for (values, out) |value, *byte| byte.* = try value.number(u8);
        return out;
    }
    pub fn render(self: Value, a: std.mem.Allocator) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(a);
        try self.append(a, &out);
        return out.toOwnedSlice(a);
    }
    fn append(self: Value, a: std.mem.Allocator, out: *std.ArrayList(u8)) anyerror!void {
        switch (self) {
            .boolean => |value| try out.appendSlice(a, if (value) "true" else "false"),
            .integer => |value| {
                var buffer: [48]u8 = undefined;
                try out.appendSlice(a, try std.fmt.bufPrint(&buffer, "{d}u{d}", .{ value.value, value.bits }));
            },
            .atom => |text| try out.appendSlice(a, text),
            .array => |values| {
                try out.append(a, '[');
                for (values, 0..) |value, i| {
                    if (i > 0) try out.appendSlice(a, ", ");
                    try value.append(a, out);
                }
                try out.append(a, ']');
            },
            .object => |members| {
                try out.append(a, '{');
                for (members, 0..) |value, i| {
                    if (i > 0) try out.appendSlice(a, ", ");
                    try out.appendSlice(a, value.name);
                    try out.appendSlice(a, ": ");
                    try value.value.append(a, out);
                }
                try out.append(a, '}');
            },
        }
    }
};
pub const Document = struct {
    arena: std.heap.ArenaAllocator,
    value: Value,
    pub fn parse(a: std.mem.Allocator, text: []const u8, limits: Limits) !Document {
        if (text.len > limits.bytes) return error.AleoPlaintextByteLimit;
        var arena = std.heap.ArenaAllocator.init(a);
        errdefer arena.deinit();
        const owned = try arena.allocator().dupe(u8, text);
        var parser: Parser = .{ .allocator = arena.allocator(), .input = owned, .limits = limits };
        const value = try parser.value(0);
        parser.space();
        if (parser.position != owned.len) return error.TrailingAleoPlaintext;
        return .{ .arena = arena, .value = value };
    }
    pub fn deinit(self: *Document) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
const Parser = struct {
    allocator: std.mem.Allocator,
    input: []const u8,
    position: usize = 0,
    nodes: usize = 0,
    limits: Limits,
    fn space(self: *Parser) void {
        while (self.position < self.input.len and std.ascii.isWhitespace(self.input[self.position])) : (self.position += 1) {}
    }
    fn take(self: *Parser, ch: u8) bool {
        self.space();
        if (self.position < self.input.len and self.input[self.position] == ch) {
            self.position += 1;
            return true;
        }
        return false;
    }
    fn word(self: *Parser) ![]const u8 {
        self.space();
        const start = self.position;
        while (self.position < self.input.len and (std.ascii.isAlphanumeric(self.input[self.position]) or self.input[self.position] == '_')) : (self.position += 1) {}
        if (self.position == start) return error.InvalidAleoPlaintext;
        return self.input[start..self.position];
    }
    fn value(self: *Parser, depth: usize) anyerror!Value {
        if (depth >= self.limits.depth) return error.AleoPlaintextDepthLimit;
        if (self.nodes == self.limits.nodes) return error.AleoPlaintextNodeLimit;
        self.nodes += 1;
        if (self.take('[')) {
            var values: std.ArrayList(Value) = .empty;
            if (!self.take(']')) {
                while (true) {
                    try values.append(self.allocator, try self.value(depth + 1));
                    if (self.take(']')) break;
                    if (!self.take(',')) return error.InvalidAleoPlaintext;
                }
            }
            return .{ .array = try values.toOwnedSlice(self.allocator) };
        }
        if (self.take('{')) {
            var members: std.ArrayList(Member) = .empty;
            if (!self.take('}')) {
                while (true) {
                    const name = try self.word();
                    if (!std.ascii.isAlphabetic(name[0])) return error.InvalidAleoMember;
                    for (members.items) |item| if (std.mem.eql(u8, item.name, name)) return error.DuplicateAleoMember;
                    if (!self.take(':')) return error.InvalidAleoPlaintext;
                    try members.append(self.allocator, .{ .name = name, .value = try self.value(depth + 1) });
                    if (self.take('}')) break;
                    if (!self.take(',')) return error.InvalidAleoPlaintext;
                }
            }
            return .{ .object = try members.toOwnedSlice(self.allocator) };
        }
        const token = try self.word();
        if (std.mem.eql(u8, token, "true")) return .{ .boolean = true };
        if (std.mem.eql(u8, token, "false")) return .{ .boolean = false };
        if (std.ascii.isDigit(token[0])) {
            const u = std.mem.indexOfScalar(u8, token, 'u') orelse return error.UnsupportedAleoLiteral;
            const bits = try std.fmt.parseInt(u8, token[u + 1 ..], 10);
            if (bits != 8 and bits != 16 and bits != 32 and bits != 64 and bits != 128) return error.UnsupportedAleoLiteral;
            if (u == 0 or std.mem.indexOfScalar(u8, token[0..u], '_') != null) return error.InvalidAleoPlaintext;
            const integer_value = try std.fmt.parseInt(u128, token[0..u], 10);
            if (bits < 128 and integer_value >> @intCast(bits) != 0) return error.AleoIntegerOverflow;
            return .{ .integer = .{ .value = integer_value, .bits = bits } };
        }
        if (std.mem.startsWith(u8, token, "aleo1") and token.len == 63) return .{ .atom = token };
        return error.UnsupportedAleoLiteral;
    }
};
pub fn hashWords(hash: [32]u8) [2]Value {
    return .{ .{ .integer = .{ .bits = 128, .value = std.mem.readInt(u128, hash[0..16], .little) } }, .{ .integer = .{ .bits = 128, .value = std.mem.readInt(u128, hash[16..32], .little) } } };
}
pub fn number(value: anytype) Value {
    return .{ .integer = .{ .value = value, .bits = @bitSizeOf(@TypeOf(value)) } };
}
pub fn byteArray(a: std.mem.Allocator, bytes: []const u8) !Value {
    const items_ = try a.alloc(Value, bytes.len);
    for (bytes, items_) |byte, *item| item.* = number(byte);
    return .{ .array = items_ };
}
pub fn hashArray(a: std.mem.Allocator, hash: [32]u8) !Value {
    const values = try a.alloc(Value, 2);
    values[0..2].* = hashWords(hash);
    return .{ .array = values };
}

test "Aleo plaintext typed nested public mapping values reject ambiguity and bounds" {
    const a = std.testing.allocator;
    var document = try Document.parse(a, "{ index: 42u32, id: [1u128, 2u128], bytes: [0u8,255u8] }", .{});
    defer document.deinit();
    try std.testing.expectEqual(@as(u32, 42), try (try document.value.member("index")).number(u32));
    const hash = try (try document.value.member("id")).hash();
    try std.testing.expectEqual(@as(u8, 1), hash[0]);
    try std.testing.expectEqual(@as(u8, 2), hash[16]);
    const text = try document.value.render(a);
    defer a.free(text);
    var second = try Document.parse(a, text, .{});
    defer second.deinit();
    try std.testing.expectError(error.WrongAleoIntegerType, (try document.value.member("index")).number(u64));
    try std.testing.expectError(error.DuplicateAleoMember, Document.parse(a, "{x: 1u8, x: 2u8}", .{}));
    try std.testing.expectError(error.AleoIntegerOverflow, Document.parse(a, "256u8", .{}));
    try std.testing.expectError(error.TrailingAleoPlaintext, Document.parse(a, "1u8.public", .{}));
    try std.testing.expectError(error.AleoPlaintextDepthLimit, Document.parse(a, "[[1u8]]", .{ .depth = 2 }));
    try std.testing.expectError(error.AleoPlaintextNodeLimit, Document.parse(a, "[1u8]", .{ .nodes = 1 }));
}
