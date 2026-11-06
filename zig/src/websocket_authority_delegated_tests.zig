const std = @import("std");
comptime {
    _ = @import("db/bzip2_glue.zig");
}

test {
    _ = @import("agents/stream/relayer.zig");
    _ = @import("agents/stream/relayer_store.zig");
    _ = @import("agents/stream/relayer_test.zig");
}
