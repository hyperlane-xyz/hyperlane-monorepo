comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/indexing/native_test.zig");
    _ = @import("agents/indexing/cooperative_native_test.zig");
    _ = @import("agents/indexing/cosmos_native_test.zig");
}
