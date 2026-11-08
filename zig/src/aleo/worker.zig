//! Isolated native-VM worker session. One owner, one process, one absolute budget.
//! Secrets travel only through pipes. Failure/cancel/timeout kill+reap before return.
const std = @import("std");
const builtin = @import("builtin");
pub const Command = enum(u8) { init = 1, add_program = 2, authorize = 3, estimate = 4, fee = 5, proving_request = 6, prove = 7, validate = 8, program_info = 9, key_address = 10, block_info = 11, network_probe = 12, transaction_info = 13, confirmed_info = 14, restore = 15, job_info = 16 };
pub const Limits = struct { timeout_ms: u32 = 30000, max_input_bytes: usize = 64 * 1024 * 1024, max_output_bytes: usize = 64 * 1024 * 1024, memory_bytes: u64 = 4 * 1024 * 1024 * 1024, cancel: ?*const std.atomic.Value(bool) = null, parameter_home: ?[]const u8 = null };
const ProcTask = extern struct { virtual: u64, resident: u64, times: [4]u64, fields: [12]i32 };
const ProcInfo = *const fn (c_int, c_int, u64, *anyopaque, c_int) callconv(.c) c_int;
pub const Session = struct {
    allocator: std.mem.Allocator,
    child: std.process.Child,
    limits: Limits,
    timer: std.time.Timer,
    input_used: usize = 0,
    output_used: usize = 0,
    retired: bool = false,
    proc_library: ?std.DynLib = null,
    proc_info: ?ProcInfo = null,
    last_error_code: u16 = 0,
    /// argv contains only explicit executable paths and public limits/config.
    /// Worker command payloads (including library init) use exchange(), never argv.
    pub fn spawn(a: std.mem.Allocator, argv: []const []const u8, limits: Limits) !Session {
        if (argv.len == 0 or limits.timeout_ms == 0 or limits.max_input_bytes < 1 or limits.max_input_bytes > 64 * 1024 * 1024 or limits.max_output_bytes < 1 or limits.max_output_bytes > 64 * 1024 * 1024 or limits.memory_bytes < 16 * 1024 * 1024) return error.InvalidAleoWorkerLimits;
        var timer = try std.time.Timer.start();
        _ = timer.read();
        if (limits.cancel) |flag| if (flag.load(.acquire)) return error.AleoWorkerCancelled;
        var child = std.process.Child.init(argv, a);
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Ignore;
        // Do not inherit credential environment variables into the isolated worker.
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        if (limits.parameter_home) |home| {
            const directory = try std.fs.path.join(a, &.{ home, ".aleo" });
            defer a.free(directory);
            try environment.put("HYPERLANE_ALEO_PARAMETER_DIR", directory);
        }
        // Rust/snarkVM already supports this public, process-local consensus
        // override. Preserve it without inheriting any credential environment.
        const consensus = std.process.getEnvVarOwned(a, "CONSENSUS_VERSION_HEIGHTS") catch |err| switch (err) {
            error.EnvironmentVariableNotFound => null,
            else => return err,
        };
        defer if (consensus) |value| a.free(value);
        if (consensus) |value| try environment.put("CONSENSUS_VERSION_HEIGHTS", value);
        child.env_map = &environment;
        try child.spawn();
        child.env_map = null;
        var result: Session = .{ .allocator = a, .child = child, .limits = limits, .timer = timer };
        errdefer result.deinit();
        try result.awaitExec();
        for ([_]std.posix.fd_t{ result.child.stdin.?.handle, result.child.stdout.?.handle }) |fd| {
            const flags = try std.posix.fcntl(fd, std.posix.F.GETFL, 0);
            _ = try std.posix.fcntl(fd, std.posix.F.SETFL, flags | @as(u32, @bitCast(std.posix.O{ .NONBLOCK = true })));
        }
        if (builtin.os.tag == .macos) {
            var library = try std.DynLib.open("/usr/lib/libproc.dylib");
            errdefer library.close();
            result.proc_info = library.lookup(ProcInfo, "proc_pidinfo") orelse return error.MissingAleoWorkerMemoryProbe;
            result.proc_library = library;
        }
        try result.check();
        return result;
    }
    pub fn deinit(self: *Session) void {
        self.retire();
        if (self.proc_library) |*lib| lib.close();
        self.* = undefined;
    }
    fn retire(self: *Session) void {
        if (self.retired) return;
        self.retired = true;
        std.posix.kill(self.child.id, std.posix.SIG.KILL) catch {};
        // SIGKILL then wait, never merely abandon a CPU worker or release its slot.
        self.child.waitForSpawn() catch {
            // This also covers cancellation racing an already-failed exec.
            self.child.term = null;
        };
        _ = self.child.wait() catch {};
    }
    fn memory(self: *Session) !u64 {
        if (builtin.os.tag == .macos) {
            var info: ProcTask = undefined;
            const count = self.proc_info.?(self.child.id, 4, 0, &info, @sizeOf(ProcTask));
            if (count != @sizeOf(ProcTask)) return error.AleoWorkerMemoryProbeFailed;
            return info.resident;
        }
        if (builtin.os.tag == .linux) {
            var path: [64]u8 = undefined;
            const name = try std.fmt.bufPrint(&path, "/proc/{d}/status", .{self.child.id});
            const bytes = try std.fs.cwd().readFileAlloc(self.allocator, name, 16 * 1024);
            defer self.allocator.free(bytes);
            var lines = std.mem.splitScalar(u8, bytes, '\n');
            while (lines.next()) |line| if (std.mem.startsWith(u8, line, "VmRSS:")) {
                var parts = std.mem.tokenizeAny(u8, line[6..], " \t");
                const number = parts.next() orelse return error.AleoWorkerMemoryProbeFailed;
                if (!std.mem.eql(u8, parts.next() orelse "", "kB")) return error.AleoWorkerMemoryProbeFailed;
                return std.math.mul(u64, try std.fmt.parseInt(u64, number, 10), 1024);
            };
            return error.AleoWorkerMemoryProbeFailed;
        }
        return error.UnsupportedAleoWorkerPlatform;
    }
    fn checkControls(self: *Session) !void {
        if (self.retired) return error.AleoWorkerRetired;
        if (self.limits.cancel) |flag| if (flag.load(.acquire)) return error.AleoWorkerCancelled;
        if (self.timer.read() >= @as(u64, self.limits.timeout_ms) * std.time.ns_per_ms) return error.AleoWorkerDeadline;
    }
    fn awaitExec(self: *Session) !void {
        // fork initially shares the parent's resident pages. Apply the worker's
        // RSS limit only after exec, using the original cancellation/deadline
        // while waiting for Child's atomic errno or CLOEXEC acknowledgement.
        if (builtin.os.tag != .windows) {
            if (self.child.err_pipe) |fd| while (true) {
                try self.checkControls();
                const remaining = @as(u64, self.limits.timeout_ms) * std.time.ns_per_ms -| self.timer.read();
                const wait_ms: i32 = @intCast(@min(@as(u64, 10), @max(@as(u64, 1), remaining / std.time.ns_per_ms)));
                var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&polls, wait_ms) == 0) continue;
                if (polls[0].revents & std.posix.POLL.NVAL != 0) return error.AleoWorkerPipeClosed;
                if (polls[0].revents & (std.posix.POLL.IN | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) break;
            };
        }
        try self.checkControls();
        self.child.waitForSpawn() catch |err| {
            // Child caches the exec error before wait() can reap/close streams.
            // Our owned error cleanup must still perform that normal wait.
            self.child.term = null;
            return err;
        };
        try self.checkControls();
    }
    fn check(self: *Session) !void {
        try self.checkControls();
        if (try self.memory() > self.limits.memory_bytes) return error.AleoWorkerMemoryLimit;
    }
    fn ready(self: *Session, fd: std.posix.fd_t, events: i16) !void {
        while (true) {
            try self.check();
            const remaining = @as(u64, self.limits.timeout_ms) * std.time.ns_per_ms -| self.timer.read();
            const wait_ms: @TypeOf(@as(i32, 0)) = @intCast(@min(@as(u64, 10), @max(@as(u64, 1), remaining / std.time.ns_per_ms)));
            var polls = [_]std.posix.pollfd{.{ .fd = fd, .events = events, .revents = 0 }};
            if (try std.posix.poll(&polls, wait_ms) == 0) continue;
            if (polls[0].revents & std.posix.POLL.NVAL != 0) return error.AleoWorkerPipeClosed;
            if (polls[0].revents & (events | std.posix.POLL.HUP | std.posix.POLL.ERR) != 0) return;
        }
    }
    fn write(self: *Session, bytes: []const u8) !void {
        var offset: usize = 0;
        const fd = self.child.stdin.?.handle;
        while (offset < bytes.len) {
            try self.ready(fd, std.posix.POLL.OUT);
            const count = std.posix.write(fd, bytes[offset..]) catch |err| switch (err) {
                error.WouldBlock => continue,
                else => return err,
            };
            if (count == 0) return error.AleoWorkerPipeClosed;
            offset += count;
        }
    }
    fn read(self: *Session, bytes: []u8) !void {
        var offset: usize = 0;
        const fd = self.child.stdout.?.handle;
        while (offset < bytes.len) {
            try self.ready(fd, std.posix.POLL.IN);
            const count = std.posix.read(fd, bytes[offset..]) catch |err| switch (err) {
                error.WouldBlock => continue,
                else => return err,
            };
            if (count == 0) return error.AleoWorkerPipeClosed;
            offset += count;
        }
    }
    pub fn exchange(self: *Session, command: Command, payload: []const u8) ![]u8 {
        errdefer self.retire();
        try self.check();
        const size = try std.math.add(usize, payload.len, 1);
        if (size > self.limits.max_input_bytes - self.input_used) return error.AleoWorkerInputLimit;
        self.input_used += size;
        var header: [5]u8 = undefined;
        std.mem.writeInt(u32, header[0..4], @intCast(size), .big);
        header[4] = @intFromEnum(command);
        try self.write(&header);
        try self.write(payload);
        var response: [5]u8 = undefined;
        try self.read(&response);
        const length = std.mem.readInt(u32, response[0..4], .big);
        if (length == 0 or length > self.limits.max_output_bytes - self.output_used) return error.AleoWorkerOutputLimit;
        self.output_used += length;
        const bytes = try self.allocator.alloc(u8, length - 1);
        errdefer self.allocator.free(bytes);
        try self.read(bytes);
        try self.check();
        if (response[4] != 0) {
            if (response[4] != 1 or bytes.len != 2) return error.InvalidAleoWorkerFrame;
            self.last_error_code = std.mem.readInt(u16, bytes[0..2], .big);
            return error.AleoWorkerRejected;
        }
        return bytes;
    }
};

