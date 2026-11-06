//! Focused canonical transaction-ID companion indexing acceptance.
export fn bz_internal_error(_: c_int) callconv(.c) noreturn {
    @import("std").process.abort();
}
test {
    _ = @import("agents/indexing/tx_id_queue.zig");
    _ = @import("agents/indexing/tx_id_native_test.zig");
    _ = @import("agents/origin_tasks_test.zig");
    _ = @import("agents/indexing/evm_native_test.zig");
    _ = @import("agents/validator/index_source.zig");
}
