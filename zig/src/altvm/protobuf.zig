//! Explicit Protobuf wire building for Cosmos/Tron transaction envelopes.
//! Proto3 scalar defaults are omitted, matching prost's canonical encoder.
const std = @import("std");

pub const Encoder = struct {
    out: []u8,
    pos: usize = 0,

    pub fn raw(self: *Encoder, value: []const u8) !void {
        if (value.len > self.out.len - self.pos) return error.BufferTooSmall;
        @memcpy(self.out[self.pos..][0..value.len], value);
        self.pos += value.len;
    }

    pub fn varint(self: *Encoder, value: u64) !void {
        var remaining = value;
        while (true) {
            const byte: u8 = @truncate(remaining & 127);
            remaining >>= 7;
            try self.raw(&.{byte | if (remaining != 0) @as(u8, 128) else 0});
            if (remaining == 0) return;
        }
    }

    fn key(self: *Encoder, number: u29, wire_type: u3) !void {
        if (number == 0) return error.InvalidFieldNumber;
        try self.varint((@as(u64, number) << 3) | wire_type);
    }

    pub fn uint(self: *Encoder, number: u29, value: u64) !void {
        if (value == 0) return;
        try self.key(number, 0);
        try self.varint(value);
    }

    pub fn bytes(self: *Encoder, number: u29, value: []const u8) !void {
        if (value.len == 0) return;
        try self.message(number, value);
    }

    /// Message presence is retained even for empty messages/repeated elements.
    pub fn message(self: *Encoder, number: u29, value: []const u8) !void {
        try self.key(number, 2);
        try self.varint(value.len);
        try self.raw(value);
    }

    pub fn written(self: Encoder) []u8 {
        return self.out[0..self.pos];
    }
};

pub const Field = struct { number: u29, value: union(enum) { uint: u64, bytes: []const u8, fixed32: [4]u8, fixed64: [8]u8 } };
pub const Decoder = struct {
    input: []const u8,
    pos: usize = 0,

    pub fn varint(self: *Decoder) !u64 {
        var value: u64 = 0;
        for (0..10) |i| {
            if (self.pos == self.input.len) return error.TruncatedProtobuf;
            const byte = self.input[self.pos];
            self.pos += 1;
            if (i == 9 and byte > 1) return error.ProtobufOverflow;
            value |= @as(u64, byte & 127) << @intCast(i * 7);
            if (byte & 128 == 0) return value;
        }
        return error.ProtobufOverflow;
    }

    fn take(self: *Decoder, size: usize) ![]const u8 {
        if (size > self.input.len - self.pos) return error.TruncatedProtobuf;
        const bytes = self.input[self.pos..][0..size];
        self.pos += size;
        return bytes;
    }

    pub fn next(self: *Decoder) !?Field {
        if (self.pos == self.input.len) return null;
        const tag = try self.varint();
        if (tag >> 3 == 0 or tag >> 3 > std.math.maxInt(u29)) return error.InvalidFieldNumber;
        const number: u29 = @intCast(tag >> 3);
        return .{ .number = number, .value = switch (tag & 7) {
            0 => .{ .uint = try self.varint() },
            1 => .{ .fixed64 = (try self.take(8))[0..8].* },
            2 => blk: {
                const size = try self.varint();
                if (size > std.math.maxInt(usize)) return error.ProtobufOverflow;
                break :blk .{ .bytes = try self.take(@intCast(size)) };
            },
            5 => .{ .fixed32 = (try self.take(4))[0..4].* },
            else => return error.UnsupportedWireType,
        } };
    }
};

test "protobuf canonical encoder and bounded decoder" {
    var out: [64]u8 = undefined;
    var enc: Encoder = .{ .out = &out };
    try enc.uint(1, 150);
    try enc.bytes(2, "testing");
    try enc.uint(3, 0);
    try enc.message(4, "");
    try std.testing.expectEqualSlices(u8, &.{ 8, 150, 1, 18, 7, 't', 'e', 's', 't', 'i', 'n', 'g', 34, 0 }, enc.written());
    var dec: Decoder = .{ .input = enc.written() };
    try std.testing.expectEqual(@as(u64, 150), (try dec.next()).?.value.uint);
    try std.testing.expectEqualStrings("testing", (try dec.next()).?.value.bytes);
    try std.testing.expectEqualStrings("", (try dec.next()).?.value.bytes);
    try std.testing.expectEqual(@as(?Field, null), try dec.next());
    var overflow: Decoder = .{ .input = &(.{255} ** 10) };
    try std.testing.expectError(error.ProtobufOverflow, overflow.varint());
    var truncated: Decoder = .{ .input = &.{ 18, 10, 1 } };
    try std.testing.expectError(error.TruncatedProtobuf, truncated.next());
}
