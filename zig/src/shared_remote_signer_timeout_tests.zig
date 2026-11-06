comptime {
    _ = @import("db/bzip2_glue.zig");
}
test {
    _ = @import("agents/destination/shared_remote_signer_timeout_test.zig");
    _ = @import("agents/destination/reveal_runner_test.zig");
    _ = @import("agents/relayer/ccs_signer_test.zig");
}
