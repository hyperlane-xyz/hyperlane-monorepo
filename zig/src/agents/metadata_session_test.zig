const std = @import("std");
const session_module = @import("metadata_session.zig");
const origin_module = @import("origin.zig");
const metadata = @import("../relayer/metadata.zig");
const parallel = @import("../relayer/metadata_parallel.zig");
const protocol = @import("../protocol/root.zig");
const objects = @import("../storage/objects.zig");
const remote = @import("../relayer/remote_checkpoints.zig");
const quorum = @import("../relayer/quorum.zig");
const observability = @import("../ops/validator_observability.zig");
const metrics = @import("../ops/metrics.zig");
const A = std.mem.Allocator;
const Address = [20]u8;

const FakeOrigin = struct {
    allocator: A,
    domain: u32 = 1,
    checkpoint_pool: ?*remote.Engine = null,
    discovery: ?origin_module.Origin.Discovery = null,
    ensure_calls: usize = 0,

    pub fn leafIndex(_: *FakeOrigin, _: [32]u8) !?u32 {
        return 0;
    }
    pub fn highestKnownLeafIndex(_: *FakeOrigin) !?u32 {
        return 0;
    }
    pub fn proof(_: *FakeOrigin, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
};

fn ensureOnce(context: *anyopaque, _: []const Address, _: ?*const std.atomic.Value(bool)) anyerror!void {
    const origin: *FakeOrigin = @ptrCast(@alignCast(context));
    origin.ensure_calls += 1;
    if (origin.ensure_calls == 1) return error.PendingReadIo;
}

test "checkpoint session retains completed discovery and no-pool results per attempt" {
    const a = std.testing.allocator;
    var origin: FakeOrigin = .{ .allocator = a };
    origin.discovery = .{ .context = &origin, .ensure = ensureOnce };
    var cancel = std.atomic.Value(bool).init(false);
    var session = session_module.Session(FakeOrigin).init(a, &origin, &cancel);
    defer session.deinit();
    var errors: usize = 0;
    try session.beginPass(&cancel);
    try std.testing.expectError(error.PendingReadIo, session.fetchQuorum(a, &.{@splat(1)}, 1, 0, &errors));
    session.endPass(error.PendingReadIo);
    try session.beginPass(&cancel);
    try std.testing.expect((try session.fetchQuorum(a, &.{@splat(1)}, 1, 0, &errors)) == null);
    session.endPass(error.PendingReadIo);
    try session.beginPass(&cancel);
    try std.testing.expect((try session.fetchQuorum(a, &.{@splat(1)}, 1, 0, &errors)) == null);
    session.endPass(null);
    try std.testing.expectEqual(@as(usize, 2), origin.ensure_calls);
    try session.beginPass(&cancel);
    try std.testing.expect((try session.fetchQuorum(a, &.{@splat(1)}, 1, 0, &errors)) == null);
    session.endPass(null);
    try std.testing.expectEqual(@as(usize, 3), origin.ensure_calls);
    var latest: [1]?u32 = undefined;
    try session.beginPass(&cancel);
    try session.fetchLatestIndices(&.{@splat(1)}, &latest, &errors);
    session.endPass(null);
    try std.testing.expectEqual(@as(?u32, null), latest[0]);
}

fn allocationExercise(a: A) !void {
    var origin: FakeOrigin = .{ .allocator = a };
    var cancel = std.atomic.Value(bool).init(false);
    var session = session_module.Session(FakeOrigin).init(a, &origin, &cancel);
    defer session.deinit();
    var errors: usize = 0;
    var latest: [2]?u32 = undefined;
    try session.beginPass(&cancel);
    try session.fetchLatestIndices(&.{ @splat(1), @splat(2) }, &latest, &errors);
    session.endPass(null);
}

test "checkpoint session allocation failures preserve ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationExercise, .{});
}

test "checkpoint session shared byte quota fails closed and releases" {
    const a = std.testing.allocator;
    var origin: FakeOrigin = .{ .allocator = a };
    var cancel = std.atomic.Value(bool).init(false);
    var session = session_module.Session(FakeOrigin).init(a, &origin, &cancel);
    defer session.deinit();
    var shared: @import("../net/byte_budget.zig").Budget = .{ .maximum = 4 };
    session.shared_budget = &shared;
    var errors: usize = 0;
    var latest: [2]?u32 = undefined;
    try session.beginPass(&cancel);
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, session.fetchLatestIndices(&.{ @splat(1), @splat(2) }, &latest, &errors));
    session.endPass(null);
    try std.testing.expectEqual(@as(usize, 0), shared.used);
}

