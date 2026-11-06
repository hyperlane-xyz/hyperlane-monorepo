//! Actual RocksDB validator scheduling regressions; native-db-test only.
test "validator Source fetch backoff generic native store retries and healthy peer fallback" {
    try @import("generic.zig").NativeTests.fetchBackoff();
}

test "validator Source cursor initialization generic real native failures and recovery" {
    try @import("generic.zig").NativeTests.cursorInitialization();
}

test "validator Source fetch backoff EVM actual native HTTP fallback and completion clock" {
    try @import("evm.zig").NativeTests.fetchBackoff();
}

test "validator Source fetch backoff EVM native HTTP200 malformed and429 response provenance" {
    try @import("evm.zig").NativeTests.fetchBackoffResponseVariants(true);
}

test "validator Source fetch backoff EVM standard HTTP503 HTTP200 malformed and429 response provenance" {
    try @import("evm.zig").NativeTests.fetchBackoffResponseVariants(false);
}

test "validator typed header recovery native healthy peer allbad backoff and startup" {
    try @import("evm.zig").NativeTests.fetchBackoffHeaderVariants(true);
}

test "validator typed header recovery standard healthy peer allbad backoff and startup" {
    try @import("evm.zig").NativeTests.fetchBackoffHeaderVariants(false);
}
