//! core module root: shared JSON, config, logging and metrics.
const std = @import("std");

pub const json = @import("json.zig");
pub const config = @import("config.zig");
pub const log = @import("log.zig");
pub const metrics = @import("metrics.zig");

test {
    std.testing.refAllDecls(@This());
    _ = @import("json_corpus_test.zig");
}
