const std = @import("std");
const factory = @import("agents/destination/factory.zig");
const sources = @import("agents/chain_source.zig");
const scraper = @import("agents/scraper/starknet.zig");
const settings = @import("settings/types.zig");
const signing = @import("agents/signer.zig");
const http = @import("cloud/http.zig");
const rpc = @import("net/json_rpc.zig");
const Felt = @import("starknet/codec.zig").Felt;
const A = std.mem.Allocator;

fn cryptoLibrary(a: A) ![]u8 {
    return std.process.getEnvVarOwned(a, "HYPERLANE_STARKNET_CRYPTO_LIBRARY") catch |err| switch (err) {
        error.EnvironmentVariableNotFound => return error.SkipZigTest,
        else => return err,
    };
}
const Fixture = struct {
    env: std.process.EnvMap,
    resources: sources.Resources,
    client: scraper.Factory,
    calls: usize = 0,
    returned: []const u8 = "0x534e5f5345504f4c4941",
    failure: ?anyerror = null,
    fail_first: bool = false,
    cancel_after: bool = false,
    halt_after: bool = false,
    cancel: std.atomic.Value(bool) = .init(false),
    halt: std.atomic.Value(bool) = .init(false),
    fn init(self: *Fixture, a: A, id: []const u8) !void {
        self.calls = 0;
        self.returned = "0x534e5f5345504f4c4941";
        self.failure = null;
        self.fail_first = false;
        self.cancel_after = false;
        self.halt_after = false;
        self.cancel = .init(false);
        self.halt = .init(false);
        self.env = std.process.EnvMap.init(a);
        var chain = @import("agents/chain_source_testing.zig").chainFor(&.{ "https://first.fixture/rpc", "https://second.fixture/rpc" });
        chain.protocol = .starknet;
        chain.chain_id = id;
        chain.domain = 23448594;
        chain.signer = .{ .stark_key = .{ .key = .{0} ** 31 ++ .{17}, .address = .{0} ** 31 ++ .{4}, .legacy = false } };
        chain.contracts = .{ .mailbox = .{0} ** 31 ++ .{2}, .merkle_tree_hook = .{0} ** 31 ++ .{3}, .validator_announce = .{0} ** 31 ++ .{6}, .interchain_gas_paymaster = @splat(0) };
        chain.connection = .{ .starknet = .{ .native_token = .{0} ** 31 ++ .{7} } };
        self.resources = .{ .allocator = a, .arena = .init(a), .chain = chain, .environment = &self.env, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a), .cancel = &self.cancel };
        self.client = try scraper.Factory.init(a, .{ .context = self, .send_fn = send }, &self.resources.chain);
        self.resources.clients = .{ .starknet = &self.client };
    }
    fn deinit(self: *Fixture) void {
        self.client.deinit();
        self.resources.http.deinit();
        self.resources.arena.deinit();
        self.env.deinit();
    }
    fn send(context: *anyopaque, a: A, request: http.Request) !http.Response {
        const self: *Fixture = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.failure) |err| return err;
        if (self.fail_first and self.calls == 1) return error.PeerUnavailable;
        var parsed = try std.json.parseFromSlice(rpc.Value, a, request.body.?, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("starknet_chainId", try rpc.string(try rpc.field(parsed.value, "method")));
        const bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = try rpc.integer(i64, try rpc.field(parsed.value, "id")), .result = self.returned }, .{});
        if (self.cancel_after) self.cancel.store(true, .release);
        if (self.halt_after) self.halt.store(true, .release);
        return .{ .allocator = a, .bytes = bytes, .status = 200 };
    }
    fn credentials(self: *Fixture) signing.Credentials {
        return .{ .transport = self.resources.http.interface(), .http_owner = &self.resources.http, .amz_date = "public-fixture" };
    }
    fn open(self: *Fixture, a: A) !*factory.Factory {
        const path = try cryptoLibrary(a);
        defer a.free(path);
        return factory.Factory.open(a, &self.resources, self.resources.chain.signer.?, self.credentials(), .{ .starknet_crypto_library = path, .origin_bindings = &.{.{ .domain = 23448593, .hook = .{0} ** 31 ++ .{3} }}, .allow_fixture_transport = true });
    }
};

