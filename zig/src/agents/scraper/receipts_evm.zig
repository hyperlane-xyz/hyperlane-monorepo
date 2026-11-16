//! Concrete EVM transaction + receipt enrichment. Each job owns a serial RPC
//! client and absolute monotonic deadline; every RPC consumes the same budget.
const std = @import("std");
const enrich = @import("enrichment.zig");
const src = @import("source.zig");
const rpc = @import("../../evm/provider.zig");
const abi = @import("../../evm/codecs.zig");
const json_fast = @import("../../net/json_fast.zig");
const envelope = @import("../../net/json_envelope.zig");
pub fn nowNs() !u64 {
    const instant = try std.time.Instant.now();
    return try std.math.add(u64, try std.math.mul(u64, std.math.cast(u64, instant.timestamp.sec) orelse return error.UnsupportedClock, 1000000000), @intCast(instant.timestamp.nsec));
}
fn field(value: std.json.Value, name: []const u8) !std.json.Value {
    if (value != .object) return error.InvalidReceiptJson;
    return value.object.get(name) orelse error.MissingReceiptField;
}
fn quantity(value: std.json.Value) !u256 {
    return quantityText(try rpc.string(value));
}
fn quantityText(text: []const u8) !u256 {
    if (text.len < 3 or text.len > 66 or !std.mem.startsWith(u8, text, "0x") or (text.len > 3 and text[2] == '0')) return error.InvalidReceiptQuantity;
    for (text[2..]) |char| if (!std.ascii.isHex(char)) return error.InvalidReceiptQuantity;
    return std.fmt.parseInt(u256, text[2..], 16);
}
fn optionalQuantity(value: std.json.Value, name: []const u8) !?u256 {
    const actual = value.object.get(name) orelse return null;
    return if (actual == .null) null else try quantity(actual);
}
fn address(value: std.json.Value) !src.Hash {
    const raw = try abi.fixedHex(20, try rpc.string(value));
    var out: src.Hash = .{0} ** 32;
    @memcpy(out[12..], &raw);
    return out;
}
fn validate(value: std.json.Value, meta: enrich.Meta, tx_field: []const u8) !void {
    const block = try abi.fixedHex(32, try rpc.string(try field(value, "blockHash")));
    const transaction = try abi.fixedHex(32, try rpc.string(try field(value, tx_field)));
    const height = try abi.quantity(try rpc.string(try field(value, "blockNumber")));
    if (!std.mem.eql(u8, &block, &meta.block_hash) or !std.mem.eql(u8, &transaction, meta.tx_hash[32..64]) or height != meta.block_number) return error.ScraperReceiptIdentityMismatch;
}
pub const Evm = struct {
    rpc_client: *rpc.RpcClient,
    allow_std_fixture: bool = false,
    pub fn interface(self: *Evm) enrich.Fetcher {
        return .{ .context = self, .fetch_fn = fetch, .header_fn = fetchHeader };
    }
    fn budget(self: *Evm, deadline: u64) !void {
        const now = try nowNs();
        if (now >= deadline) return error.ScraperReceiptDeadline;
        const ms = (deadline - now) / 1000000 + @intFromBool((deadline - now) % 1000000 != 0);
        self.rpc_client.options.owner_deadline_ns = @min(self.rpc_client.options.owner_deadline_ns orelse deadline, deadline);
        self.rpc_client.options.timeout_ms = @intCast(@min(@min(ms, std.math.maxInt(u32)), self.rpc_client.options.timeout_ms));
        self.rpc_client.options.connect_timeout_ms = @min(self.rpc_client.options.connect_timeout_ms, self.rpc_client.options.timeout_ms);
    }
    fn fetchHeader(context: *anyopaque, meta: enrich.Meta, deadline_ns: u64) !src.Header {
        const self: *Evm = @ptrCast(@alignCast(context));
        if (self.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        const saved = self.rpc_client.options;
        defer self.rpc_client.options = saved;
        try self.budget(deadline_ns);
        const header = try self.rpc_client.blockHeader(.{ .number = meta.block_number });
        if (!std.mem.eql(u8, &header.hash, &meta.block_hash)) return error.ScraperReceiptIdentityMismatch;
        return .{ .height = header.number, .hash = header.hash, .parent = header.parent_hash, .timestamp = header.timestamp };
    }
    fn fetch(context: *anyopaque, allocator: std.mem.Allocator, meta: enrich.Meta, deadline_ns: u64) !enrich.OwnedTxn {
        const self: *Evm = @ptrCast(@alignCast(context));
        if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
        if (self.rpc_client.options.native_transport == null and !self.allow_std_fixture) return error.NativeReceiptTransportRequired;
        const saved = self.rpc_client.options;
        defer self.rpc_client.options = saved;
        const hash = try abi.hexAlloc(allocator, meta.tx_hash[32..]);
        defer allocator.free(hash);
        try self.budget(deadline_ns);
        // Transaction and receipt are independent reads of the same hash:
        // overlap them (one continuation, one round-trip latency) instead of
        // two sequential calls. Each is still identity-checked below.
        const params = try std.fmt.allocPrint(allocator, "[\"{s}\"]", .{hash});
        defer allocator.free(params);
        var responses: [2]rpc.RawResponse = undefined;
        try self.rpc_client.callManyRaw(&.{ .{ .method = "eth_getTransactionByHash", .params_json = params }, .{ .method = "eth_getTransactionReceipt", .params_json = params } }, &responses);
        defer for (&responses) |*response| response.deinit();
        // Pool-validated results decode straight from their bytes; anything
        // that path does not accept takes the tree path below, which owns
        // every error and its order.
        if (responses[0].raw()) |t| if (responses[1].raw()) |r| if (try decodePairRaw(allocator, meta, t, r)) |decoded| {
            var owned = decoded;
            errdefer owned.deinit();
            if (try nowNs() >= deadline_ns) return error.ScraperReceiptDeadline;
            return owned;
        };
        const transaction = try responses[0].value();
        const receipt = try responses[1].value();
        if (transaction == .null) return error.ScraperTransactionUnavailable;
        try validate(transaction, meta, "hash");
        if (receipt == .null) return error.ScraperReceiptUnavailable;
        try validate(receipt, meta, "transactionHash");
        if (try nowNs() >= deadline_ns) return error.ScraperReceiptDeadline;
        return decodePair(allocator, meta, transaction, receipt);
    }
};

/// Shared exact Ethereum JSON-RPC receipt shape, also supplied by Tron.
pub fn decodePair(allocator: std.mem.Allocator, meta: enrich.Meta, t: std.json.Value, r: std.json.Value) !enrich.OwnedTxn {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return error.UnsupportedReceiptTransactionHash;
    try validate(t, meta, "hash");
    try validate(r, meta, "transactionHash");
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const a = arena.allocator();
    const recipient = try field(t, "to");
    const input = try rpc.string(try field(t, "input"));
    if (input.len < 2 or input.len % 2 != 0) return error.InvalidReceiptInput;
    const raw = try a.alloc(u8, (input.len - 2) / 2);
    _ = try abi.decodeHex(raw, input);
    return .{ .arena = arena, .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = try quantity(try field(t, "gas")), .max_priority_fee = try optionalQuantity(t, "maxPriorityFeePerGas"), .max_fee = try optionalQuantity(t, "maxFeePerGas"), .gas_price = try optionalQuantity(t, "gasPrice"), .effective_gas_price = try optionalQuantity(r, "effectiveGasPrice"), .nonce = try abi.quantity(try rpc.string(try field(t, "nonce"))), .sender = try address(try field(t, "from")), .recipient = if (recipient == .null) null else try address(recipient), .gas_used = try quantity(try field(r, "gasUsed")), .cumulative_gas_used = try quantity(try field(r, "cumulativeGasUsed")), .raw_input = raw } };
}

