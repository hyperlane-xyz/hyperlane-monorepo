comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("native_sender_recovery_test.zig");
}
