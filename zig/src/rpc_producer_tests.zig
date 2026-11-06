test {
    _ = @import("evm/header_testing.zig");
    _ = @import("evm/rpc_producers_test.zig");
    _ = @import("ops/rpc_metrics.zig");
    _ = @import("evm/pool.zig");
    _ = @import("evm/provider.zig");
    _ = @import("net/dynamic_tip_cache.zig");
    _ = @import("net/http_replay.zig");
}
