const std = @import("std");
const Keccak256 = std.crypto.hash.sha3.Keccak256;

/// Canonical Hyperlane wire message. Decode borrows the input body; the caller
/// must retain its backing bytes. Protocol version validation belongs at ingress.
pub const Message = struct {
    pub const prefix_len = 77;
    version: u8 = 3,
    nonce: u32 = 0,
    origin: u32 = 0,
    sender: [32]u8 = .{0} ** 32,
    destination: u32 = 0,
    recipient: [32]u8 = .{0} ** 32,
    body: []const u8 = &.{},

    pub fn decode(bytes: []const u8) error{TruncatedMessage}!Message {
        if (bytes.len < prefix_len) return error.TruncatedMessage;
        return .{
            .version = bytes[0],
            .nonce = std.mem.readInt(u32, bytes[1..5], .big),
            .origin = std.mem.readInt(u32, bytes[5..9], .big),
            .sender = bytes[9..41].*,
            .destination = std.mem.readInt(u32, bytes[41..45], .big),
            .recipient = bytes[45..77].*,
            .body = bytes[prefix_len..],
        };
    }

    pub fn encodedLen(self: Message) usize {
        return prefix_len + self.body.len;
    }

    fn header(self: Message) [prefix_len]u8 {
        var bytes: [prefix_len]u8 = undefined;
        bytes[0] = self.version;
        std.mem.writeInt(u32, bytes[1..5], self.nonce, .big);
        std.mem.writeInt(u32, bytes[5..9], self.origin, .big);
        bytes[9..41].* = self.sender;
        std.mem.writeInt(u32, bytes[41..45], self.destination, .big);
        bytes[45..77].* = self.recipient;
        return bytes;
    }

    /// The output buffer must not overlap self.body. No allocation.
    pub fn encode(self: Message, out: []u8) error{BufferTooSmall}![]u8 {
        if (out.len < prefix_len or out.len - prefix_len < self.body.len)
            return error.BufferTooSmall;
        out[0..prefix_len].* = self.header();
        @memcpy(out[prefix_len..][0..self.body.len], self.body);
        return out[0..self.encodedLen()];
    }

    /// Caller owns the returned bytes and must free them using allocator.
    pub fn encodeAlloc(self: Message, allocator: std.mem.Allocator) ![]u8 {
        const size = try std.math.add(usize, prefix_len, self.body.len);
        const bytes = try allocator.alloc(u8, size);
        errdefer allocator.free(bytes);
        return self.encode(bytes);
    }

    pub fn id(self: Message) [32]u8 {
        var hasher = Keccak256.init(.{});
        hasher.update(&self.header());
        hasher.update(self.body);
        var digest: [32]u8 = undefined;
        hasher.final(&digest);
        return digest;
    }
};

test "canonical message fixture and borrowed decode" {
    var sender = [_]u8{0} ** 32;
    @memset(sender[12..], 0x11);
    var recipient = [_]u8{0} ** 32;
    @memset(recipient[12..], 0x22);
    const message: Message = .{ .origin = 1000, .sender = sender, .destination = 2000, .recipient = recipient, .body = &.{ 0x12, 0x34 } };
    const expected = std.fmt.hexToBytes;
    var id: [32]u8 = undefined;
    _ = try expected(&id, "f8a66f8aadee751d842616fee0ed14a3" ++ "ad6da1e13564920364ee0ad35a02703f");
    try std.testing.expectEqualSlices(u8, &id, &message.id());
    const bytes = try message.encodeAlloc(std.testing.allocator);
    defer std.testing.allocator.free(bytes);
    const decoded = try Message.decode(bytes);
    try std.testing.expectEqualDeep(message, decoded);
    try std.testing.expect(decoded.body.ptr == bytes[77..].ptr);
}

test "all truncated prefixes and insufficient output fail" {
    var bytes: [77]u8 = .{0} ** 77;
    for (0..77) |len| try std.testing.expectError(error.TruncatedMessage, Message.decode(bytes[0..len]));
    try std.testing.expectError(error.BufferTooSmall, (Message{}).encode(bytes[0..76]));
    const message: Message = .{ .body = "x" };
    try std.testing.expectError(error.BufferTooSmall, message.encode(&bytes));
}

test "encode decode and streaming hash at block and integer boundaries" {
    var body: [65536]u8 = undefined;
    for (&body, 0..) |*byte, i| byte.* = @truncate(i);
    for ([_]usize{ 0, 1, 58, 59, 60, 135, 136, 137, 271, 272, 4096, 65536 }) |len| {
        for ([_]u8{ 0, 3, 255 }) |version| {
            for ([_]u32{ 0, 1, std.math.maxInt(u32) }) |nonce| {
                const message: Message = .{ .version = version, .nonce = nonce, .origin = std.math.rotl(u32, nonce, 7), .sender = .{version} ** 32, .destination = nonce ^ 0xa5a5a5a5, .recipient = .{~version} ** 32, .body = body[0..len] };
                const bytes = try message.encodeAlloc(std.testing.allocator);
                defer std.testing.allocator.free(bytes);
                try std.testing.expectEqualDeep(message, try Message.decode(bytes));
                var digest: [32]u8 = undefined;
                Keccak256.hash(bytes, &digest, .{});
                try std.testing.expectEqualSlices(u8, &digest, &message.id());
            }
        }
    }
}
