//! Cairo serde from hyperlane-starknet's checked-in ABI. Hyperlane Bytes uses
//! big-endian u128 words plus a size, not Cairo ByteArray's 31-byte encoding.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
pub const prime: u256 = (@as(u256, 1) << 251) + (@as(u256, 17) << 192) + 1;
pub const Felt = struct {
    value: u256,
    pub const zero: Felt = .{ .value = 0 };
    pub fn init(value: u256) !Felt {
        if (value >= prime) return error.InvalidStarknetFelt;
        return .{ .value = value };
    }
    pub fn fromBytes(bytes: [32]u8) !Felt {
        return init(std.mem.readInt(u256, &bytes, .big));
    }
    pub fn fromHex(text: []const u8) !Felt {
        if (text.len < 3 or text.len > 66 or !std.mem.startsWith(u8, text, "0x")) return error.InvalidStarknetFelt;
        for (text[2..]) |c| if (!std.ascii.isHex(c)) return error.InvalidStarknetFelt;
        return init(std.fmt.parseInt(u256, text[2..], 16) catch return error.InvalidStarknetFelt);
    }
    pub fn toBytes(self: Felt) [32]u8 {
        var bytes: [32]u8 = undefined;
        std.mem.writeInt(u256, &bytes, self.value, .big);
        return bytes;
    }
    pub fn integer(self: Felt, comptime T: type) !T {
        return std.math.cast(T, self.value) orelse error.StarknetIntegerOverflow;
    }
    pub fn jsonStringify(self: Felt, writer: anytype) std.json.Stringify.Error!void {
        if (self.value >= prime) return error.WriteFailed;
        var buffer: [66]u8 = undefined;
        try writer.write(std.fmt.bufPrint(&buffer, "0x{x}", .{self.value}) catch unreachable);
    }
};
pub fn selector(name: []const u8) Felt {
    // Starknet selectors are Keccak(name) masked to 250 bits.
    var digest: [32]u8 = undefined;
    std.crypto.hash.sha3.Keccak256.hash(name, &digest, .{});
    return .{ .value = std.mem.readInt(u256, &digest, .big) & ((@as(u256, 1) << 250) - 1) };
}
pub fn shortString(text: []const u8) !Felt {
    if (text.len > 31) return error.InvalidStarknetShortString;
    var value: u256 = 0;
    for (text) |c| {
        if (!std.ascii.isAscii(c)) return error.InvalidStarknetShortString;
        value = value << 8 | c;
    }
    return .{ .value = value };
}
pub const Encoder = struct {
    allocator: std.mem.Allocator,
    items: std.ArrayList(Felt) = .empty,
    pub fn deinit(self: *Encoder) void {
        self.items.deinit(self.allocator);
    }
    pub fn felt(self: *Encoder, value: Felt) !void {
        _ = try Felt.init(value.value);
        try self.items.append(self.allocator, value);
    }
    pub fn integer(self: *Encoder, value: anytype) !void {
        try self.felt(try Felt.init(value));
    }
    pub fn uint256(self: *Encoder, value: u256) !void {
        try self.integer(@as(u128, @truncate(value)));
        try self.integer(@as(u128, @truncate(value >> 128)));
    }
    pub fn hash(self: *Encoder, value: [32]u8) !void {
        try self.uint256(std.mem.readInt(u256, &value, .big));
    }
    pub fn bytes(self: *Encoder, value: []const u8) !void {
        if (value.len > std.math.maxInt(u32)) return error.StarknetIntegerOverflow;
        try self.integer(value.len);
        try self.integer(value.len / 16 + @intFromBool(value.len % 16 != 0));
        var offset: usize = 0;
        while (offset < value.len) : (offset += 16) {
            var word: [16]u8 = .{0} ** 16;
            const length = @min(16, value.len - offset);
            @memcpy(word[0..length], value[offset..][0..length]);
            try self.integer(std.mem.readInt(u128, &word, .big));
        }
    }
    pub fn message(self: *Encoder, value: protocol.Message) !void {
        try self.integer(value.version);
        try self.integer(value.nonce);
        try self.integer(value.origin);
        try self.hash(value.sender);
        try self.integer(value.destination);
        try self.hash(value.recipient);
        try self.bytes(value.body);
    }
    pub fn longString(self: *Encoder, value: []const u8) !void {
        try self.integer(value.len / 31 + @intFromBool(value.len % 31 != 0));
        var offset: usize = 0;
        while (offset < value.len) : (offset += 31) try self.felt(try shortString(value[offset..][0..@min(31, value.len - offset)]));
    }
    pub fn finish(self: *Encoder) ![]Felt {
        return self.items.toOwnedSlice(self.allocator);
    }
};
pub const Decoder = struct {
    input: []const Felt,
    pos: usize = 0,
    pub fn felt(self: *Decoder) !Felt {
        if (self.pos == self.input.len) return error.TruncatedCairo;
        const value = try Felt.init(self.input[self.pos].value);
        self.pos += 1;
        return value;
    }
    pub fn integer(self: *Decoder, comptime T: type) !T {
        return (try self.felt()).integer(T);
    }
    pub fn uint256(self: *Decoder) !u256 {
        const low = try self.integer(u128);
        return @as(u256, try self.integer(u128)) << 128 | low;
    }
    pub fn hash(self: *Decoder) ![32]u8 {
        var out: [32]u8 = undefined;
        std.mem.writeInt(u256, &out, try self.uint256(), .big);
        return out;
    }
    pub fn boolean(self: *Decoder) !bool {
        const value = try self.integer(u8);
        if (value > 1) return error.InvalidCairoBoolean;
        return value == 1;
    }
    pub fn bytes(self: *Decoder, allocator: std.mem.Allocator, max_len: usize) ![]u8 {
        const size = try self.integer(u32);
        const count = try self.integer(usize);
        if (size > max_len or count != size / 16 + @as(usize, @intFromBool(size % 16 != 0)) or count > self.input.len - self.pos) return error.InvalidCairoBytes;
        const out = try allocator.alloc(u8, size);
        errdefer allocator.free(out);
        for (0..count) |i| {
            var word: [16]u8 = undefined;
            std.mem.writeInt(u128, &word, try self.integer(u128), .big);
            const len = @min(16, size - i * 16);
            if (!std.mem.allEqual(u8, word[len..], 0)) return error.InvalidCairoBytes;
            @memcpy(out[i * 16 ..][0..len], word[0..len]);
        }
        return out;
    }
    /// Returned message body is owned by allocator; other fields are values.
    pub fn message(self: *Decoder, allocator: std.mem.Allocator, max_body: usize) !protocol.Message {
        const version = try self.integer(u8);
        const nonce = try self.integer(u32);
        const origin = try self.integer(u32);
        const sender = try self.hash();
        const destination = try self.integer(u32);
        const recipient = try self.hash();
        const body = try self.bytes(allocator, max_body);
        return .{ .version = version, .nonce = nonce, .origin = origin, .sender = sender, .destination = destination, .recipient = recipient, .body = body };
    }
    pub fn finish(self: Decoder) !void {
        if (self.pos != self.input.len) return error.TrailingCairoData;
    }
};