fn fixtureSession(limits: Limits) !Session {
    const a = std.testing.allocator;
    const fixture_path = blk: {
        std.fs.cwd().access("zig/src/aleo/testing/worker_fixture.py", .{}) catch break :blk "src/aleo/testing/worker_fixture.py";
        break :blk "zig/src/aleo/testing/worker_fixture.py";
    };
    const path = try std.fs.cwd().realpathAlloc(a, fixture_path);
    defer a.free(path);
    return Session.spawn(a, &.{ "/usr/bin/python3", path }, limits);
}

test "Aleo worker exec acknowledgement excludes inherited parent RSS" {
    const pages = try std.heap.page_allocator.alloc(u8, 256 * 1024 * 1024);
    defer std.heap.page_allocator.free(pages);
    @memset(pages, 0x51);
    std.mem.doNotOptimizeAway(pages);
    const fixture_path = blk: {
        std.fs.cwd().access("zig/src/aleo/testing/worker_fixture.py", .{}) catch break :blk "src/aleo/testing/worker_fixture.py";
        break :blk "zig/src/aleo/testing/worker_fixture.py";
    };
    const path = try std.fs.cwd().realpathAlloc(std.testing.allocator, fixture_path);
    defer std.testing.allocator.free(path);
    const args = try std.testing.allocator.alloc([]const u8, 3000);
    defer std.testing.allocator.free(args);
    args[0] = "/usr/bin/python3";
    args[1] = path;
    const filler = "x" ** 256;
    @memset(args[2..], filler);
    // Python fixture headroom; the touched 256 MiB parent still exceeds this cap.
    for (0..20) |iteration| {
        var elapsed = try std.time.Timer.start();
        var session = Session.spawn(std.testing.allocator, args, .{ .timeout_ms = 5000, .memory_bytes = 128 * 1024 * 1024 }) catch |err| {
            std.debug.print("ALEO_WORKER_EXEC_FIXTURE phase=spawn iteration={d} error={s} elapsed_ms={d}\n", .{ iteration, @errorName(err), elapsed.read() / std.time.ns_per_ms });
            return err;
        };
        defer session.deinit();
        const output = session.exchange(.program_info, "echo") catch |err| {
            std.debug.print("ALEO_WORKER_EXEC_FIXTURE phase=exchange iteration={d} error={s} elapsed_ms={d}\n", .{ iteration, @errorName(err), session.timer.read() / std.time.ns_per_ms });
            return err;
        };
        defer std.testing.allocator.free(output);
        try std.testing.expectEqualStrings("echo", output);
    }
    try std.testing.expectEqual(@as(u8, 0x51), pages[pages.len - 1]);
}

