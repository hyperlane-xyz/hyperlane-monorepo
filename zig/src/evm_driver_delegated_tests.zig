test {
    _ = @import("agents/relayer/evm_driver_test.zig");
    _ = @import("agents/relayer/evm_accounting_test.zig");
}

test {
    _ = @import("db/bzip2_glue.zig");
}
