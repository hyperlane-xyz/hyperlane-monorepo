const std = @import("std");
const curl_library = if (@import("builtin").os.tag == .macos) "/usr/lib/libcurl.4.dylib" else "libcurl.so.4";
const ccs = @import("ccs_signer.zig");
const settings = @import("../../settings/root.zig");
const mock = @import("../../cloud/testing.zig");
const protocol = @import("../../protocol/root.zig");
const sessions = @import("ccip_sessions.zig");
const ccip = @import("../../relayer/ccip.zig");
const curl = @import("../../net/curl.zig");
const evm = @import("../../evm/root.zig");
const metadata_builder = @import("../../relayer/metadata.zig");
const storage = @import("../../storage/root.zig");
const A = std.mem.Allocator;

fn defaultsDir() []const u8 {
    std.fs.cwd().access("rust/main/config", .{}) catch return "../rust/main/config";
    return "rust/main/config";
}

fn fixtureSettings(a: A) !settings.Settings {
    return settings.Settings.load(a, .relayer, .{ .defaults_dir = defaultsDir(), .arguments = &.{"--relayChains=ethereum"} });
}

fn deadline() !u64 {
    const now = std.time.nanoTimestamp();
    if (now < 0) return error.UnsupportedClock;
    return (std.math.cast(u64, now) orelse return error.UnsupportedClock) + 5 * std.time.ns_per_s;
}

fn initOwner(a: A, s: *const settings.Settings, environment: *const std.process.EnvMap, network: *mock.Mock) !*ccs.Owner {
    return ccs.Owner.init(a, s, &s.chains[0], environment, .{
        .curl_library = curl_library,
        .credential_options = .{ .transport_override = network.transport() },
    });
}

test "CCS constructor is lazy and filtered chain signer never resolves transaction credentials" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].signer = .{ .aws = .{ .id = "alias/unused-transaction-key", .region = "us-east-1" } };
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const owner = try initOwner(a, &s, &environment, &network);
    defer owner.deinit();
    try std.testing.expectEqual(@as(usize, 0), owner.stats().identity_loads);
    try network.expectDone();

    const scope = (try owner.bind(null, try deadline())).?;
    defer scope.deinit();
    const signer = scope.signer();
    try std.testing.expectEqualSlices(u8, &try protocol.signature.secretKeyAddress(@splat(0x11)), &signer.address);
    const digest: [32]u8 = @splat(0x22);
    for (0..2) |_| {
        const signature = try signer.sign_digest(signer.context, digest, null);
        try std.testing.expectEqualSlices(u8, &signer.address, &try protocol.signature.recover(digest, signature));
    }
    const stats = owner.stats();
    try std.testing.expectEqual(@as(usize, 1), stats.identity_loads);
    try std.testing.expectEqual(@as(usize, 3), stats.leases);
    try std.testing.expectEqual(@as(usize, 2), stats.signatures);
    try std.testing.expect(!stats.cancel_installed);
    try network.expectDone();
}

test "CCS absent configuration has no identity work" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].signer = .{ .hex_key = @splat(0x11) };
    s.chains[0].ccs_signer = null;
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const owner = try initOwner(a, &s, &environment, &network);
    defer owner.deinit();
    try std.testing.expectEqual(@as(?*ccs.Scope, null), try owner.bind(null, try deadline()));
    try std.testing.expectEqual(@as(usize, 0), owner.stats().leases);
    try network.expectDone();
}

fn wrongDigestSignature(_: *anyopaque, digest: [32]u8) ![65]u8 {
    var changed = digest;
    changed[0] ^= 1;
    return protocol.signature.signDigest(@splat(0x11), changed, null);
}

test "CCS refreshed signature must recover the pinned identity and clears cancellation" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const owner = try initOwner(a, &s, &environment, &network);
    defer owner.deinit();
    var ignored: u8 = 0;
    owner.installFixtureSignature(&ignored, wrongDigestSignature);
    const scope = (try owner.bind(null, try deadline())).?;
    defer scope.deinit();
    const signer = scope.signer();
    try std.testing.expectError(error.CcsSignerIdentityMismatch, signer.sign_digest(signer.context, @splat(0x22), null));
    try std.testing.expectEqual(@as(usize, 0), owner.stats().signatures);
    try std.testing.expect(!owner.stats().cancel_installed);
}

