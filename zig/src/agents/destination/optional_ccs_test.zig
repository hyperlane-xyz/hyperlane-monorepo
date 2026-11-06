const std = @import("std");
const factory = @import("factory.zig");
const sources = @import("../chain_source.zig");
const settings = @import("../../settings/types.zig");
const signer = @import("../signer.zig");
const provider = @import("../../sealevel/provider.zig");
const http = @import("../../cloud/http.zig");
const A = std.mem.Allocator;
const Fixture = struct {
    env: std.process.EnvMap,
    resources: sources.Resources,
    client: provider.Client,
    simulations: usize = 0,
    delivered_id: ?[32]u8 = null,
    pending_commit: ?@import("reveal.zig").Commit = null,
    requests: usize = 0,
    fn init(self: *Fixture, a: A, ccs: ?settings.Signer) !void {
        self.simulations = 0;
        self.delivered_id = null;
        self.pending_commit = null;
        self.requests = 0;
        self.env = std.process.EnvMap.init(a);
        var chain = @import("../chain_source_testing.zig").chainFor(&.{"https://fixture/rpc"});
        chain.protocol = .sealevel;
        chain.domain = 2;
        chain.chain_id = "fixture";
        chain.signer = .{ .hex_key = @splat(7) };
        chain.ccs_signer = ccs;
        chain.contracts = .{ .mailbox = @splat(2), .merkle_tree_hook = @splat(4), .validator_announce = @splat(3), .interchain_gas_paymaster = @splat(5) };
        chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = .{ .ccs_url = "https://ccs.fixture/base", .program_id = @splat(9) }, .native_token_decimals = 9 } };
        self.resources = .{ .allocator = a, .arena = .init(a), .chain = chain, .environment = &self.env, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
        self.client = try provider.Client.init(a, "https://fixture/rpc", .{ .exchange = .{ .context = self, .fetch_fn = exchange } });
        self.resources.clients = .{ .sealevel = &self.client };
    }
    fn deinit(self: *Fixture) void {
        self.client.deinit();
        self.resources.http.deinit();
        self.resources.arena.deinit();
        self.env.deinit();
    }
    fn exchange(context: *anyopaque, a: A, input: []const u8, _: @import("../../evm/provider.zig").Options) !@import("../../evm/provider.zig").WireResponse {
        const self: *Fixture = @ptrCast(@alignCast(context));
        self.requests += 1;
        const rpc = @import("../../net/json_rpc.zig");
        var parsed = try std.json.parseFromSlice(std.json.Value, a, input, .{});
        defer parsed.deinit();
        const id = try rpc.integer(u64, try rpc.field(parsed.value, "id"));
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        var bytes: []u8 = undefined;
        if (std.mem.eql(u8, method, "simulateTransaction")) {
            const n = self.simulations % 6;
            self.simulations += 1;
            const program: [32]u8 = if (n == 1) @splat(2) else if (n == 2 or n == 3) @splat(8) else @splat(9);
            var returned: [33]u8 = @splat(8);
            returned[32] = 255;
            const payload: []const u8 = if (n == 1) &returned else &.{ 0, 0, 0, 0, 255 };
            const text = try base64(a, payload);
            defer a.free(text);
            const address = try @import("../../altvm/base58.zig").encode(a, &program);
            defer a.free(address);
            bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .err = @as(?u8, null), .unitsConsumed = 1000, .returnData = if (n == 5) null else @as(?struct { programId: []const u8, data: [2][]const u8 }, .{ .programId = address, .data = .{ text, "base64" } }) } } }, .{});
        } else if (std.mem.eql(u8, method, "getLatestBlockhash")) {
            const hash = try @import("../../altvm/base58.zig").encode(a, &(@as([32]u8, @splat(6))));
            defer a.free(hash);
            bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .blockhash = hash, .lastValidBlockHeight = 200 } } }, .{});
        } else if (std.mem.eql(u8, method, "getFeeForMessage")) {
            bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = 5000 } }, .{});
        } else if (std.mem.eql(u8, method, "getAccountInfo")) {
            const params = (try rpc.field(parsed.value, "params")).array.items;
            const key = try provider.decodeKey(a, try rpc.string(params[0]));
            const accounts = @import("../../sealevel/accounts.zig");
            var data: [57]u8 = @splat(0);
            var length: usize = 0;
            var account_owner: [32]u8 = @splat(2);
            if (std.mem.eql(u8, &key, &(try accounts.inboxPda(@splat(2))).key)) {
                data[0] = 1;
                std.mem.writeInt(u32, data[1..5], 2, .little);
                data[5] = (try accounts.inboxPda(@splat(2))).bump;
                @memset(data[6..38], 8);
                length = 46;
            } else if (self.pending_commit != null and std.mem.eql(u8, &key, &(try self.pending_commit.?.pending()).key)) {
                const commit = self.pending_commit.?;
                data[0..32].* = commit.recipient;
                std.mem.writeInt(u32, data[32..36], commit.origin, .little);
                data[36] = (try commit.pending()).bump;
                std.mem.writeInt(i64, data[37..45], 900, .little);
                account_owner = commit.program;
                length = 45;
            } else if (self.delivered_id) |message_id| {
                try std.testing.expectEqual(key, (try accounts.processedPda(@splat(2), message_id)).key);
                data[0] = 1;
                @memcpy(data[1..9], "PROCESSD");
                data[17..49].* = message_id;
                std.mem.writeInt(u64, data[49..57], 9, .little);
                length = 57;
            }
            if (length == 0) {
                bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = @as(?u8, null) } }, .{});
            } else {
                const encoded = try base64(a, data[0..length]);
                defer a.free(encoded);
                const owner = try @import("../../altvm/base58.zig").encode(a, &account_owner);
                defer a.free(owner);
                bytes = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .owner = owner, .executable = false, .lamports = 1, .data = .{ encoded, "base64" } } } }, .{});
            }
        } else return error.UnexpectedRpc;
        return .{ .bytes = bytes, .len = bytes.len };
    }
    fn open(self: *Fixture, a: A, options: factory.Options) !*factory.Factory {
        var configured = options;
        configured.enable_reveals = true;
        configured.allow_fixture_transport = true;
        configured.reveal_boot = @splat(1);
        configured.origin_bindings = &.{.{ .domain = 1, .hook = @splat(4) }};
        return factory.Factory.open(a, &self.resources, self.resources.chain.signer.?, self.credentials(), configured);
    }
    fn credentials(self: *Fixture) signer.Credentials {
        return .{ .transport = self.resources.http.interface(), .http_owner = &self.resources.http, .amz_date = "fixture" };
    }
};
test "optional CCS actual Factory missing signer keeps SVM mailbox available" {
    var fixture: Fixture = undefined;
    try fixture.init(std.testing.allocator, null);
    defer fixture.deinit();
    const owner = try factory.Factory.open(std.testing.allocator, &fixture.resources, fixture.resources.chain.signer.?, fixture.credentials(), .{ .enable_reveals = true, .allow_fixture_transport = true, .reveal_boot = @splat(1), .origin_bindings = &.{.{ .domain = 1, .hook = @splat(4) }} });
    defer owner.deinit();
    try std.testing.expect(owner.backend_ready and owner.ccs_digest == null);
}

