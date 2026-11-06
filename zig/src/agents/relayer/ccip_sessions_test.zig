const std = @import("std");
const curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
const sessions = @import("ccip_sessions.zig");
const ccip = @import("../../relayer/ccip.zig");
const evm = @import("../../evm/root.zig");
const curl = @import("../../net/curl.zig");
const http_runtime = @import("../../net/http_runtime.zig");
const byte_budget = @import("../../net/byte_budget.zig");
const protocol = @import("../../protocol/root.zig");
const A = std.mem.Allocator;
const Hash = [32]u8;
const ism: [20]u8 = @splat(3);

fn message(origin: u32, nonce: u32) protocol.Message {
    return .{ .version = 3, .nonce = nonce, .origin = origin, .sender = @splat(1), .destination = 2000, .recipient = @splat(2), .body = &.{ 0x11, 0x22 } };
}

fn lookupText(a: A) ![]u8 {
    var parsed = try std.json.parseFromSlice(std.json.Value, a, @embedFile("../../relayer/testing/ccip-lookup.json"), .{});
    defer parsed.deinit();
    var text: std.ArrayList(u8) = .empty;
    errdefer text.deinit(a);
    for (parsed.value.object.get("chunks").?.array.items) |chunk| try text.appendSlice(a, chunk.string);
    return text.toOwnedSlice(a);
}

fn loopbackLookupText(a: A) ![]u8 {
    const original = try lookupText(a);
    defer a.free(original);
    const bytes = try a.alloc(u8, (original.len - 2) / 2);
    defer a.free(bytes);
    _ = try evm.codecs.decodeHex(bytes, original);
    const replacements = [_]struct { old: []const u8, new: []const u8 }{
        .{ .old = "https://ccs.example/{sender}/{data}", .new = "http://127.0.0.1:1/{data}" },
        .{ .old = "https://ccs.example/lookup", .new = "http://127.0.0.1:1/post" },
    };
    for (replacements) |replacement| {
        const at = std.mem.indexOf(u8, bytes, replacement.old) orelse return error.MissingFixtureUrl;
        std.mem.writeInt(u256, bytes[at - 32 .. at][0..32], replacement.new.len, .big);
        @memset(bytes[at..][0..replacement.old.len], 0);
        @memcpy(bytes[at..][0..replacement.new.len], replacement.new);
    }
    return evm.codecs.hexAlloc(a, bytes);
}

const Rpc = struct {
    revert: []const u8,
    calls: usize = 0,
    malformed: bool = false,
    result_instead: bool = false,
    pending_reads: usize = 0,
    last_id: i64 = 0,
    last_cancel: ?*const std.atomic.Value(bool) = null,
    expected_block: []const u8 = "0x2a",
    pinned_ok: bool = true,
    selector_ok: bool = true,

    fn exchange(self: *Rpc) evm.provider.Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }

    fn fetch(context: *anyopaque, a: A, body: []const u8, options: evm.provider.Options) !evm.provider.WireResponse {
        const self: *Rpc = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.last_cancel = options.cancel;
        if (self.pending_reads > 0) {
            self.pending_reads -= 1;
            return error.PendingReadIo;
        }
        var parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer parsed.deinit();
        const object = parsed.value.object;
        const id = object.get("id").?.integer;
        self.last_id = id;
        const params = object.get("params").?.array.items;
        self.pinned_ok = self.pinned_ok and std.mem.eql(u8, params[1].string, self.expected_block);
        const data = params[0].object.get("data").?.string;
        var selector: [4]u8 = undefined;
        const decoded = evm.codecs.decodeHex(&selector, data[0..10]) catch return error.InvalidRpcFixture;
        _ = decoded;
        self.selector_ok = self.selector_ok and std.mem.eql(u8, &selector, &evm.codecs.selector("getOffchainVerifyInfo(bytes)"));
        const bytes = if (self.result_instead)
            try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":\"0x\"}}", .{id})
        else
            try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"error\":{{\"code\":-32000,\"message\":\"execution reverted\",\"data\":\"{s}\"}}}}", .{ id, if (self.malformed) "0x1234" else self.revert });
        return .{ .bytes = bytes, .len = bytes.len };
    }
};

const NativeLookup = struct {
    revert: []const u8,
    calls: usize = 0,
    last_block: u64 = 0,
    last_cancel: ?*const std.atomic.Value(bool) = null,
    failure: ?anyerror = null,
    post_only: bool = false,

    fn interface(self: *NativeLookup) ccip.LookupSource {
        return .{ .context = self, .lookup_fn = lookup };
    }

    fn lookup(context: *anyopaque, a: A, module_address: [20]u8, _: protocol.Message, block_number: u64, cancel: ?*const std.atomic.Value(bool)) !ccip.Lookup {
        const self: *NativeLookup = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.last_block = block_number;
        self.last_cancel = cancel;
        if (self.failure) |failure| return failure;
        const bytes = try a.alloc(u8, (self.revert.len - 2) / 2);
        defer a.free(bytes);
        _ = try evm.codecs.decodeHex(bytes, self.revert);
        bytes[16..36].* = module_address;
        var decoded = try ccip.decode(a, bytes);
        if (self.post_only) decoded.urls[0] = decoded.urls[1];
        return decoded;
    }
};

const Origin = struct {
    hash: [64]u8,
    calls: usize = 0,

    fn init() Origin {
        var hash: [64]u8 = undefined;
        for (&hash, 0..) |*byte, index| byte.* = @truncate(index);
        return .{ .hash = hash };
    }

    fn interface(self: *Origin) sessions.OriginStore {
        return .{ .context = self, .dispatched_transaction_fn = fetch };
    }

    fn fetch(context: *anyopaque, _: Hash) !?[64]u8 {
        const self: *Origin = @ptrCast(@alignCast(context));
        self.calls += 1;
        return self.hash;
    }
};

