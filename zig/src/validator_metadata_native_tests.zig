comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/validator/metadata_native_test.zig");
}
