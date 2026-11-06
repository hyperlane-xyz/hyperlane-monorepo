const std = @import("std");
const engine = @import("remote_checkpoints.zig");
const objects = @import("../storage/objects.zig");
const protocol = @import("../protocol/root.zig");
const quorum = @import("quorum.zig");
const A = std.mem.Allocator;
const Fixture = struct {
    server: std.net.Server,
    values: []const []const u8,
    slow: usize = 0,
    flagged: ?usize = null,
    failed_guard: ?usize = null,
    guards: std.atomic.Value(usize) = .init(0),
    reads: std.atomic.Value(usize) = .init(0),
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,
    fn serve(self: *Fixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *Fixture) !void {
        var retained: [256]std.net.Stream = undefined;
        var held: usize = 0;
        defer for (retained[0..held]) |stream| stream.close();
        var timer = try std.time.Timer.start();
        requests: while (!self.stop.load(.acquire)) {
            if (timer.read() > 8 * std.time.ns_per_s) return error.FixtureTimeout;
            var fd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fd, 10) == 0) continue;
            const connection = try self.server.accept();
            var transferred = false;
            defer if (!transferred) connection.stream.close();
            var input: [4096]u8 = undefined;
            var used: usize = 0;
            while (std.mem.indexOf(u8, input[0..used], "\r\n\r\n") == null) {
                if (timer.read() > 8 * std.time.ns_per_s or self.stop.load(.acquire) or used == input.len) return error.FixtureReadTimeout;
                var read_fd = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&read_fd, 10) == 0) continue;
                const got = connection.stream.read(input[used..]) catch continue :requests;
                if (got == 0) continue :requests;
                used += got;
            }
            var words = std.mem.tokenizeScalar(u8, input[0..used], ' ');
            try std.testing.expectEqualStrings("GET", words.next().?);
            const path = words.next().?;
            if (!std.mem.startsWith(u8, path, "/peer-")) return error.FixtureWrongPath;
            const slash = std.mem.indexOfScalarPos(u8, path, 6, '/') orelse return error.FixtureWrongPath;
            const peer = try std.fmt.parseInt(usize, path[6..slash], 10);
            if (peer >= self.values.len) return error.FixtureWrongPeer;
            const name = path[slash + 1 ..];
            var status: []const u8 = "200 OK";
            var body: []const u8 = undefined;
            if (std.mem.eql(u8, name, "reorg_flag.json")) {
                _ = self.guards.fetchAdd(1, .release);
                if (self.flagged == peer) {
                    // Two valid peers are ready before the third malformed flag.
                    std.Thread.sleep(40 * std.time.ns_per_ms);
                    body = "malformed but authoritative flag";
                } else if (self.failed_guard == peer) {
                    status = "503 Unavailable";
                    body = "unreadable";
                } else {
                    status = "404 Not Found";
                    body = "<Code>NoSuchKey</Code>";
                }
            } else {
                if (self.guards.load(.acquire) != self.values.len) return error.CheckpointStartedBeforeGlobalGuard;
                _ = self.reads.fetchAdd(1, .release);
                if (std.mem.eql(u8, name, "checkpoint_latest_index.json")) body = "3" else if (std.mem.eql(u8, name, "checkpoint_3_with_id.json")) {
                    if (peer < self.slow) {
                        retained[held] = connection.stream;
                        held += 1;
                        transferred = true;
                        continue;
                    }
                    body = self.values[peer];
                } else return error.FixtureWrongObjectName;
            }
            var header: [160]u8 = undefined;
            const response = try std.fmt.bufPrint(&header, "HTTP/1.1 {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ status, body.len });
            connection.stream.writeAll(response) catch continue;
            connection.stream.writeAll(body) catch {};
        }
    }
};
fn nativeLibrary(a: A) ![]u8 {
    return std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => error.SkipZigTest,
        else => err,
    };
}
fn checkpoint(domain: u32) protocol.Checkpoint {
    return .{ .mailbox_domain = domain, .merkle_tree_hook_address = @splat(1), .root = @splat(2), .index = 3, .message_id = @splat(4) };
}
fn signed(a: A, domain: u32, count: usize, validators: []engine.Address) ![][]const u8 {
    const values = try a.alloc([]const u8, count);
    for (values, validators, 0..) |*value, *validator, index| {
        const key: [32]u8 = @splat(@as(u8, @intCast(index + 1)));
        const object = try objects.SignedCheckpoint.sign(checkpoint(domain), key, null);
        validator.* = try object.recover();
        value.* = try object.toJson(a);
    }
    return values;
}
fn register(e: *engine.Engine, a: A, fixture: *Fixture, domain: u32, validators: []const engine.Address, ignore: bool) !void {
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{fixture.server.listen_address.getPort()});
    defer a.free(endpoint);
    for (validators, 0..) |validator, index| {
        const bucket = try std.fmt.allocPrint(a, "peer-{d}", .{index});
        defer a.free(bucket);
        try e.register(.{ .origin = domain, .validator = validator, .location_id = @splat(@as(u8, @intCast(index))), .backend = .{ .s3 = .{ .endpoint = endpoint, .bucket = bucket, .region = "fixture" } }, .ignore_reorg_reports = ignore });
    }
}
test "remote checkpoint engine fans out beyond eight stalled peers and checks every guard first" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [16]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 16, &validators);
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .slow = 8 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 32 }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    try register(e, a, &fixture, 1, &validators, false);
    var errors: usize = 0;
    var timer = try std.time.Timer.start();
    var result = (try e.fetchQuorum(1, a, &validators, 2, 3, &errors, null)).?;
    defer result.deinit();
    try std.testing.expectEqual(@as(u32, 1), result.checkpoint.mailbox_domain);
    try std.testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try std.testing.expectEqual(@as(usize, 16), fixture.guards.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), errors);
    fixture.guards.store(0, .release);
    var latest: [16]?u32 = undefined;
    try e.latestIndices(1, &validators, &latest, &errors, null);
    for (latest) |value| try std.testing.expectEqual(@as(?u32, 3), value);
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}
test "remote checkpoint global guard rejects a late malformed flag and ignore skips its data" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [3]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 3, &validators);
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .flagged = 2 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    try register(e, a, &fixture, 1, &validators, false);
    var errors: usize = 0;
    try std.testing.expectError(error.ValidatorReorg, e.fetchQuorum(1, a, &validators, 2, 3, &errors, null));
    try std.testing.expectEqual(@as(usize, 0), fixture.reads.load(.acquire));
    // Reset guard counters only after all former calls completed. The registry
    // replacement itself can occur while owner cleanup still drains cancellation.
    fixture.guards.store(0, .release);
    try register(e, a, &fixture, 1, &validators, true);
    var result = (try e.fetchQuorum(1, a, &validators, 2, 3, &errors, null)).?;
    defer result.deinit();
    try std.testing.expectEqual(@as(usize, 2), result.signatures.len);
    try std.testing.expectEqual(@as(usize, 2), fixture.reads.load(.acquire));
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}

