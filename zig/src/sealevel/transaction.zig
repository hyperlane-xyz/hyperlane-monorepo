//! SVM destination boundary. No key discovery, implicit broadcast, or resend.
//! Security boundary: persist the complete signed bytes, full 64-byte signature
//! and blockhash lease before submit. Any submission transport error is ambiguous.
const std = @import("std");
const svm = @import("provider.zig");
const sol = @import("../altvm/solana.zig");
const b58 = @import("../altvm/base58.zig");
const accounts = @import("accounts.zig");
const http = @import("../cloud/http.zig");
const A = std.mem.Allocator;
const Key = sol.Key;
const Ed = std.crypto.sign.Ed25519;
pub const max_compute_units = 1_400_000;
pub const Submitter = enum { rpc, jito };
pub const Level = enum { Min, Low, Medium, High, VeryHigh, UnsafeMax };
pub const Oracle = union(enum) {
    constant: u64,
    helius: struct { transport: http.Transport, url: []const u8, level: ?Level = null },
    pub fn fee(self: Oracle, a: A, unsigned: []const u8) !u64 {
        return switch (self) {
            .constant => |value| value,
            .helius => |h| blk: {
                const encoded = try b58.encode(a, unsigned);
                defer a.free(encoded);
                const body = if (h.level) |level|
                    try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = "1", .method = "getPriorityFeeEstimate", .params = .{.{ .transaction = encoded, .options = .{ .priorityLevel = @tagName(level), .transactionEncoding = "base58" } }} }, .{})
                else
                    try std.json.Stringify.valueAlloc(a, .{ .jsonrpc = "2.0", .id = "1", .method = "getPriorityFeeEstimate", .params = .{.{ .transaction = encoded, .options = .{ .recommended = true, .transactionEncoding = "base58" } }} }, .{});
                defer a.free(body);
                var response = try h.transport.send(a, .{ .method = .POST, .url = h.url, .headers = &.{.{ .name = "content-type", .value = "application/json" }}, .body = body, .max_response_bytes = 64 * 1024 });
                defer response.deinit();
                if (response.status < 200 or response.status >= 300) return error.PriorityFeeHttpFailure;
                const parsed = try std.json.parseFromSlice(std.json.Value, a, response.bytes, .{ .duplicate_field_behavior = .@"error" });
                defer parsed.deinit();
                break :blk try decodeFee(parsed.value);
            },
        };
    }
};
pub fn decodeFee(value: std.json.Value) !u64 {
    const raw = try svm.field(try svm.field(value, "result"), "priorityFeeEstimate");
    const number: f64 = switch (raw) {
        .float => |f| f,
        .integer => |i| @floatFromInt(i),
        .number_string => |s| try std.fmt.parseFloat(f64, s),
        else => return error.InvalidPriorityFee,
    };
    if (!std.math.isFinite(number)) return error.InvalidPriorityFee;
    // Rust f64::round() as u64 is a saturating cast.
    const rounded = @round(number);
    if (rounded <= 0) return 0;
    if (rounded >= @as(f64, @floatFromInt(std.math.maxInt(u64)))) return std.math.maxInt(u64);
    return @intFromFloat(rounded);
}
pub const Estimate = struct { compute_units: u32, compute_unit_price_micro_lamports: u64 };
pub fn adjust(units: u64, raw_fee: u64, cap: ?u64, numerator: u64) !Estimate {
    if (units == 0 or units > std.math.maxInt(u32)) return error.InvalidSimulationUnits;
    const cu: u32 = @intCast(units);
    const fee = if (cap) |maximum| @min(raw_fee, maximum) else raw_fee;
    return .{ .compute_units = @min(max_compute_units, (cu *| 11) / 10), .compute_unit_price_micro_lamports = (fee *| numerator) / 100 };
}
fn fixedKey(comptime text: []const u8) Key {
    @setEvalBranchQuota(10000);
    var value: u256 = 0;
    for (text) |c| {
        const index = std.mem.indexOfScalar(u8, "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz", c).?;
        value = value * 58 + index;
    }
    var key: Key = undefined;
    std.mem.writeInt(u256, &key, value, .big);
    return key;
}
pub const compute_budget_program = fixedKey("ComputeBudget111111111111111111111111111111");
pub const jito_tip_account = fixedKey("DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh");
const slot_hashes = fixedKey("SysvarS1otHashes111111111111111111111111111");
const sysvar_owner = fixedKey("Sysvar1111111111111111111111111111111111111");
pub const BudgetInstructions = struct {
    limit_data: [5]u8,
    price_data: [12]u8,
    tip_accounts: [2]sol.AccountMeta,
    pub fn init(payer: Key, estimate: Estimate, submitter: Submitter) BudgetInstructions {
        var result: BudgetInstructions = .{ .limit_data = undefined, .price_data = .{0} ** 12, .tip_accounts = .{ .{ .key = payer, .is_signer = true, .is_writable = true }, .{ .key = jito_tip_account, .is_writable = true } } };
        result.limit_data[0] = 2;
        std.mem.writeInt(u32, result.limit_data[1..5], estimate.compute_units, .little);
        if (submitter == .rpc) {
            result.price_data[0] = 3;
            std.mem.writeInt(u64, result.price_data[1..9], estimate.compute_unit_price_micro_lamports, .little);
        } else {
            std.mem.writeInt(u32, result.price_data[0..4], 2, .little);
            const lamports = @max(1000, (@as(u64, estimate.compute_units) *| estimate.compute_unit_price_micro_lamports) / 1_000_000);
            std.mem.writeInt(u64, result.price_data[4..12], lamports, .little);
        }
        return result;
    }
    pub fn instructions(self: *const BudgetInstructions, submitter: Submitter, process: sol.Instruction) [3]sol.Instruction {
        return .{ .{ .program = compute_budget_program, .accounts = &.{}, .data = &self.limit_data }, if (submitter == .rpc) .{ .program = compute_budget_program, .accounts = &.{}, .data = self.price_data[0..9] } else .{ .program = .{0} ** 32, .accounts = &self.tip_accounts, .data = &self.price_data }, process };
    }
};
pub fn compile(payer: Key, hash: Key, process: sol.Instruction, tables: []const sol.LookupTable, estimate: Estimate, submitter: Submitter, out: []u8) !sol.Compiled {
    const budget = BudgetInstructions.init(payer, estimate, submitter);
    const instructions = budget.instructions(submitter, process);
    return if (tables.len == 0) sol.compileLegacy(payer, hash, &instructions, out) else sol.compileV0(payer, hash, &instructions, tables, out);
}
fn unsignedWire(compiled: sol.Compiled, out: []u8) ![]const u8 {
    var writer: sol.Writer = .{ .out = out };
    try writer.shortvec(compiled.signer_count);
    for (0..compiled.signer_count) |_| try writer.bytes(&(.{0} ** 64));
    try writer.bytes(compiled.bytes);
    if (writer.pos > sol.packet_limit) return error.TransactionTooLarge;
    return out[0..writer.pos];
}
pub const SimulationObserver = struct {
    context: *anyopaque,
    /// Borrowed for this synchronous callback only; retain decoded scalars,
    /// never the response's Value pointers. No signing or I/O in the callback.
    observe: *const fn (*anyopaque, std.json.Value) void,
};
pub const Input = struct {
    payer: Key,
    process: sol.Instruction,
    alt_addresses: []const Key = &.{},
    submitter: Submitter = .rpc,
    oracle: Oracle = .{ .constant = 0 },
    fee_cap: ?u64 = null,
    fee_numerator: u64 = 110,
    /// Helius and simulation use independent clients. Requires thread-safe
    /// allocators and oracle transport; at most one helper per bounded job.
    concurrent_estimate_reads: bool = false,
    simulation_observer: ?SimulationObserver = null,
};
const SimulationJob = struct {
    client: *svm.Client,
    wire: []const u8,
    result: anyerror!svm.Simulation = undefined,
    fn run(self: *@This()) void {
        self.result = self.client.simulate(self.wire, .replace_blockhash);
    }
};
pub const Prepared = struct {
    allocator: A,
    storage: [sol.packet_limit]u8,
    compiled: sol.Compiled,
    estimate: Estimate,
    blockhash: svm.Blockhash,
    pub fn deinit(self: *Prepared) void {
        const a = self.allocator;
        a.destroy(self);
    }
    /// Accept externally signed message signatures (for credential managers),
    /// verify every signer against this exact prepared message before returning.
    pub fn attach(self: *const Prepared, a: A, signatures: []const [64]u8) ![]u8 {
        if (signatures.len != self.compiled.signer_count) return error.InvalidSignerCount;
        var out: [sol.packet_limit]u8 = undefined;
        var writer: sol.Writer = .{ .out = &out };
        try writer.shortvec(signatures.len);
        for (signatures) |signature| try writer.bytes(&signature);
        try writer.bytes(self.compiled.bytes);
        _ = try validateSigned(out[0..writer.pos], self.compiled.bytes);
        return a.dupe(u8, out[0..writer.pos]);
    }
    pub fn feeQuote(self: *const Prepared, client: *svm.Client) !u64 {
        const saved = client.minimum_slot;
        defer client.minimum_slot = saved;
        client.minimum_slot = @max(saved orelse 0, self.blockhash.context_slot);
        return feeForMessage(client, self.compiled.bytes);
    }
    pub fn sign(self: *const Prepared, a: A, seeds: []const Key) ![]u8 {
        var out: [sol.packet_limit]u8 = undefined;
        const wire = try sol.signTransaction(self.compiled, seeds, &out);
        _ = try validateSigned(wire, self.compiled.bytes);
        return a.dupe(u8, wire);
    }
};
/// Fetches fresh ALT snapshots in configured order; validates owner, context and
/// live activation state. No cache can conceal a deactivated/extended table.
pub fn prepare(a: A, client: *svm.Client, input: Input) !*Prepared {
    if (client.commitment != .finalized) return error.FinalizedSvmClientRequired;
    if (input.alt_addresses.len > 32) return error.TooManyLookupTables;
    const saved_minimum = client.minimum_slot;
    defer client.minimum_slot = saved_minimum;
    const owned_tables = try a.alloc(accounts.AddressLookupTable, input.alt_addresses.len);
    defer a.free(owned_tables);
    const tables = try a.alloc(sol.LookupTable, input.alt_addresses.len);
    defer a.free(tables);
    for (input.alt_addresses, 0..) |key, i| {
        for (input.alt_addresses[0..i]) |previous| if (std.mem.eql(u8, &key, &previous)) return error.DuplicateLookupTable;
        var result = try client.account(key);
        defer result.deinit();
        const account = result.account orelse return error.LookupTableUnavailable;
        client.minimum_slot = @max(client.minimum_slot orelse 0, result.slot);
        if (account.executable) return error.InvalidLookupTable;
        owned_tables[i] = try accounts.AddressLookupTable.decode(key, account.owner, account.data);
        var recent: [512]u64 = undefined;
        var recent_count: usize = 0;
        if (owned_tables[i].deactivation_slot != std.math.maxInt(u64)) {
            var history = try client.account(slot_hashes);
            defer history.deinit();
            const state = history.account orelse return error.SlotHashesUnavailable;
            if (state.executable or !std.mem.eql(u8, &state.owner, &sysvar_owner) or state.data.len < 8) return error.InvalidSlotHashes;
            const count = std.mem.readInt(u64, state.data[0..8], .little);
            if (count > 512 or state.data.len != 8 + count * 40) return error.InvalidSlotHashes;
            recent_count = @intCast(count);
            for (0..recent_count) |j| recent[j] = std.mem.readInt(u64, state.data[8 + j * 40 ..][0..8], .little);
        }
        tables[i] = try owned_tables[i].active(result.slot, recent[0..recent_count]);
    }
    var sim_message: [sol.packet_limit]u8 = undefined;
    const candidate = try compile(input.payer, .{0} ** 32, input.process, tables, .{ .compute_units = max_compute_units, .compute_unit_price_micro_lamports = 0 }, input.submitter, &sim_message);
    var sim_wire: [sol.packet_limit]u8 = undefined;
    const unsigned = try unsignedWire(candidate, &sim_wire);
    // Complete both independent reads even when simulation fails; simulation
    // errors retain priority, matching the production Rust join semantics.
    var simulation: anyerror!svm.Simulation = undefined;
    var fee_result: anyerror!u64 = undefined;
    if (input.concurrent_estimate_reads and input.oracle == .helius) {
        var job: SimulationJob = .{ .client = client, .wire = unsigned };
        const helper = try std.Thread.spawn(.{}, SimulationJob.run, .{&job});
        fee_result = input.oracle.fee(a, unsigned);
        helper.join();
        simulation = job.result;
    } else {
        simulation = client.simulate(unsigned, .replace_blockhash);
        fee_result = input.oracle.fee(a, unsigned);
    }
    var simulated = try simulation;
    defer simulated.deinit();
    if (input.simulation_observer) |observer| observer.observe(observer.context, simulated.response.value());
    if (!try simulated.succeeded()) return error.SvmSimulationFailed;
    const units = simulated.units_consumed orelse return error.InvalidSimulationUnits;
    if (units == 0 or units > std.math.maxInt(u32)) return error.InvalidSimulationUnits;
    const estimate = try adjust(units, try fee_result, input.fee_cap, input.fee_numerator);
    client.minimum_slot = @max(client.minimum_slot orelse 0, simulated.slot);
    const blockhash = try client.latestBlockhash();
    const result = try a.create(Prepared);
    errdefer a.destroy(result);
    result.allocator = a;
    result.estimate = estimate;
    result.blockhash = blockhash;
    result.compiled = try compile(input.payer, blockhash.hash, input.process, tables, estimate, input.submitter, &result.storage);
    // The compiled message must still leave packet space for every signature.
    _ = try unsignedWire(result.compiled, &sim_wire);
    return result;
}
pub const Identity = struct { signature: [64]u8, payer: Key, message: []const u8, blockhash: Key };
fn take(bytes: []const u8, pos: *usize, len: usize) ![]const u8 {
    if (pos.* > bytes.len or len > bytes.len - pos.*) return error.TruncatedSvmTransaction;
    const result = bytes[pos.*..][0..len];
    pos.* += len;
    return result;
}
/// Verify canonical legacy/v0 structure, every signature, exact expected message
/// when supplied, and all account indices. Returns borrowed message bytes.
pub fn validateSigned(wire: []const u8, expected_message: ?[]const u8) !Identity {
    if (wire.len > sol.packet_limit or wire.len == 0) return error.InvalidSvmTransactionSize;
    var pos: usize = 0;
    const count = try sol.readShortvec(wire, &pos);
    if (count == 0 or count > 127) return error.InvalidSignerCount;
    const signatures = try take(wire, &pos, @as(usize, count) * 64);
    const message = wire[pos..];
    if (expected_message) |expected| if (!std.mem.eql(u8, message, expected)) return error.SvmSignedMessageMismatch;
    pos = 0;
    const first = (try take(message, &pos, 1))[0];
    const versioned = first & 128 != 0;
    const required = if (versioned) blk: {
        if (first != 128) return error.UnsupportedSvmMessageVersion;
        break :blk (try take(message, &pos, 1))[0];
    } else first;
    const readonly = try take(message, &pos, 2);
    if (required != count or readonly[0] >= required) return error.InvalidSvmMessageHeader;
    const key_count = try sol.readShortvec(message, &pos);
    if (key_count < required or key_count > 256 or readonly[1] > key_count - required) return error.InvalidSvmMessageHeader;
    const keys = try take(message, &pos, @as(usize, key_count) * 32);
    for (0..key_count) |i| for (0..i) |j| if (std.mem.eql(u8, keys[i * 32 ..][0..32], keys[j * 32 ..][0..32])) return error.DuplicateSvmAccount;
    const hash = (try take(message, &pos, 32))[0..32].*;
    const instruction_count = try sol.readShortvec(message, &pos);
    var largest_index: usize = 0;
    for (0..instruction_count) |_| {
        const program = (try take(message, &pos, 1))[0];
        if (program == 0 or program >= key_count) return error.InvalidSvmProgramIndex;
        const n = try sol.readShortvec(message, &pos);
        const indices = try take(message, &pos, n);
        for (indices) |index| largest_index = @max(largest_index, index);
        const data_len = try sol.readShortvec(message, &pos);
        _ = try take(message, &pos, data_len);
    }
    var loaded: usize = 0;
    if (versioned) {
        const lookups = try sol.readShortvec(message, &pos);
        if (lookups > 32) return error.TooManyLookupTables;
        for (0..lookups) |_| {
            _ = try take(message, &pos, 32);
            const writable = try sol.readShortvec(message, &pos);
            _ = try take(message, &pos, writable);
            const read = try sol.readShortvec(message, &pos);
            _ = try take(message, &pos, read);
            loaded += writable + read;
        }
    }
    if (pos != message.len or key_count + loaded > 256 or (instruction_count != 0 and largest_index >= key_count + loaded)) return error.InvalidSvmAccountIndex;
    for (0..count) |i| {
        const public = try Ed.PublicKey.fromBytes(keys[i * 32 ..][0..32].*);
        const signature = Ed.Signature.fromBytes(signatures[i * 64 ..][0..64].*);
        try signature.verify(message, public);
    }
    return .{ .signature = signatures[0..64].*, .payer = keys[0..32].*, .message = message, .blockhash = hash };
}
/// Submit exactly once through the configured RPC/Jito client. A returned ID
/// differing from the persisted native signature is never accepted as success.
pub fn submit(client: *svm.Client, wire: []const u8, skip_preflight: bool) ![64]u8 {
    const identity = try validateSigned(wire, null);
    const a = client.rpc_client.allocator;
    const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(wire.len));
    defer a.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, wire);
    var response = try client.call("sendTransaction", .{ encoded, .{ .encoding = "base64", .skipPreflight = skip_preflight } });
    defer response.deinit();
    const id = try b58.decode(a, try svm.string(response.value()));
    defer a.free(id);
    if (id.len != 64 or !std.mem.eql(u8, id, &identity.signature)) return error.SvmSubmissionIdentityMismatch;
    return identity.signature;
}
/// Real chain fee quote for a prepared message, including base/signature and
/// prioritization fees known to the current bank. No fixed5000-lamport guess.
pub fn feeForMessage(client: *svm.Client, message: []const u8) !u64 {
    if (client.commitment != .finalized) return error.FinalizedSvmClientRequired;
    if (message.len == 0 or message.len > sol.packet_limit) return error.InvalidCompiledMessage;
    const a = client.rpc_client.allocator;
    const text = try a.alloc(u8, std.base64.standard.Encoder.calcSize(message.len));
    defer a.free(text);
    _ = std.base64.standard.Encoder.encode(text, message);
    var response = try client.call("getFeeForMessage", .{ text, .{ .commitment = "finalized", .minContextSlot = client.minimum_slot } });
    defer response.deinit();
    const value = response.value();
    const slot = try svm.uint(try svm.field(try svm.field(value, "context"), "slot"));
    if (client.minimum_slot) |min| if (slot < min) return error.StaleSvmContext;
    const fee = try svm.field(value, "value");
    if (fee == .null) return error.SvmFeeQuoteUnavailable;
    return svm.uint(fee);
}

