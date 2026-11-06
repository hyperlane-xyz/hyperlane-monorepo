//! The relayer's remote Tron signer borrows the SAME HTTP owner as its RPCs.
const std = @import("std");
const http = @import("../../cloud/http.zig");
const curl = @import("../../net/curl.zig");
const fixtures = @import("../../net/rpc_timeout_fixture.zig");
const settings = @import("../../settings/root.zig");
const sources = @import("../chain_source.zig");
const credentials = @import("../credentials.zig");
const factory = @import("factory.zig");
const types = @import("types.zig");
const tx = @import("../../tron/transaction.zig");
const abi = @import("../../evm/codecs.zig");
const a = std.testing.allocator;

// KMS intentionally permits only a root endpoint, unlike the numeric-route
// general RPC fixture. Keep that production validation intact.
const KmsFixture = struct {
    server: std.net.Server,
    public: []const u8,
    hits: std.atomic.Value(usize) = .init(0),
    stop: std.atomic.Value(bool) = .init(false),
    records: [12]fixtures.Record = [_]fixtures.Record{.{}} ** 12,
    thread: ?std.Thread = null,
    failure: ?anyerror = null,
    fn init(public: []const u8) !@This() {
        return .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}), .public = public };
    }
    fn start(self: *@This()) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }
    fn deinit(self: *@This()) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| thread.join();
        self.server.deinit();
    }
    fn url(self: *@This()) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{self.server.listen_address.getPort()});
    }
    fn pathHits(self: *@This(), _: usize) usize {
        return self.hits.load(.acquire);
    }
    fn check(self: *@This()) !void {
        if (self.failure) |err| return err;
    }
    fn run(self: *@This()) void {
        self.serve() catch |err| {
            self.failure = err;
        };
    }
    fn ready(self: *@This(), fd: std.posix.fd_t) !void {
        var timer = try std.time.Timer.start();
        while (!self.stop.load(.acquire)) {
            if (timer.read() >= 3 * std.time.ns_per_s) return error.KmsFixtureReadTimeout;
            var fds = [_]std.posix.pollfd{.{ .fd = fd, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 10) > 0) return;
        }
        return error.RequestCancelled;
    }
    fn serve(self: *@This()) !void {
        var streams: [12]std.net.Stream = undefined;
        var count: usize = 0;
        defer for (streams[0..count]) |stream| stream.close();
        while (!self.stop.load(.acquire)) {
            var fds = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 10) == 0) continue;
            if (count == streams.len) return error.KmsFixtureTooManyRequests;
            const connection = try self.server.accept();
            streams[count] = connection.stream;
            count += 1;
            var input: [8192]u8 = undefined;
            var used: usize = 0;
            var end: ?usize = null;
            var length: usize = 0;
            while (true) {
                if (used == input.len) return error.KmsFixtureRequestTooLarge;
                try self.ready(connection.stream.handle);
                const got = try connection.stream.read(input[used..]);
                if (got == 0) return error.KmsFixtureUnexpectedEof;
                used += got;
                if (end == null) if (std.mem.indexOf(u8, input[0..used], "\r\n\r\n")) |header_end| {
                    end = header_end + 4;
                    try std.testing.expect(std.mem.startsWith(u8, input[0..used], "POST / HTTP/1.1\r\n"));
                    var lines = std.mem.splitSequence(u8, input[0..header_end], "\r\n");
                    var authenticated = false;
                    while (lines.next()) |line| {
                        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
                        const name = line[0..colon];
                        const value = std.mem.trim(u8, line[colon + 1 ..], " \t");
                        if (std.ascii.eqlIgnoreCase(name, "content-length")) length = try std.fmt.parseInt(usize, value, 10);
                        if (std.ascii.eqlIgnoreCase(name, "authorization")) authenticated = std.mem.startsWith(u8, value, "AWS4-HMAC-SHA256 ");
                    }
                    try std.testing.expect(authenticated);
                };
                if (end) |offset| if (used - offset >= length) break;
            }
            const index = self.hits.load(.acquire);
            if (length > self.records[index].body.len) return error.KmsFixtureRequestTooLarge;
            @memcpy(self.records[index].body[0..length], input[end.?..][0..length]);
            self.records[index].body_len = length;
            _ = self.hits.fetchAdd(1, .release);
            if (index == 0) {
                var header: [160]u8 = undefined;
                const prefix = try std.fmt.bufPrint(&header, "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{self.public.len});
                try connection.stream.writeAll(prefix);
                try connection.stream.writeAll(self.public);
                // All later authenticated requests genuinely stall.
            }
        }
    }
};