const TxField = enum { hash, blockHash, blockNumber, to, input, gas, maxPriorityFeePerGas, maxFeePerGas, gasPrice, nonce, from };
const ReceiptField = enum { transactionHash, blockHash, blockNumber, effectiveGasPrice, gasUsed, cumulativeGasUsed };
const Undecided = error{Undecided};

/// fetch()'s validate + decodePair success, read from the transaction and
/// receipt result JSON without building trees. Null when that sequence
/// would fail or when these spans cannot decide it (escapes, duplicate keys,
/// odd shapes): the caller then runs the tree path, which owns every error.
pub fn decodePairRaw(allocator: std.mem.Allocator, meta: enrich.Meta, t: []const u8, r: []const u8) !?enrich.OwnedTxn {
    if (!std.mem.allEqual(u8, meta.tx_hash[0..32], 0)) return null;
    var fallback = std.heap.stackFallback(1024, allocator);
    const scratch = fallback.get();
    const tf = (try json_fast.fields(TxField, scratch, t)) orelse return null;
    const rf = (try json_fast.fields(ReceiptField, scratch, r)) orelse return null;
    return decodeFound(allocator, meta, t, tf, r, rf) catch |err| switch (err) {
        error.Undecided => null,
        error.OutOfMemory => error.OutOfMemory,
    };
}
fn decodeFound(allocator: std.mem.Allocator, meta: enrich.Meta, t: []const u8, tf: [@typeInfo(TxField).@"enum".fields.len]?envelope.Member, r: []const u8, rf: [@typeInfo(ReceiptField).@"enum".fields.len]?envelope.Member) (Undecided || std.mem.Allocator.Error)!enrich.OwnedTxn {
    const tx = Spans(TxField){ .bytes = t, .found = tf };
    const rc = Spans(ReceiptField){ .bytes = r, .found = rf };
    try tx.identity(.hash, meta);
    try rc.identity(.transactionHash, meta);
    const to = tf[@intFromEnum(TxField.to)] orelse return error.Undecided;
    const recipient: ?src.Hash = if (tx.isNull(to)) null else try tx.address(.to);
    const input = try tx.text(.input);
    if (input.len < 2 or input.len % 2 != 0) return error.Undecided;
    const gas_limit = quantityText(try tx.text(.gas)) catch return error.Undecided;
    const max_priority_fee = try tx.optionalQuantity(.maxPriorityFeePerGas);
    const max_fee = try tx.optionalQuantity(.maxFeePerGas);
    const gas_price = try tx.optionalQuantity(.gasPrice);
    const effective_gas_price = try rc.optionalQuantity(.effectiveGasPrice);
    const nonce = abi.quantity(try tx.text(.nonce)) catch return error.Undecided;
    const sender = try tx.address(.from);
    const gas_used = quantityText(try rc.text(.gasUsed)) catch return error.Undecided;
    const cumulative_gas_used = quantityText(try rc.text(.cumulativeGasUsed)) catch return error.Undecided;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const raw = try arena.allocator().alloc(u8, (input.len - 2) / 2);
    _ = abi.decodeHex(raw, input) catch return error.Undecided;
    return .{ .arena = arena, .value = .{ .hash = meta.tx_hash, .block_hash = meta.block_hash, .block_number = meta.block_number, .gas_limit = gas_limit, .max_priority_fee = max_priority_fee, .max_fee = max_fee, .gas_price = gas_price, .effective_gas_price = effective_gas_price, .nonce = nonce, .sender = sender, .recipient = recipient, .gas_used = gas_used, .cumulative_gas_used = cumulative_gas_used, .raw_input = raw } };
}