test "Starknet omitted chain ID discovers actual provider before authority and keeps resources unchanged" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    const owner = try fixture.open(a);
    defer owner.deinit();
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
    try std.testing.expectEqual(@as(u256, 0x534e5f5345504f4c4941), owner.backend.starknet.chain_id.value);
    const authority = try owner.authorityFor(23448593, @splat(9), 1, .process);
    try std.testing.expectEqualStrings("0x534e5f5345504f4c4941", authority.chain_id);
    _ = try owner.contextFor(authority);
}

fn clock(fixture: *Fixture) !factory.Clock {
    return .{ .unix_ms = 1, .deadline_ns = try http.rpcNowNs() + std.time.ns_per_s, .cancel = &fixture.cancel, .halt = &fixture.halt };
}

test "Starknet explicit chain ID stays byte exact and network mismatch stays hard" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "0x0534e5f5345504f4c4941");
    defer fixture.deinit();
    const owner = try fixture.open(a);
    defer owner.deinit();
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
    const authority = try owner.authorityFor(23448593, @splat(9), 1, .process);
    try std.testing.expectEqualStrings(fixture.resources.chain.chain_id, authority.chain_id);
    _ = try owner.contextFor(authority);
    fixture.returned = "0x2";
    try std.testing.expectError(error.WrongStarknetChain, owner.delivered(@splat(9), try clock(&fixture)));
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    try std.testing.expect(!owner.chain_checked);
    try std.testing.expectEqualStrings("0x0534e5f5345504f4c4941", authority.chain_id);
}

test "Starknet missing chain ID uses configured fallback and keeps discovery controls" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    fixture.fail_first = true;
    const owner = try fixture.open(a);
    defer owner.deinit();
    try std.testing.expectEqual(@as(usize, 2), fixture.calls);
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
}

test "Starknet discovery does not mask cancellation halt true deadline PIO or malformed reply" {
    const a = std.testing.allocator;
    const crypto_library = try cryptoLibrary(a);
    defer a.free(crypto_library);
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    fixture.cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, fixture.open(a));
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
    fixture.cancel.store(false, .release);
    fixture.halt.store(true, .release);
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = try http.rpcNowNs() + std.time.ns_per_s, .halt = &fixture.halt, .retry_physical_timeout = true };
    try std.testing.expectError(error.CheckpointEffectsHalted, fixture.open(a));
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
    fixture.halt.store(false, .release);
    fixture.resources.rpc_deadline_ns = try http.rpcNowNs() - 1;
    try std.testing.expectError(error.ScraperReceiptDeadline, fixture.open(a));
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
    fixture.resources.rpc_deadline_ns = null;
    fixture.failure = error.PendingReadIo;
    try std.testing.expectError(error.PendingReadIo, fixture.open(a));
    try std.testing.expectEqual(@as(usize, 1), fixture.calls);
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
    fixture.failure = null;
    fixture.returned = "not-a-felt";
    try std.testing.expectError(error.InvalidStarknetFelt, fixture.open(a));
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
    fixture.returned = "0x534e5f5345504f4c4941";
    const owner = try fixture.open(a);
    defer owner.deinit();
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
}

