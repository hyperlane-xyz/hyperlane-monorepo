//! gRPC over the shared optional libcurl transport: configured grpcUrls retain
//! their HTTP/2 endpoint semantics. No REST gateway or shell subprocess fallback.
const std = @import("std");
const grpc = @import("grpc.zig");
const curl = @import("../net/curl.zig");
pub const CurlTransport = struct {
    allocator: std.mem.Allocator,
    base_url: []u8,
    client: curl.Client,
    /// Borrowed endpoint headers; owner retains them through every request.
    headers: []const curl.Header = &.{},
    pub fn init(allocator: std.mem.Allocator, base_url: []const u8, library_path: []const u8) !CurlTransport {
        const uri = try std.Uri.parse(base_url);
        if (uri.host == null or uri.user != null or uri.password != null or uri.fragment != null or (!std.mem.eql(u8, uri.scheme, "http") and !std.mem.eql(u8, uri.scheme, "https"))) return error.InvalidGrpcUrl;
        var client = try curl.Client.init(allocator, library_path);
        errdefer client.deinit();
        return .{ .allocator = allocator, .base_url = try allocator.dupe(u8, base_url), .client = client };
    }
    pub fn deinit(self: *CurlTransport) void {
        self.client.deinit();
        self.allocator.free(self.base_url);
        self.* = undefined;
    }
    pub fn interface(self: *CurlTransport) grpc.Transport {
        return .{ .context = self, .call_fn = call };
    }
    fn call(context: *anyopaque, allocator: std.mem.Allocator, request: grpc.Request) anyerror!grpc.Response {
        const self: *CurlTransport = @ptrCast(@alignCast(context));
        const separator = std.mem.indexOfScalar(u8, self.base_url, '?') orelse self.base_url.len;
        const base = std.mem.trimEnd(u8, self.base_url[0..separator], "/");
        const url = try std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ base, request.method, self.base_url[separator..] });
        defer allocator.free(url);
        const body = try grpc.frame(allocator, request.protobuf);
        defer allocator.free(body);
        const headers = try allocator.alloc(curl.Header, self.headers.len + 4);
        defer allocator.free(headers);
        headers[0] = .{ .name = "content-type", .value = "application/grpc+proto" };
        headers[1] = .{ .name = "te", .value = "trailers" };
        headers[2] = .{ .name = "grpc-accept-encoding", .value = "identity" };
        var height_text: [20]u8 = undefined;
        if (request.height) |height| headers[3] = .{ .name = "x-cosmos-block-height", .value = try std.fmt.bufPrint(&height_text, "{d}", .{height}) };
        const base_count: usize = if (request.height != null) 4 else 3;
        for (self.headers, headers[base_count..][0..self.headers.len]) |custom, *out| {
            for (headers[0..base_count]) |reserved| if (std.ascii.eqlIgnoreCase(custom.name, reserved.name)) return error.DuplicateGrpcHeader;
            out.* = custom;
        }
        var response = try self.client.send(allocator, .{ .url = url, .method = .post, .headers = headers[0 .. base_count + self.headers.len], .body = body, .timeout_ms = request.timeout_ms, .connect_timeout_ms = request.timeout_ms, .max_response_bytes = grpc.max_message_bytes + 5, .require_http2 = true, .cancel = request.cancel });
        defer response.deinit();
        if (response.status != 200) return error.GrpcHttpStatus;
        var status: ?u32 = null;
        var height: ?u64 = null;
        var content_type: ?[]const u8 = null;
        for (response.headers) |header| {
            if (std.ascii.eqlIgnoreCase(header.name, "grpc-status")) {
                if (status != null) return error.DuplicateGrpcStatus;
                status = try std.fmt.parseInt(u32, header.value, 10);
            } else if (std.ascii.eqlIgnoreCase(header.name, "x-cosmos-block-height")) {
                if (height != null) return error.DuplicateGrpcHeight;
                height = try std.fmt.parseInt(u64, header.value, 10);
            } else if (std.ascii.eqlIgnoreCase(header.name, "content-type")) {
                if (content_type != null) return error.DuplicateGrpcContentType;
                content_type = header.value;
            } else if (std.ascii.eqlIgnoreCase(header.name, "grpc-encoding") or std.ascii.eqlIgnoreCase(header.name, "content-encoding")) {
                if (!std.ascii.eqlIgnoreCase(header.value, "identity")) return error.UnsupportedGrpcCompression;
            }
        }
        const mime = content_type orelse return error.MissingGrpcContentType;
        const mime_end = std.mem.indexOfScalar(u8, mime, ';') orelse mime.len;
        if (!std.ascii.eqlIgnoreCase(mime[0..mime_end], "application/grpc") and !std.ascii.eqlIgnoreCase(mime[0..mime_end], "application/grpc+proto")) return error.InvalidGrpcContentType;
        try checkRemoteStatus(status);
        return .{ .allocator = allocator, .protobuf = try allocator.dupe(u8, try grpc.unframe(response.body)), .height = height };
    }
};