const Signer = struct {
    calls: usize = 0,
    fail: bool = false,
    generation: u64 = 1,
    last_generation: u64 = 0,

    fn interface(self: *Signer) !ccip.Signer {
        return .{ .context = self, .address = try protocol.signature.secretKeyAddress(@splat(0x11)), .sign_digest = sign };
    }

    fn sign(context: *anyopaque, digest: Hash, _: ?*const std.atomic.Value(bool)) ![65]u8 {
        const self: *Signer = @ptrCast(@alignCast(context));
        self.calls += 1;
        self.last_generation = self.generation;
        if (self.fail) return error.FixtureCredentialExpired;
        return protocol.signature.signDigest(@splat(0x11), digest, null);
    }
};

const Outcome = enum { pending, hard, retry, ready, malformed, cancel, ready_cancel, gate };
const Http = struct {
    outcomes: []const Outcome = &.{.ready},
    calls: usize = 0,
    posts: usize = 0,
    full_origin_ok: bool = true,
    expected_origin: [64]u8,
    cancel: ?*std.atomic.Value(bool) = null,
    last_cancel: ?*const std.atomic.Value(bool) = null,
    entered: std.atomic.Value(bool) = .init(false),
    gate: bool = false,
    mutex: std.Thread.Mutex = .{},
    condition: std.Thread.Condition = .{},

    fn interface(self: *Http) sessions.StepFixture {
        return .{ .context = self, .step_fn = step };
    }

    fn open(self: *Http) void {
        self.mutex.lock();
        self.gate = true;
        self.condition.broadcast();
        self.mutex.unlock();
    }

    fn step(context: *anyopaque, session: *ccip.Session, a: A, now: u64, origin: ?[]const u8, cache: ?*ccip.SignatureCache, signer: ?ccip.Signer, provider: ?ccip.SignerProvider, cancel: ?*const std.atomic.Value(bool)) !ccip.Step {
        const self: *Http = @ptrCast(@alignCast(context));
        self.last_cancel = cancel;
        var request = try ccip.prepareLazy(a, session.lookup, session.lookup.urls[session.attempt.url_index], origin, cache, signer, provider, cancel);
        defer request.deinit();
        self.calls += 1;
        if (request.request.method == .post) {
            self.posts += 1;
            const text = origin orelse return error.MissingOriginTransaction;
            if (text.len != 130) return error.TruncatedOriginTransaction;
            var decoded: [64]u8 = undefined;
            _ = try evm.codecs.decodeHex(&decoded, text);
            self.full_origin_ok = self.full_origin_ok and std.mem.eql(u8, &decoded, &self.expected_origin);
            var parsed = try std.json.parseFromSlice(std.json.Value, a, request.body.?, .{});
            defer parsed.deinit();
            if (!std.mem.eql(u8, parsed.value.object.get("origin_tx_hash").?.string, text)) return error.OriginTransactionBodyMismatch;
        }
        const outcome = self.outcomes[@min(self.calls - 1, self.outcomes.len - 1)];
        switch (outcome) {
            .retry => return .{ .retry_at_ms = now },
            .pending => {
                session.attempt.pending(now);
                return if (session.attempt.url_index == session.lookup.urls.len) .exhausted else .{ .retry_at_ms = session.attempt.ready_at_ms };
            },
            .hard, .malformed => {
                if (outcome == .malformed) _ = ccip.decodeResponse(a, 200, "not-json") catch {};
                session.attempt.hardFailure();
                return if (session.attempt.url_index == session.lookup.urls.len) .exhausted else .{ .retry_at_ms = now };
            },
            .cancel => {
                self.cancel.?.store(true, .release);
                return error.RequestCancelled;
            },
            .ready_cancel => self.cancel.?.store(true, .release),
            .gate => {
                self.entered.store(true, .release);
                self.mutex.lock();
                while (!self.gate) self.condition.wait(&self.mutex);
                self.mutex.unlock();
            },
            .ready => {},
        }
        session.attempt.done = true;
        return .{ .ready = try a.dupe(u8, &.{ 0xde, 0xad }) };
    }
};

const Fixture = struct {
    allocator: A,
    revert: []u8,
    owner: sessions.Owner,
    native: curl.Client,
    cache: ccip.SignatureCache,
    origin: Origin,
    signer: Signer,
    http: Http,
    rpc: Rpc,
    client: evm.RpcClient,
    context_hash: Hash = @splat(9),

    fn init(a: A, options: sessions.Options) !*Fixture {
        return initRevert(a, options, null);
    }

    fn initRevert(a: A, options: sessions.Options, replacement: ?[]const u8) !*Fixture {
        const self = try a.create(Fixture);
        errdefer a.destroy(self);
        self.allocator = a;
        self.context_hash = @splat(9);
        self.revert = if (replacement) |text| try a.dupe(u8, text) else try lookupText(a);
        errdefer a.free(self.revert);
        self.owner = try sessions.Owner.init(a, options);
        errdefer self.owner.deinit();
        self.native = try curl.Client.init(a, curl_library);
        errdefer self.native.deinit();
        self.cache = try ccip.SignatureCache.init(a, 8);
        errdefer self.cache.deinit();
        self.origin = Origin.init();
        self.signer = .{};
        self.http = .{ .expected_origin = self.origin.hash };
        self.rpc = .{ .revert = self.revert };
        self.client = try evm.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = self.rpc.exchange() });
        errdefer self.client.deinit();
        return self;
    }

    fn deinit(self: *Fixture) void {
        self.client.deinit();
        self.owner.deinit();
        self.cache.deinit();
        self.native.deinit();
        self.allocator.free(self.revert);
        self.allocator.destroy(self);
    }

    fn bind(self: *Fixture, allocator: A, now: u64) !*sessions.Binding {
        return self.owner.bind(.{
            .allocator = allocator,
            .origin_store = self.origin.interface(),
            .client = &self.client,
            .native = &self.native,
            .signer = try self.signer.interface(),
            .signature_cache = &self.cache,
            .block_number = 42,
            .now_ms = now,
            .context_hash = self.context_hash,
        });
    }
};

