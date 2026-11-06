//! Native Solana/SVM transaction identity and immutable compiled-message recovery.
const std = @import("std");
const types = @import("types.zig");
const provider = @import("../../sealevel/provider.zig");
const mailbox = @import("../../sealevel/mailbox.zig");
const tx = @import("../../sealevel/transaction.zig");
const sol = @import("../../altvm/solana.zig");
const b58 = @import("../../altvm/base58.zig");
const rpc = @import("../../net/json_rpc.zig");
const hex = @import("../../evm/codecs.zig");
const protocol = @import("../../protocol/root.zig");
pub const Signer = struct { context: *anyopaque, payer: [32]u8, sign_fn: *const fn (*anyopaque, [32]u8, []const u8) anyerror![64]u8 };
pub const Sealevel = struct {
    chain: mailbox.Mailbox,
    chain_id: []const u8,
    announce: [32]u8,
    reveal_target: ?[32]u8 = null,
    signer: Signer,
    identity: ?[32]u8 = null,
    noop: [32]u8,
    alt_addresses: []const [32]u8 = &.{},
    submitter: tx.Submitter = .rpc,
    oracle: tx.Oracle = .{ .constant = 0 },
    oracle_http: ?*@import("../../cloud/http.zig").HttpTransport = null,
    /// Opt in only with thread-safe allocators and an independent oracle owner.
    concurrent_estimate_reads: bool = false,
    fee_cap: ?u64 = null,
    maximum_fee: u64,
    submit_clients: []provider.Client = &.{},
    submit_index: usize = 0,
    simulation_observer: ?tx.SimulationObserver = null,
    fn authority(self: *Sealevel, context: types.Authority) !void {
        if (context.protocol != .sealevel or context.destination != self.chain.domain or !std.mem.eql(u8, context.chain_id, self.chain_id) or !std.mem.eql(u8, &context.mailbox, &self.chain.program) or self.chain.payer == null or !std.mem.eql(u8, &self.chain.payer.?, &self.signer.payer)) return error.DestinationAuthorityMismatch;
        try context.expectTarget(switch (context.kind) {
            .process => self.chain.program,
            .announcement => self.announce,
            .reveal => self.reveal_target orelse return error.MissingRevealProgram,
        });
    }
    pub fn delivered(self: *Sealevel, id: [32]u8) !bool {
        return self.chain.delivered(id);
    }
    pub fn recipientIsm(self: *Sealevel, message: protocol.Message) ![32]u8 {
        return self.chain.recipientModule(message.recipient);
    }
    pub fn metadata(self: *Sealevel, origin: anytype, module: [32]u8, message: protocol.Message) ![]u8 {
        var source: @import("../../sealevel/metadata.zig").Source(@TypeOf(origin.*)) = .{ .allocator = self.chain.client.rpc_client.allocator, .ism = .{ .mailbox = &self.chain, .identity = self.identity }, .origin = origin, .cancel = self.chain.client.rpc_client.options.cancel };
        var builder: @import("../../relayer/metadata.zig").Builder(@TypeOf(source)) = .{ .allocator = self.chain.client.rpc_client.allocator, .source = &source };
        return builder.build(module, message);
    }
    pub fn prepare(self: *Sealevel, context: types.Authority, message: protocol.Message, metadata_bytes: []const u8) !types.Prepared {
        try self.authority(context);
        try context.message(message);
        var instruction = try self.chain.processInstruction(message, metadata_bytes, self.noop, self.identity, self.identity);
        defer instruction.deinit();
        return self.prepareInstruction(context, instruction.instruction());
    }
    pub fn prepareAnnouncement(self: *Sealevel, context: types.Authority, validator: [20]u8, location: []const u8, signature: [65]u8) !types.Prepared {
        try self.authority(context);
        if (context.kind != .announcement) return error.DestinationAuthorityMismatch;
        var instruction = try @import("../../sealevel/announcement.zig").announce(self.chain.client.rpc_client.allocator, self.announce, self.signer.payer, validator, location, signature);
        defer instruction.deinit();
        return self.prepareInstruction(context, instruction.instruction());
    }
    fn prepareInstruction(self: *Sealevel, context: types.Authority, instruction: sol.Instruction) !types.Prepared {
        const a = self.chain.client.rpc_client.allocator;
        var oracle = self.oracle;
        var oracle_budget: ?@import("../scraper/receipts_common.zig").DeadlineTransport = null;
        const previous_cancel = if (self.oracle_http) |owner| owner.cancel else null;
        defer if (self.oracle_http) |owner| {
            owner.cancel = previous_cancel;
        };
        if (oracle == .helius) {
            if (self.oracle_http) |owner| {
                const deadline = self.chain.client.deadline_ns orelse return error.NativeOracleDeadlineRequired;
                owner.cancel = self.chain.client.rpc_client.options.cancel;
                oracle_budget = .{ .rpc_read = true, .owner = owner, .deadline_ns = deadline };
                try oracle_budget.?.verify(oracle.helius.transport);
                oracle.helius.transport = oracle_budget.?.interface();
            } else if (self.concurrent_estimate_reads) return error.IndependentOracleTransportRequired;
        }
        const prepared_value = try tx.prepare(a, self.chain.client, .{ .payer = self.signer.payer, .process = instruction, .alt_addresses = self.alt_addresses, .submitter = self.submitter, .oracle = oracle, .concurrent_estimate_reads = self.concurrent_estimate_reads, .fee_cap = self.fee_cap, .simulation_observer = self.simulation_observer });
        defer prepared_value.deinit();
        const fee = try prepared_value.feeQuote(self.chain.client);
        const jito_tip = if (self.submitter == .jito) @max(@as(u64, 1000), try std.math.mul(u64, prepared_value.estimate.compute_units, prepared_value.estimate.compute_unit_price_micro_lamports) / 1_000_000) else 0;
        const total = try std.math.add(u64, fee, jito_tip);
        if (total > self.maximum_fee) return error.SvmFeeCapExceeded;
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const temporary = arena.allocator();
        const body = try std.json.Stringify.valueAlloc(temporary, .{ .message = try hex.hexAlloc(temporary, prepared_value.compiled.bytes), .payer = try hex.hexAlloc(temporary, &self.signer.payer), .blockhash = try hex.hexAlloc(temporary, &prepared_value.blockhash.hash), .last_valid_block_height = prepared_value.blockhash.last_valid_block_height, .context_slot = prepared_value.blockhash.context_slot, .gas_limit = prepared_value.estimate.compute_units, .fee = total, .tip_lamports = jito_tip, .maximum_fee = self.maximum_fee, .submitter = @tagName(self.submitter) }, .{});
        return types.Prepared.init(a, context, body, prepared_value.estimate.compute_units, total);
    }
    const Restored = struct {
        allocator: std.mem.Allocator,
        message: []u8,
        signer_keys: [127][32]u8,
        count: u8,
        hash: [32]u8,
        expiration: u64,
        fn deinit(self: *@This()) void {
            self.allocator.free(self.message);
        }
    };
    fn restore(self: *Sealevel, prepared: *const types.Prepared) !Restored {
        try prepared.validate();
        try self.authority(prepared.authority);
        const body = prepared.body;
        if (!std.mem.eql(u8, &try hex.fixedHex(32, try rpc.string(try rpc.field(body, "payer"))), &self.signer.payer) or try rpc.integer(u64, try rpc.field(body, "maximum_fee")) != self.maximum_fee or try rpc.integer(u64, try rpc.field(body, "fee")) > self.maximum_fee or !std.mem.eql(u8, @tagName(self.submitter), try rpc.string(try rpc.field(body, "submitter")))) return error.DestinationIntentChanged;
        const text = try rpc.string(try rpc.field(body, "message"));
        if (text.len < 8 or text.len % 2 != 0 or text.len > sol.packet_limit * 2 + 2) return error.InvalidSvmIntent;
        const a = self.chain.client.rpc_client.allocator;
        const message = try a.alloc(u8, (text.len - 2) / 2);
        errdefer a.free(message);
        _ = try hex.decodeHex(message, text);
        if (message.len < 4) return error.InvalidSvmIntent;
        var pos: usize = if (message[0] == 0x80) 1 else 0;
        if (message[0] & 128 != 0 and pos == 0) return error.UnsupportedSvmMessageVersion;
        const count = message[pos];
        pos += 3;
        const keys = try sol.readShortvec(message, &pos);
        if (count == 0 or count > 127 or keys < count or keys > 256 or message.len - pos < @as(usize, keys) * 32 + 32) return error.InvalidSvmIntent;
        var result: Restored = .{ .allocator = a, .message = message, .signer_keys = undefined, .count = count, .hash = try hex.fixedHex(32, try rpc.string(try rpc.field(body, "blockhash"))), .expiration = try rpc.integer(u64, try rpc.field(body, "last_valid_block_height")) };
        for (0..count) |i| result.signer_keys[i] = message[pos + i * 32 ..][0..32].*;
        if (!std.mem.eql(u8, &result.signer_keys[0], &self.signer.payer) or !std.mem.eql(u8, message[pos + @as(usize, keys) * 32 ..][0..32], &result.hash)) return error.DestinationIntentChanged;
        for (result.signer_keys[0..count]) |key| if (!std.mem.eql(u8, &key, &self.signer.payer) and !(self.identity != null and std.mem.eql(u8, &key, &self.identity.?))) return error.UnconfiguredSvmSigner;
        return result;
    }
    pub fn sign(self: *Sealevel, prepared: *const types.Prepared, persistence: types.Persistence) !types.Signed {
        var restored = try self.restore(prepared);
        defer restored.deinit();
        try persistence.intent(prepared);
        var output: [sol.packet_limit]u8 = undefined;
        var writer: sol.Writer = .{ .out = &output };
        try writer.shortvec(restored.count);
        for (restored.signer_keys[0..restored.count]) |key| try writer.bytes(&try self.signer.sign_fn(self.signer.context, key, restored.message));
        try writer.bytes(restored.message);
        const decoded = try tx.validateSigned(output[0..writer.pos], restored.message);
        var signed = try types.Signed.init(self.chain.client.rpc_client.allocator, .{ .signature512 = decoded.signature }, output[0..writer.pos]);
        errdefer signed.deinit();
        try persistence.signed(prepared, &signed);
        return signed;
    }
    pub fn validateSigned(self: *Sealevel, prepared: *const types.Prepared, signed: *const types.Signed) !void {
        if (signed.identity != .signature512) return error.WrongDestinationIdentity;
        var restored = try self.restore(prepared);
        defer restored.deinit();
        const decoded = try tx.validateSigned(signed.bytes, restored.message);
        if (!std.mem.eql(u8, &decoded.signature, &signed.identity.signature512) or !std.mem.eql(u8, &decoded.payer, &self.signer.payer) or !std.mem.eql(u8, &decoded.blockhash, &restored.hash)) return error.DestinationIntentChanged;
    }
    pub fn broadcast(self: *Sealevel, prepared: *const types.Prepared, signed: *const types.Signed, persistence: types.Persistence) !void {
        try self.validateSigned(prepared, signed);
        var restored = try self.restore(prepared);
        defer restored.deinit();
        if (try self.chain.client.blockHeight() > restored.expiration) return error.SvmBlockhashExpired;
        try persistence.signed(prepared, signed);
        const client = if (self.submit_clients.len == 0) self.chain.client else blk: {
            const current = self.submit_index % self.submit_clients.len;
            self.submit_index = (current + 1) % self.submit_clients.len;
            break :blk &self.submit_clients[current];
        };
        // An ambiguous send returns immediately. A subsequent explicit actor
        // rebroadcast rotates endpoints only after reconciling this same ID.
        _ = try tx.submit(client, signed.bytes, true);
    }
    pub fn reconcile(self: *Sealevel, identity_: types.Identity) !?types.Receipt {
        if (identity_ != .signature512) return error.WrongDestinationIdentity;
        const actual = try tx.finalizedReceipt(self.chain.client, identity_.signature512) orelse return null;
        return .{ .identity = identity_, .block_hash = actual.block_hash, .height = actual.slot, .success = !actual.failed, .finalized = true, .expenditure = if (actual.units_consumed) |units| .{ .gas_used = units, .tokens_used = actual.fee_lamports } else null };
    }
};