const BlockingSignature = struct {
    entered: std.atomic.Value(bool) = .init(false),
    open: bool = false,
    mutex: std.Thread.Mutex = .{},
    condition: std.Thread.Condition = .{},

    fn sign(context: *anyopaque, digest: [32]u8) ![65]u8 {
        const self: *BlockingSignature = @ptrCast(@alignCast(context));
        self.entered.store(true, .release);
        self.mutex.lock();
        while (!self.open) self.condition.wait(&self.mutex);
        self.mutex.unlock();
        return protocol.signature.signDigest(@splat(0x11), digest, null);
    }

    fn release(self: *BlockingSignature) void {
        self.mutex.lock();
        self.open = true;
        self.condition.broadcast();
        self.mutex.unlock();
    }
};

const SignJob = struct {
    signer: @import("../../relayer/ccip.zig").Signer,
    cancel: ?*const std.atomic.Value(bool),
    failure: ?anyerror = null,

    fn run(self: *SignJob) void {
        _ = self.signer.sign_digest(self.signer.context, @splat(0x22), self.cancel) catch |err| {
            self.failure = err;
        };
    }
};

test "CCS concurrent gate wait observes operation cancel and completes refresh safely" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const owner = try initOwner(a, &s, &environment, &network);
    defer owner.deinit();
    const first_scope = (try owner.bind(null, try deadline())).?;
    defer first_scope.deinit();
    var cancelled = std.atomic.Value(bool).init(false);
    const second_scope = (try owner.bind(&cancelled, try deadline())).?;
    defer second_scope.deinit();
    var blocking: BlockingSignature = .{};
    owner.installFixtureSignature(&blocking, BlockingSignature.sign);
    var first: SignJob = .{ .signer = first_scope.signer(), .cancel = null };
    var second: SignJob = .{ .signer = second_scope.signer(), .cancel = &cancelled };
    const first_thread = try std.Thread.spawn(.{}, SignJob.run, .{&first});
    var first_joined = false;
    defer {
        blocking.release();
        if (!first_joined) first_thread.join();
    }
    while (!blocking.entered.load(.acquire)) std.Thread.yield() catch {};
    const second_thread = try std.Thread.spawn(.{}, SignJob.run, .{&second});
    cancelled.store(true, .release);
    blocking.release();
    first_thread.join();
    first_joined = true;
    second_thread.join();
    try std.testing.expectEqual(@as(?anyerror, null), first.failure);
    try std.testing.expectEqual(@as(?anyerror, error.RequestCancelled), second.failure);
    try std.testing.expectEqual(@as(usize, 1), owner.stats().signatures);
    try std.testing.expect(!owner.stats().cancel_installed);
}

const LifetimeLookup = struct {
    revert: []const u8,

    fn interface(self: *LifetimeLookup) ccip.LookupSource {
        return .{ .context = self, .lookup_fn = lookup };
    }

    fn lookup(context: *anyopaque, a: A, _: [20]u8, _: protocol.Message, _: u64, _: ?*const std.atomic.Value(bool)) !ccip.Lookup {
        const self: *LifetimeLookup = @ptrCast(@alignCast(context));
        const bytes = try a.alloc(u8, (self.revert.len - 2) / 2);
        defer a.free(bytes);
        _ = try evm.codecs.decodeHex(bytes, self.revert);
        return ccip.decode(a, bytes);
    }
};

