const std = @import("std");
const checker = @import("agents/origin_signers.zig");
const origin = @import("agents/origin_signer_source.zig");
const support = @import("agents/origin_signer_fixtures/support.zig");
const protocol = @import("protocol/root.zig");
const abi = @import("evm/codecs.zig");
const base58 = @import("altvm/base58.zig");
const A = std.mem.Allocator;
const Hash = checker.Hash;

const Mock = struct {
    mutex: std.Thread.Mutex = .{},
    changed: std.Thread.Condition = .{},
    calls: usize = 0,
    values: []const Hash = &.{.{0x11} ** 32},
    failure: ?anyerror = null,
    gated: bool = false,
    released: bool = false,

    fn interface(self: *Mock) checker.Lookup {
        return .{ .context = self, .fetch_fn = fetch };
    }
    fn fetch(context: *anyopaque, a: A, _: protocol.Message, _: u64, _: ?*const std.atomic.Value(bool)) ![]Hash {
        const self: *Mock = @ptrCast(@alignCast(context));
        self.mutex.lock();
        self.calls += 1;
        while (self.gated and !self.released) self.changed.timedWait(&self.mutex, std.time.ns_per_ms) catch {};
        const failure = self.failure;
        self.mutex.unlock();
        if (failure) |err| return err;
        return a.dupe(Hash, self.values);
    }
    fn count(self: *Mock) usize {
        self.mutex.lock();
        defer self.mutex.unlock();
        return self.calls;
    }
    fn release(self: *Mock) void {
        self.mutex.lock();
        self.released = true;
        self.changed.broadcast();
        self.mutex.unlock();
    }
};

fn message(nonce: u32) protocol.Message {
    return .{ .nonce = nonce, .origin = 1000, .destination = 2000, .sender = .{0x11} ** 32, .recipient = .{0x22} ** 32, .body = "fixture" };
}

fn lookup(cache: *checker.Cache, a: A, mock: *Mock, value: protocol.Message) !checker.Cache.Snapshot {
    return (try cache.lookup(a, value, true, false, mock.interface(), std.math.maxInt(u64), null)).?;
}

fn expectLookupFailure(cache: *checker.Cache, a: A, mock: *Mock, value: protocol.Message) !void {
    if (cache.lookup(a, value, true, false, mock.interface(), std.math.maxInt(u64), null)) |result| {
        if (result) |snapshot_value| {
            var snapshot = snapshot_value;
            snapshot.deinit();
        }
        return error.ExpectedOriginSignerLookupFailure;
    } else |_| {}
}

test "Rust OriginSenderCheck caches positive empty and never performs unneeded lookups" {
    const a = std.testing.allocator;
    var cache = try checker.Cache.initDefault(a);
    defer cache.deinit();
    var mock: Mock = .{ .values = &.{ .{0} ** 32, .{0x11} ** 32, .{0x22} ** 32 } };
    const value = message(1);
    try std.testing.expect((try cache.lookup(a, value, false, false, mock.interface(), std.math.maxInt(u64), null)) == null);
    try std.testing.expectEqual(@as(usize, 0), mock.count());
    var first = try lookup(&cache, a, &mock, value);
    defer first.deinit();
    try std.testing.expectEqualSlices(Hash, &.{ .{0x11} ** 32, .{0x22} ** 32 }, first.signers());
    var second = try lookup(&cache, a, &mock, value);
    defer second.deinit();
    try std.testing.expectEqual(@as(usize, 1), mock.count());

    var empty_mock: Mock = .{ .values = &.{} };
    const empty_message = message(2);
    var empty = try lookup(&cache, a, &empty_mock, empty_message);
    defer empty.deinit();
    try std.testing.expectEqual(@as(usize, 0), empty.signers().len);
    var empty_again = try lookup(&cache, a, &empty_mock, empty_message);
    defer empty_again.deinit();
    try std.testing.expectEqual(@as(usize, 1), empty_mock.count());

    var missing: Mock = .{ .failure = error.DispatchHashNotStored };
    try expectLookupFailure(&cache, a, &missing, message(3));
    try expectLookupFailure(&cache, a, &missing, message(3));
    try std.testing.expectEqual(@as(usize, 2), missing.count());
    try std.testing.expect(cache.cached(message(3).id()) == null);
}