test "gRPC native transport declarations typecheck without loading a library" {
    std.testing.refAllDecls(CurlTransport);
}

test "native libcurl HTTP2 gRPC loopback validates trailers height framing and deadline" {
    const allocator = std.testing.allocator;
    const url = std.process.getEnvVarOwned(allocator, "HYPERLANE_COSMOS_GRPC_TEST_URL") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer allocator.free(url);
    if (!std.mem.startsWith(u8, url, "http://127.0.0.1:")) return error.TestRequiresLoopback;
    const default_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
    var transport = try CurlTransport.init(allocator, url, default_library);
    defer transport.deinit();
    var response = try transport.interface().call(allocator, .{ .method = "/test.Service/Echo", .protobuf = &.{ 8, 1 }, .height = 100 });
    defer response.deinit();
    try std.testing.expectEqualSlices(u8, &.{ 8, 1 }, response.protobuf);
    try std.testing.expectEqual(@as(?u64, 100), response.height);
    try std.testing.expectError(error.GrpcRemoteStatus, transport.interface().call(allocator, .{ .method = "/test.Service/Failure", .protobuf = "" }));
    try std.testing.expectError(error.MissingGrpcStatus, transport.interface().call(allocator, .{ .method = "/test.Service/MissingStatus", .protobuf = "" }));
    try std.testing.expectError(error.GrpcQueryHeightMismatch, transport.interface().call(allocator, .{ .method = "/test.Service/MissingHeight", .protobuf = "", .height = 100 }));
    try std.testing.expectError(error.UnsupportedGrpcCompression, transport.interface().call(allocator, .{ .method = "/test.Service/Compressed", .protobuf = "" }));
    try std.testing.expectError(error.RequestDeadlineExceeded, transport.interface().call(allocator, .{ .method = "/test.Service/Deadline", .protobuf = "", .timeout_ms = 50 }));
    const contracts = @import("contracts.zig");
    const client: contracts.Client = .{ .allocator = allocator, .transport = transport.interface(), .domain = 2000, .config = .{ .chain_id = "test-1", .bech32_prefix = "cosmos", .canonical_asset = "uatom", .contract_address_bytes = 32, .gas_price = try @import("config.zig").Decimal.parse("0.025"), .gas_multiplier = 1.3, .confirmations = 2 } };
    try std.testing.expectEqual(@as(u64, 198), try client.finalizedHeight());
    try std.testing.expectEqual(@as(u32, 5), try client.wasmNonce(.{0x11} ** 32, 100));
    var mailbox = try client.nativeMailbox(.{0x11} ** 32, 100);
    defer mailbox.deinit();
    try std.testing.expectEqual(@as(u32, 5), mailbox.value.message_sent);
    const tree = try client.nativeTree(.{0x22} ** 32, .{0x11} ** 32, 100);
    try std.testing.expectEqual(@as(u32, 1), tree.count);
    var ism = try client.nativeIsm(.{0x33} ** 32);
    defer ism.deinit();
    try std.testing.expectEqual(@as(u8, 2), (try contracts.nativeMultisig(ism.value)).threshold);
}

fn checkRemoteStatus(status: ?u32) !void {
    const remote = status orelse return error.MissingGrpcStatus;
    if (remote == 5) return error.GrpcNotFound;
    if (remote != 0) return error.GrpcRemoteStatus;
}
test "Cosmos gRPC NotFound remains distinct from authentication transport and missing status" {
    try checkRemoteStatus(0);
    try std.testing.expectError(error.GrpcNotFound, checkRemoteStatus(5));
    try std.testing.expectError(error.GrpcRemoteStatus, checkRemoteStatus(7));
    try std.testing.expectError(error.MissingGrpcStatus, checkRemoteStatus(null));
}