const Mutation = enum { none, cancel, halt, expire };
const Journal = struct {
    owner: *http.HttpTransport,
    cancel: *std.atomic.Value(bool),
    halt: *std.atomic.Value(bool),
    deadline: u64,
    mutation: Mutation = .none,
    intents: usize = 0,
    signed_count: usize = 0,
    fn intent(ctx: *anyopaque, _: types.Hash, _: []const u8) !void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.intents += 1;
        const guard = self.owner.rpc_read_owner orelse return error.MissingSharedOwnerClock;
        try std.testing.expectEqual(self.deadline, guard.deadline_ns);
        try std.testing.expect(guard.halt == self.halt and self.owner.cancel == self.cancel);
        // This is still the RPC Scope. The REAL Factory digest callback must
        // disable only the retry capability while the KMS operation executes.
        try std.testing.expect(guard.retry_physical_timeout);
        switch (self.mutation) {
            .none => {},
            .cancel => self.cancel.store(true, .release),
            .halt => self.halt.store(true, .release),
            .expire => {
                const now = try http.rpcNowNs();
                if (now < self.deadline) std.Thread.sleep(self.deadline - now + std.time.ns_per_ms);
            },
        }
    }
    fn signed(ctx: *anyopaque, _: types.Hash, _: types.Identity, _: []const u8) !void {
        const self: *@This() = @ptrCast(@alignCast(ctx));
        self.signed_count += 1;
    }
    fn interface(self: *@This()) types.Persistence {
        return .{ .context = self, .persistIntent = intent, .persistSigned = signed };
    }
};

fn prepared(f: *factory.Factory) !types.Prepared {
    const protocol = @import("../../protocol/root.zig");
    const message: protocol.Message = .{ .version = 3, .nonce = 1, .origin = 100, .destination = 200, .sender = @splat(4), .recipient = @splat(5), .body = "shared remote signer" };
    const authority = try f.authorityFor(100, message.id(), 1, .process);
    const encoded = try message.encodeAlloc(a);
    defer a.free(encoded);
    const calldata = try abi.processCalldata(a, "fixture metadata", encoded);
    defer a.free(calldata);
    var unsigned = try tx.build(a, .{ .owner = f.backend.tron.signer.address, .contract = .{0x41} ++ .{2} ** 20, .data = calldata }, try tx.reference(10, @splat(7), 1000000, 150000));
    defer unsigned.deinit();
    const raw_hex = try abi.hexAlloc(a, unsigned.raw);
    defer a.free(raw_hex);
    const id_hex = try abi.hexAlloc(a, &unsigned.id);
    defer a.free(id_hex);
    const body = try std.json.Stringify.valueAlloc(a, .{ .raw_data = raw_hex, .id = id_hex, .expiration_ms = unsigned.expiration_ms, .gas_limit = 1000, .energy_price = 100, .estimated_cost = 150000 }, .{});
    defer a.free(body);
    return types.Prepared.init(a, authority, body, 1000, 150000);
}