fn expectPending(bound: *sessions.Binding, msg: protocol.Message, retry_at: u64) !void {
    try std.testing.expectError(error.CcipReadPending, bound.fetch(ism, msg));
    try std.testing.expectEqual(retry_at, bound.retryAt().?);
}

fn expectPendingAt(bound: *sessions.Binding, address: [20]u8, msg: protocol.Message, retry_at: u64) !void {
    try std.testing.expectError(error.CcipReadPending, bound.fetch(address, msg));
    try std.testing.expectEqual(retry_at, bound.retryAt().?);
}

test "CCIP owner preserves ten pending delays ordered fallback and metadata cache" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .max_sessions = 2 });
    defer fixture.deinit();
    const pending = [_]Outcome{.pending} ** 11;
    const outcomes = pending ++ [_]Outcome{.ready};
    fixture.http.outcomes = &outcomes;
    fixture.owner.installFixtureStep(fixture.http.interface());
    const msg = message(1000, 7);
    for (0..11) |index| {
        const bound = try fixture.bind(a, index * 1000);
        defer bound.deinit();
        try expectPending(bound, msg, if (index < 10) (index + 1) * 1000 else 0);
    }
    const bound = try fixture.bind(a, 11000);
    defer bound.deinit();
    const metadata = try bound.handler().fetch(ism, msg);
    defer a.free(metadata);
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad }, metadata);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    try std.testing.expect(fixture.rpc.pinned_ok and fixture.rpc.selector_ok and fixture.http.full_origin_ok);

    var caller_arena = std.heap.ArenaAllocator.init(a);
    defer caller_arena.deinit();
    const cached = try fixture.bind(caller_arena.allocator(), 50000);
    defer cached.deinit();
    const again = try cached.fetch(ism, msg);
    try std.testing.expectEqualSlices(u8, metadata, again);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);
    try std.testing.expectEqual(outcomes.len, fixture.http.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
}

test "CCIP authentication error is retryable and refreshed credentials precede cache hit" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    const outcomes = [_]Outcome{ .hard, .retry, .ready };
    fixture.http.outcomes = &outcomes;
    fixture.owner.installFixtureStep(fixture.http.interface());
    const msg = message(1000, 8);
    var bound = try fixture.bind(a, 0);
    try expectPending(bound, msg, 0);
    bound.deinit();

    fixture.signer.fail = true;
    bound = try fixture.bind(a, 0);
    try std.testing.expectError(error.FixtureCredentialExpired, bound.fetch(ism, msg));
    bound.deinit();
    fixture.signer.fail = false;
    fixture.signer.generation = 2;
    bound = try fixture.bind(a, 0);
    try expectPending(bound, msg, 0);
    bound.deinit();
    bound = try fixture.bind(a, 0);
    const metadata = try bound.fetch(ism, msg);
    bound.deinit();
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 2), fixture.signer.calls);
    try std.testing.expectEqual(@as(u64, 2), fixture.signer.last_generation);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);
}

test "CCIP canonical context and origin domain keys cannot share sessions" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .max_sessions = 2 });
    defer fixture.deinit();
    fixture.owner.installFixtureStep(fixture.http.interface());
    const msg = message(1000, 9);
    var bound = try fixture.bind(a, 0);
    var metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.deinit();
    bound = try fixture.bind(a, 1);
    metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);

    fixture.context_hash = @splat(8);
    bound = try fixture.bind(a, 2);
    metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.context.block_number = 43;
    metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.rpc.calls);

    const other_origin = message(1001, 9);
    try std.testing.expect(!std.mem.eql(u8, &msg.id(), &other_origin.id()));
    bound = try fixture.bind(a, 3);
    metadata = try bound.fetch(ism, other_origin);
    a.free(metadata);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 3), fixture.rpc.calls);
    try std.testing.expectEqual(@as(usize, 2), fixture.owner.stats().sessions);

    fixture.context_hash = @splat(9);
    bound = try fixture.bind(a, 4);
    bound.context.block_number = 42;
    metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 4), fixture.rpc.calls);
}

test "CCIP advancing blocks preserve pending retries while context and message changes reset" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    const outcomes = [_]Outcome{.pending};
    fixture.http.outcomes = &outcomes;
    fixture.owner.installFixtureStep(fixture.http.interface());
    fixture.rpc.expected_block = "0xa";
    const msg = message(1000, 18);
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.block_number = 10;
    try expectPending(bound, msg, 1000);
    try std.testing.expectEqual(@as(?u64, 1000), fixture.owner.pendingDelayFor(fixture.context_hash, ism, msg, 0));

    bound.context.block_number = 11;
    bound.context.now_ms = 1000;
    try expectPending(bound, msg, 2000);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);
    try std.testing.expectEqual(@as(?u64, 1000), fixture.owner.pendingDelayFor(fixture.context_hash, ism, msg, 1000));

    bound.context.block_number = 12;
    bound.context.now_ms = 2000;
    bound.context.context_hash = @splat(8);
    try expectPending(bound, msg, 3000);
    try std.testing.expectEqual(@as(usize, 2), fixture.rpc.calls);

    bound.context.now_ms = 3000;
    try expectPending(bound, message(1000, 19), 4000);
    try std.testing.expectEqual(@as(usize, 3), fixture.rpc.calls);
}

