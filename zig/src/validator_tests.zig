comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/validator/test.zig");
}
