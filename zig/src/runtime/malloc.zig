//! Process allocator tuning for the production services (libc malloc).
const std = @import("std");
const builtin = @import("builtin");

/// glibc creates up to 8 malloc arenas per core, one per contending thread.
/// With the agents' owner/worker threads that grew relayer RSS 15-24 MiB over
/// SmpAllocator. Bound arenas unless the operator set MALLOC_ARENA_MAX.
pub const arena_max: c_int = 2;

pub fn boundArenas() void {
    if (comptime !(builtin.os.tag == .linux and builtin.abi.isGnu())) return;
    if (std.posix.getenv("MALLOC_ARENA_MAX") != null) return;
    const M_ARENA_MAX: c_int = -8;
    _ = glibc.mallopt(M_ARENA_MAX, arena_max);
}

const glibc = struct {
    extern "c" fn mallopt(param: c_int, value: c_int) c_int;
};

test "arena bound is a no-op off glibc and accepted by glibc" {
    boundArenas();
    if (comptime builtin.os.tag == .linux and builtin.abi.isGnu()) {
        try std.testing.expectEqual(@as(c_int, 1), glibc.mallopt(-8, arena_max));
    }
}