fn testFdCount() !usize {
    if (builtin.os.tag != .linux) return 0;
    var dir = try std.fs.openDirAbsolute("/proc/self/fd", .{ .iterate = true });
    defer dir.close();
    var iterator = dir.iterate();
    var count: usize = 0;
    while (try iterator.next()) |_| count += 1;
    return count;
}

fn testChildren() ![]u8 {
    if (builtin.os.tag != .linux) return std.testing.allocator.dupe(u8, "");
    var path: [96]u8 = undefined;
    const name = try std.fmt.bufPrint(&path, "/proc/self/task/{d}/children", .{std.os.linux.getpid()});
    return std.fs.cwd().readFileAlloc(std.testing.allocator, name, 64 * 1024);
}

test "Aleo worker typed exec failures reap children and close every pipe" {
    const before_fds = try testFdCount();
    const before_children = try testChildren();
    defer std.testing.allocator.free(before_children);
    for (0..20) |_| {
        try std.testing.expectError(error.FileNotFound, Session.spawn(std.testing.allocator, &.{"/no-such-aleo-worker-fixture"}, .{}));
        try std.testing.expectError(error.AccessDenied, Session.spawn(std.testing.allocator, &.{"/dev/null"}, .{}));
    }
    for ([_]bool{ false, true }) |cancelled| {
        const timer = try std.time.Timer.start();
        var environment = std.process.EnvMap.init(std.testing.allocator);
        defer environment.deinit();
        var child = std.process.Child.init(&.{"/no-such-aleo-worker-fixture"}, std.testing.allocator);
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Ignore;
        child.env_map = &environment;
        try child.spawn();
        child.env_map = null;
        var flag = std.atomic.Value(bool).init(false);
        var session: Session = .{ .allocator = std.testing.allocator, .child = child, .limits = .{ .timeout_ms = if (cancelled) 5000 else 1, .cancel = &flag }, .timer = timer };
        defer session.deinit();
        var ready = [_]std.posix.pollfd{.{ .fd = session.child.err_pipe.?, .events = std.posix.POLL.IN, .revents = 0 }};
        try std.testing.expectEqual(@as(usize, 1), try std.posix.poll(&ready, 1000));
        if (cancelled) {
            flag.store(true, .release);
            try std.testing.expectError(error.AleoWorkerCancelled, session.awaitExec());
        } else {
            std.Thread.sleep(2 * std.time.ns_per_ms);
            try std.testing.expectError(error.AleoWorkerDeadline, session.awaitExec());
        }
        session.retire();
    }
    const after_children = try testChildren();
    defer std.testing.allocator.free(after_children);
    try std.testing.expectEqualStrings(before_children, after_children);
    try std.testing.expectEqual(before_fds, try testFdCount());
}