test "CCIP pendingDelayForMessage returns minimum live delay across ISMs" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .cache_ttl_ms = 1000, .active_ttl_ms = 1000 });
    defer fixture.deinit();
    // Context isolation requires an initialized, nonzero fixture identity.
    // allocator.create does not apply a struct field's declared default.
    try std.testing.expectEqualSlices(u8, &(@as(Hash, @splat(9))), &fixture.context_hash);
    const outcomes = [_]Outcome{.pending};
    fixture.http.outcomes = &outcomes;
    fixture.owner.installFixtureStep(fixture.http.interface());
    var first_lookup: NativeLookup = .{ .revert = fixture.revert };
    var second_lookup: NativeLookup = .{ .revert = fixture.revert };
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.client = null;
    bound.context.native_lookup = first_lookup.interface();
    const msg = message(1000, 33);
    try expectPending(bound, msg, 1000);
    const other_ism: [20]u8 = @splat(4);
    bound.context.native_lookup = second_lookup.interface();
    bound.context.now_ms = 500;
    try expectPendingAt(bound, other_ism, msg, 1500);
    bound.context.now_ms = 1000;
    try expectPendingAt(bound, other_ism, msg, 2000);
    try std.testing.expectEqual(@as(?u64, 1000), fixture.owner.pendingDelayForMessage(fixture.context_hash, msg, 0));
    try std.testing.expectEqual(@as(?u64, 500), fixture.owner.pendingDelayForMessage(fixture.context_hash, msg, 500));
    try std.testing.expectEqual(@as(?u64, 1000), fixture.owner.pendingDelayForMessage(fixture.context_hash, msg, 1000));
    try std.testing.expectEqual(@as(?u64, null), fixture.owner.pendingDelayForMessage(fixture.context_hash, msg, 2000));
    try std.testing.expectEqual(@as(?u64, null), fixture.owner.pendingDelayForMessage(@splat(0), msg, 500));
}

test "CCIP lookup cache has fixed creation expiration and OptionalCache disabled semantics" {
    const a = std.testing.allocator;
    var expiring = try Fixture.init(a, .{ .cache_ttl_ms = 1000, .active_ttl_ms = 1500 });
    defer expiring.deinit();
    const outcomes = [_]Outcome{.pending};
    expiring.http.outcomes = &outcomes;
    expiring.owner.installFixtureStep(expiring.http.interface());
    const msg = message(1000, 20);
    var bound = try expiring.bind(a, 0);
    try expectPending(bound, msg, 1000);
    bound.context.block_number = 11;
    bound.context.now_ms = 999;
    try expectPending(bound, msg, 1999);
    try std.testing.expectEqual(@as(usize, 1), expiring.rpc.calls);
    bound.context.now_ms = 1000;
    try expectPending(bound, msg, 2000);
    try std.testing.expectEqual(@as(usize, 1), expiring.rpc.calls);
    bound.context.now_ms = 1500;
    try expectPending(bound, msg, 2500);
    try std.testing.expectEqual(@as(usize, 2), expiring.rpc.calls);
    bound.deinit();

    var disabled = try Fixture.init(a, .{ .allow_caching = false });
    defer disabled.deinit();
    disabled.http.outcomes = &outcomes;
    disabled.owner.installFixtureStep(disabled.http.interface());
    bound = try disabled.bind(a, 0);
    defer bound.deinit();
    try expectPending(bound, msg, 1000);
    bound.context.block_number = 11;
    bound.context.now_ms = 1000;
    try expectPending(bound, msg, 2000);
    try std.testing.expectEqual(@as(usize, 1), disabled.rpc.calls);
    const ready = [_]Outcome{.ready};
    disabled.http.outcomes = &ready;
    var metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), disabled.rpc.calls);
    const other = try disabled.bind(a, 1000);
    defer other.deinit();
    metadata = try other.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 2), disabled.rpc.calls);
}

test "CCIP handler fork owns independent Binding RPC identity and cancellation" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    fixture.owner.installFixtureStep(fixture.http.interface());
    fixture.rpc.expected_block = "0xa";
    var operation_cancel = std.atomic.Value(bool).init(false);
    var independent = try evm.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.rpc.exchange(), .cancel = &operation_cancel });
    defer independent.deinit();
    independent.next_id = 77;

    var root = try fixture.bind(a, 0);
    var root_handler = root.handler();
    var root_alive = true;
    defer if (root_alive) root_handler.deinit();
    var forked = try root_handler.fork(a, &independent, 10, &operation_cancel);
    var forked_alive = true;
    defer if (forked_alive) forked.deinit();
    root_handler.deinit();
    root_alive = false;

    const metadata = try forked.fetch(ism, message(1000, 21));
    a.free(metadata);
    try std.testing.expectEqual(@as(i64, 77), fixture.rpc.last_id);
    try std.testing.expectEqual(@as(i64, 1), fixture.client.next_id);
    try std.testing.expect(fixture.rpc.last_cancel == &operation_cancel);
    try std.testing.expect(fixture.http.last_cancel == &operation_cancel);
    forked.deinit();
    forked_alive = false;

    const rebound = try fixture.bind(a, 1);
    defer rebound.deinit();
    rebound.context.client = &independent;
    rebound.context.block_number = 10;
    rebound.context.cancel = &operation_cancel;
    const reused = try rebound.fetch(ism, message(1000, 22));
    a.free(reused);
    try std.testing.expectEqual(@as(i64, 78), fixture.rpc.last_id);
}