test "cooldown and rule refresh retain cached signers without extraneous source calls" {
    const a = std.testing.allocator;
    var cache = try checker.Cache.init(a, 4, 4096);
    defer cache.deinit();
    var mock: Mock = .{};
    const value = message(4);
    var initial = try lookup(&cache, a, &mock, value);
    defer initial.deinit();
    var state: checker.Prepare = .{ .failures = 5, .skip_until_ns = 1000 };
    try std.testing.expectEqual(checker.Action.cached_only, state.begin(999));
    var queued = cache.cached(value.id()).?;
    defer queued.deinit();
    try std.testing.expectEqualSlices(Hash, initial.signers(), queued.signers());
    try std.testing.expect((try cache.lookup(a, value, false, false, mock.interface(), std.math.maxInt(u64), null)) == null);
    try std.testing.expect(cache.cached(value.id()) != null);
    try std.testing.expectEqual(@as(usize, 1), mock.count());
    try std.testing.expectEqual(checker.Action.lookup, state.begin(1000));
    var after = try lookup(&cache, a, &mock, value);
    defer after.deinit();
    try std.testing.expectEqual(@as(usize, 1), mock.count());
    const explicit_message = message(5);
    var explicit = (try cache.lookup(a, explicit_message, false, true, mock.interface(), std.math.maxInt(u64), null)).?;
    defer explicit.deinit();
    try std.testing.expectEqual(@as(usize, 2), mock.count());
}

test "Rust pending-message prepare backoff fail-fast cooldown and control boundaries" {
    var state: checker.Prepare = .{};
    try std.testing.expectEqual(checker.Action.lookup, state.begin(0));
    const delays = [_]u64{ 30, 60, 120, 240 };
    var now: u64 = 0;
    for (delays, 1..) |seconds, failures| {
        const action = state.complete(now, false, .peer_failure);
        try std.testing.expectEqual(seconds * std.time.ns_per_s, action.delay_ns);
        try std.testing.expectEqual(@as(u32, @intCast(failures)), state.failures);
        now += seconds * std.time.ns_per_s;
        try std.testing.expectEqual(checker.Action.lookup, state.begin(now));
    }
    try std.testing.expectEqual(checker.Action.proceed, state.complete(now, false, .peer_failure));
    try std.testing.expectEqual(@as(u32, 5), state.failures);
    try std.testing.expectEqual(checker.Action.cached_only, state.begin(now + 1));
    try std.testing.expectEqual(checker.Action.lookup, state.begin(now + checker.give_up_cooldown_ns));

    var missing: checker.Prepare = .{};
    try std.testing.expectEqual(@as(u64, 30 * std.time.ns_per_s), missing.complete(0, false, .hash_not_stored).delay_ns);
    try std.testing.expectEqual(checker.Action.proceed, missing.complete(30 * std.time.ns_per_s, false, .hash_not_stored));
    try std.testing.expectEqual(@as(u32, 0), missing.failures);

    var fail_fast: checker.Prepare = .{};
    try std.testing.expectEqual(checker.Action.general_retry, fail_fast.complete(0, true, .hash_not_stored));
    try std.testing.expectEqual(checker.Action.general_retry, fail_fast.complete(0, true, .peer_failure));
    try std.testing.expectEqual(@as(u32, 0), fail_fast.failures);
    for ([_]anyerror{ error.OutOfMemory, error.RequestCancelled, error.RequestDeadlineExceeded, error.SourceReadDeadline, error.OriginSignerLookupPending, error.StaleCanonicalMessage }) |err| {
        try std.testing.expect(checker.isControlError(err));
        try std.testing.expectEqual(checker.Action.control, fail_fast.complete(0, false, .control));
    }
    try std.testing.expectEqual(checker.Action.proceed, fail_fast.complete(0, false, .success));
}

const Concurrent = struct {
    cache: *checker.Cache,
    mock: *Mock,
    value: protocol.Message,
    snapshot: ?checker.Cache.Snapshot = null,
    failure: ?anyerror = null,
    deadline_ns: u64 = std.math.maxInt(u64),
    cancel: ?*const std.atomic.Value(bool) = null,

    fn run(self: *Concurrent) void {
        const result = self.cache.lookup(std.testing.allocator, self.value, true, false, self.mock.interface(), self.deadline_ns, self.cancel) catch |err| {
            self.failure = err;
            return;
        };
        self.snapshot = result;
    }
};