const DiskReader = struct {
    value: objects.SignedCheckpoint,
    references: std.atomic.Value(usize) = .init(0),
    entered: std.atomic.Value(bool) = .init(false),
    release_guard: std.atomic.Value(bool) = .init(true),
    flagged: bool = false,
    fetches: std.atomic.Value(usize) = .init(0),
    fn interface(self: *DiskReader, domain: u32) !@import("checkpoint_pool.zig").Reader {
        return .{ .origin = domain, .validator = try self.value.recover(), .context = self, .retain = retain, .release = release, .validate = validate, .fetch = fetch, .latest = latest };
    }
    fn retain(context: *anyopaque) void {
        const self: *DiskReader = @ptrCast(@alignCast(context));
        _ = self.references.fetchAdd(1, .acq_rel);
    }
    fn release(context: *anyopaque) void {
        const self: *DiskReader = @ptrCast(@alignCast(context));
        _ = self.references.fetchSub(1, .acq_rel);
    }
    fn validate(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *DiskReader = @ptrCast(@alignCast(context));
        self.entered.store(true, .release);
        var timer = try std.time.Timer.start();
        while (!self.release_guard.load(.acquire)) {
            if (cancel.load(.acquire)) return error.RequestCancelled;
            if (timer.read() > 3 * std.time.ns_per_s) return error.FixtureGuardTimeout;
            std.Thread.sleep(100 * std.time.ns_per_us);
        }
        if (self.flagged) return error.ValidatorReorg;
    }
    fn fetch(context: *anyopaque, _: u32, cancel: *const std.atomic.Value(bool)) !?objects.SignedCheckpoint {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        const self: *DiskReader = @ptrCast(@alignCast(context));
        _ = self.fetches.fetchAdd(1, .acq_rel);
        return self.value;
    }
    fn latest(context: *anyopaque, cancel: *const std.atomic.Value(bool)) !?u32 {
        if (cancel.load(.acquire)) return error.RequestCancelled;
        return @as(*DiskReader, @ptrCast(@alignCast(context))).value.value.index;
    }
};
const Caller = struct {
    e: *engine.Engine,
    domain: u32,
    validators: []const engine.Address,
    threshold: usize,
    cancel: ?*const std.atomic.Value(bool) = null,
    errors: usize = 0,
    result: anyerror!?quorum.Quorum = error.CallerNotStarted,
    fn run(self: *Caller) void {
        self.result = self.e.fetchQuorum(self.domain, std.testing.allocator, self.validators, self.threshold, 3, &self.errors, self.cancel);
    }
};
fn waitFlag(flag: *const std.atomic.Value(bool)) !void {
    var timer = try std.time.Timer.start();
    while (!flag.load(.acquire)) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureFlagTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}
