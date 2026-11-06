comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/destination/signed_recovery_readonly_native_test.zig");
}