const RemoteFixture = struct {
    server: std.net.Server,
    values: []const []const u8,
    slow: usize,
    failed_guard: ?usize = null,
    guards: std.atomic.Value(usize) = .init(0),
    checkpoint_reads: std.atomic.Value(usize) = .init(0),
    checkpoint_reads_by_peer: [256]std.atomic.Value(usize) = [_]std.atomic.Value(usize){.init(0)} ** 256,
    latest_reads: std.atomic.Value(usize) = .init(0),
    stop: std.atomic.Value(bool) = .init(false),
    failure: ?anyerror = null,

    fn serve(self: *RemoteFixture) void {
        self.run() catch |err| {
            self.failure = err;
        };
    }

    fn run(self: *RemoteFixture) !void {
        var retained: [256]std.net.Stream = undefined;
        var held: usize = 0;
        defer for (retained[0..held]) |stream| stream.close();
        connections: while (!self.stop.load(.acquire)) {
            var descriptor = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&descriptor, 10) == 0) continue;
            const connection = try self.server.accept();
            var transferred = false;
            defer if (!transferred) connection.stream.close();
            var input: [4096]u8 = undefined;
            var used: usize = 0;
            while (std.mem.indexOf(u8, input[0..used], "\r\n\r\n") == null) {
                if (used == input.len) return error.FixtureRequestTooLarge;
                const count = try connection.stream.read(input[used..]);
                if (count == 0) {
                    // Cancellation may close an accepted socket before curl
                    // sends any headers. A partial request remains malformed.
                    if (used == 0) continue :connections;
                    return error.FixtureUnexpectedEof;
                }
                used += count;
            }
            var words = std.mem.tokenizeScalar(u8, input[0..used], ' ');
            if (!std.mem.eql(u8, words.next().?, "GET")) return error.FixtureWrongMethod;
            const path = words.next().?;
            const slash = std.mem.indexOfScalarPos(u8, path, 6, '/') orelse return error.FixtureWrongPath;
            const peer = try std.fmt.parseInt(usize, path[6..slash], 10);
            if (peer >= self.values.len or peer >= self.checkpoint_reads_by_peer.len) return error.FixtureWrongPeer;
            const name = path[slash + 1 ..];
            var status: []const u8 = "200 OK";
            var body: []const u8 = undefined;
            if (std.mem.eql(u8, name, "reorg_flag.json")) {
                _ = self.guards.fetchAdd(1, .acq_rel);
                if (self.failed_guard == peer) {
                    status = "503 Unavailable";
                    body = "unreadable";
                } else {
                    status = "404 Not Found";
                    body = "<Code>NoSuchKey</Code>";
                }
            } else {
                if (self.guards.load(.acquire) < self.values.len) return error.CheckpointStartedBeforeGlobalGuard;
                if (std.mem.eql(u8, name, "checkpoint_latest_index.json")) {
                    _ = self.latest_reads.fetchAdd(1, .acq_rel);
                    body = "3";
                } else if (std.mem.eql(u8, name, "checkpoint_3_with_id.json")) {
                    _ = self.checkpoint_reads.fetchAdd(1, .acq_rel);
                    _ = self.checkpoint_reads_by_peer[peer].fetchAdd(1, .acq_rel);
                    if (peer < self.slow) {
                        if (held == retained.len) return error.FixtureTooManyStalls;
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
            try connection.stream.writeAll(response);
            try connection.stream.writeAll(body);
        }
    }
};

test "metadata remote fixture serves a real request after a canceled preheader connection" {
    var fixture: RemoteFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = &.{"unused"}, .slow = 0 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, RemoteFixture.serve, .{&fixture});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    const abandoned = try std.net.tcpConnectToAddress(fixture.server.listen_address);
    abandoned.close();
    const client = try std.net.tcpConnectToAddress(fixture.server.listen_address);
    defer client.close();
    try client.writeAll("GET /peer/0/reorg_flag.json HTTP/1.1\r\nHost: fixture\r\n\r\n");
    var response: [512]u8 = undefined;
    var used: usize = 0;
    var timer = try std.time.Timer.start();
    while (used < response.len and timer.read() < 2 * std.time.ns_per_s) {
        var descriptors = [_]std.posix.pollfd{.{ .fd = client.handle, .events = std.posix.POLL.IN, .revents = 0 }};
        if (try std.posix.poll(&descriptors, 10) == 0) continue;
        const count = try client.read(response[used..]);
        if (count == 0) break;
        used += count;
    }
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    if (fixture.failure) |err| return err;
    try std.testing.expect(std.mem.startsWith(u8, response[0..used], "HTTP/1.1 404 Not Found\r\n"));
    try std.testing.expect(std.mem.endsWith(u8, response[0..used], "<Code>NoSuchKey</Code>"));
    try std.testing.expectEqual(@as(usize, 1), fixture.guards.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.checkpoint_reads.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), fixture.latest_reads.load(.acquire));
}

