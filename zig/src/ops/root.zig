//! Operator parity services for the Zig agents.
//! Matching, runtime denylist, metrics and admin HTTP APIs are integration
//! boundaries; no constructor performs network I/O or reads process secrets.
pub const regex = @import("regex.zig");
pub const matching = @import("matching.zig");
pub const address_blacklist = @import("address_blacklist.zig");
pub const runtime_denylist = @import("runtime_denylist.zig");
pub const metrics = @import("metrics.zig");
pub const http = @import("http.zig");
pub const routes = @import("routes.zig");
pub const native = @import("native.zig");
pub const telemetry = @import("telemetry.zig");

test {
    @import("std").testing.refAllDecls(@This());
}