test "Starknet discovered ID owns text and binds stable restart context without rebinding another network" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    var first_context: [32]u8 = undefined;
    {
        const owner = try fixture.open(a);
        defer owner.deinit();
        const authority = try owner.authorityFor(23448593, @splat(9), 1, .process);
        first_context = try owner.contextFor(authority);
        const churn = try a.alloc(u8, 128 * 1024);
        defer a.free(churn);
        @memset(churn, 0xa5);
        try std.testing.expectEqualStrings("0x534e5f5345504f4c4941", authority.chain_id);
    }
    {
        const owner = try fixture.open(a);
        defer owner.deinit();
        try std.testing.expectEqualSlices(u8, &first_context, &try owner.contextFor(try owner.authorityFor(23448593, @splat(9), 1, .process)));
    }
    fixture.returned = "0x2";
    const other = try fixture.open(a);
    defer other.deinit();
    const authority = try other.authorityFor(23448593, @splat(9), 1, .process);
    try std.testing.expect(!std.mem.eql(u8, &first_context, &try other.contextFor(authority)));
    var foreign = authority;
    foreign.chain_id = "0x534e5f5345504f4c4941";
    try std.testing.expectError(error.DestinationAuthorityMismatch, other.contextFor(foreign));
}

fn allocationAttempt(a: A, fixture: *Fixture) !void {
    const owner = fixture.open(a) catch |err| {
        try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
        return err;
    };
    defer owner.deinit();
    _ = try owner.contextFor(try owner.authorityFor(23448593, @splat(9), 1, .process));
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
}

test "Starknet discovery allocation failures leave borrowed settings and Resources unchanged" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    try std.testing.checkAllAllocationFailures(a, allocationAttempt, .{&fixture});
}

test "Starknet discovery rejects foreign credential ownership before RPC" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    var credential = fixture.credentials();
    credential.transport.context = &fixture;
    try std.testing.expectError(error.SignerTransportOwnerMismatch, factory.Factory.open(a, &fixture.resources, fixture.resources.chain.signer.?, credential, .{ .allow_fixture_transport = true }));
    try std.testing.expectEqual(@as(usize, 0), fixture.calls);
}

test "Starknet Root startup scope retains same deadline across PIO and restores exact RPC owner" {
    const a = std.testing.allocator;
    const crypto_library = try cryptoLibrary(a);
    defer a.free(crypto_library);
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    const root = @import("agents/relayer_task.zig").NativeTests;
    const owner = @import("runtime/lane_owner.zig");
    const Noop = struct {
        fn run(_: *anyopaque, _: @import("runtime/supervisor.zig").Times, _: *const std.atomic.Value(bool)) !@import("runtime/supervisor.zig").Report {
            return .{};
        }
    };
    var context: u8 = 0;
    var worker = try owner.Owner.init(&context, Noop.run, .{ .timeout_ms = 1000 });
    defer worker.deinit();
    worker.timer = try std.time.Timer.start();
    const started_deadline = try root.originalInitializationDeadline(&worker);
    var inherited_halt: std.atomic.Value(bool) = .init(false);
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = started_deadline - 10, .halt = &inherited_halt, .retry_physical_timeout = true };
    fixture.resources.rpc_deadline_ns = started_deadline - 20;
    var first_deadline: u64 = undefined;
    {
        var scope = try root.initializationScope.begin(&fixture.resources, &worker, .starknet, &fixture.halt);
        defer scope.finish();
        first_deadline = fixture.resources.http.rpc_read_owner.?.deadline_ns;
        try std.testing.expectEqual(started_deadline - 20, first_deadline);
        try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
        try std.testing.expect(fixture.resources.http.rpc_read_owner.?.halt == &inherited_halt);
        fixture.failure = error.PendingReadIo;
        try std.testing.expectError(error.PendingReadIo, fixture.open(a));
    }
    try std.testing.expectEqual(started_deadline - 10, fixture.resources.http.rpc_read_owner.?.deadline_ns);
    try std.testing.expectEqual(started_deadline - 20, fixture.resources.rpc_deadline_ns.?);
    {
        var scope = try root.initializationScope.begin(&fixture.resources, &worker, .starknet, &fixture.halt);
        defer scope.finish();
        try std.testing.expectEqual(first_deadline, fixture.resources.http.rpc_read_owner.?.deadline_ns);
        fixture.failure = null;
        const destination = try fixture.open(a);
        defer destination.deinit();
    }
    fixture.resources.http.rpc_read_owner.?.retry_physical_timeout = false;
    {
        var scope = try root.initializationScope.begin(&fixture.resources, &worker, .starknet, &fixture.halt);
        defer scope.finish();
        try std.testing.expect(!fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    }
    try std.testing.expect(!fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    fixture.resources.http.rpc_read_owner = null;
    fixture.resources.rpc_deadline_ns = null;
    {
        var scope = try root.initializationScope.begin(&fixture.resources, &worker, .starknet, &fixture.halt);
        defer scope.finish();
        try std.testing.expectEqual(started_deadline, fixture.resources.rpc_deadline_ns.?);
        try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
        try std.testing.expect(fixture.resources.http.rpc_read_owner.?.halt == &fixture.halt);
    }
    try std.testing.expect(fixture.resources.http.rpc_read_owner == null);
    try std.testing.expect(fixture.resources.rpc_deadline_ns == null);
}

test "Starknet discovery rechecks control after blocked provider response before signer creation" {
    const a = std.testing.allocator;
    const crypto_library = try cryptoLibrary(a);
    defer a.free(crypto_library);
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    fixture.cancel_after = true;
    try std.testing.expectError(error.RequestCancelled, fixture.open(a));
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
    fixture.cancel_after = false;
    fixture.cancel.store(false, .release);
    fixture.halt_after = true;
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = try http.rpcNowNs() + std.time.ns_per_s, .halt = &fixture.halt, .retry_physical_timeout = true };
    try std.testing.expectError(error.CheckpointEffectsHalted, fixture.open(a));
    try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
    try std.testing.expectEqual(@as(usize, 2), fixture.calls);
}