test "metadata remote fixture still rejects truncated HTTP request headers" {
    var fixture: RemoteFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = &.{"unused"}, .slow = 0 };
    defer fixture.server.deinit();
    const Watched = struct {
        fixture: *RemoteFixture,
        done: std.atomic.Value(bool) = .init(false),
        fn serve(self: *@This()) void {
            self.fixture.serve();
            self.done.store(true, .release);
        }
    };
    var watched: Watched = .{ .fixture = &fixture };
    const thread = try std.Thread.spawn(.{}, Watched.serve, .{&watched});
    var joined = false;
    defer if (!joined) {
        fixture.stop.store(true, .release);
        thread.join();
    };
    {
        const client = try std.net.tcpConnectToAddress(fixture.server.listen_address);
        defer client.close();
        try client.writeAll("GET /peer/0/reorg_flag.json HTTP/1.1\r\nHost: fixture\r\n");
    }
    var timer = try std.time.Timer.start();
    while (!watched.done.load(.acquire) and timer.read() < 2 * std.time.ns_per_s) std.Thread.sleep(std.time.ns_per_ms);
    fixture.stop.store(true, .release);
    thread.join();
    joined = true;
    try std.testing.expectEqual(@as(?anyerror, error.FixtureUnexpectedEof), fixture.failure);
    try std.testing.expectEqual(@as(usize, 0), fixture.guards.load(.acquire));
}

fn checkpoint(domain: u32) protocol.Checkpoint {
    return .{ .mailbox_domain = domain, .merkle_tree_hook_address = @splat(1), .root = @splat(2), .index = 3, .message_id = @splat(4) };
}

fn signedAt(a: A, domain: u32, message_id: [32]u8, validators: []Address) ![][]const u8 {
    const values = try a.alloc([]const u8, validators.len);
    for (values, validators, 0..) |*value, *validator, index| {
        const key: [32]u8 = @splat(@as(u8, @intCast(index + 1)));
        var value_checkpoint = checkpoint(domain);
        value_checkpoint.message_id = message_id;
        const object = try objects.SignedCheckpoint.sign(value_checkpoint, key, null);
        validator.* = try object.recover();
        value.* = try object.toJson(a);
    }
    return values;
}

fn signed(a: A, domain: u32, validators: []Address) ![][]const u8 {
    return signedAt(a, domain, @splat(4), validators);
}