test "CCIP PendingReadIo yields without session URL or signature side effects" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .cache_ttl_ms = 1000 });
    defer fixture.deinit();
    fixture.owner.installFixtureStep(fixture.http.interface());
    fixture.rpc.pending_reads = 1;
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    const msg = message(1000, 23);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(?u64, null), bound.retryAt());
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().sessions);
    try std.testing.expectEqual(@as(usize, 0), fixture.http.calls);
    try std.testing.expectEqual(@as(usize, 0), fixture.signer.calls);
    bound.context.now_ms = 5000;
    const metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    bound.context.now_ms = 5001;
    bound.context.block_number = 11;
    const cached = try bound.fetch(ism, msg);
    a.free(cached);
    try std.testing.expectEqual(@as(usize, 2), fixture.rpc.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.http.calls);
}

test "CCIP malformed revert and responses retire entries and enforce byte budget" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    fixture.rpc.malformed = true;
    var bound = try fixture.bind(a, 0);
    try std.testing.expectError(error.InvalidOffchainLookup, bound.fetch(ism, message(1000, 10)));
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().sessions);

    fixture.rpc.malformed = false;
    const outcomes = [_]Outcome{ .malformed, .malformed };
    fixture.http.outcomes = &outcomes;
    fixture.owner.installFixtureStep(fixture.http.interface());
    bound = try fixture.bind(a, 0);
    try expectPending(bound, message(1000, 10), 0);
    try std.testing.expectError(error.CcipReadExhausted, bound.fetch(ism, message(1000, 10)));
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().sessions);

    var limited = try Fixture.init(a, .{ .max_bytes = 1 });
    defer limited.deinit();
    limited.owner.installFixtureStep(limited.http.interface());
    bound = try limited.bind(a, 0);
    try std.testing.expectError(error.CcipSessionMemoryLimit, bound.fetch(ism, message(1000, 11)));
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 0), limited.owner.stats().sessions);
}

test "CCIP cancellation retires borrow without retaining the job token" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    var cancelled = std.atomic.Value(bool).init(true);
    var bound = try fixture.bind(a, 0);
    bound.context.cancel = &cancelled;
    try std.testing.expectError(error.RequestCancelled, bound.fetch(ism, message(1000, 12)));
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().sessions);
    cancelled.store(false, .release);
    const outcomes = [_]Outcome{ .cancel, .ready };
    fixture.http.outcomes = &outcomes;
    fixture.http.cancel = &cancelled;
    fixture.owner.installFixtureStep(fixture.http.interface());
    try std.testing.expectError(error.RequestCancelled, bound.fetch(ism, message(1000, 12)));
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().borrowed);
    cancelled.store(false, .release);
    const metadata = try bound.fetch(ism, message(1000, 12));
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);

    const raced = [_]Outcome{ .ready_cancel, .ready };
    fixture.http.outcomes = &raced;
    fixture.http.calls = 0;
    const raced_message = message(1000, 17);
    try std.testing.expectError(error.RequestCancelled, bound.fetch(ism, raced_message));
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().borrowed);
    cancelled.store(false, .release);
    const retried = try bound.fetch(ism, raced_message);
    a.free(retried);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 3), fixture.rpc.calls);
}

test "CCIP native lookup fork replaces source client allocator and cancellation" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    fixture.owner.installFixtureStep(fixture.http.interface());
    var parent_lookup: NativeLookup = .{ .revert = fixture.revert };
    var child_lookup: NativeLookup = .{ .revert = fixture.revert, .failure = error.PendingReadIo };
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var operation_cancel = std.atomic.Value(bool).init(false);
    const root = try fixture.bind(a, 0);
    root.context.native_lookup = parent_lookup.interface();
    var root_handler = root.handler();
    const direct = try root_handler.fetch(ism, message(1000, 32));
    a.free(direct);
    try std.testing.expectEqual(@as(usize, 1), parent_lookup.calls);
    try std.testing.expectEqual(@as(usize, 0), fixture.rpc.calls);
    var child = try root_handler.nativeFork(arena.allocator(), child_lookup.interface(), 10, &operation_cancel);
    defer child.deinit();
    root_handler.deinit();
    const msg = message(1000, 30);
    try std.testing.expectError(error.PendingReadIo, child.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), fixture.http.calls);
    child_lookup.failure = null;
    const metadata = try child.fetch(ism, msg);
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad }, metadata);
    try std.testing.expectEqual(@as(usize, 1), parent_lookup.calls);
    try std.testing.expectEqual(@as(usize, 2), child_lookup.calls);
    try std.testing.expectEqual(@as(u64, 10), child_lookup.last_block);
    try std.testing.expect(child_lookup.last_cancel == &operation_cancel);
    try std.testing.expectEqual(@as(usize, 0), fixture.rpc.calls);

    var address: [32]u8 = @splat(0);
    address[12] = 7;
    try std.testing.expectEqual(@as(u8, 7), (try ccip.nativeAddress(address))[0]);
    address[0] = 1;
    try std.testing.expectError(error.InvalidNativeModuleAddress, ccip.nativeAddress(address));
}