/// Top-level members of one result object, read the way the tree helpers
/// above read them; anything they would not accept is Undecided.
fn Spans(comptime Names: type) type {
    return struct {
        const Self = @This();
        bytes: []const u8,
        found: [@typeInfo(Names).@"enum".fields.len]?envelope.Member,

        /// Unescaped string text (escaped strings are left to the tree path).
        fn text(self: Self, name: Names) Undecided![]const u8 {
            const member = self.found[@intFromEnum(name)] orelse return error.Undecided;
            if (member.kind != .string) return error.Undecided;
            const raw = member.span.of(self.bytes);
            if (std.mem.indexOfScalar(u8, raw, '\\') != null) return error.Undecided;
            return raw[1 .. raw.len - 1];
        }
        fn isNull(self: Self, member: envelope.Member) bool {
            return member.kind == .other and std.mem.eql(u8, member.span.of(self.bytes), "null");
        }
        /// optionalQuantity: absent or null is null.
        fn optionalQuantity(self: Self, name: Names) Undecided!?u256 {
            const member = self.found[@intFromEnum(name)] orelse return null;
            if (self.isNull(member)) return null;
            return quantityText(try self.text(name)) catch error.Undecided;
        }
        fn address(self: Self, name: Names) Undecided!src.Hash {
            const raw = abi.fixedHex(20, try self.text(name)) catch return error.Undecided;
            var out: src.Hash = .{0} ** 32;
            @memcpy(out[12..], &raw);
            return out;
        }
        /// validate(): block hash, transaction hash and height match `meta`.
        fn identity(self: Self, tx_field: Names, meta: enrich.Meta) Undecided!void {
            const block = abi.fixedHex(32, try self.text(.blockHash)) catch return error.Undecided;
            const transaction = abi.fixedHex(32, try self.text(tx_field)) catch return error.Undecided;
            const height = abi.quantity(try self.text(.blockNumber)) catch return error.Undecided;
            if (!std.mem.eql(u8, &block, &meta.block_hash) or !std.mem.eql(u8, &transaction, meta.tx_hash[32..64]) or height != meta.block_number) return error.Undecided;
        }
    };
}

test {
    _ = @import("receipts_evm_differential_test.zig");
}