fn concurrentOutcome(failure: ?anyerror) !void {
    const a = std.testing.allocator;
    var cache = try checker.Cache.init(a, 8, 4096);
    defer cache.deinit();
    var mock: Mock = .{ .gated = true, .failure = failure };
    const value = message(10);
    var calls: [6]Concurrent = undefined;
    var threads: [6]std.Thread = undefined;
    for (&calls, &threads) |*call, *thread| {
        call.* = .{ .cache = &cache, .mock = &mock, .value = value };
        thread.* = try std.Thread.spawn(.{}, Concurrent.run, .{call});
    }
    var attempts: usize = 0;
    while (mock.count() == 0 and attempts < 1000) : (attempts += 1) std.Thread.sleep(std.time.ns_per_ms);
    std.Thread.sleep(10 * std.time.ns_per_ms);
    mock.release();
    for (&threads, &calls) |thread, *call| {
        thread.join();
        if (failure) |expected| {
            try std.testing.expectEqual(expected, call.failure.?);
            try std.testing.expect(call.snapshot == null);
        } else {
            try std.testing.expect(call.failure == null);
            var snapshot = call.snapshot.?;
            defer snapshot.deinit();
            try std.testing.expectEqualSlices(Hash, &.{.{0x11} ** 32}, snapshot.signers());
        }
    }
    try std.testing.expectEqual(@as(usize, 1), mock.count());
    if (failure != null) {
        mock.failure = null;
        var recovered = try lookup(&cache, a, &mock, value);
        defer recovered.deinit();
        try std.testing.expectEqual(@as(usize, 2), mock.count());
    }
}

test "Source future cache shares in-flight success failure and OOM control flow" {
    try concurrentOutcome(null);
    try concurrentOutcome(error.RpcDown);
    try concurrentOutcome(error.OutOfMemory);
    var state: checker.Prepare = .{};
    try std.testing.expectEqual(checker.Action.control, state.complete(0, false, .control));
    try std.testing.expectEqual(@as(u32, 0), state.failures);
}

fn cooperativeClock(cancelled: bool) !void {
    const a = std.testing.allocator;
    var cache = try checker.Cache.init(a, 4, 4096);
    defer cache.deinit();
    var mock: Mock = .{ .gated = true };
    const value = message(11);
    var leader: Concurrent = .{ .cache = &cache, .mock = &mock, .value = value };
    const leader_thread = try std.Thread.spawn(.{}, Concurrent.run, .{&leader});
    while (mock.count() == 0) std.Thread.sleep(std.time.ns_per_ms);
    var cancel = std.atomic.Value(bool).init(false);
    var waiter: Concurrent = .{
        .cache = &cache,
        .mock = &mock,
        .value = value,
        .deadline_ns = if (cancelled) std.math.maxInt(u64) else try support.deadlineAfter(30 * std.time.ns_per_ms),
        .cancel = if (cancelled) &cancel else null,
    };
    var timer = try std.time.Timer.start();
    const waiter_thread = try std.Thread.spawn(.{}, Concurrent.run, .{&waiter});
    if (cancelled) {
        std.Thread.sleep(20 * std.time.ns_per_ms);
        cancel.store(true, .release);
    }
    waiter_thread.join();
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    if (cancelled) {
        try std.testing.expectEqual(error.RequestCancelled, waiter.failure.?);
    } else {
        try std.testing.expect(timer.read() >= 10 * std.time.ns_per_ms);
        try std.testing.expectEqual(error.SourceReadDeadline, waiter.failure.?);
    }
    try std.testing.expectEqual(@as(usize, 1), mock.count());
    mock.release();
    leader_thread.join();
    try std.testing.expect(leader.failure == null);
    var snapshot = leader.snapshot.?;
    defer snapshot.deinit();
}

test "cache waiters use monotonic elapsed deadline and cooperative cancellation" {
    try cooperativeClock(false);
    try cooperativeClock(true);
}

