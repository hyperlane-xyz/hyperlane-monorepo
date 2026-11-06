//! Focused native relayer origin instrumentation and Source retry parity.
comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/indexing/native_test.zig");
    _ = @import("agents/origin_tasks_test.zig");
    _ = @import("agents/origin_test.zig");
    _ = @import("agents/indexing/fetch_backoff.zig");
}