const NativeObservedSource = struct {
    pub const parallel_quorum = true;
    pub const parallel_latest = true;
    allocator: A,
    origin: *FakeOrigin,
    validators: []const Address,
    session: session_module.Session(FakeOrigin),

    pub fn fork(self: *const @This(), allocator: A, cancel: *const std.atomic.Value(bool)) !*@This() {
        const result = try allocator.create(@This());
        result.* = .{ .allocator = allocator, .origin = self.origin, .validators = self.validators, .session = session_module.Session(FakeOrigin).init(allocator, self.origin, cancel) };
        return result;
    }

    pub fn deinitFork(self: *@This()) void {
        const allocator = self.allocator;
        self.session.deinit();
        allocator.destroy(self);
    }

    pub fn beginPass(self: *@This(), cancel: *const std.atomic.Value(bool)) !void {
        return self.session.beginPass(cancel);
    }

    pub fn endPass(self: *@This(), failure: ?anyerror) void {
        self.session.endPass(failure);
    }

    pub fn moduleType(_: *@This(), address: Address) !metadata.ModuleType {
        return if (address[19] == 0) .aggregation else .message_id_multisig;
    }

    pub fn route(_: *@This(), _: Address, _: protocol.Message) !Address {
        return error.UnexpectedRoute;
    }

    pub fn members(self: *@This(), address: Address, _: protocol.Message, validators: bool) !metadata.Members {
        if (validators) return .{ .addresses = try self.allocator.dupe(Address, self.validators), .threshold = 2 };
        _ = address;
        const addresses = try self.allocator.alloc(Address, 1);
        addresses[0] = @splat(0);
        addresses[0][19] = 1;
        return .{ .addresses = addresses, .threshold = 1 };
    }

    pub fn verifyCandidate(_: *@This(), _: Address, _: protocol.Message, _: []const u8) !metadata.Verification {
        return .{ .valid = true, .cost = 1 };
    }

    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return 3;
    }

    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return 3;
    }

    pub fn fetchQuorum(self: *@This(), allocator: A, validators: []const Address, threshold: usize, index: u32, errors: *usize) !?quorum.Quorum {
        return self.session.fetchQuorum(allocator, validators, threshold, index, errors);
    }

    pub fn fetchLatestIndices(self: *@This(), validators: []const Address, output: []?u32, errors: *usize) !void {
        return self.session.fetchLatestIndices(validators, output, errors);
    }

    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
};

fn register(engine: *remote.Engine, a: A, fixture: *RemoteFixture, validators: []const Address) !void {
    const endpoint = try std.fmt.allocPrint(a, "http://127.0.0.1:{d}", .{fixture.server.listen_address.getPort()});
    defer a.free(endpoint);
    for (validators, 0..) |validator, index| {
        const bucket = try std.fmt.allocPrint(a, "peer-{d}", .{index});
        defer a.free(bucket);
        try engine.register(.{
            .origin = 1,
            .validator = validator,
            .location_id = @splat(@as(u8, @intCast(index))),
            .backend = .{ .s3 = .{ .endpoint = endpoint, .bucket = bucket, .region = "fixture" } },
        });
    }
}

