const std = @import("std");
const signers = @import("signers.zig");
const svm = @import("provider.zig");
const accounts = @import("accounts.zig");
const Mailbox = @import("mailbox.zig").Mailbox;
const rpc = @import("../evm/provider.zig");
const b58 = @import("../altvm/base58.zig");
const protocol = @import("../protocol/root.zig");
const A = std.mem.Allocator;
const Fixture = struct {
    mutex: std.Thread.Mutex = .{},
    calls: usize = 0,
    no_match: bool = false,
    unavailable: bool = false,
    reorg: bool = false,
    fn exchange(context: *anyopaque, a: A, body: []const u8, _: rpc.Options) anyerror!rpc.WireResponse {
        const self: *@This() = @ptrCast(@alignCast(context));
        self.mutex.lock();
        defer self.mutex.unlock();
        self.calls += 1;
        const request = try std.json.parseFromSlice(std.json.Value, a, body, .{});
        defer request.deinit();
        const method = (try svm.field(request.value, "method")).string;
        const params = (try svm.field(request.value, "params")).array.items;
        const hash = try b58.encode(a, &(.{8} ** 32));
        defer a.free(hash);
        const wrong_hash = try b58.encode(a, &(.{9} ** 32));
        defer a.free(wrong_hash);
        const program_key = [_]u8{9} ** 32;
        const program = try b58.encode(a, &program_key);
        defer a.free(program);
        const pda_key = (try accounts.dispatchedPda(program_key, .{5} ** 32)).key;
        const pda = try b58.encode(a, &pda_key);
        defer a.free(pda);
        const payer = try b58.encode(a, &(.{3} ** 32));
        defer a.free(payer);
        const depositor = try b58.encode(a, &(.{4} ** 32));
        defer a.free(depositor);
        const signature = try b58.encode(a, &(.{1} ** 64));
        defer a.free(signature);
        const second_signature = try b58.encode(a, &(.{2} ** 64));
        defer a.free(second_signature);
        var value: []u8 = undefined;
        if (std.mem.eql(u8, method, "getProgramAccounts")) {
            try std.testing.expectEqualStrings(program, params[0].string);
            const message: protocol.Message = .{ .origin = 1000, .destination = 2000, .nonce = 7 };
            var data: [130]u8 = undefined;
            data[0] = 1;
            @memcpy(data[1..9], "DISPATCH");
            std.mem.writeInt(u32, data[9..13], 7, .little);
            std.mem.writeInt(u64, data[13..21], 20, .little);
            data[21..53].* = .{5} ** 32;
            _ = try message.encode(data[53..]);
            const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(data.len));
            defer a.free(encoded);
            _ = std.base64.standard.Encoder.encode(encoded, &data);
            value = try std.json.Stringify.valueAlloc(a, .{ .context = .{ .slot = 30 }, .value = .{.{ .pubkey = pda, .account = .{ .owner = program, .lamports = 10000, .executable = false, .data = .{ encoded, "base64" } } }} }, .{});
        } else if (std.mem.eql(u8, method, "getBlock")) {
            const mode = (try svm.field(params[1], "transactionDetails")).string;
            try std.testing.expectEqualStrings("finalized", (try svm.field(params[1], "commitment")).string);
            if (std.mem.eql(u8, mode, "full")) {
                if (self.unavailable) value = try a.dupe(u8, "null") else if (self.no_match) value = try std.json.Stringify.valueAlloc(a, .{ .blockhash = hash, .transactions = [_]usize{} }, .{}) else {
                    var dispatch: [73]u8 = .{0} ** 73;
                    dispatch[0] = 4;
                    const encoded = try b58.encode(a, &dispatch);
                    defer a.free(encoded);
                    value = try std.json.Stringify.valueAlloc(a, .{ .blockhash = hash, .transactions = .{.{ .meta = .{ .err = null }, .transaction = .{ .signatures = .{ signature, second_signature }, .message = .{ .accountKeys = .{ payer, depositor, program, pda }, .instructions = .{.{ .programIdIndex = 2, .accounts = .{3}, .data = encoded }} } } }} }, .{});
                }
            } else {
                try std.testing.expectEqualStrings("signatures", mode);
                value = try std.json.Stringify.valueAlloc(a, .{ .blockhash = if (self.reorg) wrong_hash else hash, .signatures = .{signature} }, .{});
            }
        } else if (std.mem.eql(u8, method, "getTransaction")) {
            try std.testing.expectEqualStrings(signature, params[0].string);
            try std.testing.expectEqualStrings("jsonParsed", (try svm.field(params[1], "encoding")).string);
            value = try std.json.Stringify.valueAlloc(a, .{ .slot = 20, .meta = .{ .err = null }, .transaction = .{ .signatures = .{ signature, second_signature }, .message = .{ .accountKeys = .{ .{ .pubkey = payer, .signer = true }, .{ .pubkey = depositor, .signer = true }, .{ .pubkey = program, .signer = false }, .{ .pubkey = pda, .signer = false } } } } }, .{});
        } else return error.UnexpectedSignerRpc;
        defer a.free(value);
        const response = try std.fmt.allocPrint(a, "{{\"jsonrpc\":\"2.0\",\"id\":{d},\"result\":{s}}}", .{ (try svm.field(request.value, "id")).integer, value });
        return .{ .bytes = response, .len = response.len };
    }
};
test "SVM HTTP signer lookup resolves immutable dispatch sequence and distinguishes unavailable from unknown" {
    const a = std.testing.allocator;
    var fixture: Fixture = .{};
    var server = try @import("test_rpc.zig").Server.init(.{ .context = &fixture, .fetch_fn = Fixture.exchange }, 15);
    defer server.deinit();
    const url = try server.url(a);
    defer a.free(url);
    var client = try svm.Client.init(a, url, .{});
    defer client.deinit();
    const mailbox: Mailbox = .{ .client = &client, .program = .{9} ** 32, .domain = 1000 };
    const thread = try std.Thread.spawn(.{}, @import("test_rpc.zig").Server.serve, .{&server});
    var joined = false;
    defer if (!joined) thread.join();
    const missing = (try signers.fetchTxSignersBySequence(&client, mailbox, 7, null)).?;
    defer a.free(missing);
    try std.testing.expectEqual(@as(usize, 2), missing.len);
    try std.testing.expectEqual([_]u8{4} ** 32, missing[1]);
    const known = (try signers.fetchTxSignersBySequence(&client, mailbox, 7, .{1} ** 64)).?;
    defer a.free(known);
    try std.testing.expectEqualSlices([32]u8, missing, known);
    fixture.mutex.lock();
    fixture.no_match = true;
    fixture.mutex.unlock();
    const unknown = (try signers.fetchTxSignersBySequence(&client, mailbox, 7, null)).?;
    defer a.free(unknown);
    try std.testing.expectEqual(@as(usize, 0), unknown.len);
    fixture.mutex.lock();
    fixture.no_match = false;
    fixture.unavailable = true;
    fixture.mutex.unlock();
    try std.testing.expectError(error.SvmSignerBlockUnavailable, signers.fetchTxSignersBySequence(&client, mailbox, 7, null));
    fixture.mutex.lock();
    fixture.unavailable = false;
    fixture.reorg = true;
    fixture.mutex.unlock();
    try std.testing.expectError(error.SvmSignerCanonicalityChanged, signers.fetchTxSignersBySequence(&client, mailbox, 7, null));
    thread.join();
    joined = true;
    if (server.failure) |err| return err;
    try std.testing.expectEqual(@as(usize, 15), fixture.calls);
}
test "SVM every signer from actual production jsonParsed transactions" {
    const a = std.testing.allocator;
    for ([_][]const u8{ @embedFile("../agents/scraper/fixtures/svm-receipt-solana.json.gz"), @embedFile("../agents/scraper/fixtures/svm-receipt-eclipse.json.gz") }) |fixture| {
        const parsed = try @import("../testing/fixture.zig").parse(std.json.Value, a, fixture, .{});
        defer parsed.deinit();
        const transaction = try svm.field(parsed.value, "transaction");
        const signatures = try svm.field(transaction, "signatures");
        const hash = try b58.decode(a, (try svm.string(signatures.array.items[0])));
        defer a.free(hash);
        const keys = try signers.decode(a, parsed.value, hash[0..64].*);
        defer a.free(keys);
        const message = try svm.field(transaction, "message");
        const accounts_json = try svm.field(message, "accountKeys");
        var count: usize = 0;
        for (accounts_json.array.items) |entry| if ((try svm.field(entry, "signer")).bool) {
            try std.testing.expectEqual(try svm.decodeKey(a, try svm.string(try svm.field(entry, "pubkey"))), keys[count]);
            count += 1;
        };
        try std.testing.expectEqual(count, keys.len);
    }
}