test "entry and byte caps evict old snapshots without invalidating readers or in-flight lookups" {
    const a = std.testing.allocator;
    var cache = try checker.Cache.init(a, 1, 512);
    defer cache.deinit();
    var mock: Mock = .{};
    var old = try lookup(&cache, a, &mock, message(20));
    defer old.deinit();
    var newer = try lookup(&cache, a, &mock, message(21));
    defer newer.deinit();
    // The pinned oldest entry stays cached; the new result is returned but not cached.
    try std.testing.expect(cache.cached(message(20).id()) != null);
    try std.testing.expect(cache.cached(message(21).id()) == null);
    try std.testing.expectEqualSlices(Hash, &.{.{0x11} ** 32}, old.signers());
    try std.testing.expectEqual(@as(usize, 1), cache.stats().entries);
    try std.testing.expect(cache.stats().bytes <= 512);

    var tiny = try checker.Cache.init(a, 8, 128);
    defer tiny.deinit();
    var large_mock: Mock = .{ .values = &([_]Hash{.{0x44} ** 32} ** 8) };
    var uncached = try lookup(&tiny, a, &large_mock, message(22));
    defer uncached.deinit();
    try std.testing.expectEqual(@as(usize, 0), tiny.stats().entries);
    var repeated = try lookup(&tiny, a, &large_mock, message(22));
    defer repeated.deinit();

    var gated: Mock = .{ .gated = true, .values = &.{.{0x33} ** 32} };
    var pending: Concurrent = .{ .cache = &cache, .mock = &gated, .value = message(23) };
    var waiter: Concurrent = .{ .cache = &cache, .mock = &gated, .value = message(23) };
    const thread = try std.Thread.spawn(.{}, Concurrent.run, .{&pending});
    while (gated.count() == 0) std.Thread.sleep(std.time.ns_per_ms);
    const waiting_thread = try std.Thread.spawn(.{}, Concurrent.run, .{&waiter});
    var competing = try lookup(&cache, a, &mock, message(24));
    gated.release();
    thread.join();
    waiting_thread.join();
    try std.testing.expect(pending.failure == null);
    try std.testing.expect(waiter.failure == null);
    var completed = pending.snapshot.?;
    defer completed.deinit();
    var shared = waiter.snapshot.?;
    defer shared.deinit();
    try std.testing.expectEqualSlices(Hash, &.{.{0x33} ** 32}, completed.signers());
    competing.deinit();
    var last = try lookup(&cache, a, &mock, message(25));
    defer last.deinit();
    try std.testing.expectEqual(@as(usize, 1), cache.stats().entries);
}

test "canonical replacement uses independent full message-id entries" {
    const a = std.testing.allocator;
    var cache = try checker.Cache.init(a, 4, 4096);
    defer cache.deinit();
    var mock: Mock = .{};
    const orphaned = message(30);
    var replacement_message = orphaned;
    replacement_message.body = "replacement";
    var first = try lookup(&cache, a, &mock, orphaned);
    defer first.deinit();
    var second = try lookup(&cache, a, &mock, replacement_message);
    defer second.deinit();
    try std.testing.expect(!std.mem.eql(u8, &orphaned.id(), &replacement_message.id()));
    try std.testing.expectEqual(@as(usize, 2), mock.count());
    try std.testing.expect(cache.cached(orphaned.id()) != null);
    try std.testing.expect(cache.cached(replacement_message.id()) != null);
}

fn allocationSweep(a: A) !void {
    var cache = try checker.Cache.init(a, 2, 1024);
    defer cache.deinit();
    var mock: Mock = .{};
    var snapshot = try lookup(&cache, a, &mock, message(40));
    defer snapshot.deinit();
}

test "cache allocation failures release pending and completed ownership" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}

fn evmResponses(a: A) ![2][]u8 {
    const hash = try abi.hexAlloc(a, &(.{0x44} ** 32));
    defer a.free(hash);
    const block = try abi.hexAlloc(a, &(.{0x55} ** 32));
    defer a.free(block);
    const sender = try abi.hexAlloc(a, &(.{0x11} ** 20));
    defer a.free(sender);
    const transaction = try std.json.Stringify.valueAlloc(a, .{ .hash = hash, .blockHash = block, .blockNumber = "0x7", .gas = "0x5208", .gasPrice = "0x1", .nonce = "0x1", .from = sender, .to = @as(?[]const u8, null), .input = "0x" }, .{});
    errdefer a.free(transaction);
    const receipt = try std.json.Stringify.valueAlloc(a, .{ .transactionHash = hash, .blockHash = block, .blockNumber = "0x7", .gasUsed = "0x1", .cumulativeGasUsed = "0x1", .effectiveGasPrice = "0x1" }, .{});
    return .{ transaction, receipt };
}

