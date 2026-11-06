const std = @import("std");

pub const Reader = struct {
    bytes: []const u8,
    pos: usize = 0,

    pub fn take(self: *Reader, size: usize) ![]const u8 {
        if (size > self.bytes.len - self.pos) return error.TruncatedAccount;
        const slice = self.bytes[self.pos..][0..size];
        self.pos += size;
        return slice;
    }
    pub fn uint(self: *Reader, comptime T: type) !T {
        return std.mem.readInt(T, (try self.take(@sizeOf(T)))[0..@sizeOf(T)], .little);
    }
    pub fn boolean(self: *Reader) !bool {
        return switch (try self.uint(u8)) {
            0 => false,
            1 => true,
            else => error.InvalidBorshBoolean,
        };
    }
    pub fn key(self: *Reader) ![32]u8 {
        return (try self.take(32))[0..32].*;
    }
    pub fn initialized(self: *Reader) !void {
        if (!try self.boolean()) return error.UninitializedAccount;
    }
    pub fn discriminator(self: *Reader, expected: *const [8]u8) !void {
        if (!std.mem.eql(u8, try self.take(8), expected)) return error.InvalidDiscriminator;
    }
    pub fn vec(self: *Reader) ![]const u8 {
        return self.take(try self.uint(u32));
    }
    pub fn end(self: Reader) !void {
        if (self.pos != self.bytes.len) return error.TrailingBorshData;
    }
    /// Released providers support programs omitting SimulationReturnData's
    /// trailing transport byte. Accept its absence only after the full payload
    /// decoded; never synthesize a byte that could complete a truncated field.
    pub fn simulationEnd(self: *Reader) !void {
        if (self.pos < self.bytes.len) _ = try self.uint(u8);
        try self.end();
    }
};

pub const Writer = struct {
    out: []u8,
    pos: usize = 0,
    pub fn raw(self: *Writer, value: []const u8) !void {
        if (value.len > self.out.len - self.pos) return error.BufferTooSmall;
        @memcpy(self.out[self.pos..][0..value.len], value);
        self.pos += value.len;
    }
    pub fn uint(self: *Writer, comptime T: type, value: T) !void {
        var bytes: [@sizeOf(T)]u8 = undefined;
        std.mem.writeInt(T, &bytes, value, .little);
        try self.raw(&bytes);
    }
    pub fn vec(self: *Writer, value: []const u8) !void {
        if (value.len > std.math.maxInt(u32)) return error.BorshLengthOverflow;
        try self.uint(u32, @intCast(value.len));
        try self.raw(value);
    }
};
