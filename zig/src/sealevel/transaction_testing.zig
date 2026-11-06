const std = @import("std");
const tx = @import("transaction.zig");
const sol = @import("../altvm/solana.zig");
const svm = @import("provider.zig");
const rpc = @import("../evm/provider.zig");
const base58 = @import("../altvm/base58.zig");
const A = std.mem.Allocator;
fn unhex(a: A, text: []const u8) ![]u8 {
    const out = try a.alloc(u8, text.len / 2);
    errdefer a.free(out);
    _ = try std.fmt.hexToBytes(out, text);
    return out;
}
test "SVM destination matches independent actual SDK budget Jito legacy v0 signatures" {
    const a = std.testing.allocator;
    const Case = struct { jito: bool, versioned: bool, units: u32, price: []const u8, message: []const u8, wire: []const u8 };
    const fixture = try @import("../testing/fixture.zig").parse(struct { cases: []const Case }, a, @embedFile("../altvm/fixtures/svm-destination.json.gz"), .{ .ignore_unknown_fields = true });
    defer fixture.deinit();
    const seed: sol.Key = .{7} ** 32;
    const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    const payer = pair.public_key.toBytes();
    const process: sol.Instruction = .{ .program = .{9} ** 32, .accounts = &.{ .{ .key = payer, .is_signer = true, .is_writable = true }, .{ .key = .{1} ** 32, .is_writable = true } }, .data = "test" };
    const tables = [_]sol.LookupTable{.{ .key = .{6} ** 32, .addresses = &.{.{1} ** 32} }};
    for (fixture.value.cases) |case| {
        var message: [1232]u8 = undefined;
        const compiled = try tx.compile(payer, .{8} ** 32, process, if (case.versioned) &tables else &.{}, .{ .compute_units = case.units, .compute_unit_price_micro_lamports = try std.fmt.parseInt(u64, case.price, 10) }, if (case.jito) .jito else .rpc, &message);
        const expected_message = try unhex(a, case.message);
        defer a.free(expected_message);
        try std.testing.expectEqualSlices(u8, expected_message, compiled.bytes);
        var out: [1232]u8 = undefined;
        const signed = try sol.signTransaction(compiled, &.{seed}, &out);
        const expected_wire = try unhex(a, case.wire);
        defer a.free(expected_wire);
        try std.testing.expectEqualSlices(u8, expected_wire, signed);
        _ = try tx.validateSigned(signed, compiled.bytes);
        var pos: usize = 0;
        const count = try sol.readShortvec(signed, &pos);
        try std.testing.expectEqual(@as(u16, 1), count);
        // Re-sign a structurally invalid instruction account index, proving
        // signature validity cannot conceal an out-of-range loaded key index.
        var malformed: [1232]u8 = undefined;
        @memcpy(malformed[0..compiled.bytes.len], compiled.bytes);
        var p: usize = if (case.versioned) 4 else 3;
        const keys = try sol.readShortvec(compiled.bytes, &p);
        p += keys * 32 + 32;
        _ = try sol.readShortvec(compiled.bytes, &p);
        p += 1;
        const account_count = try sol.readShortvec(compiled.bytes, &p);
        if (account_count != 0) return error.FixtureExpectedEmptyBudgetAccounts;
        // Reject trailing bytes even if a signer actually signed that payload.
        malformed[compiled.bytes.len] = 0;
        const sig = try pair.sign(malformed[0 .. compiled.bytes.len + 1], null);
        var writer: sol.Writer = .{ .out = &out };
        try writer.shortvec(1);
        try writer.bytes(&sig.toBytes());
        try writer.bytes(malformed[0 .. compiled.bytes.len + 1]);
        if (tx.validateSigned(out[0..writer.pos], null)) |_| return error.ExpectedTrailingDataRejection else |_| {}
    }
}
const Fixture = struct {
    calls: usize = 0,
    mutex: std.Thread.Mutex = .{},
    wrong_owner: bool = false,
    fee_unavailable: bool = false,
    simulation_failed: bool = false,
    simulation_units: u64 = 100000,
    oracle_gate: ?*std.atomic.Value(bool) = null,
    signature: ?[64]u8 = null,
    wrong_ack: bool = false,
    block_reads: usize = 0,
    reorg: bool = false,
    fn exchange(context: *anyopaque, a: A, body: []const u8, _: rpc.Options) anyerror!rpc.WireResponse {
        const self: *Fixture = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.calls += 1;
        const parsed = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer parsed.deinit();
        const id = parsed.value.object.get("id").?;
        const method = parsed.value.object.get("method").?.string;
        const params = parsed.value.object.get("params").?.array.items;
        const hash = try base58.encode(a, &(.{8} ** 32));
        defer a.free(hash);
        const native_signature = self.signature orelse .{1} ** 64;
        const signature = try base58.encode(a, &native_signature);
        defer a.free(signature);
        var result: []u8 = undefined;
        if (std.mem.eql(u8, method, "getAccountInfo")) {
            const fixture_json = try @import("../testing/fixture.zig").parse(struct { solana: struct { lookup_table: []const u8 } }, a, @embedFile("../altvm/fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
            defer fixture_json.deinit();
            const raw_table = try unhex(a, fixture_json.value.solana.lookup_table);
            defer a.free(raw_table);
            const data = try a.alloc(u8, std.base64.standard.Encoder.calcSize(raw_table.len));
            defer a.free(data);
            _ = std.base64.standard.Encoder.encode(data, raw_table);
            const owner = try base58.encode(a, if (self.wrong_owner) &(.{0} ** 32) else &@import("accounts.zig").lookup_table_program);
            defer a.free(owner);
            result = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 20 }, .value = .{ .owner = owner, .executable = false, .lamports = 10000, .data = .{ data, "base64" } } }, .{});
        } else if (std.mem.eql(u8, method, "simulateTransaction")) {
            if (self.oracle_gate) |gate| {
                var timer = try std.time.Timer.start();
                while (!gate.load(.acquire)) {
                    if (timer.read() > 500 * std.time.ns_per_ms) return error.EstimateReadsNotConcurrent;
                    std.Thread.sleep(std.time.ns_per_ms);
                }
            }
            try std.testing.expectEqualStrings("base64", params[1].object.get("encoding").?.string);
            try std.testing.expect(params[1].object.get("replaceRecentBlockhash").?.bool);
            try std.testing.expect(!params[1].object.get("sigVerify").?.bool);
            result = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 20 }, .value = .{ .err = if (self.simulation_failed) @as(?u8, 1) else null, .unitsConsumed = self.simulation_units } }, .{});
        } else if (std.mem.eql(u8, method, "getFeeForMessage")) {
            try std.testing.expectEqualStrings("finalized", params[1].object.get("commitment").?.string);
            try std.testing.expectEqual(@as(i64, 21), params[1].object.get("minContextSlot").?.integer);
            result = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 22 }, .value = if (self.fee_unavailable) @as(?u64, null) else 5123 }, .{});
        } else if (std.mem.eql(u8, method, "getLatestBlockhash")) {
            try std.testing.expectEqualStrings("finalized", params[0].object.get("commitment").?.string);
            try std.testing.expectEqual(@as(i64, 20), params[0].object.get("minContextSlot").?.integer);
            result = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 21 }, .value = .{ .blockhash = hash, .lastValidBlockHeight = 150 } }, .{});
        } else if (std.mem.eql(u8, method, "sendTransaction")) {
            try std.testing.expect(params[1].object.get("skipPreflight").?.bool);
            const sent = params[0].string;
            const bytes = try a.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(sent));
            defer a.free(bytes);
            try std.base64.standard.Decoder.decode(bytes, sent);
            const identity = try tx.validateSigned(bytes, null);
            try std.testing.expectEqual(native_signature, identity.signature);
            result = try std.json.Stringify.valueAlloc(a, if (self.wrong_ack) hash else signature, .{});
        } else if (std.mem.eql(u8, method, "getTransaction")) {
            try std.testing.expectEqualStrings(signature, params[0].string);
            result = try std.json.Stringify.valueAlloc(a, .{ .slot = 22, .transaction = .{ .signatures = .{signature} }, .meta = .{ .err = null, .computeUnitsConsumed = 90000, .fee = 5000 } }, .{});
        } else if (std.mem.eql(u8, method, "getSignatureStatuses")) {
            try std.testing.expect(params[1].object.get("searchTransactionHistory").?.bool);
            result = try a.dupe(u8, "{\"context\":{\"slot\":23},\"value\":[{\"slot\":22,\"err\":null,\"confirmationStatus\":\"finalized\"}]}");
        } else if (std.mem.eql(u8, method, "getBlock")) {
            self.block_reads += 1;
            try std.testing.expectEqualStrings("signatures", params[1].object.get("transactionDetails").?.string);
            const parent = try base58.encode(a, &(.{9} ** 32));
            defer a.free(parent);
            result = try std.json.Stringify.valueAlloc(a, .{ .blockhash = if (self.reorg and self.block_reads % 2 == 0) parent else hash, .previousBlockhash = parent, .signatures = .{signature} }, .{});
        } else return error.UnexpectedMethod;
        defer a.free(result);
        const envelope = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ id.integer, result });
        return .{ .bytes = envelope, .len = envelope.len };
    }
};
test "SVM HTTP prepare sign persist boundary submit acknowledgement and finalized canonical receipt" {
    const a = std.testing.allocator;
    var fixture: Fixture = .{};
    var server = try @import("test_rpc.zig").Server.init(.{ .context = &fixture, .fetch_fn = Fixture.exchange }, 12);
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var client = try svm.Client.init(a, url, .{});
    defer client.deinit();
    const thread = try std.Thread.spawn(.{}, @import("test_rpc.zig").Server.serve, .{&server});
    var joined = false;
    defer if (!joined) thread.join();
    const seed: sol.Key = .{7} ** 32;
    const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    const process: sol.Instruction = .{ .program = .{9} ** 32, .accounts = &.{}, .data = "test" };
    const prepared = try tx.prepare(a, &client, .{ .payer = pair.public_key.toBytes(), .process = process, .oracle = .{ .constant = 100 }, .fee_cap = 90 });
    defer prepared.deinit();
    try std.testing.expectEqual(@as(u64, 99), prepared.estimate.compute_unit_price_micro_lamports);
    fixture.mutex.lock();
    const prepare_calls = fixture.calls;
    fixture.mutex.unlock();
    try std.testing.expectEqual(@as(usize, 2), prepare_calls); // prepare has no broadcast
    const signature = try pair.sign(prepared.compiled.bytes, null);
    const wire = try prepared.attach(a, &.{signature.toBytes()});
    defer a.free(wire);
    fixture.mutex.lock();
    fixture.signature = signature.toBytes();
    fixture.mutex.unlock();
    try std.testing.expectEqual(signature.toBytes(), try tx.submit(&client, wire, true));
    fixture.mutex.lock();
    fixture.wrong_ack = true;
    fixture.mutex.unlock();
    try std.testing.expectError(error.SvmSubmissionIdentityMismatch, tx.submit(&client, wire, true));
    fixture.mutex.lock();
    fixture.wrong_ack = false;
    fixture.mutex.unlock();
    const receipt = (try tx.finalizedReceipt(&client, signature.toBytes())).?;
    try std.testing.expectEqual(@as(u64, 22), receipt.slot);
    try std.testing.expect(!receipt.failed);
    fixture.mutex.lock();
    fixture.reorg = true;
    fixture.mutex.unlock();
    try std.testing.expectError(error.SvmReceiptCanonicalityChanged, tx.finalizedReceipt(&client, signature.toBytes()));
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
}
test "SVM Helius fee source rounding and saturation" {
    const a = std.testing.allocator;
    for ([_]struct { raw: []const u8, want: u64 }{ .{ .raw = "-2.5", .want = 0 }, .{ .raw = "0.49", .want = 0 }, .{ .raw = "0.5", .want = 1 }, .{ .raw = "3.5", .want = 4 }, .{ .raw = "1e30", .want = std.math.maxInt(u64) } }) |case| {
        const text = try std.fmt.allocPrint(a, "{{\"result\":{{\"priorityFeeEstimate\":{s}}}}}", .{case.raw});
        defer a.free(text);
        const parsed = try std.json.parseFromSlice(std.json.Value, a, text, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(case.want, try tx.decodeFee(parsed.value));
    }
}

test "SVM fresh ALT SDK account ownership activation and shared monotonic deadline" {
    const a = std.testing.allocator;
    var fixture: Fixture = .{};
    var client = try svm.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &fixture, .fetch_fn = Fixture.exchange } });
    defer client.deinit();
    const seed: sol.Key = .{7} ** 32;
    const pair = try std.crypto.sign.Ed25519.KeyPair.generateDeterministic(seed);
    const process: sol.Instruction = .{ .program = .{9} ** 32, .accounts = &.{.{ .key = .{1} ** 32, .is_writable = true }}, .data = "test" };
    const input: tx.Input = .{ .payer = pair.public_key.toBytes(), .process = process, .alt_addresses = &.{.{6} ** 32} };
    const prepared = try tx.prepare(a, &client, input);
    defer prepared.deinit();
    try std.testing.expectEqual(@as(u8, 128), prepared.compiled.bytes[0]);
    const wire = try prepared.sign(a, &.{seed});
    defer a.free(wire);
    _ = try tx.validateSigned(wire, prepared.compiled.bytes);
    fixture.wrong_owner = true;
    try std.testing.expectError(error.WrongLookupTableOwner, tx.prepare(a, &client, input));
    client.deadline_ns = 1;
    const calls = fixture.calls;
    try std.testing.expectError(error.SvmRequestDeadline, tx.prepare(a, &client, input));
    try std.testing.expectEqual(calls, fixture.calls);
    try std.testing.expectEqual(@as(?u64, null), client.minimum_slot);
}

