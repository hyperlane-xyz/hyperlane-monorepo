const std = @import("std");
const http = @import("http.zig");
pub const Step = struct {
    method: std.http.Method,
    suffix: []const u8,
    request_body: ?[]const u8 = null,
    check: ?*const fn (http.Request) anyerror!void = null,
    status: u16 = 200,
    response: []const u8 = "",
    metadata_flavor_google: bool = false,
};
pub const Mock = struct {
    steps: []const Step,
    index: usize = 0,
    pub fn transport(self: *Mock) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, allocator: std.mem.Allocator, request: http.Request) !http.Response {
        const self: *Mock = @ptrCast(@alignCast(context));
        if (self.index >= self.steps.len) return error.UnexpectedCloudRequest;
        const step = self.steps[self.index];
        self.index += 1;
        try std.testing.expectEqual(step.method, request.method);
        try std.testing.expect(std.mem.endsWith(u8, request.url, step.suffix));
        if (step.request_body) |expected| try std.testing.expectEqualStrings(expected, request.body orelse return error.MissingCloudRequestBody);
        if (step.check) |check| try check(request);
        return .{ .allocator = allocator, .bytes = try allocator.dupe(u8, step.response), .status = step.status, .metadata_flavor_google = step.metadata_flavor_google };
    }
    pub fn expectDone(self: Mock) !void {
        try std.testing.expectEqual(self.steps.len, self.index);
    }
};
pub fn header(request: http.Request, name: []const u8) ?[]const u8 {
    for (request.headers) |entry| if (std.ascii.eqlIgnoreCase(entry.name, name)) return entry.value;
    return null;
}