const RpcFixture = struct {
    method: []const u8,
    result: []const u8,
    expected_wire: ?[]const u8 = null,
    failure: ?anyerror = null,
    calls: usize = 0,
    retirement_height: ?u64 = null,
    account_slot: u64 = 10,
    account_result: ?[]const u8 = null,
    fn exchange(self: *RpcFixture) @import("../../evm/provider.zig").Exchange {
        return .{ .context = self, .fetch_fn = fetch };
    }
    fn fetch(ctx: *anyopaque, a: std.mem.Allocator, request: []const u8, _: @import("../../evm/provider.zig").Options) !@import("../../evm/provider.zig").WireResponse {
        const self: *RpcFixture = @ptrCast(@alignCast(ctx));
        var parsed = try std.json.parseFromSlice(std.json.Value, a, request, .{});
        defer parsed.deinit();
        const method = parsed.value.object.get("method").?.string;
        if (self.retirement_height == null) try std.testing.expectEqualStrings(self.method, method);
        self.calls += 1;
        if (self.expected_wire) |wire| {
            const text = parsed.value.object.get("params").?.array.items[0].string;
            const decoded = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(text));
            defer a.free(decoded);
            try std.base64.standard.Decoder.decode(decoded, text);
            try std.testing.expectEqualSlices(u8, wire, decoded);
        }
        if (self.failure) |failure| return failure;
        const id = try std.json.Stringify.valueAlloc(a, parsed.value.object.get("id").?, .{});
        defer a.free(id);
        var digits: [128]u8 = undefined;
        const result = if (self.retirement_height) |height| blk: {
            const params = parsed.value.object.get("params").?.array.items;
            const options = params[if (std.mem.eql(u8, method, "getAccountInfo")) 1 else 0];
            try std.testing.expectEqualStrings("finalized", options.object.get("commitment").?.string);
            if (std.mem.eql(u8, method, "getSlot")) break :blk "10";
            if (std.mem.eql(u8, method, "getBlockHeight")) break :blk try std.fmt.bufPrint(&digits, "{d}", .{height});
            if (std.mem.eql(u8, method, "getAccountInfo")) break :blk self.account_result orelse try std.fmt.bufPrint(&digits, "{{\"context\":{{\"slot\":{d}}},\"value\":null}}", .{self.account_slot});
            return error.UnexpectedSvmRetirementMethod;
        } else self.result;
        const bytes = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{s},\"result\":{s}}}", .{ id, result });
        return .{ .bytes = bytes, .len = bytes.len };
    }
};
test "SVM destination recovers independent SDK wire gates signing and rotates exact full signature broadcasts" {
    const a = std.testing.allocator;
    const helper = @import("testing.zig");
    var fixture = try @import("../../testing/fixture.zig").parse(std.json.Value, a, @embedFile("../../altvm/fixtures/svm-destination.json.gz"), .{});
    defer fixture.deinit();
    const case = fixture.value.object.get("cases").?.array.items[0];
    const message = try helper.decode(a, case.object.get("message").?.string);
    defer a.free(message);
    const expected_wire = try helper.decode(a, case.object.get("wire").?.string);
    defer a.free(expected_wire);
    var journal: helper.Journal = .{ .seed = .{7} ** 32 };
    const payer = (try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(journal.seed)).public_key.toBytes();
    var read: RpcFixture = .{ .method = "getBlockHeight", .result = "100" };
    var first: RpcFixture = .{ .method = "sendTransaction", .result = "null", .expected_wire = expected_wire, .failure = error.FixtureAmbiguousSend };
    const expected_signature = (try tx.validateSigned(expected_wire, message)).signature;
    const signature_text = try b58.encode(a, &expected_signature);
    defer a.free(signature_text);
    const signature_json = try std.json.Stringify.valueAlloc(a, signature_text, .{});
    defer a.free(signature_json);
    var second: RpcFixture = .{ .method = "sendTransaction", .result = signature_json, .expected_wire = expected_wire };
    var client = try provider.Client.init(a, "https://fixture/read", .{ .exchange = read.exchange() });
    defer client.deinit();
    var submits = [_]provider.Client{ try provider.Client.init(a, "https://fixture/submit1", .{ .exchange = first.exchange() }), try provider.Client.init(a, "https://fixture/submit2", .{ .exchange = second.exchange() }) };
    defer for (&submits) |*value| value.deinit();
    var destination: Sealevel = .{ .chain = .{ .client = &client, .program = .{9} ** 32, .domain = 2, .payer = payer }, .chain_id = "fixture", .announce = .{3} ** 32, .signer = .{ .context = &journal, .payer = payer, .sign_fn = helper.Journal.ed }, .noop = .{4} ** 32, .maximum_fee = 10000, .submit_clients = &submits };
    const message_hex = try hex.hexAlloc(a, message);
    defer a.free(message_hex);
    const payer_hex = try hex.hexAlloc(a, &payer);
    defer a.free(payer_hex);
    const blockhash_hex = try hex.hexAlloc(a, &(.{8} ** 32));
    defer a.free(blockhash_hex);
    const body = try std.json.Stringify.valueAlloc(a, .{ .message = message_hex, .payer = payer_hex, .blockhash = blockhash_hex, .last_valid_block_height = 200, .context_slot = 10, .gas_limit = 110000, .fee = 5000, .maximum_fee = 10000, .submitter = "rpc" }, .{});
    defer a.free(body);
    var prepared = try types.Prepared.init(a, .{ .protocol = .sealevel, .origin = 1, .destination = 2, .chain_id = "fixture", .mailbox = .{9} ** 32, .origin_hook = .{6} ** 32, .operation_id = .{7} ** 32 }, body, 110000, 5000);
    defer prepared.deinit();
    var restored = try types.Prepared.restore(a, prepared.canonical_intent);
    defer restored.deinit();
    journal.deny_intent = true;
    try std.testing.expectError(error.FixtureIntentDenied, destination.sign(&restored, journal.persistence()));
    try std.testing.expectEqual(@as(usize, 0), journal.key_reads);
    journal.deny_intent = false;
    var signed = try destination.sign(&restored, journal.persistence());
    defer signed.deinit();
    try std.testing.expectEqualSlices(u8, expected_wire, signed.bytes);
    try std.testing.expectEqual(expected_signature, signed.identity.signature512);
    try std.testing.expectError(error.FixtureAmbiguousSend, destination.broadcast(&restored, &signed, journal.persistence()));
    try std.testing.expectEqual(@as(usize, 0), second.calls);
    try destination.broadcast(&restored, &signed, journal.persistence());
    try std.testing.expectEqual(@as(usize, 1), first.calls);
    try std.testing.expectEqual(@as(usize, 1), second.calls);
    try std.testing.expectEqual(@as(usize, 1), journal.key_reads);
    try std.testing.expectEqual(@as(usize, 3), journal.signed);
    var wrong = signed;
    wrong.identity.signature512[63] ^= 1;
    try std.testing.expectError(error.DestinationIntentChanged, destination.broadcast(&restored, &wrong, journal.persistence()));
    try std.testing.expectEqual(@as(usize, 2), read.calls);
    const factory_module = @import("factory.zig");
    const http = @import("../../cloud/http.zig");
    var environment = std.process.EnvMap.init(a);
    defer environment.deinit();
    var resources: @import("../chain_source.zig").Resources = .{ .environment = &environment, .allocator = a, .arena = .init(a), .chain = undefined, .options = .{ .curl_library = "unused" }, .http = http.HttpTransport.init(a) };
    defer resources.http.deinit();
    defer resources.arena.deinit();
    resources.chain.protocol = .sealevel;
    resources.chain.domain = 2;
    resources.chain.chain_id = "fixture";
    resources.chain.contracts = .{ .mailbox = .{9} ** 32, .merkle_tree_hook = .{5} ** 32, .validator_announce = .{3} ** 32, .interchain_gas_paymaster = .{0} ** 32 };
    var factory: factory_module.Factory = .{ .allocator = a, .arena = .init(a), .resources = &resources, .chain_checked = true, .backend_ready = true, .options = .{ .allow_fixture_transport = true, .origin_bindings = &.{.{ .domain = 1, .hook = .{6} ** 32 }} }, .backend = .{ .sealevel = destination } };
    defer factory.arena.deinit();
    const clock: factory_module.Clock = .{ .unix_ms = 0, .deadline_ns = (try provider.Client.nowNs()) + 10 * std.time.ns_per_s };
    read.retirement_height = 200;
    try std.testing.expect((try factory.retirementProof(&restored, &signed, clock)) == null);
    read.retirement_height = 201;
    read.account_slot = 9;
    try std.testing.expectError(error.StaleSvmContext, factory.retirementProof(&restored, &signed, clock));
    read.account_slot = 10;
    const proof = (try factory.retirementProof(&restored, &signed, clock)).?;
    try std.testing.expectEqual(@as(u64, 201), proof.finalized_height);
    try std.testing.expectEqual(@as(u64, 200), proof.boundary);
    try std.testing.expect(client.deadline_ns == null);
    try std.testing.expect(client.minimum_slot == null);
    const objects = @import("../../storage/objects.zig");
    const announcement_api = @import("../../sealevel/announcement.zig");
    const announcement = try objects.SignedAnnouncement.sign(.{ .validator = try protocol.signature.secretKeyAddress(.{0x11} ** 32), .mailbox_address = .{9} ** 32, .mailbox_domain = 2, .storage_location = "s3://fixture/region" }, .{0x11} ** 32, null);
    var instruction = try announcement_api.announce(a, .{3} ** 32, payer, announcement.value.validator, announcement.value.storage_location, announcement.signature.bytes());
    defer instruction.deinit();
    var output: [sol.packet_limit]u8 = undefined;
    const compiled = try tx.compile(payer, .{8} ** 32, instruction.instruction(), &.{}, .{ .compute_units = 110000, .compute_unit_price_micro_lamports = 330 }, .rpc, &output);
    const announcement_hex = try hex.hexAlloc(a, compiled.bytes);
    defer a.free(announcement_hex);
    var payload = try std.json.parseFromSlice(std.json.Value, a, body, .{});
    defer payload.deinit();
    payload.value.object.getPtr("message").?.* = .{ .string = announcement_hex };
    const announcement_body = try std.json.Stringify.valueAlloc(a, payload.value, .{});
    defer a.free(announcement_body);
    var announcement_prepared = try types.Prepared.init(a, try factory.authorityFor(2, announcement.value.digest(), 1, .announcement), announcement_body, 110000, 5000);
    defer announcement_prepared.deinit();
    var announcement_signed = try destination.sign(&announcement_prepared, journal.persistence());
    defer announcement_signed.deinit();
    const retired = (try factory.announcementRetirement(&announcement_prepared, &announcement_signed, announcement, clock)).?;
    try std.testing.expectEqual(types.Kind.announcement, retired.kind);
    try std.testing.expectEqual(@as(?[32]u8, .{3} ** 32), retired.target);
    const pda = try announcement_api.locationsPda(.{3} ** 32, announcement.value.validator);
    const account_data = try a.alloc(u8, 10 + announcement.value.storage_location.len);
    defer a.free(account_data);
    account_data[0] = 1;
    account_data[1] = pda.bump;
    std.mem.writeInt(u32, account_data[2..6], 1, .little);
    std.mem.writeInt(u32, account_data[6..10], @intCast(announcement.value.storage_location.len), .little);
    @memcpy(account_data[10..], announcement.value.storage_location);
    const account_b64 = try a.alloc(u8, std.base64.standard.Encoder.calcSize(account_data.len));
    defer a.free(account_b64);
    _ = std.base64.standard.Encoder.encode(account_b64, account_data);
    const owner = try b58.encode(a, &(.{3} ** 32));
    defer a.free(owner);
    const existing = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 10 }, .value = .{ .owner = owner, .executable = false, .lamports = 1, .data = [_][]const u8{ account_b64, "base64" } } }, .{});
    defer a.free(existing);
    read.account_result = existing;
    try std.testing.expect((try factory.announcementRetirement(&announcement_prepared, &announcement_signed, announcement, clock)) == null);
}