test "Aleo worker pending exec acknowledgement retains deadline and cancellation" {
    for ([_]bool{ false, true }) |cancelled| {
        var flag = std.atomic.Value(bool).init(false);
        var session = try fixtureSession(.{ .timeout_ms = 100, .cancel = &flag });
        defer session.deinit();
        const pipe = try std.posix.pipe2(.{ .CLOEXEC = true });
        session.child.err_pipe = pipe[0];
        var writer_open = true;
        defer if (writer_open) std.posix.close(pipe[1]);
        const Cancel = struct {
            fn run(value: *std.atomic.Value(bool)) void {
                std.Thread.sleep(10 * std.time.ns_per_ms);
                value.store(true, .release);
            }
        };
        const thread = if (cancelled) try std.Thread.spawn(.{}, Cancel.run, .{&flag}) else null;
        defer if (thread) |value| value.join();
        if (cancelled) {
            try std.testing.expectError(error.AleoWorkerCancelled, session.awaitExec());
        } else {
            try std.testing.expectError(error.AleoWorkerDeadline, session.awaitExec());
        }
        try std.testing.expect(session.timer.read() < std.time.ns_per_s);
        std.posix.close(pipe[1]);
        writer_open = false;
        session.retire();
        try std.testing.expect(session.retired);
    }
}
test "Aleo isolated worker frames own responses and rejected job is killed and reaped" {
    const a = std.testing.allocator;
    var session = try fixtureSession(.{ .timeout_ms = 5000 });
    defer session.deinit();
    const response = try session.exchange(.program_info, "public fixture");
    defer a.free(response);
    try std.testing.expectEqualStrings("public fixture", response);
    try std.testing.expectError(error.AleoWorkerRejected, session.exchange(.program_info, "reject"));
    try std.testing.expectEqual(@as(u16, 42), session.last_error_code);
    try std.testing.expect(session.retired);
    try std.testing.expectError(error.AleoWorkerRetired, session.exchange(.program_info, "later"));
}
test "Aleo isolated worker absolute deadline and partial output retire before return" {
    for ([_][]const u8{ "sleep", "partial" }) |payload| {
        var session = try fixtureSession(.{ .timeout_ms = 300 });
        defer session.deinit();
        try std.testing.expectError(error.AleoWorkerDeadline, session.exchange(.program_info, payload));
        try std.testing.expect(session.retired);
        try std.testing.expect(session.timer.read() < 3 * std.time.ns_per_s);
    }
}
test "Aleo isolated worker pipe bounds cancellation and process memory are enforced" {
    var session = try fixtureSession(.{ .timeout_ms = 5000, .max_output_bytes = 64 });
    defer session.deinit();
    try std.testing.expectError(error.AleoWorkerOutputLimit, session.exchange(.program_info, "oversize"));
    try std.testing.expect(session.retired);
    var input = try fixtureSession(.{ .timeout_ms = 5000, .max_input_bytes = 2 });
    defer input.deinit();
    try std.testing.expectError(error.AleoWorkerInputLimit, input.exchange(.program_info, "large"));
    try std.testing.expect(input.retired);
    var flag = std.atomic.Value(bool).init(false);
    var cancel = try fixtureSession(.{ .timeout_ms = 5000, .cancel = &flag });
    defer cancel.deinit();
    flag.store(true, .release);
    try std.testing.expectError(error.AleoWorkerCancelled, cancel.exchange(.program_info, "never"));
    try std.testing.expect(cancel.retired);
    var memory = try fixtureSession(.{ .timeout_ms = 5000, .memory_bytes = 48 * 1024 * 1024 });
    defer memory.deinit();
    try std.testing.expectError(error.AleoWorkerMemoryLimit, memory.exchange(.program_info, "memory"));
    try std.testing.expect(memory.retired);
}