fn base64(a: A, bytes: []const u8) ![]u8 {
    const out = try a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
    _ = std.base64.standard.Encoder.encode(out, bytes);
    return out;
}
fn clock() !factory.Clock {
    return .{ .unix_ms = 1000000, .deadline_ns = (try http.rpcNowNs()) + 10 * std.time.ns_per_s };
}
fn message() @import("../../protocol/root.zig").Message {
    return .{ .nonce = 0, .origin = 1, .destination = 2, .sender = @splat(2), .recipient = @splat(9), .body = &(@as([96]u8, @splat(3))) };
}
test "optional CCS missing node invalid local and unavailable remote preserve actual ordinary and commit preparation" {
    const a = std.testing.allocator;
    for ([_]?settings.Signer{ null, .node, .{ .hex_key = @splat(0) }, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } }, .{ .gcp = .{ .key_version_name = "projects/fixture/locations/global/keyRings/fixture/cryptoKeys/fixture/cryptoKeyVersions/1" } } }) |configured| {
        var fixture: Fixture = undefined;
        try fixture.init(a, configured);
        defer fixture.deinit();
        const owner = try fixture.open(a, .{});
        defer owner.deinit();
        try std.testing.expect(!owner.revealsAvailable() and owner.backend.sealevel.simulation_observer == null);
        const commit_message = message();
        const authority = try owner.authorityFor(1, commit_message.id(), 0, .process);
        var prepared = try owner.prepare(authority, commit_message, "", try clock());
        defer prepared.deinit();
        try std.testing.expectEqual(prepared.authority.operation_id, commit_message.id());
        var ordinary = commit_message;
        ordinary.body = "ordinary";
        var ordinary_prepared = try owner.prepare(try owner.authorityFor(1, ordinary.id(), 0, .process), ordinary, "", try clock());
        defer ordinary_prepared.deinit();
        fixture.delivered_id = commit_message.id();
        try std.testing.expect(try owner.delivered(commit_message.id(), try clock()));
        try std.testing.expectEqual(@as(usize, 12), fixture.simulations);
    }
}
test "optional CCS invalid URL remains hard even without signer or reveals enabled" {
    var fixture: Fixture = undefined;
    try fixture.init(std.testing.allocator, null);
    defer fixture.deinit();
    fixture.resources.chain.connection.sealevel.ur_reveal.?.ccs_url = "http://ccs.example";
    const result = factory.Factory.open(std.testing.allocator, &fixture.resources, fixture.resources.chain.signer.?, fixture.credentials(), .{});
    if (result) |owner| {
        owner.deinit();
        return error.ExpectedInvalidCcsUrl;
    } else |err| try std.testing.expectEqual(error.InsecureCcsUrl, err);
}
const Lease = struct {
    fixture: *Fixture,
    failure: ?anyerror = null,
    calls: usize = 0,
    cancel_on_call: ?*std.atomic.Value(bool) = null,
    fn get(context: *anyopaque, _: u64) !signer.Credentials {
        const self: *Lease = @ptrCast(@alignCast(context));
        self.calls += 1;
        if (self.cancel_on_call) |cancel| cancel.store(true, .release);
        if (self.fixture.resources.http.rpc_read_owner) |guard| try std.testing.expect(!guard.retry_physical_timeout);
        if (self.failure) |err| return err;
        return self.fixture.credentials();
    }
    fn provider(self: *Lease) factory.CcsCredentials {
        return .{ .context = self, .lease_fn = get };
    }
};
test "optional CCS auth degradation preserves controls OOM and shared HTTP guard" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, .{ .hex_key = @splat(0x11) });
    defer fixture.deinit();
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = (try clock()).deadline_ns, .retry_physical_timeout = true };
    var lease: Lease = .{ .fixture = &fixture, .failure = error.OptionalAuthUnavailable };
    const unavailable = try fixture.open(a, .{ .ccs_credentials = lease.provider() });
    try std.testing.expect(!unavailable.revealsAvailable());
    unavailable.deinit();
    try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    for ([_]anyerror{ error.OutOfMemory, error.PendingReadIo, error.PendingIo, error.RequestCancelled, error.RequestDeadlineExceeded, error.CheckpointEffectsHalted, error.ReorgHalted }) |err| {
        lease.failure = err;
        try std.testing.expectError(err, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
        try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    }
    lease.failure = null;
    const owner = try fixture.open(a, .{ .ccs_credentials = lease.provider() });
    defer owner.deinit();
    try std.testing.expect(owner.revealsAvailable());
    try std.testing.expectEqual(@as(usize, 9), lease.calls);
    try owner.refresh(fixture.credentials());
    try std.testing.expectEqual(@as(usize, 9), lease.calls);
    try owner.refreshCcs();
    try std.testing.expectEqual(@as(usize, 10), lease.calls);
    lease.failure = error.OptionalAuthUnavailable;
    try std.testing.expectError(error.OptionalAuthUnavailable, owner.refreshCcs());
    try std.testing.expect(owner.revealsAvailable());
    try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    var cancel: std.atomic.Value(bool) = .init(true);
    fixture.resources.http.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
    try std.testing.expectEqual(@as(usize, 11), lease.calls);
    cancel.store(false, .release);
    lease.cancel_on_call = &cancel;
    try std.testing.expectError(error.RequestCancelled, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
    fixture.resources.http.cancel = null;
    cancel.store(false, .release);
    fixture.resources.http.rpc_read_owner.?.halt = &cancel;
    try std.testing.expectError(error.CheckpointEffectsHalted, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
}
fn allocationOpen(a: A, fixture: *Fixture) !void {
    const owner = try fixture.open(a, .{});
    defer owner.deinit();
    try std.testing.expect(owner.revealsAvailable());
}
test "optional CCS actual Factory every allocation failure propagates and cleans optional identity" {
    var fixture: Fixture = undefined;
    try fixture.init(std.testing.allocator, .{ .hex_key = @splat(0x11) });
    defer fixture.deinit();
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationOpen, .{&fixture});
}
const ManagedLease = struct {
    manager: *@import("../credentials.zig").Manager,
    calls: usize = 0,
    fn get(context: *anyopaque, unix_seconds: u64) !signer.Credentials {
        const self: *ManagedLease = @ptrCast(@alignCast(context));
        self.calls += 1;
        return @import("../relayer_task.zig").NativeTests.optionalSignerLease(self.manager, self.manager.transport, unix_seconds);
    }
    fn provider(self: *ManagedLease) factory.CcsCredentials {
        return .{ .context = self, .lease_fn = get };
    }
};
const Kms = struct {
    owner: *http.HttpTransport,
    fail: bool = true,
    requests: usize = 0,
    fn send(context: *anyopaque, a: A, _: @import("../../net/curl.zig").Request) !@import("../../net/curl.zig").Response {
        const self: *Kms = @ptrCast(@alignCast(context));
        self.requests += 1;
        if (self.owner.rpc_read_owner) |guard| try std.testing.expect(!guard.retry_physical_timeout);
        if (self.fail) return error.FixtureKmsUnavailable;
        const public = try std.crypto.ecc.Secp256k1.basePoint.mul(@as([32]u8, @splat(0x11)), .big);
        var der: [88]u8 = undefined;
        const prefix = [_]u8{ 0x30, 86, 0x30, 0x10, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x05, 0x2b, 0x81, 0x04, 0x00, 0x0a, 3, 66, 0 };
        @memcpy(der[0..prefix.len], &prefix);
        @memcpy(der[prefix.len..], &public.toUncompressedSec1());
        const encoded = try base64(a, &der);
        defer a.free(encoded);
        const body = try std.json.Stringify.valueAlloc(a, .{ .KeyId = "arn:aws:kms:us-east-1:123456789012:key/fixture", .KeySpec = "ECC_SECG_P256K1", .KeyUsage = "SIGN_VERIFY", .SigningAlgorithms = .{"ECDSA_SHA_256"}, .PublicKey = encoded }, .{});
        return .{ .allocator = a, .body = body, .headers = &.{}, .header_storage = &.{}, .status = 200, .http_version = 2 };
    }
};
test "optional CCS real Manager and Factory isolate cloud lease from required payer and other chains" {
    const a = std.testing.allocator;
    const credentials = @import("../credentials.zig");
    var fixture: Fixture = undefined;
    try fixture.init(a, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    defer fixture.deinit();
    // Synthetic static auth only. No HOME, files, ambient process env or metadata.
    try fixture.env.put("AWS_ACCESS_KEY_ID", "EXAMPLECCSONLY");
    try fixture.env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var configured: @import("../../settings/root.zig").Settings = .{ .config = undefined, .metrics_port = 0, .chains = &.{}, .role = .{ .relayer = std.mem.zeroes(settings.Relayer) } };
    var chains = [_]settings.Chain{ fixture.resources.chain, fixture.resources.chain };
    chains[1].name = "unrelated-unavailable-cloud-signer";
    chains[1].signer = .{ .gcp = .{ .key_version_name = "unused" } };
    configured.chains = &chains;
    var payer_manager: ?*credentials.Manager = null;
    defer if (payer_manager) |manager| manager.deinit();
    const payer = try @import("../relayer_task.zig").NativeTests.requiredPayerLease(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.signer.?, &payer_manager, 1000);
    try std.testing.expect(payer.aws == null and payer.gcp_bearer == null);
    try std.testing.expectEqual(@as(usize, 0), payer_manager.?.environment.count());
    const mandatory_remote = try credentials.Manager.initForSigner(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.ccs_signer.?, .{});
    defer mandatory_remote.deinit();
    try std.testing.expectError(error.NativeCredentialTransportRequired, mandatory_remote.lease(1000));
    var no_native: ManagedLease = .{ .manager = mandatory_remote };
    const auth_unavailable = try fixture.open(a, .{ .ccs_credentials = no_native.provider() });
    try std.testing.expect(!auth_unavailable.revealsAvailable());
    auth_unavailable.deinit();
    // Actual optional Manager lease succeeds, but actual KMS key initialization
    // fails. Only the auxiliary capability degrades; required payer stayed local.
    var kms: Kms = .{ .owner = &fixture.resources.http };
    var native: @import("../../net/curl.zig").Client = .{ .library = undefined, .api = undefined, .send_override = .{ .context = &kms, .send_fn = Kms.send } };
    fixture.resources.http.native_curl = &native;
    const optional = try credentials.Manager.initForSigner(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.ccs_signer.?, .{});
    defer optional.deinit();
    var managed: ManagedLease = .{ .manager = optional };
    const degraded = try fixture.open(a, .{ .ccs_credentials = managed.provider() });
    try std.testing.expect(!degraded.revealsAvailable());
    degraded.deinit();
    try std.testing.expectEqual(@as(usize, 1), kms.requests);
    kms.fail = false;
    const working = try fixture.open(a, .{ .ccs_credentials = managed.provider() });
    defer working.deinit();
    try std.testing.expect(working.revealsAvailable());
    try std.testing.expectEqualStrings("EXAMPLECCSONLY", working.ccs_digest.?.backend.aws.config.credentials.access_key_id);
    try working.refresh(payer);
    try std.testing.expectEqualStrings("EXAMPLECCSONLY", working.ccs_digest.?.backend.aws.config.credentials.access_key_id);
    try working.refreshCcs();
    try std.testing.expectEqual(@as(usize, 2), kms.requests); // Refresh never re-resolves the pinned key.
    try std.testing.expectEqual(@as(usize, 3), managed.calls);
    fixture.resources.http.last_native_physical_timeout = true;
    var successful = try fixture.resources.http.interface().send(a, .{ .method = .GET, .url = "https://fixture/" });
    successful.deinit();
    try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
    kms.fail = true;
    fixture.resources.http.last_native_physical_timeout = true;
    try std.testing.expectError(error.FixtureKmsUnavailable, fixture.resources.http.interface().send(a, .{ .method = .GET, .url = "https://fixture/" }));
    try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
}

test "optional CCS degraded commit completes canonical process and preserves existing durable child" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, .{ .hex_key = @splat(0x11) });
    defer fixture.deinit();
    var temporary = std.testing.tmpDir(.{});
    defer temporary.cleanup();
    const path = try temporary.dir.realpathAlloc(a, ".");
    defer a.free(path);
    var database = try @import("../../db/root.zig").rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "optional-ccs-origin");
    const commit_message = message();
    _ = try store.storeMessage(commit_message, 1, null);
    const healthy = try fixture.open(a, .{});
    const queue = @import("reveal_queue.zig");
    const route = try queue.routeId(2, @import("reveal.zig").Commit.message(@splat(9), commit_message).?);
    try healthy.onDelivered(&store, commit_message, try clock());
    healthy.deinit();
    const before = (try store.typed.get(a, "zig_ur_reveal_v1/", &route)).?;
    defer a.free(before);
    fixture.resources.chain.ccs_signer = null;
    const degraded = try fixture.open(a, .{});
    defer degraded.deinit();
    // Real Factory delivery hook must no-op BEFORE the process marker commit.
    try degraded.onDelivered(&store, commit_message, try clock());
    degraded.svm_witness.failure = .{ .instruction = 2, .code = 10 };
    try std.testing.expect(!try degraded.recoverDuplicateCommit(&store, commit_message, try clock()));
    const now: @import("operation.zig").Times = .{ .unix_ms = 1000000, .monotonic_ms = 0 };
    try std.testing.expectEqual(@as(usize, 0), try degraded.tickReveal(&store, try clock(), now));
    const after = (try store.typed.get(a, "zig_ur_reveal_v1/", &route)).?;
    defer a.free(after);
    try std.testing.expectEqualSlices(u8, before, after);
    const actor = try @import("operation.zig").Operation.open(a, &store, .{ .id = commit_message.id(), .nonce = commit_message.nonce, .origin = 1, .destination = 2, .context = try degraded.contextFor(try degraded.authorityFor(1, commit_message.id(), 0, .process)), .policy = .{ .confirm_delay_ms = 0 } }, now);
    defer actor.deinit();
    fixture.delivered_id = commit_message.id();
    var policy = try @import("../relay_policy.zig").Policy.init(a, .{}, null, null);
    defer policy.deinit();
    var history: History = .{};
    const driver: @import("../relayer/native_driver.zig").Driver = .{};
    try std.testing.expectEqual(@import("../relayer/native_driver.zig").State.delivered, (try driver.step(a, degraded, actor, &history, &policy, commit_message, try clock(), now)).state);
    try std.testing.expect(try store.processed(commit_message.nonce));
    // A later healthy startup can still recover the exact owned child/context.
    fixture.resources.chain.ccs_signer = .{ .hex_key = @splat(0x11) };
    const recovered = try fixture.open(a, .{});
    defer recovered.deinit();
    try recovered.onDelivered(&store, commit_message, try clock());
    const replay = (try store.typed.get(a, "zig_ur_reveal_v1/", &route)).?;
    defer a.free(replay);
    try std.testing.expectEqualSlices(u8, before, replay);
}