test "native session returns 27-peer quorum and latest without replay refetch" {
    const a = std.testing.allocator;
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var validators: [27]Address = undefined;
    const values = try signed(arena.allocator(), 1, &validators);
    var fixture: RemoteFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .slow = 9, .failed_guard = 26 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, RemoteFixture.serve, .{&fixture});
    defer {
        fixture.stop.store(true, .release);
        thread.join();
    }
    const engine = try remote.Engine.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 64 }, .timeout_ms = 20000, .allow_insecure_loopback = true });
    defer engine.deinit();
    try register(engine, a, &fixture, &validators);
    var origin: FakeOrigin = .{ .allocator = a, .checkpoint_pool = engine };
    var cancel = std.atomic.Value(bool).init(false);
    var session = session_module.Session(FakeOrigin).init(a, &origin, &cancel);
    defer session.deinit();
    var errors: usize = 0;
    var timer = try std.time.Timer.start();
    var selected: ?quorum.Quorum = null;
    while (selected == null) {
        try session.beginPass(&cancel);
        selected = session.fetchQuorum(a, &validators, 2, 3, &errors) catch |err| {
            if (err != error.PendingReadIo) return err;
            session.endPass(error.PendingReadIo);
            if (timer.read() > 15 * std.time.ns_per_s) return error.SessionQuorumTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        session.endPass(error.PendingReadIo);
    }
    defer selected.?.deinit();
    try std.testing.expectEqual(@as(usize, 1), errors);
    try std.testing.expectEqual(@as(usize, 27), fixture.guards.load(.acquire));
    try std.testing.expectEqualDeep(checkpoint(1), selected.?.checkpoint);
    try std.testing.expectEqual(@as(usize, 2), selected.?.signatures.len);
    var previous_signer: ?usize = null;
    for (selected.?.signatures) |signature| {
        const recovered = try (objects.SignedCheckpoint{ .value = selected.?.checkpoint, .signature = signature }).recover();
        var configured_signer: ?usize = null;
        for (validators, 0..) |validator, index| if (std.mem.eql(u8, &validator, &recovered)) {
            configured_signer = index;
            break;
        };
        try std.testing.expect(configured_signer != null);
        try std.testing.expect(configured_signer.? >= fixture.slow and configured_signer.? != fixture.failed_guard.?);
        if (previous_signer) |previous| try std.testing.expect(configured_signer.? > previous);
        previous_signer = configured_signer;
    }
    fixture.guards.store(0, .release);
    errors = 0;
    var latest: [27]?u32 = undefined;
    while (true) {
        try session.beginPass(&cancel);
        session.fetchLatestIndices(&validators, &latest, &errors) catch |err| {
            if (err != error.PendingReadIo) return err;
            session.endPass(error.PendingReadIo);
            if (timer.read() > 15 * std.time.ns_per_s) return error.SessionLatestTimeout;
            std.Thread.sleep(std.time.ns_per_ms);
            continue;
        };
        session.endPass(error.PendingReadIo);
        break;
    }
    for (latest, 0..) |value, index| try std.testing.expectEqual(if (index == 26) @as(?u32, null) else @as(?u32, 3), value);
    try std.testing.expectEqual(@as(usize, 1), errors);
    // Reaching threshold closes the request and may cancel eligible peers before
    // they send HTTP headers. Check per-peer uniqueness after the latest phase
    // has drained earlier cancellation, rather than assuming all26 send a GET.
    const checkpoint_reads = fixture.checkpoint_reads.load(.acquire);
    try std.testing.expect(checkpoint_reads >= 2 and checkpoint_reads <= 26);
    var counted_reads: usize = 0;
    for (validators, 0..) |_, index| {
        const count = fixture.checkpoint_reads_by_peer[index].load(.acquire);
        try std.testing.expect(count <= 1);
        if (index == fixture.failed_guard.?) try std.testing.expectEqual(@as(usize, 0), count);
        counted_reads += count;
    }
    try std.testing.expectEqual(checkpoint_reads, counted_reads);
    errors = 0;
    try session.beginPass(&cancel);
    var replayed = (try session.fetchQuorum(a, &validators, 2, 3, &errors)).?;
    session.endPass(error.PendingReadIo);
    try std.testing.expectEqualDeep(selected.?.checkpoint, replayed.checkpoint);
    try std.testing.expectEqualDeep(selected.?.signatures, replayed.signatures);
    replayed.deinit();
    try std.testing.expectEqual(@as(usize, 1), errors);
    try std.testing.expectEqual(checkpoint_reads, fixture.checkpoint_reads.load(.acquire));
    session.endPass(null);
    if (fixture.failure) |err| return err;
}