// Literal public fixture key17, used ONLY to construct its public-key response.
fn publicResponse() ![]u8 {
    const point = (try std.crypto.ecc.Secp256k1.basePoint.mul(.{0x11} ** 32, .big)).toCompressedSec1();
    var der: [56]u8 = undefined;
    der[0..23].* = .{ 0x30, 54, 0x30, 0x10, 6, 7, 0x2a, 0x86, 0x48, 0xce, 0x3d, 2, 1, 6, 5, 0x2b, 0x81, 4, 0, 0x0a, 3, 34, 0 };
    @memcpy(der[23..], &point);
    var encoded: [80]u8 = undefined;
    return std.json.Stringify.valueAlloc(a, .{ .KeyId = "arn:aws:kms:us-east-1:000000000000:key/fixture", .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = std.base64.standard.Encoder.encode(&encoded, &der) }, .{});
}

test "shared remote Tron actual Manager lease Factory digest physical timeout retains controls and RPC retry capability" {
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const public = try publicResponse();
    defer a.free(public);
    var server = try KmsFixture.init(public);
    try server.start();
    defer server.deinit();
    const kms_url = try server.url();
    defer a.free(kms_url);
    const rpc_behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "", .stall = true }} }};
    var rpc_server = try fixtures.Fixture.init(1, &rpc_behaviors);
    try rpc_server.start();
    defer rpc_server.deinit();
    const rpc_url = try rpc_server.url(a, 0);
    defer a.free(rpc_url);
    var native = try curl.Client.init(a, library);
    defer native.deinit();
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var chain = @import("../chain_source_testing.zig").chainFor(&.{rpc_url});
    chain.name = "shared-remote-tron";
    chain.protocol = .tron;
    chain.domain = 200;
    chain.chain_id = "728126428";
    chain.contracts = .{ .mailbox = .{0} ** 12 ++ .{2} ** 20, .merkle_tree_hook = .{0} ** 12 ++ .{3} ** 20, .validator_announce = .{0} ** 12 ++ .{8} ** 20, .interchain_gas_paymaster = @splat(0) };
    chain.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    chain.connection = .{ .tron = .{ .wallet_urls = &.{rpc_url}, .wallet_solidity_urls = &.{rpc_url}, .fee_multiplier = null } };
    var configured: settings.Settings = undefined;
    configured.chains = @as(*[1]settings.Chain, @ptrCast(&chain));
    configured.role = .{ .relayer = std.mem.zeroes(@import("../../settings/types.zig").Relayer) };
    var readers: sources.Resources = .{ .allocator = a, .arena = .init(a), .chain = chain, .environment = &env, .options = .{ .curl_library = library }, .http = http.HttpTransport.init(a) };
    defer readers.arena.deinit();
    defer readers.http.deinit();
    readers.http.native_curl = &native;
    readers.http.allow_insecure_loopback = true;
    readers.http.timeout_ms = 1000;
    const manager = try credentials.Manager.init(a, &configured, &env, &readers.http, .{ .kms_endpoint = kms_url });
    defer manager.deinit();
    const lease = try manager.lease(1);
    try std.testing.expect(lease.http_owner == &readers.http and lease.transport.context == readers.http.interface().context);
    const endpoints = [_]@import("../../tron/rpc.zig").Endpoint{.{ .url = rpc_url }};
    var provider = try @import("../../tron/provider.zig").Provider.init(a, readers.http.interface(), .{ .rpc_urls = &endpoints, .wallet_urls = &endpoints, .wallet_solidity_urls = &endpoints });
    readers.clients = .{ .tron = &provider };
    const f = try factory.Factory.open(a, &readers, chain.signer.?, lease, .{ .origin_bindings = &.{.{ .domain = 100, .hook = @splat(9) }}, .reveal_boot = @splat(1) });
    defer f.deinit();
    // Chain validation is unrelated to the key boundary; its canonical intent,
    // real Factory callback, Manager lease and actual native KMS stay active.
    f.chain_checked = true;
    try std.testing.expect(f.signer_http == &readers.http and f.digest.?.backend == .aws);
    var intent = try prepared(f);
    defer intent.deinit();
    var cancel: std.atomic.Value(bool) = .init(false);
    var halt: std.atomic.Value(bool) = .init(false);
    var prior_cancel: std.atomic.Value(bool) = .init(false);
    readers.setCancellation(&prior_cancel);
    readers.http.timeout_ms = 50;
    readers.http.connect_timeout_ms = 50;
    const inherited = (try http.rpcNowNs()) + 30 * std.time.ns_per_s;
    readers.http.rpc_read_owner = .{ .deadline_ns = inherited, .halt = &halt, .retry_physical_timeout = true };
    const deadline = (try http.rpcNowNs()) + 2 * std.time.ns_per_s;
    var journal: Journal = .{ .owner = &readers.http, .cancel = &cancel, .halt = &halt, .deadline = deadline };
    try std.testing.expectError(error.RequestDeadlineExceeded, f.sign(&intent, null, journal.interface(), .{ .unix_ms = 1000000, .deadline_ns = deadline, .cancel = &cancel, .halt = &halt }));
    try std.testing.expectEqual(@as(usize, 1), journal.intents);
    try std.testing.expectEqual(@as(usize, 0), journal.signed_count);
    try std.testing.expectEqual(@as(usize, 2), server.pathHits(0));
    try std.testing.expect(std.mem.indexOf(u8, server.records[1].bodyText(), "DIGEST") != null);
    try std.testing.expectEqual(inherited, readers.http.rpc_read_owner.?.deadline_ns);
    try std.testing.expectEqual(true, readers.http.rpc_read_owner.?.retry_physical_timeout);
    try std.testing.expect(readers.http.cancel == &prior_cancel);
    // Same concrete owner, AFTER the non-RPC guard and Factory Scope unwind.
    try std.testing.expectError(error.UpstreamReadTimeout, readers.http.interface().send(a, .{ .method = .POST, .url = rpc_url, .body = "{}" }));
    try std.testing.expectEqual(@as(usize, 1), rpc_server.pathHits(0));
    for ([_]struct { mutation: Mutation, expected: anyerror }{ .{ .mutation = .cancel, .expected = error.RequestCancelled }, .{ .mutation = .halt, .expected = error.CheckpointEffectsHalted }, .{ .mutation = .expire, .expected = error.RequestDeadlineExceeded } }) |case| {
        cancel.store(false, .release);
        halt.store(false, .release);
        const actual_deadline = (try http.rpcNowNs()) + 100 * std.time.ns_per_ms;
        journal.deadline = actual_deadline;
        journal.mutation = case.mutation;
        try std.testing.expectError(case.expected, f.sign(&intent, null, journal.interface(), .{ .unix_ms = 1000000, .deadline_ns = actual_deadline, .cancel = &cancel, .halt = &halt }));
        try std.testing.expectEqual(@as(usize, 2), server.pathHits(0));
        try std.testing.expectEqual(true, readers.http.rpc_read_owner.?.retry_physical_timeout);
        try std.testing.expect(readers.http.cancel == &prior_cancel);
    }
    try std.testing.expectEqual(@as(usize, 4), journal.intents);
    try std.testing.expectEqual(@as(usize, 0), journal.signed_count);
    // A later public-key initialization is also non-RPC, even when the
    // caller's shared HTTP owner already carries RPC retry authority.
    cancel.store(false, .release);
    halt.store(false, .release);
    try std.testing.expectError(error.RequestDeadlineExceeded, factory.Factory.open(a, &readers, chain.signer.?, lease, .{ .origin_bindings = &.{.{ .domain = 100, .hook = @splat(9) }}, .reveal_boot = @splat(1) }));
    try std.testing.expectEqual(@as(usize, 3), server.pathHits(0));
    try std.testing.expect(std.mem.indexOf(u8, server.records[2].bodyText(), "DIGEST") == null);
    try std.testing.expectEqual(inherited, readers.http.rpc_read_owner.?.deadline_ns);
    try std.testing.expectEqual(true, readers.http.rpc_read_owner.?.retry_physical_timeout);
    try std.testing.expect(readers.http.cancel == &prior_cancel);
    try server.check();
    try rpc_server.check();
}