test "CCIP binding rejects missing lookup and half retained signer" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    defer fixture.deinit();
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    var context = bound.context;
    context.client = null;
    try std.testing.expectError(error.InvalidCcipLookupSource, fixture.owner.bind(context));
    const Hooks = struct {
        fn retain(_: *anyopaque) void {}
    };
    var native_lookup: NativeLookup = .{ .revert = fixture.revert };
    context.native_lookup = native_lookup.interface();
    var retained_signer = try fixture.signer.interface();
    retained_signer.retain_fn = Hooks.retain;
    context.signer = retained_signer;
    try std.testing.expectError(error.InvalidCcipSignerLifetime, fixture.owner.bind(context));
}

fn nativeAllocationSweep(a: A) !void {
    var budget: byte_budget.Budget = .{ .maximum = 64 * 1024 * 1024 };
    var fixture = try Fixture.init(a, .{ .shared_budget = &budget });
    defer {
        fixture.deinit();
        std.testing.expectEqual(@as(usize, 0), budget.used) catch @panic("CCIP shared budget leak");
    }
    fixture.owner.installFixtureStep(fixture.http.interface());
    var native_lookup: NativeLookup = .{ .revert = fixture.revert };
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.client = null;
    bound.context.native_lookup = native_lookup.interface();
    const metadata = try bound.fetch(ism, message(1000, 31));
    a.free(metadata);
}

test "CCIP native lookup and metadata ownership survive allocation failure sweep" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, nativeAllocationSweep, .{});
}

test "CCIP shared global cap releases across independent owners" {
    const a = std.testing.allocator;
    var budget: byte_budget.Budget = .{ .maximum = 64 * 1024 * 1024 };
    const outcomes = [_]AsyncOutcome{.stall};
    var first = try Fixture.init(a, .{ .shared_budget = &budget });
    var first_backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    const first_bound = try first.bind(a, 0);
    var first_alive = true;
    defer if (first_alive) {
        first_bound.deinit();
        first.deinit();
        first_backend.deinit();
    };
    first_bound.context.async_fixture = first_backend.interface();
    const msg = message(1000, 36);
    try std.testing.expectError(error.PendingReadIo, first_bound.fetch(ism, msg));
    try std.testing.expect(budget.used > 0);
    budget.maximum = budget.used;

    var second = try Fixture.init(a, .{ .shared_budget = &budget });
    var second_backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        second.deinit();
        second_backend.deinit();
    }
    const second_bound = try second.bind(a, 0);
    defer second_bound.deinit();
    second_bound.context.async_fixture = second_backend.interface();
    try std.testing.expectError(error.ReadReplayGlobalByteBudgetExceeded, second_bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 0), second_backend.submits);
    first_bound.deinit();
    first.deinit();
    first_backend.deinit();
    first_alive = false;
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try std.testing.expectError(error.PendingReadIo, second_bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), second_backend.submits);
}

const AsyncOutcome = enum { stall, ready, pending, hard };
const AsyncFixture = struct {
    allocator: A,
    outcomes: []const AsyncOutcome,
    active: bool = false,
    submits: usize = 0,
    polls: usize = 0,
    cancels: usize = 0,
    public_only: bool = false,
    origin: ?[]u8 = null,
    url: ?[]u8 = null,
    body: ?[]u8 = null,

    fn interface(self: *AsyncFixture) ccip.AsyncTransport {
        return .{ .context = self, .has_active_fn = hasActive, .submit_fn = submit, .poll_fn = poll, .cancel_fn = cancel };
    }

    fn hasActive(context: *anyopaque) bool {
        const self: *AsyncFixture = @ptrCast(@alignCast(context));
        return self.active;
    }

    fn clearRequest(self: *AsyncFixture) void {
        if (self.url) |url| self.allocator.free(url);
        if (self.body) |body| self.allocator.free(body);
        self.url = null;
        self.body = null;
    }

    fn deinit(self: *AsyncFixture) void {
        self.clearRequest();
        if (self.origin) |origin| self.allocator.free(origin);
    }

    fn submit(context: *anyopaque, request: curl.Request) !void {
        const self: *AsyncFixture = @ptrCast(@alignCast(context));
        if (self.active) return error.DuplicateAsyncSubmit;
        self.clearRequest();
        self.url = try self.allocator.dupe(u8, request.url);
        self.body = if (request.body) |body| try self.allocator.dupe(u8, body) else null;
        self.public_only = request.public_only;
        self.active = true;
        self.submits += 1;
        if (request.body) |body| {
            var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, body, .{});
            defer parsed.deinit();
            const origin = parsed.value.object.get("origin_tx_hash").?.string;
            if (origin.len != 130) return error.TruncatedOriginTransaction;
            if (self.origin) |old| self.allocator.free(old);
            self.origin = try self.allocator.dupe(u8, origin);
        }
    }

    fn response(self: *AsyncFixture, body: []const u8) !curl.Response {
        const owned = try self.allocator.dupe(u8, body);
        return .{ .allocator = self.allocator, .status = 200, .http_version = 2, .body = owned, .headers = try self.allocator.alloc(curl.Header, 0), .header_storage = try self.allocator.alloc(u8, 0) };
    }

    fn poll(context: *anyopaque) !?curl.Response {
        const self: *AsyncFixture = @ptrCast(@alignCast(context));
        if (!self.active) return error.InvalidAsyncPoll;
        const outcome = self.outcomes[@min(self.polls, self.outcomes.len - 1)];
        self.polls += 1;
        switch (outcome) {
            .stall => return null,
            .hard => {
                self.active = false;
                return error.CurlTransportFailed;
            },
            .pending => {
                self.active = false;
                return try self.response("{\"status\":\"pending\"}");
            },
            .ready => {
                self.active = false;
                return try self.response("{\"data\":\"0xdead\"}");
            },
        }
    }

    fn cancel(context: *anyopaque) void {
        const self: *AsyncFixture = @ptrCast(@alignCast(context));
        self.active = false;
        self.cancels += 1;
        self.clearRequest();
    }
};