const FailingFee = struct {
    calls: usize = 0,
    fn send(context: *anyopaque, _: A, _: @import("../cloud/http.zig").Request) anyerror!@import("../cloud/http.zig").Response {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.calls += 1;
        return error.FixtureFeeUnavailable;
    }
};
test "SVM simulation errors take precedence after oracle read completes" {
    const a = std.testing.allocator;
    var fixture: Fixture = .{ .simulation_failed = true };
    var fee: FailingFee = .{};
    var client = try svm.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &fixture, .fetch_fn = Fixture.exchange } });
    defer client.deinit();
    const input: tx.Input = .{ .payer = .{3} ** 32, .process = .{ .program = .{9} ** 32, .accounts = &.{}, .data = "test" }, .oracle = .{ .helius = .{ .url = "https://fixture.invalid", .transport = .{ .context = &fee, .send_fn = FailingFee.send } } } };
    try std.testing.expectError(error.SvmSimulationFailed, tx.prepare(a, &client, input));
    try std.testing.expectEqual(@as(usize, 1), fee.calls);
    fixture.simulation_failed = false;
    fixture.simulation_units = 0;
    try std.testing.expectError(error.InvalidSimulationUnits, tx.prepare(a, &client, input));
    try std.testing.expectEqual(@as(usize, 2), fee.calls);
    fixture.simulation_units = 100000;
    try std.testing.expectError(error.FixtureFeeUnavailable, tx.prepare(a, &client, input));
    try std.testing.expectEqual(@as(usize, 3), fee.calls);
}

