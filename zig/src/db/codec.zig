//! Exact binary formats from hyperlane-core Encode/Decode. Fixed-width decoders
//! intentionally leave trailing bytes unread, matching Rust's reader semantics.
const std = @import("std");
pub const Hash = [32]u8;
pub const Uuid = [16]u8;

pub const Reader = struct {
    bytes: []const u8,
    position: usize = 0,

    pub fn take(self: *Reader, count: usize) ![]const u8 {
        if (count > self.bytes.len - self.position) return error.TruncatedRecord;
        const out = self.bytes[self.position .. self.position + count];
        self.position += count;
        return out;
    }

    pub fn fixed(self: *Reader, comptime length: usize) ![length]u8 {
        const value = try self.take(length);
        return value[0..length].*;
    }

    pub fn integer(self: *Reader, comptime T: type) !T {
        if (T != u32 and T != u64 and T != u256) @compileError("Unsupported Rust DB integer");
        const value = try self.fixed(@sizeOf(T));
        return std.mem.readInt(T, &value, if (T == u256) .little else .big);
    }

    pub fn boolean(self: *Reader) !bool {
        return switch ((try self.take(1))[0]) {
            0 => false,
            1 => true,
            else => error.InvalidBoolean,
        };
    }

    pub fn finish(self: Reader) !void {
        if (self.position != self.bytes.len) return error.TrailingRecordBytes;
    }
};

pub const Writer = struct {
    allocator: std.mem.Allocator,
    bytes: std.ArrayList(u8) = .empty,

    pub fn deinit(self: *Writer) void {
        self.bytes.deinit(self.allocator);
    }

    pub fn append(self: *Writer, bytes: []const u8) !void {
        try self.bytes.appendSlice(self.allocator, bytes);
    }

    pub fn integer(self: *Writer, value: anytype) !void {
        const T = @TypeOf(value);
        if (T != u32 and T != u64 and T != u256) @compileError("Unsupported Rust DB integer");
        var out: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &out, value, if (T == u256) .little else .big);
        try self.append(&out);
    }

    pub fn boolean(self: *Writer, value: bool) !void {
        try self.bytes.append(self.allocator, @intFromBool(value));
    }

    pub fn owned(self: *Writer) ![]u8 {
        return self.bytes.toOwnedSlice(self.allocator);
    }
};

pub fn encode(allocator: std.mem.Allocator, value: anytype) ![]u8 {
    var writer: Writer = .{ .allocator = allocator };
    defer writer.deinit();
    const T = @TypeOf(value);
    if (@typeInfo(T) == .@"struct" or @typeInfo(T) == .@"union") {
        if (@hasDecl(T, "encodeAlloc")) return value.encodeAlloc(allocator);
        if (@hasDecl(T, "toJson")) return value.toJson(allocator);
    }
    try writeValue(&writer, value);
    return writer.owned();
}

pub fn decode(comptime T: type, bytes: []const u8) !T {
    var reader: Reader = .{ .bytes = bytes };
    if (@typeInfo(T) == .@"struct" or @typeInfo(T) == .@"union") {
        if (@hasDecl(T, "decode")) return T.decode(bytes);
    }
    return readValue(T, &reader);
}

pub fn writeValue(writer: *Writer, value: anytype) !void {
    const T = @TypeOf(value);
    if (T == bool) try writer.boolean(value) else if (T == u32 or T == u64 or T == u256)
        try writer.integer(value)
    else if (@typeInfo(T) == .array and @typeInfo(T).array.child == u8)
        try writer.append(&value)
    else
        try value.write(writer);
}

pub fn readValue(comptime T: type, reader: *Reader) !T {
    if (T == bool) return reader.boolean();
    if (T == u32 or T == u64 or T == u256) return reader.integer(T);
    if (@typeInfo(T) == .array and @typeInfo(T).array.child == u8)
        return reader.fixed(@typeInfo(T).array.len);
    return T.read(reader);
}

fn minimumSize(comptime T: type) usize {
    if (T == bool) return 1;
    if (T == u32 or T == u64 or T == u256) return @sizeOf(T);
    if (@typeInfo(T) == .array and @typeInfo(T).array.child == u8) return @typeInfo(T).array.len;
    if (@hasDecl(T, "minimum_encoded_size")) return T.minimum_encoded_size;
    return T.encoded_size;
}

pub const GasPaymentKey = struct {
    message_id: Hash,
    destination: u32,
    pub const encoded_size = 36;
    pub fn write(self: GasPaymentKey, out: *Writer) !void {
        try out.append(&self.message_id);
        try out.integer(self.destination);
    }
    pub fn read(input: *Reader) !GasPaymentKey {
        return .{ .message_id = try input.fixed(32), .destination = try input.integer(u32) };
    }
};

pub const GasPaymentMeta = struct {
    transaction_id: [64]u8,
    log_index: u64,
    pub const encoded_size = 72;
    pub fn write(self: GasPaymentMeta, out: *Writer) !void {
        try out.append(&self.transaction_id);
        try out.integer(self.log_index);
    }
    pub fn read(input: *Reader) !GasPaymentMeta {
        return .{ .transaction_id = try input.fixed(64), .log_index = try input.integer(u64) };
    }
};