test "remote checkpoint snapshots retain local reader across registry rotation and combine local remote quorum" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [2]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 2, &validators);
    var disk: DiskReader = .{ .value = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(2), null) };
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values[0..1] };
    defer fixture.server.deinit();
    const fixture_thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    var fixture_joined = false;
    defer if (!fixture_joined) {
        fixture.stop.store(true, .release);
        fixture_thread.join();
    };
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    var destroyed = false;
    defer if (!destroyed) e.deinit();
    try register(e, a, &fixture, 1, validators[0..1], false);
    try e.registerLocal(try disk.interface(1));
    var errors: usize = 0;
    var selected = (try e.fetchQuorum(1, a, &validators, 2, 3, &errors, null)).?;
    defer selected.deinit();
    try std.testing.expectEqual(@as(usize, 2), selected.signatures.len);
    // A separate local-only request freezes the old guarded location, then the
    // registry changes to a flagged location while the old guard is in flight.
    disk.entered.store(false, .release);
    disk.release_guard.store(false, .release);
    var caller: Caller = .{ .e = e, .domain = 1, .validators = validators[1..2], .threshold = 1 };
    const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    var joined = false;
    defer if (!joined) {
        disk.release_guard.store(true, .release);
        thread.join();
    };
    try waitFlag(&disk.entered);
    var replacement: DiskReader = .{ .value = disk.value, .flagged = true };
    try e.registerLocal(try replacement.interface(1));
    disk.release_guard.store(true, .release);
    thread.join();
    joined = true;
    var old = (try caller.result).?;
    defer old.deinit();
    try std.testing.expectEqualDeep(disk.value.value, old.checkpoint);
    try std.testing.expectError(error.ValidatorReorg, e.fetchQuorum(1, a, validators[1..2], 1, 3, &errors, null));
    fixture.stop.store(true, .release);
    fixture_thread.join();
    fixture_joined = true;
    e.deinit();
    destroyed = true;
    try std.testing.expectEqual(@as(usize, 0), disk.references.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), replacement.references.load(.acquire));
    if (fixture.failure) |err| return err;
}
test "remote checkpoint engine serves concurrent origins and cancels one without poisoning later sessions" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [4]engine.Address = undefined;
    const slow_values = try signed(arena.allocator(), 1, 4, &validators);
    const fast_values = try signed(arena.allocator(), 2, 4, &validators);
    var slow: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = slow_values, .slow = 4 };
    defer slow.server.deinit();
    var fast: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = fast_values };
    defer fast.server.deinit();
    const st = try std.Thread.spawn(.{}, Fixture.serve, .{&slow});
    const ft = try std.Thread.spawn(.{}, Fixture.serve, .{&fast});
    var fixtures_joined = false;
    defer if (!fixtures_joined) {
        slow.stop.store(true, .release);
        fast.stop.store(true, .release);
        st.join();
        ft.join();
    };
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 32 }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    try register(e, a, &slow, 1, &validators, false);
    try register(e, a, &fast, 2, &validators, false);
    var cancel = std.atomic.Value(bool).init(false);
    var waiting: Caller = .{ .e = e, .domain = 1, .validators = &validators, .threshold = 2, .cancel = &cancel };
    var healthy: Caller = .{ .e = e, .domain = 2, .validators = &validators, .threshold = 2 };
    const wt = try std.Thread.spawn(.{}, Caller.run, .{&waiting});
    const ht = try std.Thread.spawn(.{}, Caller.run, .{&healthy});
    var callers_joined = false;
    defer if (!callers_joined) {
        cancel.store(true, .release);
        wt.join();
        ht.join();
    };
    ht.join();
    var healthy_result = (try healthy.result).?;
    defer healthy_result.deinit();
    try std.testing.expectEqual(@as(u32, 2), healthy_result.checkpoint.mailbox_domain);
    var timer = try std.time.Timer.start();
    while (slow.reads.load(.acquire) == 0) {
        if (timer.read() > 2 * std.time.ns_per_s) return error.FixtureReadTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    cancel.store(true, .release);
    wt.join();
    callers_joined = true;
    try std.testing.expectError(error.RequestCancelled, waiting.result);
    fast.guards.store(0, .release);
    var errors: usize = 0;
    var later = (try e.fetchQuorum(2, a, &validators, 2, 3, &errors, null)).?;
    defer later.deinit();
    try std.testing.expectEqual(@as(u32, 2), later.checkpoint.mailbox_domain);
    slow.stop.store(true, .release);
    fast.stop.store(true, .release);
    st.join();
    ft.join();
    fixtures_joined = true;
    if (slow.failure) |err| return err;
    if (fast.failure) |err| return err;
}

