//! Focused typed-cache instrumentation with the production Registry.
test {
    _ = @import("ops/cache_metrics_test.zig");
    _ = @import("relayer/contract_cache_test.zig");
}
