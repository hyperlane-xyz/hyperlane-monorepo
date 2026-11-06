comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/validator/generic.zig");
    _ = @import("agents/validator/evm.zig");
    _ = @import("agents/validator_task_test.zig");
}

test "validator operational methods remain concrete with native Source backoff" {
    @import("std").testing.refAllDecls(@import("agents/validator/evm.zig").Role);
    @import("std").testing.refAllDecls(@import("agents/validator/generic.zig").Role);
}