const History = struct {
    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?@import("../../storage/objects.zig").SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }
    pub fn proof(_: *@This(), _: u32, _: @import("../../protocol/root.zig").Checkpoint) !@import("../../protocol/root.zig").Proof {
        return error.UnexpectedMetadata;
    }
};
test "optional CCS never hides missing required payer or resolves absent optional signer" {
    const a = std.testing.allocator;
    var fixture: Fixture = undefined;
    try fixture.init(a, null);
    defer fixture.deinit();
    var lease: Lease = .{ .fixture = &fixture, .failure = error.OptionalAuthUnavailable };
    const owner = try fixture.open(a, .{ .ccs_credentials = lease.provider() });
    owner.deinit();
    try std.testing.expectEqual(@as(usize, 0), lease.calls);
    fixture.resources.chain.signer = .node;
    try std.testing.expectError(error.SealevelSignerRequired, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
    try std.testing.expectEqual(@as(usize, 0), lease.calls);
}
const LazyManagedLease = struct {
    allocator: A,
    fixture: *Fixture,
    configured: *@import("../../settings/root.zig").Settings,
    manager: ?*@import("../credentials.zig").Manager = null,
    fn get(context: *anyopaque, unix_seconds: u64) !signer.Credentials {
        const self: *LazyManagedLease = @ptrCast(@alignCast(context));
        if (self.manager == null) self.manager = try @import("../credentials.zig").Manager.initForSigner(self.allocator, self.configured, &self.fixture.env, &self.fixture.resources.http, self.fixture.resources.chain.ccs_signer.?, .{});
        return self.manager.?.lease(unix_seconds);
    }
};
fn allocationLazyManager(a: A, fixture: *Fixture) !void {
    var configured: @import("../../settings/root.zig").Settings = .{ .config = undefined, .metrics_port = 0, .chains = &.{}, .role = .{ .relayer = std.mem.zeroes(settings.Relayer) } };
    var lease: LazyManagedLease = .{ .allocator = a, .fixture = fixture, .configured = &configured };
    defer if (lease.manager) |manager| manager.deinit();
    const owner = try fixture.open(a, .{ .ccs_credentials = .{ .context = &lease, .lease_fn = LazyManagedLease.get } });
    defer owner.deinit();
    try std.testing.expect(owner.revealsAvailable());
}
test "optional CCS lazy Manager every allocation failure remains hard and owner teardown follows Factory" {
    var fixture: Fixture = undefined;
    try fixture.init(std.testing.allocator, .{ .hex_key = @splat(0x11) });
    defer fixture.deinit();
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationLazyManager, .{&fixture});
}
const StallServer = struct {
    server: std.net.Server,
    stop: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    accepted: std.atomic.Value(usize) = .init(0),
    failure: ?anyerror = null,
    fn init() !StallServer {
        return .{ .server = try (try std.net.Address.parseIp4("127.0.0.1", 0)).listen(.{}) };
    }
    fn start(self: *StallServer) !void {
        self.thread = try std.Thread.spawn(.{}, run, .{self});
    }
    fn deinit(self: *StallServer) void {
        self.stop.store(true, .release);
        if (self.thread) |thread| thread.join();
        self.server.deinit();
    }
    fn run(self: *StallServer) void {
        self.serve() catch |err| {
            self.failure = err;
        };
    }
    fn serve(self: *StallServer) !void {
        var streams: [16]std.net.Stream = undefined;
        var count: usize = 0;
        defer for (streams[0..count]) |stream| stream.close();
        while (!self.stop.load(.acquire)) {
            var fds = [_]std.posix.pollfd{.{ .fd = self.server.stream.handle, .events = std.posix.POLL.IN, .revents = 0 }};
            if (try std.posix.poll(&fds, 10) == 0) continue;
            if (count == streams.len) return error.FixtureTooManyConnections;
            streams[count] = (try self.server.accept()).stream;
            count += 1;
            _ = self.accepted.fetchAdd(1, .release);
            // Keep the actual accepted socket open without a response.
        }
    }
    fn url(self: *StallServer, a: A) ![]u8 {
        return std.fmt.allocPrint(a, "http://127.0.0.1:{d}/", .{self.server.listen_address.getPort()});
    }
};
test "optional CCS real native physical key timeout degrades only within original live owner" {
    const a = std.testing.allocator;
    const library = try @import("../../evm/pool_testing.zig").nativeLibrary(a);
    defer a.free(library);
    var server = try StallServer.init();
    try server.start();
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var native = try @import("../../net/curl.zig").Client.init(a, library);
    defer native.deinit();
    var fixture: Fixture = undefined;
    try fixture.init(a, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    defer fixture.deinit();
    fixture.resources.http.native_curl = &native;
    fixture.resources.http.allow_insecure_loopback = true;
    fixture.resources.http.timeout_ms = 30;
    fixture.resources.http.connect_timeout_ms = 30;
    try fixture.env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
    try fixture.env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
    var configured: @import("../../settings/root.zig").Settings = .{ .config = undefined, .metrics_port = 0, .chains = &.{}, .role = .{ .relayer = std.mem.zeroes(settings.Relayer) } };
    const manager = try @import("../credentials.zig").Manager.initForSigner(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.ccs_signer.?, .{ .kms_endpoint = url });
    defer manager.deinit();
    var managed: ManagedLease = .{ .manager = manager };
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = (try clock()).deadline_ns, .retry_physical_timeout = true };
    const owner = try fixture.open(a, .{ .ccs_credentials = managed.provider() });
    try std.testing.expect(!owner.revealsAvailable());
    owner.deinit();
    try std.testing.expect(fixture.resources.http.rpc_read_owner.?.retry_physical_timeout);
    try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
    // The same physical cap may not disguise an owner-clamped deadline.
    fixture.resources.http.timeout_ms = 1000;
    fixture.resources.http.rpc_read_owner.?.deadline_ns = (try http.rpcNowNs()) + 20 * std.time.ns_per_ms;
    try std.testing.expectError(error.RequestDeadlineExceeded, fixture.open(a, .{ .ccs_credentials = managed.provider() }));
    try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
    // No fresh native request occurs after actual owner cancellation/halt.
    fixture.resources.http.rpc_read_owner.?.deadline_ns = (try clock()).deadline_ns;
    var cancel: std.atomic.Value(bool) = .init(true);
    fixture.resources.http.cancel = &cancel;
    try std.testing.expectError(error.RequestCancelled, fixture.open(a, .{ .ccs_credentials = managed.provider() }));
    cancel.store(false, .release);
    var halt: std.atomic.Value(bool) = .init(true);
    fixture.resources.http.rpc_read_owner.?.halt = &halt;
    try std.testing.expectError(error.CheckpointEffectsHalted, fixture.open(a, .{ .ccs_credentials = managed.provider() }));
    try std.testing.expectEqual(@as(usize, 2), managed.calls);
    try std.testing.expectEqual(@as(usize, 2), server.accepted.load(.acquire));
    if (server.failure) |err| return err;
}
test "optional CCS real native metadata auth timeout is scoped and does not leak stale provenance" {
    const a = std.testing.allocator;
    const library = try @import("../../evm/pool_testing.zig").nativeLibrary(a);
    defer a.free(library);
    var server = try StallServer.init();
    try server.start();
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var native = try @import("../../net/curl.zig").Client.init(a, library);
    defer native.deinit();
    var fixture: Fixture = undefined;
    try fixture.init(a, .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } });
    defer fixture.deinit();
    fixture.resources.http.native_curl = &native;
    fixture.resources.http.allow_insecure_loopback = true;
    fixture.resources.http.timeout_ms = 30;
    fixture.resources.http.connect_timeout_ms = 30;
    fixture.resources.http.rpc_read_owner = .{ .deadline_ns = (try clock()).deadline_ns, .retry_physical_timeout = true };
    try fixture.env.put("AWS_CONTAINER_CREDENTIALS_FULL_URI", url);
    try fixture.env.put("AWS_EC2_METADATA_DISABLED", "true");
    var configured: @import("../../settings/root.zig").Settings = .{ .config = undefined, .metrics_port = 0, .chains = &.{}, .role = .{ .relayer = std.mem.zeroes(settings.Relayer) } };
    const manager = try @import("../credentials.zig").Manager.initForSigner(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.ccs_signer.?, .{});
    defer manager.deinit();
    var managed: ManagedLease = .{ .manager = manager };
    const unavailable = try fixture.open(a, .{ .ccs_credentials = managed.provider() });
    unavailable.deinit();
    try std.testing.expectEqual(@as(usize, 1), server.accepted.load(.acquire));
    try std.testing.expect(manager.metadata_transport.rpc_read_owner == null);
    try std.testing.expect(!manager.metadata_transport.last_native_physical_timeout and !fixture.resources.http.last_native_physical_timeout);
    // Injected deadline errors remain control even after the preceding real
    // native timeout; neither stale diagnostic nor mock origin can authorize off.
    var lease: Lease = .{ .fixture = &fixture, .failure = error.RequestDeadlineExceeded };
    try std.testing.expectError(error.RequestDeadlineExceeded, fixture.open(a, .{ .ccs_credentials = lease.provider() }));
    if (server.failure) |err| return err;
}
test "optional CCS initialization deadline derives from original retained worker start" {
    const owner = @import("../../runtime/lane_owner.zig");
    const Noop = struct {
        fn run(_: *anyopaque, _: @import("../../runtime/supervisor.zig").Times, _: *const std.atomic.Value(bool)) !@import("../../runtime/supervisor.zig").Report {
            return .{};
        }
    };
    var context: u8 = 0;
    var worker = try owner.Owner.init(&context, Noop.run, .{ .timeout_ms = 1000 });
    const get = @import("../relayer_task.zig").NativeTests.originalInitializationDeadline;
    try std.testing.expectError(error.MissingLaneInitializationClock, get(&worker));
    worker.timer = try std.time.Timer.start();
    const before = try get(&worker);
    std.Thread.sleep(2 * std.time.ns_per_ms);
    try std.testing.expectEqual(before, try get(&worker));
    try std.testing.expect(before > try http.rpcNowNs());
    try std.testing.expect(before - try http.rpcNowNs() < std.time.ns_per_s);
}
const DeadlineMock = struct {
    fn send(_: *anyopaque, _: A, _: @import("../../net/curl.zig").Request) !@import("../../net/curl.zig").Response {
        return error.RequestDeadlineExceeded;
    }
};
test "optional CCS late native KMS and fetch outages back off child while ordinary Actor progresses" {
    const a = std.testing.allocator;
    const library = try @import("../../evm/pool_testing.zig").nativeLibrary(a);
    defer a.free(library);
    for ([_]bool{ true, false }) |remote| {
        var server = try StallServer.init();
        try server.start();
        defer server.deinit();
        const url = try server.url(a);
        defer a.free(url);
        var native = try @import("../../net/curl.zig").Client.init(a, library);
        defer native.deinit();
        var fixture: Fixture = undefined;
        try fixture.init(a, if (remote) .{ .aws = .{ .id = "alias/fixture", .region = "us-east-1" } } else .{ .hex_key = @splat(0x11) });
        defer fixture.deinit();
        fixture.resources.chain.connection.sealevel.ur_reveal.?.ccs_url = url;
        fixture.resources.http.native_curl = &native;
        fixture.resources.http.allow_insecure_loopback = true;
        fixture.resources.http.timeout_ms = 30;
        fixture.resources.http.connect_timeout_ms = 30;
        try fixture.env.put("AWS_ACCESS_KEY_ID", "EXAMPLE");
        try fixture.env.put("AWS_SECRET_ACCESS_KEY", "public-fixture");
        var configured: @import("../../settings/root.zig").Settings = .{ .config = undefined, .metrics_port = 0, .chains = &.{}, .role = .{ .relayer = std.mem.zeroes(settings.Relayer) } };
        const manager = try @import("../credentials.zig").Manager.initForSigner(a, &configured, &fixture.env, &fixture.resources.http, fixture.resources.chain.ccs_signer.?, .{ .kms_endpoint = url });
        defer manager.deinit();
        var managed: ManagedLease = .{ .manager = manager };
        var kms: Kms = .{ .owner = &fixture.resources.http, .fail = false };
        native.send_override = .{ .context = &kms, .send_fn = Kms.send };
        const owner = try fixture.open(a, .{ .ccs_credentials = managed.provider() });
        defer owner.deinit();
        try std.testing.expect(owner.revealsAvailable());
        native.send_override = null; // Only the later actual physical outage is under test.
        var temporary = std.testing.tmpDir(.{});
        defer temporary.cleanup();
        const path = try temporary.dir.realpathAlloc(a, ".");
        defer a.free(path);
        var database = try @import("../../db/root.zig").rocks.Database.open(a, path, .{});
        defer database.deinit();
        var store = @import("../store.zig").Store.init(a, &database, "late-optional-outage");
        const commit_message = message();
        fixture.pending_commit = @import("reveal.zig").Commit.message(@splat(9), commit_message).?;
        try owner.onDelivered(&store, commit_message, try clock());
        const now: @import("operation.zig").Times = .{ .unix_ms = 1000000, .monotonic_ms = 0 };
        try std.testing.expectEqual(@as(usize, 1), try owner.tickReveal(&store, try clock(), now)); // PDA→tokens.
        try std.testing.expectEqual(@as(usize, 1), try owner.tickReveal(&store, try clock(), now)); // Actual native timeout→durable retry.
        const queue = @import("reveal_queue.zig");
        var row = (try queue.next(a, &store, 2)).?;
        defer row.deinit();
        try std.testing.expectEqual(queue.Phase.tokens, row.value().phase);
        try std.testing.expectEqual(@as(u32, 1), row.value().token_count);
        try std.testing.expect(!row.due(now.unix_ms) and row.due(now.unix_ms + 5000));
        try std.testing.expectEqual(!remote, row.value().signature_hex != null);
        try std.testing.expectEqual(@as(usize, 0), try owner.tickReveal(&store, try clock(), now));
        try std.testing.expectEqual(@as(usize, 1), server.accepted.load(.acquire));
        try std.testing.expect(!fixture.resources.http.last_native_physical_timeout);
        // A separate ordinary operation can finish in the same lane after the
        // auxiliary step returns; no key/send/nonce work is required for it.
        var ordinary = commit_message;
        ordinary.nonce = 1;
        ordinary.body = "ordinary";
        _ = try store.storeMessage(ordinary, 2, null);
        fixture.delivered_id = ordinary.id();
        const actor = try @import("operation.zig").Operation.open(a, &store, .{ .id = ordinary.id(), .nonce = ordinary.nonce, .origin = 1, .destination = 2, .context = try owner.contextFor(try owner.authorityFor(1, ordinary.id(), 0, .process)), .policy = .{ .confirm_delay_ms = 0 } }, now);
        defer actor.deinit();
        var policy = try @import("../relay_policy.zig").Policy.init(a, .{}, null, null);
        defer policy.deinit();
        var history: History = .{};
        const driver: @import("../relayer/native_driver.zig").Driver = .{};
        try std.testing.expectEqual(@import("../relayer/native_driver.zig").State.delivered, (try driver.step(a, owner, actor, &history, &policy, ordinary, try clock(), now)).state);
        try std.testing.expect(try store.processed(ordinary.nonce));
        const route = try queue.routeId(2, fixture.pending_commit.?);
        const before = (try store.typed.get(a, "zig_ur_reveal_v1/", &route)).?;
        defer a.free(before);
        const due: @import("operation.zig").Times = .{ .unix_ms = now.unix_ms + 5000, .monotonic_ms = 5000 };
        fixture.resources.http.timeout_ms = 1000;
        var limited = try clock();
        limited.deadline_ns = (try http.rpcNowNs()) + 20 * std.time.ns_per_ms;
        try std.testing.expectError(error.RequestDeadlineExceeded, owner.tickReveal(&store, limited, due));
        // A later mock timeout cannot reuse the preceding native evidence.
        native.send_override = .{ .context = &kms, .send_fn = DeadlineMock.send };
        fixture.resources.http.last_native_physical_timeout = true;
        try std.testing.expectError(error.RequestDeadlineExceeded, owner.tickReveal(&store, try clock(), due));
        var cancel: std.atomic.Value(bool) = .init(true);
        var cancelled = try clock();
        cancelled.cancel = &cancel;
        try std.testing.expectError(error.RequestCancelled, owner.tickReveal(&store, cancelled, due));
        var halted = try clock();
        halted.halt = &cancel;
        try std.testing.expectError(error.CheckpointEffectsHalted, owner.tickReveal(&store, halted, due));
        const after = (try store.typed.get(a, "zig_ur_reveal_v1/", &route)).?;
        defer a.free(after);
        try std.testing.expectEqualSlices(u8, before, after);
        if (server.failure) |err| return err;
    }
}