test "native Builder publishes full 27-peer observation through production Registry" {
    const a = std.testing.allocator;
    const library = std.process.getEnvVarOwned(a, "HYPERLANE_CURL_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
    defer a.free(library);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const input: protocol.Message = .{ .version = 3, .origin = 1, .destination = 2, .sender = @splat(3), .recipient = @splat(4), .body = "native-observation" };
    var validators: [27]Address = undefined;
    const values = try signedAt(arena.allocator(), 1, input.id(), &validators);
    var fixture: RemoteFixture = .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .values = values, .slow = 9, .failed_guard = 26 };
    defer fixture.server.deinit();
    const thread = try std.Thread.spawn(.{}, RemoteFixture.serve, .{&fixture});
    defer {
        fixture.stop.store(true, .release);
        thread.join();
    }
    const engine = try remote.Engine.start(a, .{ .multi = .{ .library_path = library, .max_concurrent = 64 }, .timeout_ms = 20000, .allow_insecure_loopback = true });
    defer engine.deinit();
    try register(engine, a, &fixture, &validators);
    var origin: FakeOrigin = .{ .allocator = a, .checkpoint_pool = engine };
    const registry = try metrics.Registry.init(a, .relayer, .{ .base_version = "fixture", .max_render_bytes = 65536 });
    defer registry.deinit();
    var manager = observability.Manager.init(a, registry, .{ .context = undefined, .now_ms_fn = struct {
        fn now(_: *anyopaque) u64 {
            return 0;
        }
    }.now });
    defer manager.deinit();
    var active: observability.Active = .{ .manager = &manager, .resolver = .{ .context = undefined, .name_fn = struct {
        fn name(_: *anyopaque, domain: u32) ![]const u8 {
            return if (domain == 1) "origin" else "destination";
        }
    }.name } };
    const root = try parallel.Root.start(a, .{});
    defer root.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var source: NativeObservedSource = .{ .allocator = a, .origin = &origin, .validators = &validators, .session = session_module.Session(FakeOrigin).init(a, &origin, &cancel) };
    defer source.session.deinit();
    var builder: metadata.Builder(NativeObservedSource) = .{ .allocator = a, .source = &source, .executor = &root.executor, .observation = active.observation(), .app_context = "native-app" };
    const encoded = try builder.build(@splat(0), input);
    defer a.free(encoded);
    var timer = try std.time.Timer.start();
    while (root.executor.retainedJobs() != 0) {
        if (timer.read() > 15 * std.time.ns_per_s) return error.NativeObservationTimeout;
        std.Thread.sleep(std.time.ns_per_ms);
    }
    if (fixture.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 54), fixture.guards.load(.acquire));
    try std.testing.expectEqual(@as(usize, 26), fixture.latest_reads.load(.acquire));
    const text = try registry.render(a);
    defer a.free(text);
    try std.testing.expectEqual(@as(usize, 27), std.mem.count(u8, text, "hyperlane_observed_validator_latest_index{"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, text, "} -1\n"));
    try std.testing.expectEqual(@as(usize, 28), std.mem.count(u8, text, "app_context=\"native-app\""));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, text, "hyperlane_ism_build_count{"));
    try std.testing.expectEqual(@as(u64, 0), manager.failures.load(.acquire));
}

const BlockedMultisigSource = struct {
    allocator: A,
    cancel: *const std.atomic.Value(bool),
    healthy: bool = true,
    effects: ?*std.atomic.Value(usize) = null,
    pending_children: ?*std.atomic.Value(u16) = null,
    child_index: u4 = 0,
    pub const parallel_latest = true;

    pub fn fork(self: *const BlockedMultisigSource, allocator: A, cancel: *const std.atomic.Value(bool)) !*BlockedMultisigSource {
        const result = try allocator.create(BlockedMultisigSource);
        result.* = .{ .allocator = allocator, .cancel = cancel, .healthy = self.healthy, .effects = self.effects, .pending_children = self.pending_children, .child_index = self.child_index };
        return result;
    }
    pub fn deinitFork(self: *BlockedMultisigSource) void {
        self.allocator.destroy(self);
    }
    pub fn moduleType(self: *BlockedMultisigSource, address: Address) !metadata.ModuleType {
        if (address[19] == 0) return .aggregation;
        return if (self.healthy and address[19] > 8) .null_ism else .merkle_root_multisig;
    }
    pub fn route(_: *BlockedMultisigSource, _: Address, _: protocol.Message) !Address {
        return error.UnexpectedRoute;
    }
    pub fn members(self: *BlockedMultisigSource, module: Address, _: protocol.Message, validators: bool) !metadata.Members {
        if (validators) self.child_index = @intCast(module[19] - 1);
        const count: usize = if (validators) 1 else 9;
        const addresses = try self.allocator.alloc(Address, count);
        for (addresses, 0..) |*address, index| {
            address.* = @splat(0);
            address.*[19] = @intCast(index + 1);
        }
        return .{ .addresses = addresses, .threshold = 1 };
    }
    pub fn verifyCandidate(_: *BlockedMultisigSource, _: Address, _: protocol.Message, _: []const u8) !metadata.Verification {
        return .{ .valid = true, .cost = null };
    }
    pub fn leafIndex(_: *BlockedMultisigSource, _: [32]u8) !?u32 {
        return 0;
    }
    pub fn highestKnownLeafIndex(_: *BlockedMultisigSource) !?u32 {
        return 0;
    }
    pub fn fetchCheckpoint(_: *BlockedMultisigSource, _: Address, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *BlockedMultisigSource, _: Address) !?u32 {
        return error.PendingReadIo;
    }
    pub fn fetchLatestIndices(self: *BlockedMultisigSource, _: []const Address, _: []?u32, _: *usize) !void {
        if (self.cancel.load(.acquire)) return error.RequestCancelled;
        if (self.pending_children) |children| _ = children.fetchOr(@as(u16, 1) << self.child_index, .acq_rel);
        if (self.effects) |effects| _ = effects.fetchAdd(1, .acq_rel);
        return error.PendingReadIo;
    }
    pub fn proof(_: *BlockedMultisigSource, _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.NoProof;
    }
};

