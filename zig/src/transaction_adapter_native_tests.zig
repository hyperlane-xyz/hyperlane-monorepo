test {
    _ = @import("db/bzip2_glue.zig");
    _ = @import("transaction_adapter_tests.zig");
    _ = @import("transaction_adapter_consumer_native_test.zig");
    _ = @import("transaction_adapter_aleo_native_test.zig");
    _ = @import("transaction_adapter_aleo_authority_native_test.zig");
}
