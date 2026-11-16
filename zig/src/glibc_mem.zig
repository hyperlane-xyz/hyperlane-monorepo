//! Linux/glibc executables only (linked by build.zig, `-Dglibc-mem`).
//!
//! compiler_rt exports weak, hidden `memcpy`/`memmove`/`memset` (a 32-byte vector loop)
//! and `memcmp`/`bcmp` (byte loops). Being defined inside the executable, they win over
//! glibc for every caller there, including the statically linked RocksDB comparators.
//! These strong definitions replace them and forward to glibc's IFUNC-selected bodies
//! (ERMS `rep movsb`/`rep stosb` for large copies, AVX2 compares).
//!
//! glibc is reached with dlsym(RTLD_NEXT): by name these symbols resolve back here, and
//! compiler_rt also shadows glibc's `__memcpy_chk` family (its versions call `memcpy`).
const std = @import("std");

const Copy = fn (?*anyopaque, ?*const anyopaque, usize) callconv(.c) ?*anyopaque;
const Fill = fn (?*anyopaque, c_int, usize) callconv(.c) ?*anyopaque;
const Compare = fn (?*const anyopaque, ?*const anyopaque, usize) callconv(.c) c_int;

/// One lazily resolved glibc entry point. Racing first calls store the same pointer.
fn Glibc(comptime name: [:0]const u8, comptime F: type) type {
    return struct {
        var resolved: ?*const F = null;

        inline fn get() *const F {
            return @atomicLoad(?*const F, &resolved, .monotonic) orelse resolve();
        }

        noinline fn resolve() *const F {
            const next: ?*anyopaque = @ptrFromInt(std.math.maxInt(usize)); // RTLD_NEXT
            // abort, not panic: the panic path itself copies and compares memory.
            const found: *const F = @ptrCast(std.c.dlsym(next, name) orelse std.c.abort());
            @atomicStore(?*const F, &resolved, found, .monotonic);
            return found;
        }
    };
}

fn memcpy(noalias dest: ?*anyopaque, noalias src: ?*const anyopaque, len: usize) callconv(.c) ?*anyopaque {
    return Glibc("memcpy", Copy).get()(dest, src, len);
}

fn memmove(dest: ?*anyopaque, src: ?*const anyopaque, len: usize) callconv(.c) ?*anyopaque {
    return Glibc("memmove", Copy).get()(dest, src, len);
}

fn memset(dest: ?*anyopaque, byte: c_int, len: usize) callconv(.c) ?*anyopaque {
    return Glibc("memset", Fill).get()(dest, byte, len);
}

fn memcmp(lhs: ?*const anyopaque, rhs: ?*const anyopaque, len: usize) callconv(.c) c_int {
    return Glibc("memcmp", Compare).get()(lhs, rhs, len);
}

comptime {
    @export(&memcpy, .{ .name = "memcpy", .linkage = .strong, .visibility = .hidden });
    @export(&memmove, .{ .name = "memmove", .linkage = .strong, .visibility = .hidden });
    @export(&memset, .{ .name = "memset", .linkage = .strong, .visibility = .hidden });
    @export(&memcmp, .{ .name = "memcmp", .linkage = .strong, .visibility = .hidden });
    @export(&memcmp, .{ .name = "bcmp", .linkage = .strong, .visibility = .hidden }); // a valid bcmp
}
