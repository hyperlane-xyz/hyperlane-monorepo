comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("canonical_admission_native_test.zig");
}