const ConcurrentFee = struct {
    gate: *std.atomic.Value(bool),
    fn send(context: *anyopaque, a: A, request: @import("../cloud/http.zig").Request) anyerror!@import("../cloud/http.zig").Response {
        const self: *@This() = @ptrCast(@alignCast(context));
        const parsed = try std.json.parseFromSlice(std.json.Value, a, request.body orelse return error.MissingFeeBody, .{});
        defer parsed.deinit();
        try std.testing.expectEqualStrings("1", parsed.value.object.get("id").?.string);
        try std.testing.expectEqualStrings("getPriorityFeeEstimate", parsed.value.object.get("method").?.string);
        const params = parsed.value.object.get("params").?.array.items[0];
        const options = params.object.get("options").?;
        try std.testing.expect(options.object.get("recommended").?.bool);
        try std.testing.expectEqualStrings("base58", options.object.get("transactionEncoding").?.string);
        const wire = try base58.decode(a, params.object.get("transaction").?.string);
        defer a.free(wire);
        try std.testing.expectEqual(@as(u8, 1), wire[0]);
        for (wire[1..65]) |byte| try std.testing.expectEqual(@as(u8, 0), byte);
        self.gate.store(true, .release);
        return .{ .allocator = a, .status = 200, .bytes = try a.dupe(u8, "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"priorityFeeEstimate\":100.5}}") };
    }
};
test "SVM concurrent Helius and simulation preserve exact unsigned request and join" {
    const a = std.testing.allocator;
    var gate: std.atomic.Value(bool) = .init(false);
    var fixture: Fixture = .{ .oracle_gate = &gate };
    var fee: ConcurrentFee = .{ .gate = &gate };
    var client = try svm.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &fixture, .fetch_fn = Fixture.exchange } });
    defer client.deinit();
    const prepared = try tx.prepare(a, &client, .{ .payer = .{3} ** 32, .process = .{ .program = .{9} ** 32, .accounts = &.{}, .data = "test" }, .concurrent_estimate_reads = true, .oracle = .{ .helius = .{ .url = "https://fixture.invalid", .transport = .{ .context = &fee, .send_fn = ConcurrentFee.send } } } });
    defer prepared.deinit();
    try std.testing.expectEqual(@as(u64, 111), prepared.estimate.compute_unit_price_micro_lamports);
    try std.testing.expect(gate.load(.acquire));
}

test "SVM actual chain fee quote is context pinned and absence is explicit" {
    const a = std.testing.allocator;
    var fixture: Fixture = .{};
    var client = try svm.Client.init(a, "http://127.0.0.1:1", .{ .exchange = .{ .context = &fixture, .fetch_fn = Fixture.exchange } });
    defer client.deinit();
    const prepared = try tx.prepare(a, &client, .{ .payer = .{3} ** 32, .process = .{ .program = .{9} ** 32, .accounts = &.{}, .data = "test" } });
    defer prepared.deinit();
    try std.testing.expectEqual(@as(u64, 5123), try prepared.feeQuote(&client));
    fixture.fee_unavailable = true;
    try std.testing.expectError(error.SvmFeeQuoteUnavailable, prepared.feeQuote(&client));
    try std.testing.expectEqual(@as(?u64, null), client.minimum_slot);
}
