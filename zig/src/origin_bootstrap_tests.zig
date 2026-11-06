//! Focused native origin acceptance; use the native DB archives from build.zig.
export fn bz_internal_error(_: c_int) callconv(.c) noreturn {
    @import("std").process.abort();
}
test {
    _ = @import("agents/indexing/native_test.zig");
    _ = @import("agents/origin_tasks_test.zig");
}