test "eight blocked multisig jobs do not delay the healthy ninth Null child" {
    const a = std.testing.allocator;
    const root = try parallel.Root.start(a, .{});
    defer root.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var source: BlockedMultisigSource = .{ .allocator = a, .cancel = &cancel };
    var builder: metadata.Builder(BlockedMultisigSource) = .{ .allocator = a, .source = &source, .executor = &root.executor };
    const encoded = try builder.build(@splat(0), .{ .origin = 1, .destination = 2 });
    defer a.free(encoded);
    const decoded = try protocol.metadata.Aggregation.decode(encoded, 9);
    for (0..8) |index| try std.testing.expect((try decoded.metadataAt(index)) == null);
    try std.testing.expectEqual(@as(usize, 0), (try decoded.metadataAt(8)).?.len);
    var timer = try std.time.Timer.start();
    while (root.executor.retainedJobs() != 0) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.BlockedJobsNotRetired;
        std.Thread.sleep(std.time.ns_per_ms);
    }
}

const ParentBuild = struct {
    builder: *metadata.Builder(BlockedMultisigSource),
    result: anyerror![]u8 = error.ParentBuildNotFinished,

    fn run(self: *ParentBuild) void {
        self.result = self.builder.build(@splat(0), .{ .origin = 1, .destination = 2 });
    }
};

fn parentCancellationExercise(a: A, fail_before_cancel: bool) !void {
    const root = try parallel.Root.start(a, .{});
    defer root.deinit();
    var parent_cancel = std.atomic.Value(bool).init(false);
    var effects = std.atomic.Value(usize).init(0);
    var pending_children = std.atomic.Value(u16).init(0);
    var source: BlockedMultisigSource = .{ .allocator = a, .healthy = false, .effects = &effects, .pending_children = &pending_children, .cancel = &parent_cancel };
    var builder: metadata.Builder(BlockedMultisigSource) = .{ .allocator = a, .source = &source, .executor = &root.executor, .cancel = &parent_cancel };
    var run: ParentBuild = .{ .builder = &builder };
    const thread = try std.Thread.spawn(.{}, ParentBuild.run, .{&run});
    var joined = false;
    defer {
        // This runs before Root.deinit on every assertion/timeout/error path.
        // The successful path poisons the caller flag after joining, so never
        // touch its storage again once that join has completed.
        if (!joined) {
            parent_cancel.store(true, .release);
            thread.join();
        }
        if (run.result) |bytes| a.free(bytes) else |_| {}
    }
    var timer = try std.time.Timer.start();
    while (pending_children.load(.acquire) != 0x1ff) {
        if (timer.read() > 5 * std.time.ns_per_s) return error.ChildrenNeverReachedPending;
        std.Thread.yield() catch {};
    }
    if (fail_before_cancel) return error.DeliberateCancellationFixtureFailure;
    parent_cancel.store(true, .release);
    thread.join();
    joined = true;
    try std.testing.expectError(error.RequestCancelled, run.result);
    parent_cancel = undefined;
    const after_return = effects.load(.acquire);
    while (root.executor.retainedJobs() != 0) {
        _ = root.executor.assist();
        if (timer.read() > 5 * std.time.ns_per_s) return error.CancelledJobsNotDrained;
        std.Thread.yield() catch {};
    }
    try std.testing.expectEqual(after_return, effects.load(.acquire));
    try std.testing.expectEqual(@as(usize, 0), root.executor.retainedOutputBytes());
}

test "parent cancel returns promptly and children never reuse the caller flag" {
    try parentCancellationExercise(std.testing.allocator, false);
}

test "parent cancellation fixture cancels and joins before early error unwind" {
    try std.testing.expectError(error.DeliberateCancellationFixtureFailure, parentCancellationExercise(std.testing.allocator, true));
}
