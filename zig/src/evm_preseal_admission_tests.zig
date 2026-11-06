comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("evm_preseal_admission_native_test.zig");
}