pub const Receipt = struct { slot: u64, block_hash: Key, parent_hash: Key, failed: bool, units_consumed: ?u64, fee_lamports: u64 };
fn block(client: *svm.Client, slot: u64, signature: []const u8) !struct { hash: Key, parent: Key } {
    var response = try client.call("getBlock", .{ slot, .{ .encoding = "json", .transactionDetails = "signatures", .rewards = false, .commitment = "finalized", .maxSupportedTransactionVersion = 0 } });
    defer response.deinit();
    const signatures = try svm.field(response.value(), "signatures");
    if (signatures != .array) return error.InvalidSvmResponse;
    const found = for (signatures.array.items) |entry| {
        if (std.mem.eql(u8, signature, try svm.string(entry))) break true;
    } else false;
    if (!found) return error.SvmReceiptNotInCanonicalBlock;
    return .{ .hash = try svm.decodeKey(client.rpc_client.allocator, try svm.string(try svm.field(response.value(), "blockhash"))), .parent = try svm.decodeKey(client.rpc_client.allocator, try svm.string(try svm.field(response.value(), "previousBlockhash"))) };
}
pub fn finalizedReceipt(client: *svm.Client, signature: [64]u8) !?Receipt {
    if (client.commitment != .finalized) return error.FinalizedSvmClientRequired;
    const a = client.rpc_client.allocator;
    const encoded = try b58.encode(a, &signature);
    defer a.free(encoded);
    var response = try client.transaction(encoded);
    defer response.deinit();
    if (response.value() == .null) return null;
    const value = response.value();
    const slot = try svm.uint(try svm.field(value, "slot"));
    const transaction = try svm.field(value, "transaction");
    const signatures = try svm.field(transaction, "signatures");
    if (signatures != .array or signatures.array.items.len == 0 or !std.mem.eql(u8, encoded, try svm.string(signatures.array.items[0]))) return error.SvmReceiptIdentityMismatch;
    const meta = try svm.field(value, "meta");
    const units = if (meta == .object) meta.object.get("computeUnitsConsumed") else null;
    const header = try block(client, slot, encoded);
    var statuses = try client.signatureStatuses(&.{encoded});
    defer statuses.deinit();
    const status = statuses.values[0] orelse return error.SvmReceiptStatusUnavailable;
    const failed = (try svm.field(meta, "err")) != .null;
    if (statuses.context_slot < slot or status.confirmation != .finalized or status.slot != slot or status.failed != failed) return error.SvmReceiptIdentityMismatch;
    const checked = try block(client, slot, encoded);
    if (!std.mem.eql(u8, &header.hash, &checked.hash)) return error.SvmReceiptCanonicalityChanged;
    return .{ .slot = slot, .block_hash = header.hash, .parent_hash = header.parent, .failed = failed, .units_consumed = if (units) |u| if (u == .null) null else try svm.uint(u) else null, .fee_lamports = try svm.uint(try svm.field(meta, "fee")) };
}