const LifetimeFixture = struct {
    allocator: A,
    owner: sessions.Owner,
    native: curl.Client,
    cache: ccip.SignatureCache,
    lookup: LifetimeLookup,
    hash: [64]u8,

    fn init(a: A) !*LifetimeFixture {
        const self = try a.create(LifetimeFixture);
        errdefer a.destroy(self);
        self.allocator = a;
        self.owner = try sessions.Owner.init(a, .{});
        errdefer self.owner.deinit();
        self.native = try curl.Client.init(a, curl_library);
        errdefer self.native.deinit();
        self.cache = try ccip.SignatureCache.init(a, 4);
        errdefer self.cache.deinit();
        var parsed = try std.json.parseFromSlice(std.json.Value, a, @embedFile("../../relayer/testing/ccip-lookup.json"), .{});
        defer parsed.deinit();
        var text: std.ArrayList(u8) = .empty;
        defer text.deinit(a);
        for (parsed.value.object.get("chunks").?.array.items) |chunk| try text.appendSlice(a, chunk.string);
        self.lookup = .{ .revert = try text.toOwnedSlice(a) };
        self.hash = @splat(0x5a);
        return self;
    }

    fn deinit(self: *LifetimeFixture) void {
        self.owner.deinit();
        self.cache.deinit();
        self.native.deinit();
        self.allocator.free(self.lookup.revert);
        self.allocator.destroy(self);
    }

    fn jobContext(self: *LifetimeFixture, a: A, signer: ?ccip.Signer, cancel: ?*const std.atomic.Value(bool)) sessions.Context {
        return .{
            .allocator = a,
            .origin_store = .{ .context = self, .dispatched_transaction_fn = origin },
            .native_lookup = self.lookup.interface(),
            .native = &self.native,
            .signer = signer,
            .signature_cache = &self.cache,
            .block_number = 42,
            .now_ms = 0,
            .cancel = cancel,
            .context_hash = @splat(7),
        };
    }

    fn origin(context: *anyopaque, _: [32]u8) !?[64]u8 {
        const self: *LifetimeFixture = @ptrCast(@alignCast(context));
        return self.hash;
    }

    fn step(context: *anyopaque, session: *ccip.Session, a: A, now: u64, origin_hash: ?[]const u8, cache: ?*ccip.SignatureCache, signer: ?ccip.Signer, provider: ?ccip.SignerProvider, cancel: ?*const std.atomic.Value(bool)) !ccip.Step {
        _ = context;
        var request = try ccip.prepareLazy(a, session.lookup, session.lookup.urls[session.attempt.url_index], origin_hash, cache, signer, provider, cancel);
        defer request.deinit();
        if (session.attempt.url_index == 0) {
            session.attempt.hardFailure();
            return .{ .retry_at_ms = now };
        }
        session.attempt.done = true;
        return .{ .ready = try a.dupe(u8, &.{ 0xde, 0xad }) };
    }
};

fn lifetimeMessage(nonce: u32) protocol.Message {
    return .{ .origin = 1000, .nonce = nonce, .destination = 2000, .sender = @splat(1), .recipient = @splat(2), .body = "lifetime" };
}

test "CCS retained Scope outlives root Scope Binding and honors late child cancel" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const signer_owner = try initOwner(a, &s, &environment, &network);
    defer signer_owner.deinit();
    var fixture = try LifetimeFixture.init(a);
    defer fixture.deinit();
    fixture.owner.installFixtureStep(.{ .context = fixture, .step_fn = LifetimeFixture.step });
    const scope = (try signer_owner.bind(null, try deadline())).?;
    var child_cancel = std.atomic.Value(bool).init(false);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const root = try fixture.owner.bind(fixture.jobContext(a, scope.signer(), null));
    var root_handler = root.handler();
    var child = try root_handler.nativeFork(arena.allocator(), fixture.lookup.interface(), 42, &child_cancel);
    root_handler.deinit();
    scope.deinit();
    const ism: [20]u8 = @splat(3);
    try std.testing.expectError(error.CcipReadPending, child.fetch(ism, lifetimeMessage(1)));
    const metadata = try child.fetch(ism, lifetimeMessage(1));
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad }, metadata);
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
    child_cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, child.fetch(ism, lifetimeMessage(2)));
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
    child.deinit();
}

const ReleaseJob = struct {
    handler: ccip.Handler,
    fn run(self: *ReleaseJob) void {
        self.handler.deinit();
    }
};

test "CCS concurrent releases from different allocators retire Scope only after last child" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const signer_owner = try initOwner(a, &s, &environment, &network);
    defer signer_owner.deinit();
    var fixture = try LifetimeFixture.init(a);
    defer fixture.deinit();
    fixture.owner.installFixtureStep(.{ .context = fixture, .step_fn = LifetimeFixture.step });
    const scope = (try signer_owner.bind(null, try deadline())).?;
    const root = try fixture.owner.bind(fixture.jobContext(a, scope.signer(), null));
    var root_handler = root.handler();
    var first_arena = std.heap.ArenaAllocator.init(a);
    defer first_arena.deinit();
    var second_arena = std.heap.ArenaAllocator.init(a);
    defer second_arena.deinit();
    var cancel = std.atomic.Value(bool).init(false);
    var children: [5]ccip.Handler = undefined;
    for (&children, 0..) |*child, index| child.* = try root_handler.nativeFork(if (index % 3 == 0) first_arena.allocator() else if (index % 3 == 1) second_arena.allocator() else a, fixture.lookup.interface(), 42, &cancel);
    root_handler.deinit();
    scope.deinit();
    var jobs: [4]ReleaseJob = undefined;
    var threads: [4]std.Thread = undefined;
    for (&threads, 0..) |*thread, index| {
        jobs[index] = .{ .handler = children[index] };
        thread.* = try std.Thread.spawn(.{}, ReleaseJob.run, .{&jobs[index]});
    }
    const ism: [20]u8 = @splat(3);
    try std.testing.expectError(error.CcipReadPending, children[4].fetch(ism, lifetimeMessage(3)));
    const metadata = try children[4].fetch(ism, lifetimeMessage(3));
    try std.testing.expectEqualSlices(u8, &.{ 0xde, 0xad }, metadata);
    children[4].deinit();
    for (threads) |thread| thread.join();
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
}