test "Starknet felt strict field range JSON selectors and Cairo serde packed bytes" {
    const a = std.testing.allocator;
    try std.testing.expectError(error.InvalidStarknetFelt, Felt.init(prime));
    try std.testing.expectError(error.InvalidStarknetFelt, Felt.fromHex("0x-1"));
    try std.testing.expectEqual(@as(u256, 1), (try Felt.fromHex("0x01")).value);
    const text = try std.json.Stringify.valueAlloc(a, try Felt.init(123), .{});
    defer a.free(text);
    try std.testing.expectEqualStrings("\"0x7b\"", text);
    try std.testing.expectEqual(try std.fmt.parseInt(u256, "0083afd3f4caedc6eebf44246fe54e38" ++ "c95e3179a5ec9ea81740eca5b482d12e", 16), selector("transfer").value);
    for ([_][]const u8{ "", "1", "1234567890123456", "12345678901234567", "trailing zeros\x00\x00" }) |body| {
        var encoder: Encoder = .{ .allocator = a };
        defer encoder.deinit();
        try encoder.message(.{ .nonce = 42, .origin = 100, .destination = 200, .body = body });
        const felts = try encoder.finish();
        defer a.free(felts);
        var decoder: Decoder = .{ .input = felts };
        const decoded = try decoder.message(a, 1024);
        defer a.free(decoded.body);
        try decoder.finish();
        try std.testing.expectEqual(@as(u32, 42), decoded.nonce);
        try std.testing.expectEqualStrings(body, decoded.body);
        for (0..felts.len) |end| {
            var partial: Decoder = .{ .input = felts[0..end] };
            if (partial.message(a, 1024)) |value| {
                a.free(value.body);
                return error.AcceptedTruncatedCairo;
            } else |_| {}
        }
    }
}
