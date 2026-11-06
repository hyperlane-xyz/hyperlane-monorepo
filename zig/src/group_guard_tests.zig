comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/destination/group_guard_native_test.zig");
}
