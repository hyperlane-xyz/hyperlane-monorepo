//! One serial owner per receipt job. Fallback endpoint sends consume one shared
//! absolute budget; no endpoint retry receives a fresh full timeout.
const std = @import("std");
const http = @import("../../cloud/http.zig");
const evm = @import("receipts_evm.zig");
pub fn milliseconds(deadline_ns: u64) !u32 {
    const now = try evm.nowNs();
    if (now >= deadline_ns) return error.ScraperReceiptDeadline;
    return @intCast(@min(std.math.maxInt(u32), (deadline_ns - now + 999999) / 1000000));
}
pub const DeadlineTransport = struct {
    owner: *http.HttpTransport,
    deadline_ns: u64,
    allow_std_fixture: bool = false,
    /// Only explicit chain RPC reads may normalize a physical native timeout.
    /// Auth/proving/storage callers keep false, including under an RPC scope.
    rpc_read: bool = false,
    /// Only an exact validated owner capability may survive the deadline scope.
    /// The stable owner context is copied, never this temporary wrapper address.
    delegate: ?http.Transport = null,
    pub fn verify(self: *DeadlineTransport, transport: http.Transport) !void {
        self.delegate = null;
        const expected = self.owner.interface();
        const configured = self.owner.configuredRpcInterface();
        if (transport.context != expected.context or (transport.send_fn != expected.send_fn and (!self.rpc_read or transport.send_fn != configured.send_fn))) return error.ReceiptTransportOwnerMismatch;
        if (self.owner.native_curl == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        self.delegate = transport;
    }
    pub fn interface(self: *DeadlineTransport) http.Transport {
        return .{ .context = self, .send_fn = send };
    }
    fn send(context: *anyopaque, allocator: std.mem.Allocator, request: http.Request) !http.Response {
        const self: *DeadlineTransport = @ptrCast(@alignCast(context));
        const saved_timeout = self.owner.timeout_ms;
        const saved_connect = self.owner.connect_timeout_ms;
        const saved_owner = self.owner.rpc_read_owner;
        const deadline = if (saved_owner) |owner| @min(self.deadline_ns, owner.deadline_ns) else self.deadline_ns;
        defer {
            self.owner.timeout_ms = saved_timeout;
            self.owner.connect_timeout_ms = saved_connect;
            self.owner.rpc_read_owner = saved_owner;
        }
        self.owner.rpc_read_owner = .{
            .deadline_ns = deadline,
            .halt = if (saved_owner) |owner| owner.halt else null,
            .retry_physical_timeout = self.rpc_read and (if (saved_owner) |owner| owner.retry_physical_timeout else true),
        };
        self.owner.timeout_ms = @min(saved_timeout, try milliseconds(deadline));
        self.owner.connect_timeout_ms = @min(saved_connect, self.owner.timeout_ms);
        var result = try (self.delegate orelse self.owner.interface()).send(allocator, request);
        errdefer result.deinit();
        _ = try milliseconds(deadline);
        return result;
    }
};