const Step = struct { path: []const u8, status: []const u8, body: []const u8 };
const GcsFixture = struct {
    server: std.net.Server,
    steps: []const Step,
    failure: ?anyerror = null,
    fn serve(self: *GcsFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }
    fn run(self: *GcsFixture) !void {
        for (self.steps) |step| {
            var pollfd = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&pollfd, 3000) == 0) return error.FixtureAcceptTimeout;
            const connection = try self.server.accept();
            defer connection.stream.close();
            var buffer: [4096]u8 = undefined;
            var used: usize = 0;
            var timer = try std.time.Timer.start();
            while (std.mem.indexOf(u8, buffer[0..used], "\r\n\r\n") == null) {
                if (used == buffer.len or timer.read() > 3 * std.time.ns_per_s) return error.FixtureReadTimeout;
                var ready = [_]std.posix.pollfd{.{ .fd = connection.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
                if (try std.posix.poll(&ready, 20) == 0) continue;
                const got = try connection.stream.read(buffer[used..]);
                if (got == 0) return error.FixtureUnexpectedEof;
                used += got;
            }
            var words = std.mem.tokenizeScalar(u8, buffer[0..used], ' ');
            try std.testing.expectEqualStrings("GET", words.next().?);
            try std.testing.expectEqualStrings(step.path, words.next().?);
            var found = false;
            var lines = std.mem.splitSequence(u8, buffer[0..used], "\r\n");
            while (lines.next()) |line| {
                if (std.ascii.startsWithIgnoreCase(line, "authorization:")) {
                    try std.testing.expect(!found);
                    found = true;
                    try std.testing.expectEqualStrings("Bearer owned-token", std.mem.trim(u8, line[14..], " \t"));
                }
            }
            try std.testing.expect(found);
            const header = try std.fmt.allocPrint(std.testing.allocator, "HTTP/1.1 {s}\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{ step.status, step.body.len });
            defer std.testing.allocator.free(header);
            try connection.stream.writeAll(header);
            try connection.stream.writeAll(step.body);
        }
    }
};
test "remote checkpoint GCS preserves legacy root guard folder keys owned bearer and canonical latest objects" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    const object = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(1), null);
    const encoded = try object.toJson(a);
    defer a.free(encoded);
    const prefix = "/storage/v1/b/fixture-bucket/o/";
    const steps = [_]Step{
        .{ .path = prefix ++ "gcsReorgFlagKey?alt=media", .status = "404 Not Found", .body = "missing" },
        .{ .path = prefix ++ "folder%2FgcsReorgFlagKey?alt=media", .status = "404 Not Found", .body = "missing" },
        .{ .path = prefix ++ "folder%2Fcheckpoint_3_with_id.json?alt=media", .status = "200 OK", .body = encoded },
        .{ .path = prefix ++ "gcsReorgFlagKey?alt=media", .status = "404 Not Found", .body = "missing" },
        .{ .path = prefix ++ "folder%2FgcsReorgFlagKey?alt=media", .status = "404 Not Found", .body = "missing" },
        .{ .path = prefix ++ "folder%2FgcsLatestIndexKey?alt=media", .status = "200 OK", .body = "3" },
        .{ .path = prefix ++ "gcsReorgFlagKey?alt=media", .status = "200 OK", .body = "invalid JSON still a flag" },
    };
    var fixture: GcsFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .steps = &steps };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, GcsFixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) thread.join();
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{fixture.server.listen_address.getPort()});
    defer a.free(endpoint);
    var folder = "folder/".*;
    var bearer = "owned-token".*;
    const validator = try object.recover();
    try e.register(.{ .origin = 1, .validator = validator, .location_id = @splat(1), .backend = .{ .gcs = .{ .endpoint = endpoint, .bucket = "fixture-bucket", .folder = &folder, .bearer_token = &bearer } } });
    try std.testing.expect(e.hasLocation(1, validator, @splat(1)));
    try std.testing.expect(!e.hasLocation(1, validator, @splat(2)));
    @memset(&folder, 'x');
    @memset(&bearer, 'x');
    var errors: usize = 0;
    var selected = (try e.fetchQuorum(1, a, &.{validator}, 1, 3, &errors, null)).?;
    defer selected.deinit();
    var latest: [1]?u32 = undefined;
    try e.latestIndices(1, &.{validator}, &latest, &errors, null);
    try std.testing.expectEqual(@as(?u32, 3), latest[0]);
    try std.testing.expectError(error.ValidatorReorg, e.fetchQuorum(1, a, &.{validator}, 1, 3, &errors, null));
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}