test "CCIP async submits once across stalls and never reruns POST signing" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    const outcomes = [_]AsyncOutcome{ .hard, .stall, .ready };
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        fixture.deinit();
        backend.deinit();
    }
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.async_fixture = backend.interface();
    const msg = message(1000, 24);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try expectPending(bound, msg, 0);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    try std.testing.expectEqual(@as(usize, 2), backend.submits);
    try std.testing.expect(backend.public_only and backend.origin != null);
    const metadata = try bound.fetch(ism, msg);
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad }, metadata);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    try std.testing.expectEqual(@as(usize, 2), backend.submits);
    try std.testing.expectEqual(@as(usize, 3), backend.polls);
    try std.testing.expectEqual(@as(usize, 4), fixture.owner.stats().bytes);
}

test "CCIP disabled cache memo survives verification PIO and releases shared quota" {
    const a = std.testing.allocator;
    var budget: byte_budget.Budget = .{ .maximum = 64 * 1024 * 1024 };
    var fixture = try Fixture.init(a, .{ .allow_caching = false, .shared_budget = &budget });
    defer fixture.deinit();
    const outcomes = [_]AsyncOutcome{ .ready, .ready, .ready };
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer backend.deinit();
    var native_lookup: NativeLookup = .{ .revert = fixture.revert, .post_only = true };
    var operation_cancel = std.atomic.Value(bool).init(false);
    const bound = try fixture.bind(a, 0);
    bound.context.client = null;
    bound.context.native_lookup = native_lookup.interface();
    bound.context.async_fixture = backend.interface();
    bound.context.cancel = &operation_cancel;
    const msg = message(1000, 35);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    var metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 2), budget.used);

    metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 1), native_lookup.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);

    var root_handler = bound.handler();
    var forked = try root_handler.nativeFork(a, native_lookup.interface(), 42, &operation_cancel);
    metadata = try forked.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 4), budget.used);
    forked.deinit();

    const other = try fixture.bind(a, 0);
    other.context.client = null;
    other.context.native_lookup = native_lookup.interface();
    other.context.async_fixture = backend.interface();
    try std.testing.expectError(error.PendingReadIo, other.fetch(ism, msg));
    metadata = try other.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 2), backend.submits);
    try std.testing.expectEqual(@as(usize, 2), native_lookup.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    try std.testing.expectEqual(@as(usize, 4), budget.used);
    other.deinit();
    root_handler.deinit();
    try std.testing.expectEqual(@as(usize, 0), budget.used);
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().bytes);
}

test "CCIP disabled cache preserves native async continuation without duplicate signing" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .allow_caching = false });
    const outcomes = [_]AsyncOutcome{ .stall, .ready, .ready };
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        fixture.deinit();
        backend.deinit();
    }
    var native_lookup: NativeLookup = .{ .revert = fixture.revert, .post_only = true };
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.client = null;
    bound.context.native_lookup = native_lookup.interface();
    bound.context.async_fixture = backend.interface();
    const msg = message(1000, 34);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 1), native_lookup.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    var metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 1), native_lookup.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
    const other = try fixture.bind(a, 0);
    defer other.deinit();
    other.context.client = null;
    other.context.native_lookup = native_lookup.interface();
    other.context.async_fixture = backend.interface();
    try std.testing.expectError(error.PendingReadIo, other.fetch(ism, msg));
    metadata = try other.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 2), backend.submits);
    try std.testing.expectEqual(@as(usize, 2), native_lookup.calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.signer.calls);
}

test "CCIP async cancel drains retained handle before clean resubmission" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{});
    const outcomes = [_]AsyncOutcome{ .stall, .ready };
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        fixture.deinit();
        backend.deinit();
    }
    var cancelled = std.atomic.Value(bool).init(false);
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.async_fixture = backend.interface();
    bound.context.cancel = &cancelled;
    const msg = message(1000, 25);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    cancelled.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 1), backend.cancels);
    try std.testing.expect(!backend.active);
    cancelled.store(false, .release);
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, msg));
    const metadata = try bound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 2), backend.submits);
}

test "CCIP async retained callback outlives fork and TTL expiry cancels old attempt" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .cache_ttl_ms = 1000, .active_ttl_ms = 1000 });
    const outcomes = [_]AsyncOutcome{ .stall, .ready };
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        fixture.deinit();
        backend.deinit();
    }
    var independent = try evm.RpcClient.init(a, "http://127.0.0.1:1", .{ .exchange = fixture.rpc.exchange() });
    defer independent.deinit();
    var operation_cancel = std.atomic.Value(bool).init(false);
    const root = try fixture.bind(a, 0);
    root.context.async_fixture = backend.interface();
    var root_handler = root.handler();
    var forked = try root_handler.fork(a, &independent, 10, &operation_cancel);
    root_handler.deinit();
    const msg = message(1000, 26);
    try std.testing.expectError(error.PendingReadIo, forked.fetch(ism, msg));
    forked.deinit();

    const rebound = try fixture.bind(a, 0);
    rebound.context.async_fixture = backend.interface();
    try std.testing.expectError(error.PendingReadIo, rebound.fetch(ism, msg));
    const metadata = try rebound.fetch(ism, msg);
    a.free(metadata);
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 1), fixture.rpc.calls);

    const other = message(1000, 27);
    try std.testing.expectError(error.PendingReadIo, rebound.fetch(ism, other));
    rebound.context.now_ms = 2000;
    try std.testing.expectError(error.PendingReadIo, rebound.fetch(ism, other));
    try std.testing.expectEqual(@as(usize, 1), backend.cancels);
    try std.testing.expectEqual(@as(usize, 3), backend.submits);
    try std.testing.expectEqual(@as(usize, 3), fixture.rpc.calls);
    const refreshed = try rebound.fetch(ism, other);
    a.free(refreshed);
    rebound.deinit();
}

