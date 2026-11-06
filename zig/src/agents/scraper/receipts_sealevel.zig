//! Source-equivalent parsed-transaction enrichment. Recipient follows Rust's
//! top-level partially-decoded instruction heuristic, including CPI accounts.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const common = @import("receipts_common.zig");
const svm = @import("../../sealevel/provider.zig");
const b58 = @import("../../altvm/base58.zig");
const V = std.json.Value;
const native_programs = [_][]const u8{
    "BPFLoaderUpgradeab1e11111111111111111111111", "ComputeBudget111111111111111111111111111111", "Config1111111111111111111111111111111111111", "Ed25519SigVerify111111111111111111111111111", "KeccakSecp256k11111111111111111111111111111", "Stake11111111111111111111111111111111111111", "11111111111111111111111111111111", "Vote111111111111111111111111111111111111111",
};
fn field(value: V, name: []const u8) !V {
    return svm.field(value, name);
}
fn array(value: V) ![]const V {
    if (value != .array) return error.InvalidSvmReceipt;
    return value.array.items;
}
fn decodeFixed(comptime n: usize, a: std.mem.Allocator, value: V) ![n]u8 {
    const text = try svm.string(value);
    if (text.len > n * 2) return error.InvalidSvmReceipt;
    const bytes = try b58.decode(a, text);
    defer a.free(bytes);
    if (bytes.len != n) return error.InvalidSvmReceipt;
    return bytes[0..n].*;
}
fn known(key: [32]u8, programs: []const [32]u8) bool {
    for (programs) |program| if (std.mem.eql(u8, &key, &program)) return true;
    return false;
}
fn recipient(a: std.mem.Allocator, instructions: []const V, programs: []const [32]u8) ![32]u8 {
    var fallback: ?[32]u8 = null;
    for (instructions) |instruction| {
        if (instruction != .object) return error.InvalidSvmReceipt;
        // Fully parsed native instructions and compiled instructions are omitted
        // by the source RecipientProvider.
        if (instruction.object.contains("parsed") or !instruction.object.contains("programId")) continue;
        const id_text = try svm.string(try field(instruction, "programId"));
        const id = try decodeFixed(32, a, try field(instruction, "programId"));
        var relevant = known(id, programs);
        for (try array(try field(instruction, "accounts"))) |account| relevant = relevant or known(try decodeFixed(32, a, account), programs);
        if (relevant) return id;
        var native = false;
        for (native_programs) |program| native = native or std.mem.eql(u8, program, id_text);
        if (!native and fallback == null) fallback = id;
    }
    return fallback orelse error.NoNonNativePrograms;
}
pub fn decode(a: std.mem.Allocator, meta: enrich.Meta, value: V, programs: []const [32]u8, decimals: u32) !enrich.OwnedTxn {
    if (decimals > 18) return error.InvalidNativeTokenDecimals;
    if (try svm.uint(try field(value, "slot")) != meta.block_number) return error.ScraperReceiptIdentityMismatch;
    const transaction = try field(value, "transaction");
    const signatures = try array(try field(transaction, "signatures"));
    if (signatures.len == 0 or !std.mem.eql(u8, &(try decodeFixed(64, a, signatures[0])), &meta.tx_hash)) return error.ScraperReceiptIdentityMismatch;
    const message = try field(transaction, "message");
    const keys = try array(try field(message, "accountKeys"));
    if (keys.len == 0) return error.UnsignedSvmTransaction;
    const sender = try decodeFixed(32, a, try field(keys[0], "pubkey"));
    const to = try recipient(a, try array(try field(message, "instructions")), programs);
    const metadata = try field(value, "meta");
    const gas = try svm.uint(try field(metadata, "computeUnitsConsumed"));
    var fee: u256 = try svm.uint(try field(metadata, "fee"));
    for (decimals..18) |_| fee = try std.math.mul(u256, fee, 10);
    const price: ?u256 = if (gas == 0) null else fee / gas;
    return .{ .arena = std.heap.ArenaAllocator.init(a), .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = gas, .gas_price = price, .effective_gas_price = price, .nonce = 0, .sender = sender, .recipient = to, .gas_used = gas, .cumulative_gas_used = gas } };
}
pub const Sealevel = struct {
    client: *svm.Client,
    programs: []const [32]u8,
    native_decimals: u32,
    max_transaction_version: u8 = 0,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Sealevel) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = header };
    }
    fn budget(self: *Sealevel, deadline: u64) !void {
        if (self.client.commitment != .finalized) return error.FinalizedSvmScraperRequired;
        if (self.client.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        self.client.rpc_client.options.owner_deadline_ns = @min(self.client.rpc_client.options.owner_deadline_ns orelse deadline, deadline);
        self.client.rpc_client.options.timeout_ms = @min(self.client.rpc_client.options.timeout_ms, try common.milliseconds(deadline));
        self.client.rpc_client.options.connect_timeout_ms = @min(self.client.rpc_client.options.connect_timeout_ms, self.client.rpc_client.options.timeout_ms);
    }
    fn fetch(context: *anyopaque, a: std.mem.Allocator, meta: enrich.Meta, deadline: u64) !enrich.OwnedTxn {
        const self: *Sealevel = @ptrCast(@alignCast(context));
        const saved = self.client.rpc_client.options;
        defer self.client.rpc_client.options = saved;
        try self.budget(deadline);
        const signature = try b58.encode(a, &meta.tx_hash);
        defer a.free(signature);
        var response = try self.client.rpc_client.call("getTransaction", .{ signature, .{ .encoding = "jsonParsed", .commitment = "finalized", .maxSupportedTransactionVersion = self.max_transaction_version } });
        defer response.deinit();
        if (response.value() == .null) return error.ScraperTransactionUnavailable;
        _ = try common.milliseconds(deadline);
        return decode(a, meta, response.value(), self.programs, self.native_decimals);
    }
    fn header(context: *anyopaque, meta: enrich.Meta, deadline: u64) !src.Header {
        const self: *Sealevel = @ptrCast(@alignCast(context));
        const saved = self.client.rpc_client.options;
        defer self.client.rpc_client.options = saved;
        try self.budget(deadline);
        var response = try self.client.rpc_client.call("getBlock", .{ meta.block_number, .{ .encoding = "json", .transactionDetails = "none", .rewards = false, .commitment = "finalized", .maxSupportedTransactionVersion = self.max_transaction_version } });
        defer response.deinit();
        const value = response.value();
        const hash = try decodeFixed(32, self.client.rpc_client.allocator, try field(value, "blockhash"));
        if (!std.mem.eql(u8, &hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return .{ .height = meta.block_number, .hash = hash, .parent = try decodeFixed(32, self.client.rpc_client.allocator, try field(value, "previousBlockhash")), .timestamp = try svm.uint(try field(value, "blockTime")) };
    }
};

test "scraper Sealevel receipt matches production parsed transactions and recipient heuristic" {
    const fixtures = [_]struct { bytes: []const u8, mailbox: []const u8, recipient: []const u8 }{
        .{ .bytes = @embedFile("fixtures/svm-receipt-solana.json.gz"), .mailbox = "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi", .recipient = "3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm" },
        .{ .bytes = @embedFile("fixtures/svm-receipt-eclipse.json.gz"), .mailbox = "EitxJuv2iBjsg2d7jVy2LDC1e2zBrx4GB5Y9h2Ko3A9Y", .recipient = "FJu4E1BDYKVg7aTWdwATZRUvytJZ8ZZ2gQuvPfMWAz9y" },
    };
    const a = std.testing.allocator;
    for (fixtures) |fixture| {
        var parsed = try @import("../../testing/fixture.zig").parse(V, a, fixture.bytes, .{});
        defer parsed.deinit();
        const value = parsed.value;
        const signature = (try array(try field(try field(value, "transaction"), "signatures")))[0];
        var meta: enrich.Meta = .{ .block_number = try svm.uint(try field(value, "slot")), .block_hash = .{7} ** 32, .tx_hash = try decodeFixed(64, a, signature) };
        const programs = [_][32]u8{try svm.decodeKey(a, fixture.mailbox)};
        var result = try decode(a, meta, value, &programs, 9);
        defer result.deinit();
        try std.testing.expectEqual(try svm.decodeKey(a, fixture.recipient), result.value.recipient.?);
        const gas = try svm.uint(try field(try field(value, "meta"), "computeUnitsConsumed"));
        try std.testing.expectEqual(@as(u256, gas), result.value.gas_limit);
        const fee = try svm.uint(try field(try field(value, "meta"), "fee"));
        try std.testing.expectEqual(@as(?u256, @as(u256, fee) * 1000000000 / gas), result.value.gas_price);
        meta.tx_hash[0] ^= 1;
        try std.testing.expectError(error.ScraperReceiptIdentityMismatch, decode(a, meta, value, &programs, 9));
        meta.tx_hash[0] ^= 1;
        meta.block_number += 1;
        try std.testing.expectError(error.ScraperReceiptIdentityMismatch, decode(a, meta, value, &programs, 9));
    }
}
