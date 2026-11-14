//! core module root: shared JSON, config, logging, metrics and the process timer thread.
const std = @import("std");

pub const json = @import("json.zig");
pub const config = @import("config.zig");
pub const log = @import("log.zig");
pub const metrics = @import("metrics.zig");
pub const scheduler = @import("scheduler.zig");
pub const blocking = @import("blocking.zig");
pub const fiber = @import("fiber.zig");
/// See `fiber.onEventLoopThread`.
pub const onEventLoopThread = fiber.onEventLoopThread;

test {
    std.testing.refAllDecls(@This());
    _ = @import("json_corpus_test.zig");
    _ = @import("fiber.zig");
}
