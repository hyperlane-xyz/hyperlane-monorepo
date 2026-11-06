//! Metadata host identity from the exact pinned Rust URL parser. This is not an
//! RPC transport policy or endpoint validator. Returned bytes belong to caller.
const std = @import("std");
const builtin = @import("builtin");
/// Existing settings file byte limit, not a smaller metadata-only URL limit.
pub const maximum_input: usize = 16 * 1024 * 1024;
pub const maximum_output: usize = maximum_input * 3 + 256;
pub const abi_version: u32 = 1;
const HostFn = *const fn ([*]const u8, usize, [*]u8, usize, *usize) callconv(.c) i32;
pub fn defaultPath() []const u8 {
    return switch (builtin.os.tag) {
        .macos => "libziggy_url.dylib",
        .windows => "ziggy_url.dll",
        else => "libziggy_url.so",
    };
}
pub const Library = struct {
    library: std.DynLib,
    host_fn: HostFn,
    pub fn open(path: []const u8) !Library {
        var library = try std.DynLib.open(path);
        errdefer library.close();
        const version_fn = library.lookup(*const fn () callconv(.c) u32, "ziggy_url_abi_version") orelse return error.MissingUrlHostSymbol;
        if (version_fn() != abi_version) return error.IncompatibleUrlHostAbi;
        return .{ .library = library, .host_fn = library.lookup(HostFn, "ziggy_url_host") orelse return error.MissingUrlHostSymbol };
    }
    /// Parse errors and hostless URLs return an owned empty slice, exactly as
    /// Source metadata does. Invalid UTF-8/bounds/ABI/allocation errors stay hard.
    pub fn normalize(self: *const Library, a: std.mem.Allocator, raw: []const u8) ![]u8 {
        if (raw.len > maximum_input) return error.UrlHostInputTooLarge;
        var scratch: [1024]u8 = undefined;
        var length: usize = 0;
        const status = self.host_fn(raw.ptr, raw.len, &scratch, scratch.len, &length);
        if (status == 0) {
            if (length > scratch.len or !std.unicode.utf8ValidateSlice(scratch[0..length])) return error.InvalidUrlHostResult;
            return a.dupe(u8, scratch[0..length]);
        }
        if (status != -3) return failure(status);
        if (length <= scratch.len or length > maximum_output) return error.InvalidUrlHostResult;
        const output = try a.alloc(u8, length);
        errdefer a.free(output);
        var written: usize = 0;
        const second = self.host_fn(raw.ptr, raw.len, output.ptr, output.len, &written);
        if (second != 0) return failure(second);
        if (written != length or !std.unicode.utf8ValidateSlice(output)) return error.InvalidUrlHostResult;
        return output;
    }
    /// All consumers must join before unloading the stateless native ABI.
    pub fn deinit(self: *Library) void {
        self.library.close();
        self.* = undefined;
    }
};
fn failure(code: i32) anyerror {
    return switch (code) {
        -1 => error.InvalidUrlHostInput,
        -2 => error.UrlHostEngineFailure,
        else => error.InvalidUrlHostResult,
    };
}
