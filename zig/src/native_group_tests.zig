comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/destination/group_guard_native_test.zig");
    _ = @import("starknet_group_control_native_test.zig");
    _ = @import("native_sender_recovery_test.zig");
    _ = @import("agents/relayer/native_driver_test.zig");
    _ = @import("relayer_control_delegated_tests.zig");
    _ = @import("public_relay_delegated_tests.zig");
    _ = @import("starknet_group_native_test.zig");
    _ = @import("relayer_reservation_native_test.zig");
    _ = @import("agents/destination/group_commit_native_test.zig");
}
