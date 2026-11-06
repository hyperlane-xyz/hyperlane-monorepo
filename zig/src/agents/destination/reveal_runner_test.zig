const std = @import("std");
const types = @import("types.zig");
const destination = @import("root.zig");
const queue = @import("reveal_queue.zig");
const reveal = @import("reveal.zig");
const protocol = @import("../../protocol/root.zig");
const objects = @import("../../storage/objects.zig");
const rpc = @import("../../net/json_rpc.zig");
const evm = @import("../../evm/provider.zig");
const curl = @import("../../net/curl.zig");
const b58 = @import("../../altvm/base58.zig");
const A = std.mem.Allocator;
const History = struct {
    pub fn leafIndex(_: *@This(), _: [32]u8) !?u32 {
        return null;
    }
    pub fn highestKnownLeafIndex(_: *@This()) !?u32 {
        return null;
    }
    pub fn fetchCheckpoint(_: *@This(), _: [20]u8, _: u32) !?objects.SignedCheckpoint {
        return null;
    }
    pub fn latestIndex(_: *@This(), _: [20]u8) !?u32 {
        return null;
    }
    pub fn proof(_: *@This(), _: u32, _: protocol.Checkpoint) !protocol.Proof {
        return error.UnexpectedRevealProof;
    }
};
const Fixture = struct {
    allocator: A,
    store: *@import("../store.zig").Store,
    aux_id: [32]u8,
    pending_key: []const u8,
    token_key: []const u8,
    pending_owner: []const u8,
    token_owner: []const u8,
    pending_b64: []const u8,
    token_b64: []const u8,
    ccs_json: []const u8,
    commit: reveal.Commit,
    ccs_signer: [20]u8,
    ccs_requests: usize = 0,
    ccs_status: u16 = 200,
    sign_calls: usize = 0,
    broadcasts: usize = 0,
    finalized: bool = false,
    pending_exists: bool = true,
    height: u64 = 100,
    last_valid_height: u64 = 200,
    blockhash_byte: u8 = 8,
    allow_new_wire: bool = false,
    wire: ?[]u8 = null,
    authorization: ?[]u8 = null,
    fn deinit(self: *Fixture) void {
        if (self.wire) |wire| self.allocator.free(wire);
        if (self.authorization) |authorization| self.allocator.free(authorization);
    }
    fn assertPersisted(self: *Fixture, signed: bool) !void {
        const row = try self.store.typed.get(self.allocator, "zig_native_destination_operation_v1/", &self.aux_id) orelse return error.MissingRevealActorIntent;
        defer self.allocator.free(row);
        var parsed = try std.json.parseFromSlice(std.json.Value, self.allocator, row, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("reveal", (try rpc.field(parsed.value, "kind")).string);
        try std.testing.expect((try rpc.field(parsed.value, "intent")) != .null);
        if (signed) try std.testing.expect((try rpc.field(parsed.value, "signed_hex")) != .null) else try std.testing.expectEqualStrings("ready", (try rpc.field(parsed.value, "stage")).string);
    }
    fn sign(ctx: *anyopaque, key: [32]u8, message: []const u8) ![64]u8 {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        try self.assertPersisted(false);
        const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{7} ** 32);
        try std.testing.expectEqual(key, pair.public_key.toBytes());
        self.sign_calls += 1;
        return (try pair.sign(message, null)).toBytes();
    }
    fn ccs(ctx: *anyopaque, a: A, request: curl.Request) !curl.Response {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        self.ccs_requests += 1;
        try std.testing.expectEqual(curl.Method.get, request.method);
        try std.testing.expect(request.timeout_ms <= 30000);
        try std.testing.expect(std.mem.startsWith(u8, request.url, "https://ccs.fixture/base/calldata/0x"));
        var authorization: ?[]const u8 = null;
        for (request.headers) |header| if (std.ascii.eqlIgnoreCase(header.name, "Authorization")) {
            authorization = header.value;
        };
        const text = authorization orelse return error.MissingCcsAuthorization;
        try std.testing.expect(std.mem.startsWith(u8, text, "Hyperlane-Signature "));
        const signature = try @import("../../evm/codecs.zig").fixedHex(65, text["Hyperlane-Signature ".len..]);
        const digest = try reveal.authenticationHash(a, "https://ccs.fixture/base", self.commit, self.ccs_signer, false);
        try std.testing.expectEqual(self.ccs_signer, try protocol.signature.recover(digest, signature));
        if (self.authorization) |old| try std.testing.expectEqualStrings(old, text) else self.authorization = try self.allocator.dupe(u8, text);
        return .{ .allocator = a, .body = try a.dupe(u8, self.ccs_json), .headers = &.{}, .header_storage = &.{}, .status = self.ccs_status, .http_version = 2 };
    }
    fn exchange(ctx: *anyopaque, a: A, input: []const u8, _: evm.Options) !evm.WireResponse {
        const self: *Fixture = @ptrCast(@alignCast(ctx));
        var parsed = try std.json.parseFromSlice(std.json.Value, a, input, .{});
        defer parsed.deinit();
        const method = try rpc.string(try rpc.field(parsed.value, "method"));
        const id = try rpc.integer(u64, try rpc.field(parsed.value, "id"));
        const params = (try rpc.field(parsed.value, "params")).array.items;
        var response: []u8 = undefined;
        if (std.mem.eql(u8, method, "getAccountInfo")) {
            const key = try rpc.string(params[0]);
            const is_pending = std.mem.eql(u8, key, self.pending_key);
            if (!is_pending and !std.mem.eql(u8, key, self.token_key)) return error.UnexpectedRevealAccount;
            if (is_pending and !self.pending_exists) {
                response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = @as(?u8, null) } }, .{});
            } else response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .owner = if (is_pending) self.pending_owner else self.token_owner, .executable = false, .lamports = 1, .data = [_][]const u8{ if (is_pending) self.pending_b64 else self.token_b64, "base64" } } } }, .{});
        } else if (std.mem.eql(u8, method, "simulateTransaction")) {
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .err = @as(?u8, null), .unitsConsumed = 1000, .logs = [_][]const u8{} } } }, .{});
        } else if (std.mem.eql(u8, method, "getLatestBlockhash")) {
            const hash = try b58.encode(a, &([_]u8{self.blockhash_byte} ** 32));
            defer a.free(hash);
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = .{ .blockhash = hash, .lastValidBlockHeight = self.last_valid_height } } }, .{});
        } else if (std.mem.eql(u8, method, "getFeeForMessage")) {
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 10 }, .value = 5000 } }, .{});
        } else if (std.mem.eql(u8, method, "getBlockHeight") or std.mem.eql(u8, method, "getSlot")) {
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = if (std.mem.eql(u8, method, "getSlot")) @as(u64, 10) else self.height }, .{});
        } else if (std.mem.eql(u8, method, "sendTransaction")) {
            try self.assertPersisted(true);
            const text = try rpc.string(params[0]);
            const bytes = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(text));
            defer a.free(bytes);
            try std.base64.standard.Decoder.decode(bytes, text);
            const identity = try @import("../../sealevel/transaction.zig").validateSigned(bytes, null);
            if (self.wire) |old| {
                if (self.allow_new_wire) {
                    try std.testing.expect(!std.mem.eql(u8, old, bytes));
                    self.allocator.free(old);
                    self.wire = try self.allocator.dupe(u8, bytes);
                    self.allow_new_wire = false;
                } else try std.testing.expectEqualSlices(u8, old, bytes);
            } else self.wire = try self.allocator.dupe(u8, bytes);
            const signature = try b58.encode(a, &identity.signature);
            defer a.free(signature);
            self.broadcasts += 1;
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = signature }, .{});
        } else if (std.mem.eql(u8, method, "getTransaction") and !self.finalized) {
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = @as(?u8, null) }, .{});
        } else if (std.mem.eql(u8, method, "getTransaction")) {
            const identity = try @import("../../sealevel/transaction.zig").validateSigned(self.wire.?, null);
            const signature = try b58.encode(a, &identity.signature);
            defer a.free(signature);
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .slot = 12, .transaction = .{ .signatures = [_][]const u8{signature} }, .meta = .{ .err = @as(?u8, null), .computeUnitsConsumed = 1000, .fee = 5000 } } }, .{});
        } else if (std.mem.eql(u8, method, "getBlock")) {
            const identity = try @import("../../sealevel/transaction.zig").validateSigned(self.wire.?, null);
            const signature = try b58.encode(a, &identity.signature);
            defer a.free(signature);
            const hash = try b58.encode(a, &(.{12} ** 32));
            defer a.free(hash);
            const parent = try b58.encode(a, &(.{11} ** 32));
            defer a.free(parent);
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .blockhash = hash, .previousBlockhash = parent, .signatures = [_][]const u8{signature} } }, .{});
        } else if (std.mem.eql(u8, method, "getSignatureStatuses")) {
            response = try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = id, .result = .{ .context = .{ .slot = 20 }, .value = .{.{ .slot = 12, .err = @as(?u8, null), .confirmationStatus = "finalized" }} } }, .{});
        } else return error.UnexpectedRevealRpc;
        return .{ .bytes = response, .len = response.len };
    }
};
fn base64(a: A, bytes: []const u8) ![]u8 {
    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(bytes.len));
    _ = std.base64.standard.Encoder.encode(encoded, bytes);
    return encoded;
}
test "UR reveal runner replays delivered commit without process signing persists CCS authorization and recovers exact signed auxiliary transaction" {
    const a = std.testing.allocator;
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const temporary = arena.allocator();
    var temp = std.testing.tmpDir(.{});
    defer temp.cleanup();
    const base = try temp.dir.realpathAlloc(a, ".");
    defer a.free(base);
    const path = try std.fs.path.join(a, &.{ base, "native" });
    defer a.free(path);
    var database = try @import("../../db/root.zig").rocks.Database.open(a, path, .{});
    defer database.deinit();
    var store = @import("../store.zig").Store.init(a, &database, "origin");
    const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(.{7} ** 32)).public_key.toBytes();
    const salt = [_]u8{3} ** 32;
    const calldata = "route";
    var hash = std.crypto.hash.sha3.Keccak256.init(.{});
    hash.update(&salt);
    hash.update(calldata);
    var body: [96]u8 = undefined;
    hash.final(body[0..32]);
    body[32..64].* = .{5} ** 32;
    body[64..96].* = .{6} ** 32;
    const message: protocol.Message = .{ .nonce = 0, .origin = 1, .destination = 2, .sender = .{2} ** 32, .recipient = .{9} ** 32, .body = &body };
    _ = try store.storeMessage(message, 1, null);
    const commit = reveal.Commit.message(.{9} ** 32, message).?;
    const pending = try commit.pending();
    const token_key = try reveal.associated(pending.key, .{4} ** 32, reveal.token_program);
    var pending_data: [45]u8 = undefined;
    pending_data[0..32].* = commit.recipient;
    std.mem.writeInt(u32, pending_data[32..36], commit.origin, .little);
    pending_data[36] = pending.bump;
    std.mem.writeInt(i64, pending_data[37..45], 900, .little);
    var token_data: [165]u8 = .{0} ** 165;
    token_data[0..32].* = .{4} ** 32;
    token_data[32..64].* = pending.key;
    std.mem.writeInt(u64, token_data[64..72], 10, .little);
    token_data[108] = 1;
    const Meta = struct { pubkey: []const u8, isWritable: bool, isSigner: bool };
    var metas: [15]Meta = undefined;
    for (&metas, 0..) |*meta, i| {
        const key: [32]u8 = switch (i) {
            11 => reveal.token_program,
            14 => .{4} ** 32,
            else => .{@as(u8, @intCast(i + 1))} ** 32,
        };
        meta.* = .{ .pubkey = try b58.encode(temporary, &key), .isWritable = true, .isSigner = false };
    }
    const ccs_json = try std.json.Stringify.valueAlloc(temporary, .{ .data = try @import("../../evm/codecs.zig").hexAlloc(temporary, calldata), .salt = try @import("../../evm/codecs.zig").hexAlloc(temporary, &salt), .revealAccounts = metas }, .{});
    var fixture: Fixture = .{ .allocator = a, .store = &store, .aux_id = queue.operationId(try queue.routeId(2, commit), 0, message.id()), .pending_key = try b58.encode(temporary, &pending.key), .token_key = try b58.encode(temporary, &token_key), .pending_owner = try b58.encode(temporary, &commit.program), .token_owner = try b58.encode(temporary, &reveal.token_program), .pending_b64 = try base64(temporary, &pending_data), .token_b64 = try base64(temporary, &token_data), .ccs_json = ccs_json, .commit = commit, .ccs_signer = try protocol.signature.secretKeyAddress(.{0x11} ** 32) };
    defer fixture.deinit();
    var injected: curl.Client = .{ .library = undefined, .api = undefined, .send_override = .{ .context = &fixture, .send_fn = Fixture.ccs } };
    const http = @import("../../cloud/http.zig");
    var fixture_environment = std.process.EnvMap.init(a);
    defer fixture_environment.deinit();
    var resources: @import("../chain_source.zig").Resources = .{ .environment = &fixture_environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    resources.http.native_curl = &injected;
    resources.chain.protocol = .sealevel;
    resources.chain.domain = 2;
    resources.chain.chain_id = "fixture";
    resources.chain.contracts = .{ .mailbox = .{2} ** 32, .validator_announce = .{3} ** 32, .merkle_tree_hook = .{4} ** 32, .interchain_gas_paymaster = .{5} ** 32 };
    resources.chain.connection = .{ .sealevel = .{ .max_supported_transaction_version = 0, .transaction_submitter = .rpc, .transaction_submitter_urls = &.{}, .priority_fee = 0, .priority_fee_oracle = .{ .constant = 0 }, .mailbox_process_alts = &.{}, .process_alt_overrides = &.{}, .ur_reveal = .{ .ccs_url = "https://ccs.fixture/base", .program_id = commit.program }, .native_token_decimals = 9 } };
    var client = try @import("../../sealevel/provider.zig").Client.init(a, "https://fixture/rpc", .{ .exchange = .{ .context = &fixture, .fetch_fn = Fixture.exchange } });
    defer client.deinit();
    const ccs = try @import("../signer.zig").DigestSigner.open(a, .{ .hex_key = .{0x11} ** 32 }, .{ .transport = resources.http.interface(), .amz_date = "fixture" });
    defer ccs.deinit();
    var factory: destination.Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .options = .{ .allow_fixture_transport = true, .enable_reveals = true, .origin_bindings = &.{.{ .domain = 1, .hook = .{4} ** 32 }} }, .chain_checked = true, .backend_ready = true, .reveal_boot = .{5} ** 32, .ccs_digest = ccs, .backend = .{ .sealevel = .{ .chain = .{ .client = &client, .program = resources.chain.contracts.mailbox, .domain = 2, .payer = payer }, .chain_id = "fixture", .announce = .{3} ** 32, .reveal_target = commit.program, .signer = .{ .context = &fixture, .payer = payer, .sign_fn = Fixture.sign }, .noop = .{7} ** 32, .maximum_fee = 10000 } } };
    defer factory.arena.deinit();
    const initial: destination.operation.Times = .{ .unix_ms = 1000000, .monotonic_ms = 0 };
    const clock: destination.Clock = .{ .unix_ms = initial.unix_ms, .deadline_ns = (try @import("../scraper/receipts_evm.zig").nowNs()) + 30 * std.time.ns_per_s };
    const process_context = try factory.contextFor(try factory.authorityFor(1, message.id(), 0, .process));
    const actor = try destination.operation.Operation.open(a, &store, .{ .id = message.id(), .context = process_context, .nonce = 0, .origin = 1, .destination = 2, .policy = .{ .confirm_delay_ms = 0 } }, initial);
    defer actor.deinit();
    try actor.alreadyDelivered(true, initial); // Existing completed operation replay.
    var policy = try @import("../relay_policy.zig").Policy.init(a, .{}, null, null);
    defer policy.deinit();
    var history: History = .{};
    const driver: @import("../relayer/native_driver.zig").Driver = .{};
    try std.testing.expectEqual(@import("../relayer/native_driver.zig").State.delivered, (try driver.step(a, &factory, actor, &history, &policy, message, clock, initial)).state);
    try std.testing.expectEqual(@as(usize, 0), fixture.sign_calls);
    try std.testing.expectEqual(@as(usize, 0), fixture.ccs_requests);
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, initial)); // PDA.
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, initial)); // CCS + tokens.
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, initial)); // Prepare public tx.
    try std.testing.expectEqual(@as(usize, 0), fixture.sign_calls);
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, initial)); // Durable signing.
    try std.testing.expectEqual(@as(usize, 1), fixture.sign_calls);
    // Every tick reopens durable state; emulate process reconstruction by a new
    // boot generation before broadcasting the persisted exact signed bytes.
    factory.reveal_boot = .{6} ** 32;
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, initial));
    try std.testing.expectEqual(@as(usize, 1), fixture.broadcasts);
    // An absent PDA alone cannot retire a transaction whose blockhash still
    // lives: it can be recreated by another commit. Retain exact signed ID.
    fixture.pending_exists = false;
    const uncertain: destination.operation.Times = .{ .unix_ms = initial.unix_ms + 2000, .monotonic_ms = 2000 };
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, uncertain));
    try std.testing.expectEqual(@as(usize, 1), fixture.sign_calls);
    try std.testing.expectEqual(@as(usize, 1), fixture.broadcasts);
    // Equality at lease boundary is still live; no re-sign even after restart.
    fixture.pending_exists = true;
    fixture.height = 200;
    const boundary: destination.operation.Times = .{ .unix_ms = initial.unix_ms + 4000, .monotonic_ms = 4000 };
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, boundary));
    try std.testing.expectEqual(@as(usize, 1), fixture.sign_calls);
    // Strictly later finalized height is positive chain expiry evidence. The
    // old exact wire is archived before a fresh blockhash/signature is allowed.
    fixture.height = 201;
    const expired: destination.operation.Times = .{ .unix_ms = initial.unix_ms + 6000, .monotonic_ms = 6000 };
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, expired));
    try std.testing.expectEqual(@as(usize, 1), fixture.sign_calls);
    fixture.last_valid_height = 300;
    fixture.blockhash_byte = 9;
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, expired)); // new public intent
    try std.testing.expectEqual(@as(usize, 1), fixture.sign_calls);
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, expired)); // new signed wire
    try std.testing.expectEqual(@as(usize, 2), fixture.sign_calls);
    fixture.allow_new_wire = true;
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, expired));
    try std.testing.expectEqual(@as(usize, 2), fixture.broadcasts);
    fixture.finalized = true;
    const later: destination.operation.Times = .{ .unix_ms = initial.unix_ms + 8000, .monotonic_ms = 8000 };
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, later));
    try std.testing.expect((try queue.next(a, &store, 2)) == null);
    try std.testing.expectEqual(@as(usize, 2), fixture.sign_calls);
    try std.testing.expectEqual(@as(usize, 3), fixture.ccs_requests);
    try factory.onDelivered(&store, message, clock);
    try std.testing.expect((try queue.next(a, &store, 2)) == null);
    try std.testing.expectEqual(@as(usize, 2), fixture.sign_calls);
    try std.testing.expect(try store.processed(message.nonce));
    // Only the exact process instruction/custom code triggers Source duplicate
    // close recovery. This distinct auxiliary cycle never signs process again.
    factory.svm_witness.failure = .{ .instruction = 1, .code = 10 };
    try std.testing.expect(!try factory.recoverDuplicateCommit(&store, message, clock));
    factory.svm_witness.failure = .{ .instruction = 2, .code = 10 };
    try std.testing.expect(try factory.recoverDuplicateCommit(&store, message, clock));
    fixture.aux_id = queue.operationId(try queue.routeId(2, commit), 1, message.id());
    fixture.finalized = false;
    fixture.ccs_status = 404;
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, later));
    try std.testing.expectEqual(@as(usize, 2), fixture.sign_calls);
    const not_due: destination.operation.Times = .{ .unix_ms = later.unix_ms + 4999, .monotonic_ms = later.monotonic_ms + 4999 };
    try std.testing.expectEqual(@as(usize, 0), try factory.tickReveal(&store, clock, not_due));
    fixture.ccs_status = 200;
    const ready: destination.operation.Times = .{ .unix_ms = later.unix_ms + 5000, .monotonic_ms = later.monotonic_ms + 5000 };
    var cancelled = std.atomic.Value(bool).init(true);
    var cancelled_clock = clock;
    cancelled_clock.cancel = &cancelled;
    try std.testing.expectError(error.RequestCancelled, factory.tickReveal(&store, cancelled_clock, ready));
    try std.testing.expectEqual(@as(usize, 4), fixture.ccs_requests);
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, ready)); // Close intent.
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, ready)); // Close signature.
    try std.testing.expectEqual(@as(usize, 3), fixture.sign_calls);
    fixture.allow_new_wire = true;
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, ready)); // Close broadcast.
    try std.testing.expectEqual(@as(usize, 3), fixture.broadcasts);
    fixture.finalized = true;
    const closed: destination.operation.Times = .{ .unix_ms = ready.unix_ms + 2000, .monotonic_ms = ready.monotonic_ms + 2000 };
    try std.testing.expectEqual(@as(usize, 1), try factory.tickReveal(&store, clock, closed));
    try std.testing.expect((try queue.next(a, &store, 2)) == null);
    try std.testing.expectEqual(@as(usize, 5), fixture.ccs_requests);
    try std.testing.expectEqual(@as(usize, 3), fixture.sign_calls);
    try std.testing.expect(try store.processed(message.nonce));
}
