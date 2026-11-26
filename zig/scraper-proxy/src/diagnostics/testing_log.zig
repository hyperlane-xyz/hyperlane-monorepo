//! Test helper: core.log writes to stdout, which the zig test runner uses for
//! its protocol, so tests that trigger warnings route logs to a no-op sink.
const core = @import("core");

fn discard(_: ?*anyopaque, _: core.log.Level, _: []const u8, _: []const u8) void {}

pub fn silence() void {
    core.log.setSink(discard, null);
}