test "Aleo actual isolated native worker authorizes fees and exports source proving wire through pipes" {
    const a = std.testing.allocator;
    const executable = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_WORKER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(executable);
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    var session = try Session.spawn(a, &.{ executable, "4294967296", "67108864", "67108864" }, .{ .timeout_ms = 30000 });
    defer session.deinit();
    const config = try std.json.Stringify.valueAlloc(a, .{ .library = library, .network = @as(u16, 0) }, .{});
    defer a.free(config);
    const initialized = try session.exchange(.init, config);
    defer a.free(initialized);
    try std.testing.expectEqual(@as(usize, 0), initialized.len);
    const address = try session.exchange(.key_address, &(.{0x11} ** 32));
    defer a.free(address);
    try std.testing.expectEqual(@as(usize, 32), address.len);
    const request = try std.json.Stringify.valueAlloc(a, .{ .program_id = "credits.aleo", .function_name = "fee_public", .inputs = [_][]const u8{ "1000u64", "1u64", "1field" }, .unchecked = false }, .{});
    defer a.free(request);
    const authorization = try a.alloc(u8, 64 + request.len);
    defer {
        std.crypto.secureZero(u8, authorization);
        a.free(authorization);
    }
    @memset(authorization[0..32], 0x11);
    @memset(authorization[32..64], 7);
    @memcpy(authorization[64..], request);
    const info = try session.exchange(.authorize, authorization);
    defer a.free(info);
    var parsed = try std.json.parseFromSlice(std.json.Value, a, info, .{});
    defer parsed.deinit();
    try std.testing.expect(parsed.value.object.contains("execution_id"));
    var fee: [81]u8 = undefined;
    @memset(fee[0..32], 0x11);
    @memset(fee[32..64], 8);
    std.mem.writeInt(u64, fee[64..72], 1000, .big);
    std.mem.writeInt(u64, fee[72..80], 1, .big);
    fee[80] = 0;
    defer std.crypto.secureZero(u8, &fee);
    const approved = try session.exchange(.fee, &fee);
    defer a.free(approved);
    try std.testing.expectEqual(@as(usize, 0), approved.len);
    const wire = try session.exchange(.proving_request, "");
    defer {
        std.crypto.secureZero(u8, wire);
        a.free(wire);
    }
    try std.testing.expect(wire.len > 64);
    try std.testing.expectEqual(@as(u8, 0), wire[wire.len - 1]);
    try std.testing.expectError(error.AleoWorkerRejected, session.exchange(.validate, "{}"));
    try std.testing.expect(session.retired);
}

