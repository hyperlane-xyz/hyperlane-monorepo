comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("lander/tests.zig");
}