const AnnouncementReply = struct {
    var late_cancel: ?*std.atomic.Value(bool) = null;
    var late_halt: ?*std.atomic.Value(bool) = null;
    fn reply(a: A, body: []const u8) ![]u8 {
        var parsed = try std.json.parseFromSlice(rpc.Value, a, body, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("starknet_chainId", try rpc.string(try rpc.field(parsed.value, "method")));
        const result = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = try rpc.integer(i64, try rpc.field(parsed.value, "id")), .result = "0x534e5f5345504f4c4941" }, .{});
        if (late_cancel) |flag| flag.store(true, .release);
        if (late_halt) |flag| flag.store(true, .release);
        return result;
    }
};

fn openAnnouncement(a: A, fixture: *Fixture, database: *@import("db/rocks.zig").Database, curl_path: []const u8, startup: factory.Clock, physical_ms: u32) !*@import("agents/validator/announcement.zig").Owner {
    const path = try cryptoLibrary(a);
    defer a.free(path);
    return @import("agents/validator/announcement.zig").Owner.open(a, database, &fixture.resources.chain, &fixture.env, fixture.resources.chain.signer.?, fixture.credentials(), .{ .validator = @splat(9), .mailbox_address = fixture.resources.chain.contracts.mailbox, .mailbox_domain = fixture.resources.chain.domain, .storage_location = "file:///public-structural-fixture" }, .{ .initialization_clock = startup, .clients = .{ .curl_library = curl_path, .request_timeout_ms = physical_ms, .allow_insecure_loopback = true }, .destination = .{ .starknet_crypto_library = path, .allow_fixture_transport = true } });
}