const NullMetadataSource = struct {
    handler: ccip.Handler,

    pub fn moduleType(_: *@This(), _: [20]u8) !metadata_builder.ModuleType {
        return .null_ism;
    }

    pub fn route(_: *@This(), _: [20]u8, _: protocol.Message) ![20]u8 {
        return error.UnexpectedNullRoute;
    }

    pub fn members(_: *@This(), _: [20]u8, _: protocol.Message, _: bool) !metadata_builder.Members {
        return error.UnexpectedNullMembers;
    }

    pub fn verify(_: *@This(), _: [20]u8, _: protocol.Message, _: []const u8) !u256 {
        return error.UnexpectedNullVerify;
    }

    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return null;
    }

    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }

    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }

    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?storage.SignedCheckpoint {
        return null;
    }

    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedNullProof;
    }

    pub fn ccipMetadata(self: *@This(), address: [20]u8, msg: protocol.Message) ![]u8 {
        return self.handler.fetch(address, msg);
    }
};

test "CCS lazy provider avoids Null GET and invalid URL identity work then signs POST" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const signer_owner = try initOwner(a, &s, &environment, &network);
    defer signer_owner.deinit();
    var fixture = try LifetimeFixture.init(a);
    defer fixture.deinit();
    fixture.owner.installFixtureStep(.{ .context = fixture, .step_fn = LifetimeFixture.step });
    var context = fixture.jobContext(a, null, null);
    context.signer_provider = signer_owner.provider(try deadline());
    const root = try fixture.owner.bind(context);
    var root_handler = root.handler();
    var null_source: NullMetadataSource = .{ .handler = root_handler };
    var builder: metadata_builder.Builder(NullMetadataSource) = .{ .allocator = a, .source = &null_source };
    const null_metadata = try builder.build(@splat(3), lifetimeMessage(4));
    a.free(null_metadata);
    try std.testing.expectEqual(@as(usize, 0), signer_owner.stats().leases);

    var lookup = try fixture.lookup.interface().lookup_fn(fixture.lookup.interface().context, a, @splat(3), lifetimeMessage(5), 42, null);
    defer lookup.deinit();
    try std.testing.expectError(error.NonPublicDestination, ccip.prepareLazy(a, lookup, "http://127.0.0.1:1/post", null, &fixture.cache, null, context.signer_provider, null));
    try std.testing.expectEqual(@as(usize, 0), signer_owner.stats().leases);

    var operation_cancel = std.atomic.Value(bool).init(false);
    var child = try root_handler.nativeFork(a, fixture.lookup.interface(), 42, &operation_cancel);
    root_handler.deinit();
    const ism: [20]u8 = @splat(3);
    try std.testing.expectError(error.CcipReadPending, child.fetch(ism, lifetimeMessage(5)));
    try std.testing.expectEqual(@as(usize, 0), signer_owner.stats().leases);
    const metadata_bytes = try child.fetch(ism, lifetimeMessage(5));
    a.free(metadata_bytes);
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().identity_loads);
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
    try std.testing.expectEqual(@as(usize, 2), signer_owner.stats().leases);
    child.deinit();
}

const LazyAsyncFixture = struct {
    allocator: A,
    active: bool = false,
    submits: usize = 0,
    polls: usize = 0,

    fn interface(self: *LazyAsyncFixture) ccip.AsyncTransport {
        return .{ .context = self, .has_active_fn = hasActive, .submit_fn = submit, .poll_fn = poll, .cancel_fn = cancel };
    }

    fn hasActive(context: *anyopaque) bool {
        const self: *LazyAsyncFixture = @ptrCast(@alignCast(context));
        return self.active;
    }

    fn submit(context: *anyopaque, request: curl.Request) !void {
        const self: *LazyAsyncFixture = @ptrCast(@alignCast(context));
        if (!request.public_only) return error.MissingPublicGuard;
        self.active = true;
        self.submits += 1;
    }

    fn poll(context: *anyopaque) !?curl.Response {
        const self: *LazyAsyncFixture = @ptrCast(@alignCast(context));
        self.active = false;
        self.polls += 1;
        return .{ .allocator = self.allocator, .status = 200, .http_version = 2, .body = try self.allocator.dupe(u8, "{\"data\":\"0xdead\"}"), .headers = try self.allocator.alloc(curl.Header, 0), .header_storage = try self.allocator.alloc(u8, 0) };
    }

    fn cancel(context: *anyopaque) void {
        const self: *LazyAsyncFixture = @ptrCast(@alignCast(context));
        self.active = false;
    }
};

