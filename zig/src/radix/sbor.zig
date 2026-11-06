//! Bounded borrowed SBOR traversal and canonical encoding of the values used by
//! Hyperlane Radix methods and V2 manifests. SBOR schemas come from the pinned
//! production radix-common/sbor crates. No general manifest text interpreter.
const std = @import("std");
pub const Flavor = enum(u8) { manifest = 0x4d, scrypto = 0x5c };
pub const max_bytes = 1024 * 1024;
pub const Value = struct { kind: u8, body: []const u8, flavor: Flavor };
fn validKind(kind: u8, flavor: Flavor) bool {
    return (kind >= 1 and kind <= 12) or (kind >= 0x20 and kind <= 0x23) or switch (flavor) {
        .manifest => kind >= 0x80 and kind <= 0x88,
        .scrypto => kind == 0x80 or kind == 0x90 or kind == 0xa0 or kind == 0xb0 or kind == 0xc0,
    };
}
pub const Reader = struct {
    input: []const u8,
    flavor: Flavor,
    pos: usize = 0,
    pub fn take(self: *Reader, length: usize) ![]const u8 {
        if (length > self.input.len - self.pos) return error.TruncatedSbor;
        const out = self.input[self.pos..][0..length];
        self.pos += length;
        return out;
    }
    pub fn byte(self: *Reader) !u8 {
        return (try self.take(1))[0];
    }
    pub fn size(self: *Reader) !usize {
        var result: u32 = 0;
        for (0..4) |i| {
            const next = try self.byte();
            result |= @as(u32, next & 0x7f) << @intCast(i * 7);
            if (next & 0x80 == 0) {
                if (i > 0 and next == 0) return error.NonCanonicalSborSize;
                return result;
            }
        }
        return error.SborSizeOverflow;
    }
    fn localId(self: *Reader) !void {
        switch (try self.byte()) {
            0 => {
                const utf8 = try self.take(try self.size());
                if (!std.unicode.utf8ValidateSlice(utf8)) return error.InvalidSborUtf8;
            },
            1 => _ = try self.take(8),
            2 => _ = try self.take(try self.size()),
            3 => _ = try self.take(32),
            else => return error.InvalidSborDiscriminator,
        }
    }
    pub fn value(self: *Reader) anyerror!Value {
        return self.body(try self.byte(), 0);
    }
    fn body(self: *Reader, kind: u8, depth: usize) anyerror!Value {
        if (depth >= 64) return error.SborDepthExceeded;
        const start = self.pos;
        switch (kind) {
            1 => if (try self.byte() > 1) {
                return error.InvalidSborBoolean;
            },
            2, 7 => _ = try self.take(1),
            3, 8 => _ = try self.take(2),
            4, 9 => _ = try self.take(4),
            5, 10 => _ = try self.take(8),
            6, 11 => _ = try self.take(16),
            12 => {
                const utf8 = try self.take(try self.size());
                if (!std.unicode.utf8ValidateSlice(utf8)) return error.InvalidSborUtf8;
            },
            0x20 => {
                const element = try self.byte();
                if (!validKind(element, self.flavor)) return error.UnsupportedSborValueKind;
                const count = try self.size();
                for (0..count) |_| _ = try self.body(element, depth + 1);
            },
            0x21, 0x22 => {
                if (kind == 0x22) _ = try self.byte();
                const count = try self.size();
                for (0..count) |_| _ = try self.body(try self.byte(), depth + 1);
            },
            0x23 => {
                const key = try self.byte();
                const value_kind = try self.byte();
                if (!validKind(key, self.flavor) or !validKind(value_kind, self.flavor)) return error.UnsupportedSborValueKind;
                const count = try self.size();
                for (0..count) |_| {
                    _ = try self.body(key, depth + 1);
                    _ = try self.body(value_kind, depth + 1);
                }
            },
            else => switch (self.flavor) {
                .manifest => switch (kind) {
                    0x80 => switch (try self.byte()) {
                        0 => _ = try self.take(30),
                        1 => _ = try self.take(4),
                        else => return error.InvalidSborDiscriminator,
                    },
                    0x81, 0x82, 0x88 => _ = try self.take(4),
                    0x83 => if (try self.byte() > 1) {
                        return error.InvalidSborDiscriminator;
                    },
                    0x84, 0x86 => _ = try self.take(32),
                    0x85 => _ = try self.take(24),
                    0x87 => try self.localId(),
                    else => return error.UnsupportedSborValueKind,
                },
                .scrypto => switch (kind) {
                    0x80, 0x90 => _ = try self.take(30),
                    0xa0 => _ = try self.take(24),
                    0xb0 => _ = try self.take(32),
                    0xc0 => try self.localId(),
                    else => return error.UnsupportedSborValueKind,
                },
            },
        }
        return .{ .kind = kind, .body = self.input[start..self.pos], .flavor = self.flavor };
    }
};
pub fn decode(input: []const u8, flavor: Flavor) !Value {
    if (input.len > max_bytes) return error.SborTooLarge;
    var reader: Reader = .{ .input = input, .flavor = flavor };
    if (try reader.byte() != @intFromEnum(flavor)) return error.WrongSborPrefix;
    const value = try reader.value();
    if (reader.pos != input.len) return error.TrailingSborBytes;
    return value;
}
pub fn fields(value: Value, out: []Value) !void {
    if (value.kind != 0x21) return error.WrongSborValueKind;
    var reader: Reader = .{ .input = value.body, .flavor = value.flavor };
    if (try reader.size() != out.len) return error.WrongSborFieldCount;
    for (out) |*field| field.* = try reader.value();
    if (reader.pos != reader.input.len) return error.TrailingSborBytes;
}
pub fn uint(value: Value, comptime T: type) !T {
    const expected = switch (@bitSizeOf(T)) {
        8 => 7,
        16 => 8,
        32 => 9,
        64 => 10,
        128 => 11,
        else => @compileError("SBOR unsigned width"),
    };
    if (value.kind != expected or value.body.len != @sizeOf(T)) return error.WrongSborValueKind;
    return std.mem.readInt(T, value.body[0..@sizeOf(T)], .little);
}
pub fn boolean(value: Value) !bool {
    if (value.kind != 1 or value.body.len != 1 or value.body[0] > 1) return error.WrongSborValueKind;
    return value.body[0] == 1;
}
pub fn byteArray(value: Value) ![]const u8 {
    if (value.kind != 0x20) return error.WrongSborValueKind;
    var reader: Reader = .{ .input = value.body, .flavor = value.flavor };
    if (try reader.byte() != 7) return error.WrongSborValueKind;
    const length = try reader.size();
    const bytes = try reader.take(length);
    if (reader.pos != reader.input.len) return error.TrailingSborBytes;
    return bytes;
}
pub fn component(value: Value) ![30]u8 {
    if (value.kind != 0x80) return error.WrongSborValueKind;
    if (value.flavor == .scrypto and value.body.len == 30) return value.body[0..30].*;
    if (value.flavor == .manifest and value.body.len == 31 and value.body[0] == 0) return value.body[1..31].*;
    return error.WrongSborValueKind;
}
pub const Array = struct {
    reader: Reader,
    kind: u8,
    remaining: usize,
    pub fn next(self: *Array) !?Value {
        if (self.remaining == 0) return null;
        self.remaining -= 1;
        return try self.reader.body(self.kind, 0);
    }
};
pub fn elements(value: Value) !Array {
    if (value.kind != 0x20) return error.WrongSborValueKind;
    var reader: Reader = .{ .input = value.body, .flavor = value.flavor };
    const kind = try reader.byte();
    const count = try reader.size();
    return .{ .reader = reader, .kind = kind, .remaining = count };
}
pub fn text(value: Value) ![]const u8 {
    if (value.kind != 12) return error.WrongSborValueKind;
    var reader: Reader = .{ .input = value.body, .flavor = value.flavor };
    return reader.take(try reader.size());
}
pub fn decimalAttos(value: Value) !i192 {
    if (value.kind != 0xa0 or value.body.len != 24 or value.flavor != .scrypto) return error.WrongSborValueKind;
    return std.mem.readInt(i192, value.body[0..24], .little);
}
pub const Writer = struct {
    allocator: std.mem.Allocator,
    list: std.ArrayList(u8) = .empty,
    pub fn deinit(self: *Writer) void {
        self.list.deinit(self.allocator);
    }
    pub fn raw(self: *Writer, data: []const u8) !void {
        if (data.len > max_bytes - self.list.items.len) return error.SborTooLarge;
        try self.list.appendSlice(self.allocator, data);
    }
    pub fn byte(self: *Writer, value: u8) !void {
        try self.raw(&.{value});
    }
    pub fn size(self: *Writer, size_: usize) !void {
        if (size_ > 0x0fffffff) return error.SborSizeOverflow;
        var value = size_;
        while (true) {
            const low: u8 = @intCast(value & 127);
            value >>= 7;
            try self.byte(low | @as(u8, if (value != 0) 128 else 0));
            if (value == 0) return;
        }
    }
    pub fn tuple(self: *Writer, count: usize) !void {
        try self.byte(0x21);
        try self.size(count);
    }
    pub fn enumeration(self: *Writer, discriminator: u8, count: usize) !void {
        try self.raw(&.{ 0x22, discriminator });
        try self.size(count);
    }
    pub fn array(self: *Writer, element: u8, count: usize) !void {
        try self.raw(&.{ 0x20, element });
        try self.size(count);
    }
    pub fn bytes(self: *Writer, value: []const u8) !void {
        try self.array(7, value.len);
        try self.raw(value);
    }
    pub fn text(self: *Writer, value: []const u8) !void {
        if (!std.unicode.utf8ValidateSlice(value)) return error.InvalidSborUtf8;
        try self.byte(12);
        try self.size(value.len);
        try self.raw(value);
    }
    pub fn uint(self: *Writer, comptime T: type, value: T) !void {
        const kind: u8 = switch (@bitSizeOf(T)) {
            8 => 7,
            16 => 8,
            32 => 9,
            64 => 10,
            128 => 11,
            else => @compileError("SBOR unsigned width"),
        };
        var bytes_: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &bytes_, value, .little);
        try self.byte(kind);
        try self.raw(&bytes_);
    }
    pub fn address(self: *Writer, value: [30]u8) !void {
        try self.raw(&.{ 0x80, 0 });
        try self.raw(&value);
    }
    pub fn decimal(self: *Writer, attos: i192) !void {
        var bytes_: [24]u8 = undefined;
        std.mem.writeInt(i192, &bytes_, attos, .little);
        try self.byte(0x85);
        try self.raw(&bytes_);
    }
    pub fn owned(self: *Writer) ![]u8 {
        return self.list.toOwnedSlice(self.allocator);
    }
};

test "SBOR rejects malformed sizes truncation booleans and trailing values" {
    try std.testing.expectError(error.UnsupportedSborValueKind, decode(&.{ 0x4d, 0x20, 0xff, 0 }, .manifest));
    try std.testing.expectError(error.NonCanonicalSborSize, decode(&.{ 0x4d, 0x21, 0x80, 0 }, .manifest));
    try std.testing.expectError(error.TruncatedSbor, decode(&.{ 0x4d, 0x20, 7, 2, 1 }, .manifest));
    try std.testing.expectError(error.InvalidSborBoolean, decode(&.{ 0x5c, 1, 2 }, .scrypto));
    try std.testing.expectError(error.TrailingSborBytes, decode(&.{ 0x5c, 1, 0, 0 }, .scrypto));
}