test "remote checkpoint unreadable guards skip peers and deadline cancellation releases running disk snapshots" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 80 });
    var destroyed = false;
    defer if (!destroyed) e.deinit();
    var good: DiskReader = .{ .value = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(1), null) };
    var bad: DiskReader = .{ .value = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(2), null) };
    var bad_reader = try bad.interface(1);
    bad_reader.validate = struct {
        fn fail(_: *anyopaque, _: *const std.atomic.Value(bool)) !void {
            return error.GuardUnavailable;
        }
    }.fail;
    try e.registerLocal(try good.interface(1));
    try e.registerLocal(bad_reader);
    const validators = [_]engine.Address{ try good.value.recover(), try bad.value.recover() };
    var errors: usize = 0;
    var selected = (try e.fetchQuorum(1, a, &validators, 1, 3, &errors, null)).?;
    defer selected.deinit();
    try std.testing.expectEqual(@as(usize, 1), errors);
    good.release_guard.store(false, .release);
    good.entered.store(false, .release);
    try std.testing.expectEqual(@as(?quorum.Quorum, null), try e.fetchQuorum(1, a, validators[0..1], 1, 3, &errors, null));
    try std.testing.expect(errors >= 2);
    e.deinit();
    destroyed = true;
    try std.testing.expectEqual(@as(usize, 0), good.references.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), bad.references.load(.acquire));
}

