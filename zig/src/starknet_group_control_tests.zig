comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("starknet_group_control_native_test.zig");
}
