//! Physical-only multi completion accounting shared by EVM and SDK read replay.
const std = @import("std");
const recorder = @import("../../ops/rpc_metrics.zig");
const curl = @import("../../net/curl.zig");
const multi = @import("../../net/curl_multi.zig");
pub const Pending = struct {
    recorder: *recorder.Recorder,
    host: []const u8,
    connection: []const u8,
    json_rpc: bool,
    method: [128]u8 = @splat(0),
    method_len: usize,
    started_ns: u64,
    reported: bool = false,
    pub fn init(value: ?*recorder.Recorder, request: curl.Request, now_ns: u64) ?Pending {
        const owner = value orelse return null;
        var storage: [128]u8 = undefined;
        const description = owner.describe(request, &storage) orelse return null;
        var out: Pending = .{ .recorder = owner, .host = description.host, .connection = description.connection, .json_rpc = description.json_rpc, .method_len = description.method.len, .started_ns = now_ns };
        @memcpy(out.method[0..out.method_len], description.method);
        return out;
    }
    pub fn complete(self: *Pending, result: *const multi.Result, now_ns: u64) void {
        if (self.reported) return;
        self.reported = true;
        const description: recorder.Recorder.Description = .{ .host = self.host, .connection = self.connection, .method = self.method[0..self.method_len], .json_rpc = self.json_rpc };
        const success = switch (result.*) {
            .response => |*response| self.recorder.responseSuccess(description, response),
            .failure => |err| if (err == error.RequestCancelled) return else false,
        };
        self.recorder.record(self.host, self.connection, description.method, success, now_ns -| self.started_ns) catch |err| {
            if (self.recorder.failures.fetchAdd(1, .monotonic) == 0) std.log.warn("RPC metrics failed: {s}", .{@errorName(err)});
        };
    }
};

test "physical completion snapshot survives moves and counts once without sensitive URL retention" {
    const a = std.testing.allocator;
    const registry = try @import("../../ops/metrics.zig").Registry.init(a, .validator, .{ .base_version = "3.0.0" });
    defer registry.deinit();
    const owner = try recorder.Recorder.init(a, registry, .{ .chain = "public-fixture", .role = .quorum, .operation = .validator_checkpoint });
    defer owner.deinit();
    try owner.addEndpoints(&.{"https://name:password@rpc.example/private?token=public-fixture"});
    var first = Pending.init(owner, .{ .url = "https://name:password@rpc.example/private?token=public-fixture", .method = .post, .body = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]}" }, 10).?;
    var moved = first;
    first.method[0] = 'X';
    const failure: multi.Result = .{ .failure = error.RequestDeadlineExceeded };
    moved.complete(&failure, 1010);
    moved.complete(&failure, 2010);
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "method=\"eth_call\"") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "status=\"failure\",rpc_role=\"quorum\",operation=\"validator_checkpoint\",agent=\"validator\",hyperlane_baselib_version=\"3.0.0\"} 1") != null);
    for ([_][]const u8{ "password", "private", "token=", "Xth_call" }) |value| try std.testing.expect(std.mem.indexOf(u8, text, value) == null);
}