test "Aleo actual isolated local proof is bound to exact authorized execution and fee" {
    const a = std.testing.allocator;
    const executable = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_WORKER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(executable);
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    const parameter_home = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_PARAMETER_HOME") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(parameter_home);
    var session = try Session.spawn(a, &.{ executable, "4294967296", "67108864", "67108864" }, .{ .timeout_ms = 60000, .parameter_home = parameter_home });
    defer session.deinit();
    const config = try std.json.Stringify.valueAlloc(a, .{ .library = library, .network = @as(u16, 0) }, .{});
    defer a.free(config);
    a.free(try session.exchange(.init, config));
    const program = "program ziggyfixture.aleo;\nfunction add_one:\n input r0 as u64.public;\n add r0 1u64 into r1;\n output r1 as u64.public;\n";
    const add = try std.json.Stringify.valueAlloc(a, .{ .program = program, .edition = @as(u16, 1) }, .{});
    defer a.free(add);
    a.free(try session.exchange(.add_program, add));
    const request = try std.json.Stringify.valueAlloc(a, .{ .program_id = "ziggyfixture.aleo", .function_name = "add_one", .inputs = [_][]const u8{"1u64"}, .unchecked = false }, .{});
    defer a.free(request);
    const auth = try a.alloc(u8, 64 + request.len);
    defer {
        std.crypto.secureZero(u8, auth);
        a.free(auth);
    }
    @memset(auth[0..32], 0x11);
    @memset(auth[32..64], 9);
    @memcpy(auth[64..], request);
    a.free(try session.exchange(.authorize, auth));
    var fee: [81]u8 = undefined;
    @memset(fee[0..32], 0x11);
    @memset(fee[32..64], 10);
    std.mem.writeInt(u64, fee[64..72], 1000, .big);
    std.mem.writeInt(u64, fee[72..80], 1, .big);
    fee[80] = 0;
    defer std.crypto.secureZero(u8, &fee);
    a.free(try session.exchange(.fee, &fee));
    const query = "{\"state_root\":\"sr1dz06ur5spdgzkguh4pr42mvft6u3nwsg5drh9rdja9v8jpcz3czsls9geg\",\"height\":15000000,\"state_paths\":{}}";
    const input = try a.alloc(u8, 32 + query.len);
    defer a.free(input);
    @memset(input[0..32], 11);
    @memcpy(input[32..], query);
    const transaction = try session.exchange(.prove, input);
    defer a.free(transaction);
    try std.testing.expect(transaction.len > 100);
    const metadata = try session.exchange(.validate, transaction);
    defer a.free(metadata);
    var parsed = try std.json.parseFromSlice(std.json.Value, a, metadata, .{});
    defer parsed.deinit();
    try std.testing.expectEqual(@as(i64, 1000), parsed.value.object.get("base_fee").?.integer);
    try std.testing.expectEqual(@as(i64, 1), parsed.value.object.get("priority_fee").?.integer);
}

test "Aleo actual proof worker OS sandbox forbids loopback network connections" {
    const a = std.testing.allocator;
    const executable = std.process.getEnvVarOwned(a, "HYPERLANE_ALEO_VM_WORKER") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(executable);
    var listener = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{ .force_nonblocking = true });
    defer listener.deinit();
    var session = try Session.spawn(a, &.{ executable, "4294967296", "67108864", "67108864" }, .{ .timeout_ms = 5000 });
    defer session.deinit();
    var port: [2]u8 = undefined;
    std.mem.writeInt(u16, &port, listener.listen_address.getPort(), .big);
    const result = try session.exchange(.network_probe, &port);
    defer a.free(result);
    try std.testing.expectEqualSlices(u8, &.{1}, result);
    try std.testing.expectError(error.WouldBlock, listener.accept());
}