fn allocationExercise(allocator: A, library: []const u8, object: objects.SignedCheckpoint) !void {
    // Failure injection itself is serialized: Engine's production contract is a
    // thread-safe allocator, including during callbacks and final ref cleanup.
    var synchronized: std.heap.ThreadSafeAllocator = .{ .child_allocator = allocator };
    const a = synchronized.allocator();
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library, .max_pending = 4, .max_concurrent = 4 }, .max_readers = 4, .max_sessions = 2 });
    defer e.deinit();
    try e.register(.{ .origin = 2, .validator = try object.recover(), .location_id = @splat(9), .backend = .{ .gcs = .{ .endpoint = "https://example.invalid", .bucket = "fixture-bucket", .folder = "owned/folder", .bearer_token = "fixture-token" } } });
    var reader: DiskReader = .{ .value = object };
    try e.registerLocal(try reader.interface(1));
    var errors: usize = 0;
    var latest: [1]?u32 = undefined;
    try e.latestIndices(1, &.{try object.recover()}, &latest, &errors, null);
    try std.testing.expectEqual(@as(?u32, 3), latest[0]);
}
test "remote checkpoint engine partial allocation failures release registries sessions and native owners" {
    const library = try nativeLibrary(std.testing.allocator);
    defer std.testing.allocator.free(library);
    const object = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(1), null);
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{ library, object });
}

test "remote checkpoint ordered fallback skips ignored flags unreadable and invalid candidates before one guarded fetch" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [1]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 1, &validators);
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{fixture.server.listen_address.getPort()});
    defer a.free(endpoint);
    var flagged: DiskReader = .{ .value = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(1), null), .flagged = true };
    var flagged_reader = try flagged.interface(1);
    flagged_reader.ignore_reorg_reports = true;
    flagged_reader.location_id = @splat(0xaa);
    var unreadable: DiskReader = .{ .value = flagged.value };
    var unreadable_reader = try unreadable.interface(1);
    unreadable_reader.validate = struct {
        fn fail(_: *anyopaque, _: *const std.atomic.Value(bool)) !void {
            return error.GuardUnreadable;
        }
    }.fail;
    const remote: engine.RemoteReader = .{ .origin = 1, .validator = validators[0], .location_id = @splat(0xbb), .backend = .{ .s3 = .{ .endpoint = endpoint, .bucket = "peer-0", .region = "fixture" } } };
    var invalid = remote;
    invalid.backend.s3.bucket = "!invalid";
    try e.registerLocations(1, validators[0], &.{ .{ .disk = flagged_reader }, .{ .remote = invalid }, .{ .disk = unreadable_reader }, .{ .remote = remote } });
    try std.testing.expect(e.hasLocation(1, validators[0], @splat(0xaa)));
    var errors: usize = 0;
    var selected = (try e.fetchQuorum(1, a, &validators, 1, 3, &errors, null)).?;
    defer selected.deinit();
    try std.testing.expectEqual(@as(usize, 1), errors);
    try std.testing.expectEqual(@as(usize, 1), fixture.reads.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), flagged.fetches.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), unreadable.fetches.load(.acquire));
    flagged_reader.ignore_reorg_reports = false;
    try e.registerLocations(1, validators[0], &.{ .{ .disk = flagged_reader }, .{ .remote = remote } });
    try std.testing.expectError(error.ValidatorReorg, e.fetchQuorum(1, a, &validators, 1, 3, &errors, null));
    try std.testing.expectEqual(@as(usize, 1), fixture.reads.load(.acquire));
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
}
test "remote checkpoint empty location registration removes cache while an in-flight snapshot remains valid" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var reader: DiskReader = .{ .value = try objects.SignedCheckpoint.sign(checkpoint(1), @splat(1), null), .release_guard = .init(false) };
    const validator = try reader.value.recover();
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000 });
    var destroyed = false;
    defer if (!destroyed) e.deinit();
    try e.registerLocal(try reader.interface(1));
    var caller: Caller = .{ .e = e, .domain = 1, .validators = &.{validator}, .threshold = 1 };
    const thread = try std.Thread.spawn(.{}, Caller.run, .{&caller});
    var joined = false;
    defer if (!joined) {
        reader.release_guard.store(true, .release);
        thread.join();
    };
    try waitFlag(&reader.entered);
    try e.registerLocations(1, validator, &.{});
    try std.testing.expect(!e.hasReader(1, validator));
    reader.release_guard.store(true, .release);
    thread.join();
    joined = true;
    var selected = (try caller.result).?;
    defer selected.deinit();
    var errors: usize = 0;
    try std.testing.expectEqual(@as(?quorum.Quorum, null), try e.fetchQuorum(1, a, &.{validator}, 1, 3, &errors, null));
    e.deinit();
    destroyed = true;
    try std.testing.expectEqual(@as(usize, 0), reader.references.load(.acquire));
}

