//! Unary gRPC boundary, retaining configured grpcUrls and historical height
//! metadata. Transport must provide authenticated HTTP/2 plus validated trailers.
const std = @import("std");
pub const max_message_bytes = 8 * 1024 * 1024;
pub const Request = struct { method: []const u8, protobuf: []const u8, height: ?u64 = null, timeout_ms: u32 = 30000, cancel: ?*const std.atomic.Value(bool) = null };
pub const Response = struct {
    allocator: std.mem.Allocator,
    protobuf: []u8,
    height: ?u64 = null,
    pub fn deinit(self: *Response) void {
        self.allocator.free(self.protobuf);
        self.* = undefined;
    }
};
pub const Transport = struct {
    context: *anyopaque,
    call_fn: *const fn (*anyopaque, std.mem.Allocator, Request) anyerror!Response,
    pub fn call(self: Transport, allocator: std.mem.Allocator, request: Request) !Response {
        try validateMethod(request.method);
        if (request.protobuf.len > max_message_bytes or request.timeout_ms == 0) return error.InvalidGrpcRequest;
        if (request.cancel) |cancel| if (cancel.load(.acquire)) return error.RequestCancelled;
        var response = try self.call_fn(self.context, allocator, request);
        errdefer response.deinit();
        if (response.protobuf.len > max_message_bytes) return error.GrpcMessageTooLarge;
        if (request.height) |height| {
            if (response.height == null or response.height.? != height) return error.GrpcQueryHeightMismatch;
        }
        return response;
    }
};

pub fn validateMethod(method: []const u8) !void {
    if (method.len < 4 or method.len > 256 or method[0] != '/') return error.InvalidGrpcMethod;
    for (method) |char| if (!std.ascii.isAlphanumeric(char) and char != '/' and char != '.' and char != '_') return error.InvalidGrpcMethod;
    if (std.mem.count(u8, method, "/") != 2 or method[method.len - 1] == '/') return error.InvalidGrpcMethod;
}

pub fn frame(allocator: std.mem.Allocator, message: []const u8) ![]u8 {
    if (message.len > max_message_bytes) return error.GrpcMessageTooLarge;
    const out = try allocator.alloc(u8, 5 + message.len);
    out[0] = 0; // identity, no compression
    std.mem.writeInt(u32, out[1..5], @intCast(message.len), .big);
    @memcpy(out[5..], message);
    return out;
}
pub fn unframe(bytes: []const u8) ![]const u8 {
    if (bytes.len < 5) return error.TruncatedGrpcFrame;
    if (bytes[0] != 0) return error.UnsupportedGrpcCompression;
    const size = std.mem.readInt(u32, bytes[1..5], .big);
    if (size > max_message_bytes) return error.GrpcMessageTooLarge;
    if (bytes.len - 5 < size) return error.TruncatedGrpcFrame;
    if (bytes.len - 5 != size) return error.MultipleUnaryGrpcMessages;
    return bytes[5..];
}

test "gRPC unary framing rejects compression truncation and extra messages" {
    const encoded = try frame(std.testing.allocator, &.{ 8, 1 });
    defer std.testing.allocator.free(encoded);
    try std.testing.expectEqualSlices(u8, &.{ 0, 0, 0, 0, 2, 8, 1 }, encoded);
    try std.testing.expectEqualSlices(u8, &.{ 8, 1 }, try unframe(encoded));
    for (0..encoded.len) |len| try std.testing.expectError(error.TruncatedGrpcFrame, unframe(encoded[0..len]));
    try std.testing.expectError(error.UnsupportedGrpcCompression, unframe(&.{ 1, 0, 0, 0, 0 }));
    try std.testing.expectError(error.MultipleUnaryGrpcMessages, unframe(&.{ 0, 0, 0, 0, 0, 0 }));
    try std.testing.expectError(error.InvalidGrpcMethod, validateMethod("/Query/Thing?token=x"));
}