extern "c" fn setenv(name: [*:0]const u8, value: [*:0]const u8, overwrite: c_int) c_int;
extern "c" fn unsetenv(name: [*:0]const u8) c_int;

fn workerTestEnvironment(name: [:0]const u8, value: ?[]const u8) !void {
    if (value) |text| {
        const terminated = try std.testing.allocator.dupeZ(u8, text);
        defer std.testing.allocator.free(terminated);
        if (setenv(name.ptr, terminated.ptr, 1) != 0) return error.EnvironmentVariableSetFailed;
    } else if (unsetenv(name.ptr) != 0) return error.EnvironmentVariableUnsetFailed;
}

test "Aleo worker forwards explicit public consensus override into actual clean child and preserves absence" {
    const a = std.testing.allocator;
    const key = "CONSENSUS_VERSION_HEIGHTS";
    const foreign = "ZIGGY_COMPONENT_PRIVATE_SENTINEL";
    const prior = std.process.getEnvVarOwned(a, key) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (prior) |value| a.free(value);
    defer workerTestEnvironment(key, prior) catch @panic("restore public consensus environment");
    const prior_foreign = std.process.getEnvVarOwned(a, foreign) catch |err| switch (err) {
        error.EnvironmentVariableNotFound => null,
        else => return err,
    };
    defer if (prior_foreign) |value| a.free(value);
    defer workerTestEnvironment(foreign, prior_foreign) catch @panic("restore foreign fixture environment");
    try workerTestEnvironment(foreign, "PRIVATE_SENTINEL");
    const schedule = "0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,4294967291,4294967292,4294967293,4294967294,4294967295";
    const script =
        \\import os,struct,sys,json
        \\while True:
        \\ h=sys.stdin.buffer.read(4)
        \\ if not h:break
        \\ size=struct.unpack('>I',h)[0]
        \\ request=sys.stdin.buffer.read(size)
        \\ data=json.dumps({'consensus':os.environ.get('CONSENSUS_VERSION_HEIGHTS'),'foreign':any(k in os.environ for k in {'ZIGGY_COMPONENT_PRIVATE_SENTINEL','GH_TOKEN','AWS_SECRET_ACCESS_KEY','HOME','ALEO_SKIP_PROOFS','ALEO_CONSENSUS_VERSION_HEIGHTS'}),'parameter':os.environ.get('HYPERLANE_ALEO_PARAMETER_DIR')}).encode()
        \\ sys.stdout.buffer.write(struct.pack('>IB',len(data)+1,0)+data);sys.stdout.buffer.flush()
    ;
    const Snapshot = struct { consensus: ?[]const u8, foreign: bool, parameter: ?[]const u8 };
    for ([_]?[]const u8{ schedule, null }) |value| {
        try workerTestEnvironment(key, value);
        var session = try Session.spawn(a, &.{ "/usr/bin/python3", "-c", script }, .{ .timeout_ms = 5000, .parameter_home = "/tmp/ziggy-public-environment-component" });
        defer session.deinit();
        const reply = try session.exchange(.program_info, "public-environment-only");
        defer a.free(reply);
        const parsed = try std.json.parseFromSlice(Snapshot, a, reply, .{});
        defer parsed.deinit();
        if (value) |expected| try std.testing.expectEqualStrings(expected, parsed.value.consensus orelse return error.MissingPublicConsensusOverride) else try std.testing.expect(parsed.value.consensus == null);
        try std.testing.expect(!parsed.value.foreign);
        try std.testing.expectEqualStrings("/tmp/ziggy-public-environment-component/.aleo", parsed.value.parameter orelse return error.MissingParameterDirectory);
        session.child.stdin.?.close();
        session.child.stdin = null;
        const term = try session.child.wait();
        session.retired = true;
        try std.testing.expectEqual(std.process.Child.Term{ .Exited = 0 }, term);
        std.debug.print("ALEO_PUBLIC_ENV_COMPONENT forwarded={any} foreign=false actual_parent_wait=0\n", .{value != null});
    }
}