pub const GasPaymentData = struct {
    payment: u256,
    gas_amount: u256,
    pub const encoded_size = 64;
    pub fn write(self: GasPaymentData, out: *Writer) !void {
        try out.integer(self.payment);
        try out.integer(self.gas_amount);
    }
    pub fn read(input: *Reader) !GasPaymentData {
        return .{ .payment = try input.integer(u256), .gas_amount = try input.integer(u256) };
    }
};

pub const GasExpenditureData = struct {
    tokens_used: u256,
    gas_used: u256,
    pub const encoded_size = 64;
    pub fn write(self: GasExpenditureData, out: *Writer) !void {
        try out.integer(self.tokens_used);
        try out.integer(self.gas_used);
    }
    pub fn read(input: *Reader) !GasExpenditureData {
        return .{ .tokens_used = try input.integer(u256), .gas_used = try input.integer(u256) };
    }
};

pub const GasPayment = struct {
    message_id: Hash,
    destination: u32,
    payment: u256,
    gas_amount: u256,
    pub const encoded_size = 100;
    pub fn write(self: GasPayment, out: *Writer) !void {
        try out.append(&self.message_id);
        try out.integer(self.destination);
        try out.integer(self.payment);
        try out.integer(self.gas_amount);
    }
    pub fn read(input: *Reader) !GasPayment {
        return .{ .message_id = try input.fixed(32), .destination = try input.integer(u32), .payment = try input.integer(u256), .gas_amount = try input.integer(u256) };
    }
};

pub const MerkleInsertion = struct {
    leaf_index: u32,
    message_id: Hash,
    pub const encoded_size = 36;
    pub fn write(self: MerkleInsertion, out: *Writer) !void {
        try out.integer(self.leaf_index);
        try out.append(&self.message_id);
    }
    pub fn read(input: *Reader) !MerkleInsertion {
        return .{ .leaf_index = try input.integer(u32), .message_id = try input.fixed(32) };
    }
};

pub const BackwardCursor = struct {
    sequence: u32,
    block: u32,
    pub const encoded_size = 8;
    pub fn write(self: BackwardCursor, out: *Writer) !void {
        try out.integer(self.sequence);
        try out.integer(self.block);
    }
    pub fn read(input: *Reader) !BackwardCursor {
        return .{ .sequence = try input.integer(u32), .block = try input.integer(u32) };
    }
};

/// Rust Indexed<T> places the optional sequence AFTER T, not before it.
/// T must have a fixed binary size; a message body consumes its remaining bytes.
pub fn Indexed(comptime T: type) type {
    return struct {
        const Self = @This();
        value: T,
        sequence: ?u32,
        pub const minimum_encoded_size = minimumSize(T) + 1;
        pub fn write(self: Self, out: *Writer) !void {
            try writeValue(out, self.value);
            try out.boolean(self.sequence != null);
            if (self.sequence) |sequence| try out.integer(sequence);
        }
        pub fn read(input: *Reader) !Self {
            const value = try readValue(T, input);
            return .{ .value = value, .sequence = if (try input.boolean()) try input.integer(u32) else null };
        }
    };
}

/// UUID bytes use UUID/RFC order. Vec<T>'s length is an EIGHT-byte BE u64.
pub fn encodeList(allocator: std.mem.Allocator, comptime T: type, values: []const T) ![]u8 {
    var writer: Writer = .{ .allocator = allocator };
    defer writer.deinit();
    try writer.integer(@as(u64, @intCast(values.len)));
    for (values) |value| try writeValue(&writer, value);
    return writer.owned();
}

pub fn decodeList(allocator: std.mem.Allocator, comptime T: type, bytes: []const u8) ![]T {
    var reader: Reader = .{ .bytes = bytes };
    const count = try reader.integer(u64);
    if (count > (bytes.len - reader.position) / minimumSize(T)) return error.TruncatedRecord;
    const values = try allocator.alloc(T, @intCast(count));
    errdefer allocator.free(values);
    for (values) |*value| value.* = try readValue(T, &reader);
    return values;
}

pub fn encodeUuids(allocator: std.mem.Allocator, uuids: []const Uuid) ![]u8 {
    return encodeList(allocator, Uuid, uuids);
}

pub fn decodeUuids(allocator: std.mem.Allocator, bytes: []const u8) ![]Uuid {
    return decodeList(allocator, Uuid, bytes);
}

test "integer endianness and strict bool match production" {
    const allocator = std.testing.allocator;
    const encoded = try encode(allocator, @as(u256, 0x0102));
    defer allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, &.{ 2, 1 }, encoded[0..2]);
    try std.testing.expectEqual(@as(u256, 0x0102), try decode(u256, encoded));
    try std.testing.expectEqual(@as(u32, 42), try decode(u32, &.{ 0, 0, 0, 42, 99 }));
    try std.testing.expectError(error.InvalidBoolean, decode(bool, &.{2}));
    try std.testing.expectError(error.TruncatedRecord, decode(u64, &.{0}));
    try std.testing.expectError(error.TruncatedRecord, decodeUuids(allocator, &.{ 255, 255, 255, 255, 255, 255, 255, 255 }));
}
