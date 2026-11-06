//! Network isolation for the CPU-only proof worker. REST/prover HTTP lives in Zig
//! parent transport; missing explicit public parameters must fail without fetch.
const std = @import("std");
const builtin = @import("builtin");
pub fn denyNetwork() !void {
    if (builtin.os.tag == .macos) {
        var library = try std.DynLib.open("/usr/lib/libsandbox.1.dylib");
        defer library.close();
        const init = library.lookup(*const fn ([*:0]const u8, u64, *?[*:0]u8) callconv(.c) c_int, "sandbox_init") orelse return error.MissingWorkerSandboxSymbol;
        const free = library.lookup(*const fn (?[*:0]u8) callconv(.c) void, "sandbox_free_error") orelse return error.MissingWorkerSandboxSymbol;
        var message: ?[*:0]u8 = null;
        defer free(message);
        if (init("(version 1) (allow default) (deny network*) (deny process-exec)", 0, &message) != 0) return error.WorkerSandboxRejected;
        return;
    }
    if (builtin.os.tag == .linux) {
        const linux = std.os.linux;
        const architecture: u32 = switch (builtin.cpu.arch) {
            .aarch64 => 0xc00000b7,
            .x86_64 => 0xc000003e,
            else => return error.UnsupportedWorkerSandboxArchitecture,
        };
        const Filter = extern struct { code: u16, jt: u8, jf: u8, k: u32 };
        const Program = extern struct { len: u16, filter: [*]const Filter };
        const blocked = [_]linux.SYS{ .socket, .connect, .sendto, .sendmsg, .execve, .execveat };
        var filters: [6 + blocked.len * 2 + 1]Filter = undefined;
        // Verify audit architecture and reject alternate x32 syscall numbering.
        filters[0] = .{ .code = 0x20, .jt = 0, .jf = 0, .k = 4 };
        filters[1] = .{ .code = 0x15, .jt = 1, .jf = 0, .k = architecture };
        filters[2] = .{ .code = 0x06, .jt = 0, .jf = 0, .k = 0x80000000 };
        filters[3] = .{ .code = 0x20, .jt = 0, .jf = 0, .k = 0 };
        filters[4] = .{ .code = 0x35, .jt = 0, .jf = 1, .k = 0x40000000 };
        filters[5] = .{ .code = 0x06, .jt = 0, .jf = 0, .k = 0x80000000 };
        for (blocked, 0..) |syscall, index| {
            filters[6 + index * 2] = .{ .code = 0x15, .jt = 0, .jf = 1, .k = @intCast(@intFromEnum(syscall)) };
            filters[7 + index * 2] = .{ .code = 0x06, .jt = 0, .jf = 0, .k = 0x00050000 | 1 };
        }
        filters[filters.len - 1] = .{ .code = 0x06, .jt = 0, .jf = 0, .k = 0x7fff0000 };
        const program: Program = .{ .len = filters.len, .filter = &filters };
        if (linux.prctl(38, 1, 0, 0, 0) != 0 or linux.prctl(22, 2, @intFromPtr(&program), 0, 0) != 0) return error.WorkerSandboxRejected;
        return;
    }
    return error.UnsupportedWorkerSandboxPlatform;
}
