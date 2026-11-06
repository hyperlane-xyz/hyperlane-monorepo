//! Bounded, injected credential commands. Actual AWS SDK Unix semantics use
//! /bin/sh -c; no command, stdout or stderr is included in errors or logs.
const std = @import("std");
const builtin = @import("builtin");
const A = std.mem.Allocator;
pub const Limits = struct {
    timeout_ms: u32 = 30000,
    max_output_bytes: usize = 64 * 1024,
    cancel: ?*const std.atomic.Value(bool) = null,
};
pub const Runner = struct {
    context: ?*anyopaque = null,
    run_fn: *const fn (?*anyopaque, A, []const u8, *const std.process.EnvMap, Limits) anyerror![]u8 = run,
    argv_fn: *const fn (?*anyopaque, A, []const []const u8, *const std.process.EnvMap, Limits) anyerror![]u8 = runArgv,
    pub fn executeArgv(self: Runner, a: A, argv: []const []const u8, environment: *const std.process.EnvMap, limits: Limits) ![]u8 {
        const bytes = try self.argv_fn(self.context, a, argv, environment, limits);
        errdefer {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        }
        if (bytes.len > limits.max_output_bytes) return error.CredentialCommandOutputLimit;
        return bytes;
    }
    pub fn execute(self: Runner, a: A, command: []const u8, environment: *const std.process.EnvMap, limits: Limits) ![]u8 {
        const bytes = try self.run_fn(self.context, a, command, environment, limits);
        errdefer {
            std.crypto.secureZero(u8, bytes);
            a.free(bytes);
        }
        if (bytes.len > limits.max_output_bytes) return error.CredentialCommandOutputLimit;
        return bytes;
    }
};
fn check(timer: *std.time.Timer, limits: Limits) !void {
    if (limits.cancel) |flag| if (flag.load(.acquire)) return error.RequestCancelled;
    if (timer.read() >= @as(u64, limits.timeout_ms) * std.time.ns_per_ms) return error.CredentialCommandDeadline;
}
fn term(status: u32) std.process.Child.Term {
    if (std.posix.W.IFEXITED(status)) return .{ .Exited = std.posix.W.EXITSTATUS(status) };
    if (std.posix.W.IFSIGNALED(status)) return .{ .Signal = std.posix.W.TERMSIG(status) };
    return .{ .Unknown = status };
}
fn run(_: ?*anyopaque, a: A, command: []const u8, environment: *const std.process.EnvMap, limits: Limits) ![]u8 {
    if (builtin.os.tag != .macos and builtin.os.tag != .linux) return error.UnsupportedCredentialCommandPlatform;
    if (command.len == 0 or command.len > 16384 or std.mem.indexOfScalar(u8, command, 0) != null or limits.timeout_ms == 0 or limits.max_output_bytes == 0 or limits.max_output_bytes > 1024 * 1024) return error.InvalidCredentialCommand;
    return runArgv(null, a, &.{ "/bin/sh", "-c", command }, environment, limits);
}
fn runArgv(_: ?*anyopaque, a: A, argv: []const []const u8, environment: *const std.process.EnvMap, limits: Limits) ![]u8 {
    if (builtin.os.tag != .macos and builtin.os.tag != .linux) return error.UnsupportedCredentialCommandPlatform;
    if (argv.len == 0 or argv.len > 256 or limits.timeout_ms == 0 or limits.max_output_bytes == 0 or limits.max_output_bytes > 1024 * 1024) return error.InvalidCredentialCommand;
    var size: usize = 0;
    for (argv) |arg| {
        size = try std.math.add(usize, size, arg.len);
        if (size > 16384 or std.mem.indexOfScalar(u8, arg, 0) != null) return error.InvalidCredentialCommand;
    }
    var timer = try std.time.Timer.start();
    try check(&timer, limits);
    var child = std.process.Child.init(argv, a);
    child.env_map = environment;
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore; // Source stderr may contain secret values.
    child.pgid = 0; // Isolated process group: terminate descendants before return.
    try child.spawn();
    const pid = child.id;
    var reaped = false;
    defer {
        std.posix.kill(-pid, std.posix.SIG.KILL) catch {};
        if (!reaped) _ = child.wait() catch {};
    }
    const fd = child.stdout.?.handle;
    const flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
    _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
    var output: std.ArrayList(u8) = .empty;
    defer {
        std.crypto.secureZero(u8, output.items);
        output.deinit(a);
    }
    var buffer: [4096]u8 = undefined;
    defer std.crypto.secureZero(u8, &buffer);
    var eof = false;
    var exit: ?std.process.Child.Term = null;
    while (!eof or exit == null) {
        try check(&timer, limits);
        if (!eof) {
            var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
            _ = try std.posix.poll(&polls, 10);
            if (polls[0].revents & std.posix.POLL.NVAL != 0) return error.CredentialCommandPipeClosed;
            if (polls[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) {
                const count = std.posix.read(fd, &buffer) catch |err| switch (err) {
                    error.WouldBlock => continue,
                    else => return err,
                };
                if (count == 0) eof = true else {
                    if (count > limits.max_output_bytes - output.items.len) return error.CredentialCommandOutputLimit;
                    try output.appendSlice(a, buffer[0..count]);
                }
            }
        } else {
            // A zero-length Zig slice may carry a noncanonical pointer. Linux
            // ppoll validates it even for nfds=0; sleep while waiting for exit.
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        if (exit == null) {
            const waited = std.posix.waitpid(pid, std.posix.W.NOHANG);
            if (waited.pid != 0) {
                exit = term(waited.status);
                child.term = exit.?;
            }
        }
    }
    _ = try child.wait(); // Clean streams; waitpid already reaped the exact PID.
    reaped = true;
    if (exit.? != .Exited or exit.?.Exited != 0) return error.CredentialCommandRejected;
    try check(&timer, limits);
    return output.toOwnedSlice(a);
}
test "credential command owns bounded stdout hides failures and kills process group on deadline" {
    const a = std.testing.allocator;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    try environment.put("PUBLIC_FIXTURE", "credential command");
    const runner: Runner = .{};
    const output = try runner.execute(a, "printf '%s' \"$PUBLIC_FIXTURE\"", &environment, .{});
    defer a.free(output);
    try std.testing.expectEqualStrings("credential command", output);
    const direct = try runner.executeArgv(a, &.{ "/usr/bin/printf", "%s", "$PUBLIC_FIXTURE" }, &environment, .{});
    defer a.free(direct);
    try std.testing.expectEqualStrings("$PUBLIC_FIXTURE", direct);
    try std.testing.expectError(error.CredentialCommandRejected, runner.execute(a, "printf 'private-error' >&2; exit 3", &environment, .{}));
    try std.testing.expectError(error.CredentialCommandOutputLimit, runner.execute(a, "printf 'too-long'", &environment, .{ .max_output_bytes = 3 }));
    var timer = try std.time.Timer.start();
    try std.testing.expectError(error.CredentialCommandDeadline, runner.execute(a, "sleep 10 & wait", &environment, .{ .timeout_ms = 50 }));
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    // A child closing stdout early must not turn wait() into an unbounded wait.
    try std.testing.expectError(error.CredentialCommandDeadline, runner.execute(a, "exec 1>&-; sleep 10", &environment, .{ .timeout_ms = 50 }));
    var cancelled = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, runner.execute(a, "printf should-not-run", &environment, .{ .cancel = &cancelled }));
}
