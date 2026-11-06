//! Cross-platform durable-directory regression entrypoint.
test {
    _ = @import("storage/local.zig");
    _ = @import("runtime/journal.zig");
    _ = @import("cloud/credential_io.zig");
}