test "CCS lazy async submit releases provider without signing replay on poll" {
    const a = std.testing.allocator;
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const signer_owner = try initOwner(a, &s, &environment, &network);
    defer signer_owner.deinit();
    var fixture = try LifetimeFixture.init(a);
    defer fixture.deinit();
    const msg = lifetimeMessage(6);
    const ism: [20]u8 = @splat(3);
    const lookup = try fixture.lookup.interface().lookup_fn(fixture.lookup.interface().context, a, ism, msg, 42, null);
    var session = try ccip.Session.init(lookup, ism, msg.id());
    session.attempt.url_index = 1;
    var backend: LazyAsyncFixture = .{ .allocator = a };
    const provider = signer_owner.provider(try deadline());
    try std.testing.expectError(error.PendingReadIo, session.stepAsyncLazy(a, backend.interface(), 0, &fixture.hash, &fixture.cache, null, provider, null));
    try std.testing.expectEqual(@as(usize, 1), backend.submits);
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
    try std.testing.expectEqual(@as(usize, 2), signer_owner.stats().leases);
    const outcome = try session.stepAsyncLazy(a, backend.interface(), 0, &fixture.hash, &fixture.cache, null, provider, null);
    a.free(outcome.ready);
    try std.testing.expectEqual(@as(usize, 1), backend.polls);
    try std.testing.expectEqual(@as(usize, 1), signer_owner.stats().signatures);
    try std.testing.expectEqual(@as(usize, 2), signer_owner.stats().leases);
    session.deinit();
}

const HaltMode = enum { role, operation, deadline };
const HaltBarrier = struct {
    mode: HaltMode,
    role_halt: *std.atomic.Value(bool),
    operation_cancel: *std.atomic.Value(bool),
    calls: usize = 0,
    deadline_utc_ns: ?u64 = null,

    fn before(context: *anyopaque) !void {
        const self: *HaltBarrier = @ptrCast(@alignCast(context));
        switch (self.mode) {
            .role => self.role_halt.store(true, .release),
            .operation => self.operation_cancel.store(true, .release),
            .deadline => std.Thread.sleep(5 * std.time.ns_per_ms),
        }
    }

    fn sign(context: *anyopaque, digest: [32]u8) ![65]u8 {
        const self: *HaltBarrier = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.calls == 1) {
            switch (self.mode) {
                .role => self.role_halt.store(true, .release),
                .operation => self.operation_cancel.store(true, .release),
                .deadline => {
                    if (self.deadline_utc_ns) |at| {
                        const now = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
                        std.Thread.sleep((at -| now) +| std.time.ns_per_ms);
                    } else std.Thread.sleep(5 * std.time.ns_per_ms);
                },
            }
        }
        return protocol.signature.signDigest(@splat(0x11), digest, null);
    }
};

test "CCS role halt operation cancel and deadline after lease block actual sign" {
    const a = std.testing.allocator;
    for ([_]HaltMode{ .role, .operation, .deadline }) |mode| {
        var s = try fixtureSettings(a);
        defer s.deinit();
        s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        var network: mock.Mock = .{ .steps = &.{} };
        var role_halt = std.atomic.Value(bool).init(false);
        var operation_cancel = std.atomic.Value(bool).init(false);
        const owner = try ccs.Owner.init(a, &s, &s.chains[0], &environment, .{
            .curl_library = curl_library,
            .credential_options = .{ .transport_override = network.transport() },
            .halt = &role_halt,
        });
        defer owner.deinit();
        const scope = (try owner.bind(if (mode == .operation) &operation_cancel else null, if (mode == .deadline) (std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock) + std.time.ns_per_ms else try deadline())).?;
        defer scope.deinit();
        var barrier: HaltBarrier = .{ .mode = mode, .role_halt = &role_halt, .operation_cancel = &operation_cancel };
        owner.installFixtureBeforeSign(&barrier, HaltBarrier.before);
        owner.installFixtureSignature(&barrier, HaltBarrier.sign);
        const signer = scope.signer();
        const expected = switch (mode) {
            .role => error.GlobalEffectsHalted,
            .operation => error.RequestCancelled,
            .deadline => error.SourceReadDeadline,
        };
        try std.testing.expectError(expected, signer.sign_digest(signer.context, @splat(0x22), null));
        try std.testing.expectEqual(@as(usize, 0), barrier.calls);
        try std.testing.expectEqual(@as(usize, 0), owner.stats().signatures);
        try std.testing.expect(!owner.stats().cancel_installed);
    }
}