test "SVM budget bytes, saturating costs and signed native identity" {
    const estimate = try adjust(100_000, 400, 300, 110);
    try std.testing.expectEqual(@as(u32, 110_000), estimate.compute_units);
    try std.testing.expectEqual(@as(u64, 330), estimate.compute_unit_price_micro_lamports);
    try std.testing.expectEqual(@as(u32, max_compute_units), (try adjust(std.math.maxInt(u32), 0, null, 110)).compute_units);
    try std.testing.expectError(error.InvalidSimulationUnits, adjust(0, 0, null, 110));
    const seed: Key = .{7} ** 32;
    const pair = try Ed.KeyPair.generateDeterministic(seed);
    const payer = pair.public_key.toBytes();
    const process: sol.Instruction = .{ .program = .{9} ** 32, .accounts = &.{.{ .key = payer, .is_signer = true, .is_writable = true }}, .data = "test" };
    var bytes: [1232]u8 = undefined;
    const compiled = try compile(payer, .{8} ** 32, process, &.{}, estimate, .rpc, &bytes);
    var output: [1232]u8 = undefined;
    const signed = try sol.signTransaction(compiled, &.{seed}, &output);
    const identity = try validateSigned(signed, compiled.bytes);
    try std.testing.expectEqual(payer, identity.payer);
    try std.testing.expectEqual([_]u8{8} ** 32, identity.blockhash);
    for (0..signed.len) |len| try std.testing.expectError(if (len == 0) error.InvalidSvmTransactionSize else if (len < 65) error.TruncatedSvmTransaction else error.SvmSignedMessageMismatch, validateSigned(signed[0..len], compiled.bytes));
    signed[1] ^= 1;
    if (validateSigned(signed, compiled.bytes)) |_| return error.ExpectedInvalidSignature else |_| {}
    signed[1] ^= 1;
    const jito = BudgetInstructions.init(payer, estimate, .jito);
    try std.testing.expectEqual(@as(u64, 1000), std.mem.readInt(u64, jito.price_data[4..12], .little));
    try std.testing.expectEqual(jito_tip_account, jito.tip_accounts[1].key);
}
