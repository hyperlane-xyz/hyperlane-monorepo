comptime {
    _ = @import("db/bzip2_glue.zig");
}

test {
    _ = @import("agents/stream/relayer_bridge.zig");
    _ = @import("agents/stream/relayer_store.zig");
}

pub fn main() !void {
    const allocator = @import("std").heap.page_allocator;
    try @import("agents/stream/relayer_bridge.zig").runCursorJsonRegression(allocator);
    try @import("agents/stream/relayer_bridge.zig").runReconnectFailureRegression(allocator);
    try @import("agents/stream/relayer_store.zig").runInsertionBarrierRegression(allocator);
    try @import("agents/stream/relayer_bridge.zig").runCallbackOutcomeRegression(allocator);
    try @import("agents/stream/relayer_bridge.zig").runParityPhaseRegression(allocator);
    try @import("agents/stream/relayer_bridge.zig").runSubscriptionPlanAllocationSweep(allocator);
    try @import("agents/stream/relayer_bridge_test.zig").runNativeFixture();
    try @import("agents/stream/relayer_bridge_test.zig").runGasDowngradeFixture();
}
