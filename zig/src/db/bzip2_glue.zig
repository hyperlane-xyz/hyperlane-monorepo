//! bzip2-sys builds its C library with BZ_NO_STDIO and provides this callback in
//! Rust. When linking that exact static archive without Rust, provide the same
//! fatal invariant behavior. This is not a compression or storage implementation.
const std = @import("std");
export fn bz_internal_error(code: c_int) callconv(.c) noreturn {
    std.debug.print("bzip2 internal invariant failure: {d}\n", .{code});
    std.process.abort();
}