test "CCS late halt cancel and deadline discard result without cache or HTTP request" {
    const a = std.testing.allocator;
    for ([_]HaltMode{ .role, .operation, .deadline }) |mode| {
        var s = try fixtureSettings(a);
        defer s.deinit();
        s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
        var environment = std.process.EnvMap.init(a);
        defer environment.deinit();
        var network: mock.Mock = .{ .steps = &.{} };
        var role_halt = std.atomic.Value(bool).init(false);
        var operation_cancel = std.atomic.Value(bool).init(false);
        const owner = try ccs.Owner.init(a, &s, &s.chains[0], &environment, .{
            .curl_library = curl_library,
            .credential_options = .{ .transport_override = network.transport() },
            .halt = &role_halt,
        });
        defer owner.deinit();
        const scope = (try owner.bind(if (mode == .operation) &operation_cancel else null, try deadline())).?;
        defer scope.deinit();
        var fixture = try LifetimeFixture.init(a);
        defer fixture.deinit();
        const msg = lifetimeMessage(7);
        const ism: [20]u8 = @splat(3);
        const lookup = try fixture.lookup.interface().lookup_fn(fixture.lookup.interface().context, a, ism, msg, 42, null);
        var session = try ccip.Session.init(lookup, ism, msg.id());
        defer session.deinit();
        session.attempt.url_index = 1;
        var barrier: HaltBarrier = .{ .mode = mode, .role_halt = &role_halt, .operation_cancel = &operation_cancel };
        owner.installFixtureSignature(&barrier, HaltBarrier.sign);
        const signer = scope.signer();
        const cancel = if (mode == .operation) &operation_cancel else null;
        const expected = switch (mode) {
            .role => error.GlobalEffectsHalted,
            .operation => error.RequestCancelled,
            .deadline => error.SourceReadDeadline,
        };
        if (mode == .deadline) {
            const now = std.math.cast(u64, std.time.nanoTimestamp()) orelse return error.UnsupportedClock;
            scope.deadline_ns = now + std.time.ns_per_s;
            barrier.deadline_utc_ns = scope.deadline_ns;
        }
        try std.testing.expectError(expected, ccip.prepareLazy(a, session.lookup, session.lookup.urls[1], &fixture.hash, &fixture.cache, signer, null, cancel));
        try std.testing.expectEqual(@as(usize, 1), barrier.calls);
        try std.testing.expectEqual(@as(usize, 0), owner.stats().signatures);
        role_halt.store(false, .release);
        operation_cancel.store(false, .release);
        if (mode == .deadline) scope.deadline_ns = try deadline();
        var backend: LazyAsyncFixture = .{ .allocator = a };
        try std.testing.expectError(error.PendingReadIo, session.stepAsyncLazy(a, backend.interface(), 0, &fixture.hash, &fixture.cache, signer, null, cancel));
        try std.testing.expectEqual(@as(usize, 1), backend.submits);
        try std.testing.expectEqual(@as(usize, 2), barrier.calls);
        try std.testing.expectEqual(@as(usize, 1), owner.stats().signatures);
    }
}

fn allocationSweep(a: A) !void {
    var s = try fixtureSettings(a);
    defer s.deinit();
    s.chains[0].ccs_signer = .{ .hex_key = @splat(0x11) };
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var network: mock.Mock = .{ .steps = &.{} };
    const owner = try initOwner(a, &s, &environment, &network);
    defer owner.deinit();
    const scope = (try owner.bind(null, try deadline())).?;
    defer scope.deinit();
    const signer = scope.signer();
    _ = try signer.sign_digest(signer.context, @splat(0x22), null);
}

test "CCS owner scope and refreshed identity survive allocation failure sweep" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationSweep, .{});
}