test "SVM destination concurrent Helius estimation requires independent deadline scoped HTTP owner" {
    const a = std.testing.allocator;
    var client = try provider.Client.init(a, "https://fixture/rpc", .{});
    defer client.deinit();
    var network: @import("../../cloud/testing.zig").Mock = .{ .steps = &.{} };
    var destination: Sealevel = .{
        .chain = .{ .client = &client, .program = .{1} ** 32, .domain = 2, .payer = .{3} ** 32 },
        .chain_id = "fixture",
        .announce = .{4} ** 32,
        .signer = undefined,
        .noop = .{5} ** 32,
        .maximum_fee = 10000,
        .oracle = .{ .helius = .{ .transport = network.transport(), .url = "https://fixture/fee" } },
        .concurrent_estimate_reads = true,
    };
    const instruction: sol.Instruction = .{ .program = .{1} ** 32, .accounts = &.{}, .data = &.{} };
    const authority: types.Authority = .{ .protocol = .sealevel, .origin = 1, .destination = 2, .mailbox = .{1} ** 32, .chain_id = "fixture", .operation_id = .{6} ** 32 };
    try std.testing.expectError(error.IndependentOracleTransportRequired, destination.prepareInstruction(authority, instruction));
    var owner = @import("../../cloud/http.zig").HttpTransport.init(a);
    defer owner.deinit();
    destination.oracle_http = &owner;
    try std.testing.expectError(error.NativeOracleDeadlineRequired, destination.prepareInstruction(authority, instruction));
    var old_cancel = std.atomic.Value(bool).init(false);
    owner.cancel = &old_cancel;
    client.deadline_ns = try @import("../scraper/receipts_evm.zig").nowNs() + std.time.ns_per_s;
    // Incorrect transport ownership rejects before either estimate read starts.
    try std.testing.expectError(error.ReceiptTransportOwnerMismatch, destination.prepareInstruction(authority, instruction));
    destination.oracle.helius.transport = owner.interface();
    try std.testing.expectError(error.NativeReceiptTransportRequired, destination.prepareInstruction(authority, instruction));
    try std.testing.expect(owner.cancel == &old_cancel);
    try network.expectDone();
}