fn nativeEvm(case: enum { success, empty }) !void {
    const a = std.testing.allocator;
    var responses: [2][]u8 = undefined;
    var have_responses = false;
    defer if (have_responses) for (responses) |response| a.free(response);
    var steps: [2]support.Step = undefined;
    const count: usize = if (case == .success) 2 else 1;
    if (case == .success) {
        responses = try evmResponses(a);
        have_responses = true;
        steps[0] = .{ .method = "eth_getTransactionByHash", .result = responses[0] };
        steps[1] = .{ .method = "eth_getTransactionReceipt", .result = responses[1] };
    } else {
        steps[0] = .{ .method = "eth_getTransactionByHash", .result = "null" };
    }
    var rpc = try support.Rpc.init(steps[0..count]);
    defer rpc.deinit();
    const url = try rpc.url(a);
    defer a.free(url);
    const urls = [_][]const u8{url};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const owner = try support.openResources(a, .ethereum, &urls, &env);
    defer owner.deinit();
    var provenance: support.Provenance = .{ .hash = support.nativeHash(.{0x44} ** 32) };
    var source = origin.Source.initProvenance(owner, provenance.interface());
    var cache = try checker.Cache.init(a, 4, 4096);
    defer cache.deinit();
    try rpc.start();
    const value = message(50);
    var snapshot = (try cache.lookup(a, value, true, false, source.interface(), try support.deadline(), null)).?;
    defer snapshot.deinit();
    if (case == .success) {
        try std.testing.expectEqual(@as(usize, 1), snapshot.signers().len);
        try std.testing.expectEqualSlices(u8, &([_]u8{0} ** 12 ++ [_]u8{0x11} ** 20), &snapshot.signers()[0]);
    } else {
        try std.testing.expectEqual(@as(usize, 0), snapshot.signers().len);
    }
    var cached = (try cache.lookup(a, value, true, false, source.interface(), try support.deadline(), null)).?;
    defer cached.deinit();
}

// Adapter used only to reuse the failure assertion with the concrete source.
fn concreteFailure(cache: *checker.Cache, a: A, source: *origin.Source, value: protocol.Message) !void {
    if (cache.lookup(a, value, true, false, source.interface(), try support.deadline(), null)) |result| {
        if (result) |snapshot_value| {
            var snapshot = snapshot_value;
            snapshot.deinit();
        }
        return error.ExpectedOriginSignerLookupFailure;
    } else |_| {}
}

test "native HTTP EVM sender and empty outcomes follow Rust oracle" {
    try nativeEvm(.success);
    try nativeEvm(.empty);
}

test "native HTTP malformed and remote errors are not cached" {
    for ([_]enum { malformed, remote_error }{ .malformed, .remote_error }) |case| {
        const a = std.testing.allocator;
        var steps = [_]support.Step{ .{ .method = "eth_getTransactionByHash", .result = if (case == .malformed) "{\"hash\":" else "null", .remote_error = case == .remote_error }, .{ .method = "eth_getTransactionByHash", .result = if (case == .malformed) "{\"hash\":" else "null", .remote_error = case == .remote_error } };
        var rpc = try support.Rpc.init(&steps);
        defer rpc.deinit();
        const url = try rpc.url(a);
        defer a.free(url);
        const urls = [_][]const u8{url};
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        const owner = try support.openResources(a, .ethereum, &urls, &env);
        defer owner.deinit();
        var provenance: support.Provenance = .{ .hash = support.nativeHash(.{0x44} ** 32) };
        var source = origin.Source.initProvenance(owner, provenance.interface());
        var cache = try checker.Cache.init(a, 4, 4096);
        defer cache.deinit();
        try rpc.start();
        try concreteFailure(&cache, a, &source, message(51));
        try concreteFailure(&cache, a, &source, message(51));
    }
}

fn nativeClock(case: enum { expire, cancel }) !void {
    const a = std.testing.allocator;
    var steps = [_]support.Step{.{ .method = "eth_getTransactionByHash", .result = "null" }};
    var rpc = try support.Rpc.init(&steps);
    defer rpc.deinit();
    rpc.delay_ms = 200;
    const url = try rpc.url(a);
    defer a.free(url);
    const urls = [_][]const u8{url};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const owner = try support.openResources(a, .ethereum, &urls, &env);
    defer owner.deinit();
    var provenance: support.Provenance = .{ .hash = support.nativeHash(.{0x44} ** 32) };
    var source = origin.Source.initProvenance(owner, provenance.interface());
    var cache = try checker.Cache.init(a, 4, 4096);
    defer cache.deinit();
    try rpc.start();
    var cancel = std.atomic.Value(bool).init(false);
    const Cancel = struct {
        fn run(flag: *std.atomic.Value(bool)) void {
            std.Thread.sleep(20 * std.time.ns_per_ms);
            flag.store(true, .release);
        }
    };
    const cancel_thread = if (case == .cancel) try std.Thread.spawn(.{}, Cancel.run, .{&cancel}) else null;
    defer if (cancel_thread) |thread| thread.join();
    var timer = try std.time.Timer.start();
    const deadline = if (case == .expire) try support.deadlineAfter(30 * std.time.ns_per_ms) else std.math.maxInt(u64);
    if (cache.lookup(a, message(52), true, false, source.interface(), deadline, if (case == .cancel) &cancel else null)) |result| {
        if (result) |snapshot_value| {
            var snapshot = snapshot_value;
            snapshot.deinit();
        }
        return error.ExpectedNativeClockFailure;
    } else |err| {
        if (case == .cancel) {
            try std.testing.expectEqual(error.RequestCancelled, err);
        } else {
            try std.testing.expect(checker.isControlError(err));
        }
    }
    try std.testing.expect(timer.read() < std.time.ns_per_s);
    try std.testing.expect(cache.cached(message(52).id()) == null);
}