test "Starknet announcement actual native HTTP constructor discovers omitted ID with transient clock and clean teardown" {
    const a = std.testing.allocator;
    const pool_fixture = @import("evm/pool_testing.zig");
    const library = try pool_fixture.nativeLibrary(a);
    defer a.free(library);
    var server = try pool_fixture.Fixture.init(1, &.{.{ .replies = &.{.{ .body = "unused" }}, .response_fn = AnnouncementReply.reply }});
    try server.start();
    defer server.deinit();
    const url = try server.url(a, 0);
    defer a.free(url);
    var fixture: Fixture = undefined;
    try fixture.init(a, "");
    defer fixture.deinit();
    fixture.resources.chain.rpc_urls = &.{url};
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const db_path = try std.fs.path.join(a, &.{ base, "announcement" });
    defer a.free(db_path);
    var database = try @import("db/rocks.zig").Database.open(a, db_path, .{});
    defer database.deinit();
    const owner = try openAnnouncement(a, &fixture, &database, library, try clock(&fixture), 1000);
    defer owner.deinit();
    try std.testing.expectEqual(@as(usize, 1), server.acceptedCount());
    try std.testing.expectEqualStrings("", owner.resources.chain.chain_id);
    try std.testing.expectEqualStrings("0x534e5f5345504f4c4941", (try owner.factory.authorityFor(fixture.resources.chain.domain, @splat(9), 0, .announcement)).chain_id);
    try std.testing.expect(owner.options.initialization_clock == null);
    try std.testing.expect(owner.resources.cancel == null);
    try std.testing.expect(owner.resources.http.cancel == null);
    try std.testing.expect(owner.resources.http.rpc_read_owner == null);
    try std.testing.expect(owner.resources.rpc_deadline_ns == null);
    try std.testing.expect(owner.announcement == null and owner.operation == null);
    try server.check();
}

test "Starknet announcement native constructor pre late controls and physical RPC timeout fail closed without leaked owners" {
    const a = std.testing.allocator;
    const crypto_library = try cryptoLibrary(a);
    defer a.free(crypto_library);
    const pool_fixture = @import("evm/pool_testing.zig");
    const library = try pool_fixture.nativeLibrary(a);
    defer a.free(library);
    for (0..7) |variant| {
        var fixture: Fixture = undefined;
        try fixture.init(a, "");
        defer fixture.deinit();
        var startup = try clock(&fixture);
        if (variant == 0) fixture.cancel.store(true, .release);
        if (variant == 1) fixture.halt.store(true, .release);
        if (variant == 2) startup.deadline_ns = try http.rpcNowNs() - 1;
        if (variant == 6) startup.deadline_ns = try http.rpcNowNs() + 40 * std.time.ns_per_ms;
        AnnouncementReply.late_cancel = if (variant == 4) &fixture.cancel else null;
        AnnouncementReply.late_halt = if (variant == 5) &fixture.halt else null;
        defer {
            AnnouncementReply.late_cancel = null;
            AnnouncementReply.late_halt = null;
        }
        var server = try pool_fixture.Fixture.init(1, &.{.{ .replies = &.{.{ .body = "unused", .stall = variant == 3 or variant == 6 }}, .response_fn = AnnouncementReply.reply }});
        try server.start();
        defer server.deinit();
        const url = try server.url(a, 0);
        defer a.free(url);
        fixture.resources.chain.rpc_urls = &.{url};
        var temp = std.testing.tmpDir(.{});
        defer temp.cleanup();
        const base = try temp.dir.realpathAlloc(a, ".");
        defer a.free(base);
        const db_path = try std.fs.path.join(a, &.{ base, "announcement" });
        defer a.free(db_path);
        var database = try @import("db/rocks.zig").Database.open(a, db_path, .{});
        defer database.deinit();
        const expected = switch (variant) {
            0, 4 => error.RequestCancelled,
            1, 5 => error.CheckpointEffectsHalted,
            2 => error.ScraperReceiptDeadline,
            3 => error.UpstreamReadTimeout,
            6 => error.RequestDeadlineExceeded,
            else => unreachable,
        };
        try std.testing.expectError(expected, openAnnouncement(a, &fixture, &database, library, startup, if (variant == 3) 30 else 1000));
        try std.testing.expectEqual(@as(usize, if (variant < 3) 0 else 1), server.acceptedCount());
        try std.testing.expectEqualStrings("", fixture.resources.chain.chain_id);
        try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
        try server.check();
    }
}
