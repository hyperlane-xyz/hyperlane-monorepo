//! Deterministic production Registry -> Factory -> Resources -> Replay races.
//! Latches only control scheduling; actual reads use native configured Pool I/O.
const std = @import("std");
const registry_mod = @import("../relayer/announced_readers.zig");
const Factory = @import("announcement_source.zig").Factory;
const source = @import("chain_source.zig");
const fixture = @import("../evm/pool_testing.zig");
const Engine = @import("../relayer/remote_checkpoints.zig").Engine;
const A = std.mem.Allocator;
const Address = [20]u8;

fn respond(a: A, body: []const u8) ![]u8 {
    const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer parsed.deinit();
    const method = parsed.value.object.get("method").?.string;
    const result = if (std.mem.eql(u8, method, "eth_chainId")) "0x1" else if (std.mem.eql(u8, method, "eth_call")) "0x" ++ "00" ** 31 ++ "20" ++ "00" ** 31 ++ "01" ++ "00" ** 31 ++ "20" ++ "00" ** 32 else return error.UnexpectedAnnouncementMethod;
    return std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = parsed.value.object.get("id").?, .result = result }, .{});
}

const Gate = struct {
    factory: *Factory,
    park_fetch: bool = true,
    park_pending_end: bool = false,
    park_success: bool = false,
    entered: std.atomic.Value(bool) = .init(false),
    resume_pass: std.atomic.Value(bool) = .init(false),
    cleanup_entered: std.atomic.Value(bool) = .init(false),
    cleanup_resume: std.atomic.Value(bool) = .init(false),
    begins: std.atomic.Value(usize) = .init(0),
    ends: std.atomic.Value(usize) = .init(0),
    cleanups: std.atomic.Value(usize) = .init(0),
    fetches: std.atomic.Value(usize) = .init(0),
    fn interface(self: *Gate) registry_mod.LocationSource {
        return .{ .context = self, .begin_pass_fn = begin, .end_pass_fn = end, .fetch_fn = fetch };
    }
    fn wait(flag: *const std.atomic.Value(bool)) !void {
        var timer = try std.time.Timer.start();
        while (!flag.load(.acquire)) {
            if (timer.read() > 5 * std.time.ns_per_s) return error.AnnouncementLatchTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
        }
    }
    fn begin(raw: *anyopaque, cancel: *const std.atomic.Value(bool)) !void {
        const self: *Gate = @ptrCast(@alignCast(raw));
        _ = self.begins.fetchAdd(1, .acq_rel);
        const actual = self.factory.interface();
        try actual.begin_pass_fn.?(actual.context, cancel);
    }
    fn end(raw: *anyopaque, failure: ?anyerror) void {
        const self: *Gate = @ptrCast(@alignCast(raw));
        _ = self.ends.fetchAdd(1, .acq_rel);
        const actual = self.factory.interface();
        if (self.park_pending_end and (if (failure) |err| err == error.RequestCancelled else false)) {
            _ = self.cleanups.fetchAdd(1, .acq_rel);
            self.cleanup_entered.store(true, .release);
            wait(&self.cleanup_resume) catch @panic("cleanup latch timed out");
        }
        actual.end_pass_fn.?(actual.context, failure);
        if (self.park_pending_end and (if (failure) |err| err == error.PendingReadIo else false) and !self.entered.swap(true, .acq_rel)) {
            wait(&self.resume_pass) catch @panic("pending pass latch timed out");
        }
    }
    fn fetch(raw: *anyopaque, a: A, validators: []const Address, cancel: ?*const std.atomic.Value(bool)) !registry_mod.Locations {
        const self: *Gate = @ptrCast(@alignCast(raw));
        if (self.park_fetch and self.fetches.fetchAdd(1, .acq_rel) == 0) {
            self.entered.store(true, .release);
            try wait(&self.resume_pass);
        }
        const actual = self.factory.interface();
        const result = try actual.fetch_fn(actual.context, a, validators, cancel);
        if (self.park_success and !self.entered.swap(true, .acq_rel)) try wait(&self.resume_pass);
        return result;
    }
};
const Call = struct {
    registry: *registry_mod.Registry,
    failure: ?anyerror = null,
    cancel: ?*const std.atomic.Value(bool) = null,
    retry_pending: bool = false,
    fn run(self: *Call) void {
        var timer = std.time.Timer.start() catch unreachable;
        while (true) {
            self.registry.ensureValidators(&.{.{1} ** 20}, self.cancel) catch |err| {
                if (err == error.PendingReadIo and self.retry_pending and timer.read() < 3 * std.time.ns_per_s) {
                    std.Thread.sleep(std.time.ns_per_ms);
                    continue;
                }
                self.failure = err;
            };
            return;
        }
    }
};
fn exercise(maintain: bool, cancellation: bool, caller_cancel: bool, deadline: bool) !void {
    const a = std.testing.allocator;
    const library = try fixture.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixture.Behavior{.{ .replies = &.{.{ .body = "" }}, .response_fn = respond }};
    var server = try fixture.Fixture.init(32, &behaviors);
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var chain = @import("chain_source_testing.zig").chainFor(&.{url});
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    var budget: source.ReadReplay.ByteBudget = .{ .maximum = 1024 * 1024 };
    const resources = try source.Resources.open(a, &chain, &env, .{ .curl_library = library, .cooperative_reads = true, .read_budget = &budget, .rpc_parallelism = 4, .rpc_max_response_bytes = 32768, .rpc_max_reserved_bytes = 2 * 1024 * 1024 });
    defer resources.deinit();
    var factory = Factory.init(resources);
    var gate: Gate = .{ .factory = &factory, .park_fetch = !cancellation and !caller_cancel and !deadline, .park_pending_end = cancellation, .park_success = caller_cancel or deadline };
    const engine = try Engine.start(a, .{ .multi = .{ .library_path = library } });
    defer engine.deinit();
    var registry = try registry_mod.Registry.initSource(a, gate.interface(), &resources.native, engine, .{ .domain = 1, .discovery_timeout_ms = if (deadline) 500 else 120000 });
    defer registry.deinit();
    var owner_cancel = std.atomic.Value(bool).init(false);
    var first: Call = .{ .registry = &registry, .cancel = if (caller_cancel) &owner_cancel else null, .retry_pending = caller_cancel or deadline };
    const thread = try std.Thread.spawn(.{}, Call.run, .{&first});
    var joined = false;
    defer if (!joined) {
        gate.resume_pass.store(true, .release);
        gate.cleanup_resume.store(true, .release);
        thread.join();
    };
    try Gate.wait(&gate.entered);
    if (deadline) {
        std.Thread.sleep(550 * std.time.ns_per_ms);
        gate.resume_pass.store(true, .release);
    } else if (caller_cancel) {
        // Actual Factory has produced owned locations, but Registry has not
        // installed them. A late original-caller cancellation must fence them.
        owner_cancel.store(true, .release);
        gate.resume_pass.store(true, .release);
    } else if (cancellation) {
        // Observe the complete native request before cancelling its retained
        // journal handle. The shared fixture intentionally treats an EOF before
        // request headers as a server failure; that unrelated socket race must
        // not replace the Registry cleanup handoff exercised here.
        var request_timer = try std.time.Timer.start();
        while (server.acceptedCount() == 0) {
            if (request_timer.read() > 3 * std.time.ns_per_s) return error.AnnouncementRequestNotObserved;
            std.Thread.sleep(std.time.ns_per_ms);
        }
        // A cancelled contender must signal the in-flight provider without
        // detaching/resetting it or letting a new frame reuse that context.
        var cancel = std.atomic.Value(bool).init(true);
        try std.testing.expectError(error.RequestCancelled, registry.ensureValidators(&.{.{1} ** 20}, &cancel));
        try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{.{2} ** 20}, null));
        gate.resume_pass.store(true, .release);
        // This hook runs from the old Active's final release. New callers must
        // still yield while its retained Replay cancellation cleanup is parked.
        try Gate.wait(&gate.cleanup_entered);
        try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{.{2} ** 20}, null));
        try std.testing.expectError(error.PendingReadIo, registry.maintain(null));
        try std.testing.expectEqual(@as(usize, 1), gate.begins.load(.acquire));
        gate.cleanup_resume.store(true, .release);
    } else {
        if (maintain) try std.testing.expectError(error.PendingReadIo, registry.maintain(null)) else try std.testing.expectError(error.PendingReadIo, registry.ensureValidators(&.{.{1} ** 20}, null));
        try std.testing.expectEqual(@as(usize, 1), gate.begins.load(.acquire));
        try std.testing.expectEqual(@as(usize, 0), gate.ends.load(.acquire));
        try std.testing.expect(resources.read_replay.?.in_pass);
        gate.resume_pass.store(true, .release);
    }
    thread.join();
    joined = true;
    try std.testing.expectEqual(@as(?anyerror, if (deadline) error.RequestDeadlineExceeded else if (cancellation or caller_cancel) error.RequestCancelled else error.PendingReadIo), first.failure);
    if (cancellation) try std.testing.expectEqual(@as(usize, 1), gate.cleanups.load(.acquire));
    if (caller_cancel or deadline) {
        try std.testing.expectEqual(@as(usize, 0), registry.cache.count());
        try std.testing.expect(!engine.hasReader(1, .{1} ** 20));
        try std.testing.expectEqual(@as(usize, 0), budget.used);
    }
    // Resume the retained callback (or a clean new frame after cancellation).
    // The actual typed producer must recover, not turn contention permanent.
    var timer = try std.time.Timer.start();
    while (true) {
        registry.ensureValidators(&.{.{1} ** 20}, null) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.AnnouncementResumeTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        break;
    }
    try std.testing.expect(registry.active == null);
    try std.testing.expect(!resources.read_replay.?.in_pass);
    try std.testing.expectEqual(@as(usize, 0), resources.read_replay.?.entries.items.len);
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try std.testing.expect(server.acceptedCount() >= 2);
    // Zero-TTL freshness remains: a separate completed job re-fetches locations.
    const before = server.acceptedCount();
    timer.reset();
    while (true) {
        registry.ensureValidators(&.{.{1} ** 20}, null) catch |err| {
            if (err != error.PendingReadIo) return err;
            if (timer.read() > 3 * std.time.ns_per_s) return error.AnnouncementFreshnessTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        break;
    }
    try std.testing.expectEqual(before + 1, server.acceptedCount());
    try server.check();
}
test "announcement replay one Registry serializes concurrent ensure callbacks through actual Factory Resources" {
    try exercise(false, false, false, false);
}
test "announcement replay maintenance yields while actual Factory Resources pass is owned" {
    try exercise(true, false, false, false);
}
test "announcement replay cancellation and detached-frame cleanup cannot race a new provider pass" {
    try exercise(false, true, false, false);
}

test "announcement replay original caller cancellation fences actual returned locations before install" {
    try exercise(false, false, true, false);
}

test "announcement replay absolute discovery deadline fences actual returned locations before install" {
    try exercise(false, false, false, true);
}