test "native Cache to Source HTTP path enforces UTC deadline expiration and cancellation" {
    try nativeClock(.expire);
    try nativeClock(.cancel);
}

test "missing zero and stale canonical provenance never issue native RPC" {
    const a = std.testing.allocator;
    for ([_]?[64]u8{ null, .{0} ** 64 }) |hash| {
        var rpc = try support.Rpc.init(&.{});
        defer rpc.deinit();
        const url = try rpc.url(a);
        defer a.free(url);
        const urls = [_][]const u8{url};
        var env = std.process.EnvMap.init(a);
        defer env.deinit();
        const owner = try support.openResources(a, .ethereum, &urls, &env);
        defer owner.deinit();
        var provenance: support.Provenance = .{ .hash = hash };
        var source = origin.Source.initProvenance(owner, provenance.interface());
        try std.testing.expectError(error.SourceReadDeadline, source.interface().fetch(a, message(60), 0, null));
        try std.testing.expectError(error.DispatchHashNotStored, source.interface().fetch(a, message(60), try support.deadline(), null));
        provenance.canonical = .{0x66} ** 32;
        try std.testing.expectError(error.StaleCanonicalMessage, source.interface().fetch(a, message(60), try support.deadline(), null));
    }
}

test "native HTTP SVM known full64 hash returns every jsonParsed signer in account order" {
    const a = std.testing.allocator;
    const signature = [_]u8{0x44} ** 64;
    const signature_text = try base58.encode(a, &signature);
    defer a.free(signature_text);
    const second_text = try base58.encode(a, &(.{0x45} ** 64));
    defer a.free(second_text);
    const payer = try base58.encode(a, &(.{0x22} ** 32));
    defer a.free(payer);
    const depositor = try base58.encode(a, &(.{0x33} ** 32));
    defer a.free(depositor);
    const program = try base58.encode(a, &(.{0x11} ** 32));
    defer a.free(program);
    const block_hash = try base58.encode(a, &(.{0x55} ** 32));
    defer a.free(block_hash);
    const transaction = try std.json.Stringify.valueAlloc(a, .{ .slot = 7, .meta = .{ .err = null }, .transaction = .{ .signatures = .{ signature_text, second_text }, .message = .{ .accountKeys = .{ .{ .pubkey = payer, .signer = true }, .{ .pubkey = depositor, .signer = true }, .{ .pubkey = program, .signer = false } } } } }, .{});
    defer a.free(transaction);
    const block = try std.json.Stringify.valueAlloc(a, .{ .blockhash = block_hash, .signatures = .{ signature_text, second_text } }, .{});
    defer a.free(block);
    var steps = [_]support.Step{ .{ .method = "getTransaction", .result = transaction, .svm_signature = signature_text }, .{ .method = "getBlock", .result = block } };
    var rpc = try support.Rpc.init(&steps);
    defer rpc.deinit();
    const url = try rpc.url(a);
    defer a.free(url);
    const urls = [_][]const u8{url};
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    const owner = try support.openResources(a, .sealevel, &urls, &env);
    defer owner.deinit();
    var provenance: support.Provenance = .{ .hash = signature };
    var source = origin.Source.initProvenance(owner, provenance.interface());
    try rpc.start();
    const keys = try source.interface().fetch(a, message(70), try support.deadline(), null);
    defer a.free(keys);
    try std.testing.expectEqualSlices(Hash, &.{ .{0x22} ** 32, .{0x33} ** 32 }, keys);
}

test {
    _ = @import("sealevel/signers_testing.zig");
    _ = @import("agents/origin_signer_fixtures/native_store_test.zig");
}