const TokenFile = struct {
    reads: usize = 0,
    fn read(ctx: ?*anyopaque, allocator: std.mem.Allocator, path: []const u8, _: usize) !?[]u8 {
        const self: *@This() = @ptrCast(@alignCast(ctx.?));
        self.reads += 1;
        try std.testing.expectEqualStrings("/fixture/public-token", path);
        return try allocator.dupe(u8, "public-token");
    }
};
test "shared remote Tron actual Manager web identity auth physical timeout keeps owner deadline cancel and halt" {
    // Actual role ordering: credential lease precedes Factory.open/sign. This
    // is NOT an artificial nested lease from a persistence callback.
    const library = try fixtures.nativeLibrary(a);
    defer a.free(library);
    const behaviors = [_]fixtures.Behavior{.{ .replies = &.{.{ .body = "", .stall = true }} }};
    var server = try fixtures.Fixture.init(3, &behaviors);
    try server.start();
    defer server.deinit();
    const endpoint = try server.url(a, 0);
    defer a.free(endpoint);
    var native = try curl.Client.init(a, library);
    defer native.deinit();
    var owner = http.HttpTransport.init(a);
    defer owner.deinit();
    owner.native_curl = &native;
    owner.allow_insecure_loopback = true;
    owner.timeout_ms = 50;
    owner.connect_timeout_ms = 50;
    var cancel: std.atomic.Value(bool) = .init(false);
    var halt: std.atomic.Value(bool) = .init(false);
    owner.cancel = &cancel;
    const deadline = (try http.rpcNowNs()) + 2 * std.time.ns_per_s;
    owner.rpc_read_owner = .{ .deadline_ns = deadline, .halt = &halt }; // Default non-RPC capability.
    var env = std.process.EnvMap.init(a);
    defer env.deinit();
    try env.put("AWS_ROLE_ARN", "arn:aws:iam::000000000000:role/fixture");
    try env.put("AWS_WEB_IDENTITY_TOKEN_FILE", "/fixture/public-token");
    var chain = @import("../chain_source_testing.zig").chainFor(&.{endpoint});
    chain.protocol = .tron;
    chain.signer = .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } };
    var configured: settings.Settings = undefined;
    configured.chains = @as(*[1]settings.Chain, @ptrCast(&chain));
    configured.role = .{ .relayer = std.mem.zeroes(@import("../../settings/types.zig").Relayer) };
    var token: TokenFile = .{};
    const manager = try credentials.Manager.init(a, &configured, &env, &owner, .{ .sts_endpoint = endpoint, .file_reader = .{ .context = &token, .read_fn = TokenFile.read } });
    defer manager.deinit();
    try std.testing.expect(manager.transport == &owner and manager.options.transport_override == null);
    try std.testing.expectError(error.RequestDeadlineExceeded, manager.lease(1));
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expect(std.mem.indexOf(u8, server.records[0].bodyText(), "AssumeRoleWithWebIdentity") != null);
    try std.testing.expectEqual(deadline, owner.rpc_read_owner.?.deadline_ns);
    try std.testing.expect(owner.cancel == &cancel and owner.rpc_read_owner.?.halt == &halt and !owner.rpc_read_owner.?.retry_physical_timeout);
    cancel.store(true, .release);
    try std.testing.expectError(error.RequestCancelled, manager.lease(1));
    cancel.store(false, .release);
    halt.store(true, .release);
    try std.testing.expectError(error.CheckpointEffectsHalted, manager.lease(1));
    halt.store(false, .release);
    owner.rpc_read_owner.?.deadline_ns = (try http.rpcNowNs()) - 1;
    try std.testing.expectError(error.RequestDeadlineExceeded, manager.lease(1));
    try std.testing.expectEqual(@as(usize, 1), server.pathHits(0));
    try std.testing.expectEqual(@as(usize, 4), token.reads);
    try server.check();
}