test "remote checkpoint async retained request polls without blocking beyond eight stalled peers and owns validator IDs" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [16]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 16, &validators);
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .slow = 8 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer {
        fixture.stop.store(true, .release);
        thread.join();
    }
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 32 }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    try register(e, a, &fixture, 1, &validators, false);
    var borrowed = validators;
    const request = try e.submitQuorum(1, a, &borrowed, 2, 3);
    defer request.deinit();
    @memset(&borrowed, .{0} ** 20);
    var timer = try std.time.Timer.start();
    var pending: usize = 0;
    var result: ?quorum.Quorum = null;
    while (true) {
        switch (try request.poll(null)) {
            .pending => pending += 1,
            .quorum => |found| {
                result = found;
                break;
            },
            .latest => return error.WrongReadKind,
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.AsyncQuorumStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    defer if (result) |*found| found.deinit();
    try std.testing.expect(result != null);
    try std.testing.expect(pending > 0);
    try std.testing.expectEqual(@as(usize, 16), fixture.guards.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), request.storage_errors);
    try std.testing.expectError(error.RemoteReadAlreadyConsumed, request.poll(null));
    fixture.guards.store(0, .release);
    const latest = try e.submitLatest(1, &validators);
    defer latest.deinit();
    while (true) {
        switch (try latest.poll(null)) {
            .pending => {},
            .latest => |indices| {
                for (indices) |value| try std.testing.expectEqual(@as(?u32, 3), value);
                break;
            },
            .quorum => return error.WrongReadKind,
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.AsyncLatestStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), latest.storage_errors);
}

test "remote checkpoint async request preserves global flag barrier and cancellation consumes once" {
    const a = std.testing.allocator;
    const library = try nativeLibrary(a);
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [3]engine.Address = undefined;
    const values = try signed(arena.allocator(), 1, 3, &validators);
    var fixture: Fixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .flagged = 2 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, Fixture.serve, .{&fixture});
    defer {
        fixture.stop.store(true, .release);
        thread.join();
    }
    const e = try engine.Engine.start(a, .{ .multi = .{ .library_path = library }, .timeout_ms = 3000, .allow_insecure_loopback = true });
    defer e.deinit();
    try register(e, a, &fixture, 1, &validators, false);
    const request = try e.submitQuorum(1, a, &validators, 2, 3);
    defer request.deinit();
    var timer = try std.time.Timer.start();
    while (true) {
        if (request.poll(null)) |value| {
            if (value != .pending) return error.UncheckedQuorumAccepted;
        } else |err| {
            try std.testing.expectEqual(error.ValidatorReorg, err);
            break;
        }
        if (timer.read() > 2 * std.time.ns_per_s) return error.AsyncGuardStarved;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    try std.testing.expectEqual(@as(usize, 0), fixture.reads.load(.acquire));
    try std.testing.expectError(error.RemoteReadAlreadyConsumed, request.poll(null));
    const cancelled = try e.submitLatest(1, &validators);
    defer cancelled.deinit();
    var cancel = std.atomic.Value(bool).init(true);
    try std.testing.expectError(error.RequestCancelled, cancelled.poll(&cancel));
    try std.testing.expectError(error.RemoteReadAlreadyConsumed, cancelled.poll(&cancel));
}