test "CCIP async retained request bytes reject before submit without URL advance" {
    const a = std.testing.allocator;
    const outcomes = [_]AsyncOutcome{.stall};
    var required: usize = 0;
    {
        var probe = try Fixture.init(a, .{});
        var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
        defer {
            probe.deinit();
            backend.deinit();
        }
        const bound = try probe.bind(a, 0);
        defer bound.deinit();
        bound.context.async_fixture = backend.interface();
        try std.testing.expectError(error.PendingReadIo, bound.fetch(ism, message(1000, 29)));
        required = probe.owner.stats().bytes;
    }
    try std.testing.expect(required > 2);
    var fixture = try Fixture.init(a, .{ .max_bytes = required - 1 });
    var backend: AsyncFixture = .{ .allocator = a, .outcomes = &outcomes };
    defer {
        fixture.deinit();
        backend.deinit();
    }
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.async_fixture = backend.interface();
    try std.testing.expectError(error.CcipSessionMemoryLimit, bound.fetch(ism, message(1000, 29)));
    try std.testing.expectEqual(@as(usize, 0), backend.submits);
    try std.testing.expect(!backend.active);
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().borrowed);
}

test "CCIP async native Runtime rejects private destinations before KMS" {
    const a = std.testing.allocator;
    const runtime = try http_runtime.Runtime.start(a, .{ .multi = .{
        .library_path = curl_library,
        .max_concurrent = 2,
        .max_pending = 4,
        .max_response_bytes = ccip.max_response_bytes,
        .max_request_bytes = ccip.max_response_bytes,
        .max_reserved_bytes = 4 * 1024 * 1024,
    }, .max_sessions = 4 });
    defer runtime.deinit();
    const revert = try loopbackLookupText(a);
    defer a.free(revert);
    var fixture = try Fixture.initRevert(a, .{}, revert);
    defer fixture.deinit();
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    bound.context.runtime = runtime;
    const msg = message(1000, 28);
    try expectPending(bound, msg, 0);
    try std.testing.expectError(error.CcipReadExhausted, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 0), fixture.signer.calls);
}

const ThreadFetch = struct {
    bound: *sessions.Binding,
    msg: protocol.Message,
    result: ?[]u8 = null,
    failure: ?anyerror = null,

    fn run(self: *ThreadFetch) void {
        self.result = self.bound.fetch(ism, self.msg) catch |err| {
            self.failure = err;
            return;
        };
    }
};

test "CCIP borrowed entry cannot be evicted and same key does not race" {
    const a = std.testing.allocator;
    var fixture = try Fixture.init(a, .{ .max_sessions = 1 });
    defer fixture.deinit();
    const first = message(1000, 13);
    const initial = [_]Outcome{.pending};
    fixture.http.outcomes = &initial;
    fixture.owner.installFixtureStep(fixture.http.interface());
    var bound = try fixture.bind(a, 0);
    try expectPending(bound, first, 1000);
    bound.deinit();

    const gated = [_]Outcome{.gate};
    fixture.http.outcomes = &gated;
    bound = try fixture.bind(a, 1000);
    var worker: ThreadFetch = .{ .bound = bound, .msg = first };
    const thread = try std.Thread.spawn(.{}, ThreadFetch.run, .{&worker});
    var joined = false;
    defer {
        fixture.http.open();
        if (!joined) thread.join();
    }
    while (!fixture.http.entered.load(.acquire)) std.Thread.yield() catch {};
    var other = try fixture.bind(a, 1000);
    defer other.deinit();
    try std.testing.expectError(error.CcipSessionCapacity, other.fetch(ism, message(1000, 14)));
    try expectPending(other, first, 2000);
    fixture.http.open();
    thread.join();
    joined = true;
    try std.testing.expectEqual(@as(?anyerror, null), worker.failure);
    a.free(worker.result.?);
    bound.deinit();
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().borrowed);
}

test "CCIP native public egress rejects every literal before KMS" {
    const a = std.testing.allocator;
    const revert = try loopbackLookupText(a);
    defer a.free(revert);
    var fixture = try Fixture.initRevert(a, .{}, revert);
    defer fixture.deinit();
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    const msg = message(1000, 15);
    try expectPending(bound, msg, 0);
    try std.testing.expectError(error.CcipReadExhausted, bound.fetch(ism, msg));
    try std.testing.expectEqual(@as(usize, 0), fixture.signer.calls);
    try std.testing.expectEqual(@as(usize, 0), fixture.owner.stats().sessions);
}

fn allocationSweep(a: A) !void {
    var budget: byte_budget.Budget = .{ .maximum = 64 * 1024 * 1024 };
    var fixture = try Fixture.init(a, .{ .shared_budget = &budget });
    defer {
        fixture.deinit();
        std.testing.expectEqual(@as(usize, 0), budget.used) catch @panic("CCIP shared budget leak");
    }
    fixture.owner.installFixtureStep(fixture.http.interface());
    const bound = try fixture.bind(a, 0);
    defer bound.deinit();
    const metadata = try bound.fetch(ism, message(1000, 16));
    a.free(metadata);
}

test "CCIP owner and handler results survive allocation failure sweep" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}
