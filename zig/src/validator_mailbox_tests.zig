comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/validator/mailbox.zig");
}

test {
    _ = @import("agents/validator/mailbox_native_test.zig");
}
