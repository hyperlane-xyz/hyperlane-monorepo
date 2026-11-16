//! Differential oracle: the pre-scanner JSON-RPC parsers, copied verbatim,
//! against the one-pass envelope facts on a corpus of real response shapes
//! plus seeded mutations (truncation, byte flips, duplicate keys, escaped
//! member names, id spellings, deep nesting, multi-fault documents).
const std = @import("std");
const env = @import("json_envelope.zig");
const read_replay = @import("read_replay.zig");
const json_bounds = @import("json_bounds.zig");
const provider = @import("../evm/provider.zig");
const A = std.mem.Allocator;
const fixture_hash_0 = "0x" ++ "769f" ** 16;
const fixture_hash_1 = "0x" ++ "0000" ** 16;
const fixture_hash_2 = "0x" ++ "0000" ** 16;
const fixture_hash_3 = "0x" ++ "b1d5" ** 16;
const fixture_hash_4 = "0x" ++ "2f1e" ** 16;
const fixture_hash_5 = "0x" ++ "0000" ** 16;
const fixture_hash_6 = "0x" ++ "1f1e" ** 16;
const fixture_hash_7 = "0x" ++ "08c3" ** 16;
const Value = std.json.Value;

// ---- legacy oracles (verbatim logic, pre-change) ----

pub const LegacyRequest = struct {
    parsed: std.json.Parsed(Value),
    owned: []u8,
    method: []const u8,
    id: i64,
    params: Value,
    pub fn deinit(self: *LegacyRequest, a: A) void {
        self.parsed.deinit();
        a.free(self.owned);
    }
};
pub fn legacyRequestParse(allocator: A, body: []const u8, max_bytes: usize) !LegacyRequest {
    if (body.len == 0 or body.len > max_bytes) return error.InvalidRpcRequest;
    try json_bounds.validate(body);
    const owned = try allocator.dupe(u8, body);
    errdefer allocator.free(owned);
    var parsed = try std.json.parseFromSlice(Value, allocator, owned, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = max_bytes });
    errdefer parsed.deinit();
    if (parsed.value != .object) return error.InvalidRpcRequest;
    const object = parsed.value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcRequest;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return error.InvalidRpcRequest;
    const id_value = object.get("id") orelse return error.InvalidRpcRequest;
    if (id_value != .number_string) return error.InvalidRpcRequest;
    const id = std.fmt.parseInt(i64, id_value.number_string, 10) catch return error.InvalidRpcRequest;
    const method = object.get("method") orelse return error.InvalidRpcRequest;
    if (method != .string or method.string.len == 0) return error.InvalidRpcRequest;
    const params = object.get("params") orelse Value{ .array = std.json.Array.init(allocator) };
    return .{ .owned = owned, .parsed = parsed, .method = method.string, .id = id, .params = params };
}

pub const LegacyResponse = struct {
    parsed: std.json.Parsed(Value),
    result: ?Value,
    rpc_error: ?Value,
};
pub fn legacyParseOwned(allocator: A, bytes: []const u8, expected_id: i64, max_bytes: usize) !LegacyResponse {
    if (bytes.len > max_bytes) return error.ResponseTooLarge;
    try json_bounds.validate(bytes);
    var parsed = try std.json.parseFromSlice(Value, allocator, bytes, .{ .allocate = .alloc_always, .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = max_bytes });
    errdefer parsed.deinit();
    if (parsed.value != .object) return error.InvalidRpcEnvelope;
    const object = parsed.value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0")) return error.InvalidRpcEnvelope;
    const id = object.get("id") orelse return error.InvalidRpcEnvelope;
    if (id != .number_string) return error.RpcIdMismatch;
    const actual_id = std.fmt.parseInt(i64, id.number_string, 10) catch return error.RpcIdMismatch;
    if (actual_id != expected_id) return error.RpcIdMismatch;
    const has_result = object.contains("result");
    const has_error = object.contains("error");
    if (has_result == has_error) return error.InvalidRpcEnvelope;
    if (has_error) {
        const rpc_error = object.get("error").?;
        if (rpc_error != .object) return error.InvalidRpcEnvelope;
        const code = rpc_error.object.get("code") orelse return error.InvalidRpcEnvelope;
        const message = rpc_error.object.get("message") orelse return error.InvalidRpcEnvelope;
        if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
        _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
    }
    return .{ .parsed = parsed, .result = if (has_result) object.get("result").? else null, .rpc_error = if (has_error) object.get("error").? else null };
}

pub fn legacyRequireReadOnly(a: A, body: []const u8, maximum: usize) !i64 {
    if (body.len == 0 or body.len > maximum) return error.ReadReplayRequestTooLarge;
    var parsed = try std.json.parseFromSlice(Value, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false, .max_value_len = maximum });
    defer parsed.deinit();
    if (parsed.value != .object) return error.InvalidRpcRequest;
    const object = parsed.value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcRequest;
    const method = object.get("method") orelse return error.InvalidRpcRequest;
    const id = object.get("id") orelse return error.InvalidRpcRequest;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0") or method != .string or id != .number_string) return error.InvalidRpcRequest;
    if (!read_replay.readOnly(method.string)) return error.NonReadOnlyReplayRequest;
    return std.fmt.parseInt(i64, id.number_string, 10) catch return error.InvalidRpcRequest;
}

fn legacyValidateResponse(a: A, body: []const u8, expected_id: i64) !void {
    try json_bounds.validate(body);
    const parsed = try std.json.parseFromSlice(Value, a, body, .{ .duplicate_field_behavior = .@"error", .parse_numbers = false });
    defer parsed.deinit();
    const value = parsed.value;
    if (value != .object) return error.InvalidRpcEnvelope;
    const object = value.object;
    const version = object.get("jsonrpc") orelse return error.InvalidRpcEnvelope;
    const id = object.get("id") orelse return error.InvalidRpcEnvelope;
    if (version != .string or !std.mem.eql(u8, version.string, "2.0") or id != .number_string) return error.InvalidRpcEnvelope;
    if ((std.fmt.parseInt(i64, id.number_string, 10) catch return error.RpcIdMismatch) != expected_id) return error.RpcIdMismatch;
    if (object.contains("result") == object.contains("error")) return error.InvalidRpcEnvelope;
    if (object.get("error")) |rpc_error| {
        if (rpc_error != .object) return error.InvalidRpcEnvelope;
        const code = rpc_error.object.get("code") orelse return error.InvalidRpcEnvelope;
        const message = rpc_error.object.get("message") orelse return error.InvalidRpcEnvelope;
        if (code != .number_string or message != .string) return error.InvalidRpcEnvelope;
        _ = std.fmt.parseInt(i64, code.number_string, 10) catch return error.InvalidRpcEnvelope;
    }
}

// ---- exact tree equality (tags, spellings, floats bitwise, member order) ----

pub fn deepEqual(left: Value, right: Value) bool {
    if (std.meta.activeTag(left) != std.meta.activeTag(right)) return false;
    return switch (left) {
        .null => true,
        .bool => |v| v == right.bool,
        .integer => |v| v == right.integer,
        .float => |v| @as(u64, @bitCast(v)) == @as(u64, @bitCast(right.float)),
        .number_string => |v| std.mem.eql(u8, v, right.number_string),
        .string => |v| std.mem.eql(u8, v, right.string),
        .array => |v| blk: {
            if (v.items.len != right.array.items.len) break :blk false;
            for (v.items, right.array.items) |x, y| if (!deepEqual(x, y)) break :blk false;
            break :blk true;
        },
        .object => |v| blk: {
            if (v.count() != right.object.count()) break :blk false;
            for (v.keys(), v.values(), right.object.keys(), right.object.values()) |lk, lv, rk, rv| {
                if (!std.mem.eql(u8, lk, rk) or !deepEqual(lv, rv)) break :blk false;
            }
            break :blk true;
        },
    };
}

// ---- comparison drivers ----

const response_limit = 1 << 20;

fn checkResponse(a: A, bytes: []const u8, id: i64) !void {
    // Pool dialect.
    const old = legacyParseOwned(a, bytes, id, response_limit);
    const new = env.validateResponse(a, bytes, id, .pool);
    if (old) |legacy| {
        var l = legacy;
        defer l.parsed.deinit();
        var fresh = new catch |err| {
            std.debug.print("pool: legacy ok, new {s} for {s}\n", .{ @errorName(err), bytes });
            return error.DifferentialMismatch;
        };
        defer fresh.deinit();
        try std.testing.expectEqual(l.result != null, fresh.result != null);
        if (fresh.result) |span| {
            const tree = try env.parseValue(a, span.of(bytes), false);
            defer tree.deinit();
            try std.testing.expect(deepEqual(l.result.?, tree.value));
            try checkAdopted(a, bytes, id, span);
        } else try std.testing.expect(deepEqual(l.rpc_error.?, fresh.rpc_error.?.value));
    } else |old_err| {
        if (new) |fresh| {
            var f = fresh;
            f.deinit();
            std.debug.print("pool: legacy {s}, new ok for {s}\n", .{ @errorName(old_err), bytes });
            return error.DifferentialMismatch;
        } else |new_err| if (old_err != new_err) {
            std.debug.print("pool: legacy {s}, new {s} for {s}\n", .{ @errorName(old_err), @errorName(new_err), bytes });
            return error.DifferentialMismatch;
        }
    }
    // Replay dialect.
    const replay_old = legacyValidateResponse(a, bytes, id);
    const replay_new = read_replay.validateResponse(a, bytes, id);
    try expectSameVoid(replay_old, replay_new, bytes);
    // Full-document tree builder against std.json, both number modes.
    inline for (.{ false, true }) |numbers| {
        const std_tree = std.json.parseFromSlice(Value, a, bytes, .{ .duplicate_field_behavior = .@"error", .parse_numbers = numbers });
        const new_tree = env.parseValue(a, bytes, numbers);
        if (std_tree) |s| {
            defer s.deinit();
            const n = new_tree catch |err| {
                std.debug.print("tree: std ok, new {s} for {s}\n", .{ @errorName(err), bytes });
                return error.DifferentialMismatch;
            };
            defer n.deinit();
            try std.testing.expect(deepEqual(s.value, n.value));
        } else |s_err| {
            if (new_tree) |n| {
                n.deinit();
                std.debug.print("tree: std {s}, new ok for {s}\n", .{ @errorName(s_err), bytes });
                return error.DifferentialMismatch;
            } else |n_err| if (s_err != n_err) {
                std.debug.print("tree: std {s}, new {s} for {s}\n", .{ @errorName(s_err), @errorName(n_err), bytes });
                return error.DifferentialMismatch;
            }
        }
    }
}

/// The caller's adoption of a pool-validated span against the legacy caller
/// decode (whole document, default number parsing, provider.validateEnvelope):
/// an adopted tree is the legacy result exactly; a refusal happens only where
/// the legacy caller rejects too (the whole-body fallback then yields its error).
fn checkAdopted(a: A, bytes: []const u8, id: i64, span: env.Span) !void {
    const legacy = try std.json.parseFromSlice(Value, a, bytes, .{ .duplicate_field_behavior = .@"error" });
    defer legacy.deinit();
    const code = provider.validateEnvelope(legacy.value, id);
    if (try provider.adoptValidated(a, bytes, id, span)) |tree| {
        defer tree.deinit();
        try std.testing.expectEqual(@as(?i64, null), try code);
        try std.testing.expect(deepEqual(legacy.value.object.get("result").?, tree.value.object.get("result").?));
        try std.testing.expect(deepEqual(legacy.value.object.get("id").?, tree.value.object.get("id").?));
        adopted_count += 1;
    } else {
        if (code) |_| {
            std.debug.print("adopt refused a legacy-valid envelope: {s}\n", .{bytes});
            return error.DifferentialMismatch;
        } else |_| {}
    }
}
var adopted_count: usize = 0;

fn expectSameVoid(old: anyerror!void, new: anyerror!void, bytes: []const u8) !void {
    if (old) |_| {
        new catch |err| {
            std.debug.print("legacy ok, new {s} for {s}\n", .{ @errorName(err), bytes });
            return error.DifferentialMismatch;
        };
    } else |old_err| {
        if (new) |_| {
            std.debug.print("legacy {s}, new ok for {s}\n", .{ @errorName(old_err), bytes });
            return error.DifferentialMismatch;
        } else |new_err| if (old_err != new_err) {
            std.debug.print("legacy {s}, new {s} for {s}\n", .{ @errorName(old_err), @errorName(new_err), bytes });
            return error.DifferentialMismatch;
        }
    }
}

fn checkRequest(a: A, body: []const u8) !void {
    const old = legacyRequireReadOnly(a, body, 4096);
    const new = read_replay.requireReadOnly(a, body, 4096);
    if (old) |id| {
        const fresh = new catch |err| {
            std.debug.print("request: legacy ok, new {s} for {s}\n", .{ @errorName(err), body });
            return error.DifferentialMismatch;
        };
        try std.testing.expectEqual(id, fresh);
    } else |old_err| {
        if (new) |_| {
            std.debug.print("request: legacy {s}, new ok for {s}\n", .{ @errorName(old_err), body });
            return error.DifferentialMismatch;
        } else |new_err| if (old_err != new_err) {
            std.debug.print("request: legacy {s}, new {s} for {s}\n", .{ @errorName(old_err), @errorName(new_err), body });
            return error.DifferentialMismatch;
        }
    }
    // Pool request dialect: facts + method/id/params against the legacy parse.
    const legacy = legacyRequestParse(a, body, 4096);
    const facts = poolRequest(a, body, 4096);
    if (legacy) |value| {
        var l = value;
        defer l.deinit(a);
        var f = facts catch |err| {
            std.debug.print("pool request: legacy ok, new {s} for {s}\n", .{ @errorName(err), body });
            return error.DifferentialMismatch;
        };
        defer f.deinit(a);
        try std.testing.expectEqualStrings(l.method, f.method);
        try std.testing.expectEqual(l.id, f.id);
        try std.testing.expect(deepEqual(l.params, f.params.value));
    } else |old_err| {
        if (facts) |value| {
            var f = value;
            f.deinit(a);
            std.debug.print("pool request: legacy {s}, new ok for {s}\n", .{ @errorName(old_err), body });
            return error.DifferentialMismatch;
        } else |new_err| if (old_err != new_err) {
            std.debug.print("pool request: legacy {s}, new {s} for {s}\n", .{ @errorName(old_err), @errorName(new_err), body });
            return error.DifferentialMismatch;
        }
    }
}

/// Mirrors evm/pool.zig Request.parse on the scan facts (params always parsed here).
const PoolRequest = struct {
    method: []const u8,
    method_owned: bool,
    id: i64,
    params: std.json.Parsed(Value),
    fn deinit(self: *PoolRequest, a: A) void {
        if (self.method_owned) a.free(self.method);
        self.params.deinit();
    }
};
fn poolRequest(a: A, body: []const u8, maximum: usize) !PoolRequest {
    if (body.len == 0 or body.len > maximum) return error.InvalidRpcRequest;
    const top = try env.scan(a, body, env.pool_options);
    const facts = try env.requestFacts(&top, body);
    const id = std.fmt.parseInt(i64, facts.id.of(body), 10) catch return error.InvalidRpcRequest;
    const method = try env.stringAlloc(a, body, facts.method);
    errdefer if (method.owned) a.free(method.text);
    if (method.text.len == 0) return error.InvalidRpcRequest;
    const params = try env.parseValue(a, if (facts.params) |span| span.of(body) else "[]", false);
    return .{ .method = method.text, .method_owned = method.owned, .id = id, .params = params };
}

// ---- corpus ----

const log_entry = "{\"address\":\"0x3a464f746d23ab22155710f44db16dca53e0775e\",\"topics\":[\"" ++ fixture_hash_0 ++ "\",\"" ++ fixture_hash_1 ++ "\"],\"data\":\"" ++ fixture_hash_2 ++ "00000000000000000000000000000000000000000000000000000000000000770300000001000000010000000000000000000000002e234dae75c793f67a35089c9d99245e1c58470b0000a4b1000000000000000000000000ab5b2df4e1e7b2cc1d0ed3e7ae9df0e8c8d4e1c2\",\"blockNumber\":\"0x12a05f2\",\"transactionHash\":\"" ++ fixture_hash_3 ++ "\",\"transactionIndex\":\"0x3\",\"blockHash\":\"" ++ fixture_hash_4 ++ "\",\"logIndex\":\"0x1a\",\"removed\":false}";
const corpus = [_][]const u8{
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"0x12a05f2\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":[" ++ log_entry ++ "," ++ log_entry ++ "]}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":[]}",
    "{\"id\":7,\"result\":\"" ++ fixture_hash_5 ++ "\",\"jsonrpc\":\"2.0\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"number\":\"0x12a05f2\",\"hash\":\"" ++ fixture_hash_4 ++ "\",\"parentHash\":\"" ++ fixture_hash_6 ++ "\",\"timestamp\":\"0x6553f100\",\"gasLimit\":\"0x1c9c380\",\"baseFeePerGas\":\"0x7\",\"transactions\":[\"" ++ fixture_hash_3 ++ "\"],\"uncles\":[],\"size\":\"0x220\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"status\":\"0x1\",\"logs\":[" ++ log_entry ++ "],\"gasUsed\":\"0x5208\",\"effectiveGasPrice\":\"0x3b9aca00\",\"contractAddress\":null}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":3,\"message\":\"execution reverted: ICA: Invalid Reveal\",\"data\":\"" ++ fixture_hash_7 ++ "00000020\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":-32005,\"message\":\"rate limit exceeded\",\"data\":{\"see\":\"https://x\"}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":-32000,\"message\":\"header not found\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"context\":{\"slot\":245000000,\"apiVersion\":\"1.18.0\"},\"value\":{\"lamports\":18446744073709551615,\"data\":[\"AAEC\",\"base64\"],\"owner\":\"11111111111111111111111111111111\",\"executable\":false,\"rentEpoch\":18446744073709551616,\"space\":0}}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"x\":1.5,\"y\":-0,\"z\":1e400,\"w\":1E-7,\"v\":-9223372036854775808,\"u\":9223372036854775808}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"esc \\\"q\\\" \\u00e9 \\ud83d\\ude00 \\n\\t\\/\"}",
    " \n{ \"jsonrpc\" : \"2.0\" , \"id\" : 7 , \"result\" : [ 1 , 2 , { \"a\" : [ ] } ] } \n",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"height\":\"12345\",\"txs\":[]},\"extra\":{\"k\":[1,{\"k\":2}]}}",
    // envelope faults
    "{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":\"7\",\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":7.0,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":7e0,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":-0,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":9223372036854775808,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":null,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"result\":1}",
    "{\"jsonrpc\":\"1.0\",\"id\":7,\"result\":1}",
    "{\"jsonrpc\":2.0,\"id\":7,\"result\":1}",
    "{\"id\":7,\"result\":1}",
    "{\"jsonrpc\":\"2\\u002e0\",\"\\u0069d\":7,\"res\\u0075lt\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":7}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1,\"error\":{\"code\":1,\"message\":\"m\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1,\"error\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":null}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":\"3\",\"message\":\"m\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":3.5,\"message\":\"m\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":3,\"message\":7}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"message\":\"m\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":99999999999999999999,\"message\":\"m\"}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":[1]}",
    "[{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1}]",
    "\"text\"",
    "7",
    "",
    "   ",
    // duplicates at every depth and multi-fault documents
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"id\":7,\"result\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"a\":1,\"a\":2}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"a\":1,\"\\u0061\":2}}",
    "{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":[{\"a\":1},{\"a\":1,\"b\":{\"c\":1,\"c\":2}}]}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"a\":1,\"a\":[1,}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"a\":1,\"a\":2},\"x\":[}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"x\":{\"k\":1,\"k\":2},\"result\":1",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"k0\":0,\"k1\":1,\"k2\":2,\"k3\":3,\"k4\":4,\"k5\":5,\"k6\":6,\"k7\":7,\"k8\":8,\"k9\":9,\"k10\":10,\"k11\":11,\"k12\":12,\"k13\":13,\"k14\":14,\"k15\":15,\"k16\":16,\"k17\":17,\"k3\":18}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"k0\":0,\"k1\":1,\"k2\":2,\"k3\":3,\"k4\":4,\"k5\":5,\"k6\":6,\"k7\":7,\"k8\":8,\"k9\":9,\"k10\":10,\"k11\":11,\"k12\":12,\"k13\":13,\"k14\":14,\"k15\":15,\"k16\":16,\"k17\":17,\"k18\":18}}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":1}x",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":01}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"\\x\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"\\ud800\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":\"\xff\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":tru}",
};

pub const request_corpus = [_][]const u8{
    "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"eth_call\",\"params\":[{\"to\":\"0x1\",\"n\":9007199254740993}]}",
    "{\"jsonrpc\":\"2.0\",\"method\":\"getBalance\",\"params\":[],\"id\":1}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[]}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"sendTransaction\",\"params\":[]}",
    "{\"jsonrpc\":\"1.0\",\"id\":1,\"method\":\"eth_call\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"eth_call\"}",
    "[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\"}]",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_blockNumber\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"\",\"params\":[]}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth\\u005fcall\",\"params\":[]}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_sendRawTransaction\",\"params\":[],\"id\":2}",
    "{\"jsonrpc\":\"2.0\",\"id\":1e400,\"method\":\"eth_sendRawTransaction\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":1e400,\"method\":\"eth_call\"}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":7}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBlockByNumber\",\"params\":[\"latest\",false]}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tx\",\"params\":{\"hash\":\"q83vEjRWeJCrze8SNFZ4kKvN7xI0VniQq83vEjRWeJA=\",\"prove\":false}}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"a\":1,\"a\":2}]}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[{\"a\":1,\"a\":[}",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[",
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_call\",\"params\":[]} ",
    "",
};

test "envelope facts match the legacy parsers on the corpus" {
    const a = std.testing.allocator;
    for (corpus) |bytes| {
        try checkResponse(a, bytes, 7);
        try checkRequest(a, bytes);
    }
    for (request_corpus) |body| {
        try checkRequest(a, body);
        try checkResponse(a, body, 1);
    }
}

test "envelope facts match the legacy parsers on objects past the linear key bound" {
    const a = std.testing.allocator;
    var list: std.ArrayList(u8) = .empty;
    defer list.deinit(a);
    for ([_]usize{ 31, 32, 33, 80 }) |count| for ([_]?usize{ null, 0, count / 2, count - 1 }) |duplicate| {
        list.clearRetainingCapacity();
        try list.appendSlice(a, "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":[{\"inner\":1},{");
        for (0..count) |index| try list.print(a, "\"k{d}\":{d},", .{ index, index });
        if (duplicate) |index| try list.print(a, "\"\\u006b{d}\":0,", .{index});
        try list.appendSlice(a, "\"z\":[{\"k1\":1}]}]}");
        try checkResponse(a, list.items, 7);
    };
}

test "envelope facts match the legacy parsers at the depth bound" {
    const a = std.testing.allocator;
    for ([_]usize{ 126, 127, 128, 129, 300, 3000 }) |depth| {
        var list: std.ArrayList(u8) = .empty;
        defer list.deinit(a);
        try list.appendSlice(a, "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":");
        try list.appendNTimes(a, '[', depth);
        try list.appendNTimes(a, ']', depth);
        try list.append(a, '}');
        try checkResponse(a, list.items, 7);
        // A trailing syntax error after the depth breach: depth wins in the pool.
        list.items[list.items.len - 1] = ',';
        try checkResponse(a, list.items, 7);
        try checkRequest(a, list.items);
    }
}

pub fn mutate(random: std.Random, source: []const u8, out: *std.ArrayList(u8), a: A) !void {
    out.clearRetainingCapacity();
    try out.appendSlice(a, source);
    const fragments = [_][]const u8{ "\"id\":7,", "\"a\":1,", "\"result\":", "\"error\":", "{", "}", "[", "]", ",", ":", "\"", "\\", "\\u0069", "1e9", "-0", "null", " ", "\"jsonrpc\":\"2.0\",", "\"\\u0061\":1," };
    const rounds = 1 + random.uintLessThan(usize, 3);
    for (0..rounds) |_| {
        if (out.items.len == 0) break;
        switch (random.uintLessThan(u8, 5)) {
            0 => out.shrinkRetainingCapacity(random.uintLessThan(usize, out.items.len)),
            1 => out.items[random.uintLessThan(usize, out.items.len)] = random.int(u8),
            2 => {
                const fragment = fragments[random.uintLessThan(usize, fragments.len)];
                try out.insertSlice(a, random.uintLessThan(usize, out.items.len + 1), fragment);
            },
            3 => _ = out.orderedRemove(random.uintLessThan(usize, out.items.len)),
            else => {
                // Duplicate an existing key/value pair right after itself.
                const at = std.mem.indexOfScalarPos(u8, out.items, random.uintLessThan(usize, out.items.len), '"') orelse continue;
                const colon = std.mem.indexOfScalarPos(u8, out.items, at, ':') orelse continue;
                const comma = std.mem.indexOfAnyPos(u8, out.items, colon, ",}") orelse continue;
                const pair = try a.dupe(u8, out.items[at..comma]);
                defer a.free(pair);
                try out.insertSlice(a, comma, pair);
                try out.insert(a, comma, ',');
            },
        }
    }
}

test "envelope facts match the legacy parsers on seeded mutations" {
    const a = std.testing.allocator;
    var prng = std.Random.DefaultPrng.init(0x5eed_4a50_4e00_0001);
    const random = prng.random();
    var buffer: std.ArrayList(u8) = .empty;
    defer buffer.deinit(a);
    const adopted_before = adopted_count;
    for (0..6000) |_| {
        try mutate(random, corpus[random.uintLessThan(usize, corpus.len)], &buffer, a);
        try checkResponse(a, buffer.items, 7);
        try mutate(random, request_corpus[random.uintLessThan(usize, request_corpus.len)], &buffer, a);
        try checkRequest(a, buffer.items);
        // Mostly-valid variants: whitespace between tokens and extra members.
        try reshape(random, corpus[random.uintLessThan(usize, corpus.len)], &buffer, a);
        try checkResponse(a, buffer.items, 7);
        try reshape(random, request_corpus[random.uintLessThan(usize, request_corpus.len)], &buffer, a);
        try checkRequest(a, buffer.items);
    }
    // The mutations must still reach the success path, not only errors.
    try std.testing.expect(adopted_count - adopted_before > 1500);
}

pub fn reshape(random: std.Random, source: []const u8, out: *std.ArrayList(u8), a: A) !void {
    out.clearRetainingCapacity();
    try out.appendSlice(a, source);
    if (out.items.len == 0) return;
    const members = [_][]const u8{ "\"x\":{\"k\":[1,2.5,\"s\",null]},", "\"\\u0078\":-0,", "\"r\":\"\\u0072esult\",", "\"n\":[],", "\"jsonrpc2\":true," };
    if (random.boolean()) if (std.mem.indexOfScalar(u8, out.items, '{')) |at| try out.insertSlice(a, at + 1, members[random.uintLessThan(usize, members.len)]);
    for (0..random.uintLessThan(usize, 5)) |_| {
        const from = random.uintLessThan(usize, out.items.len);
        const at = std.mem.indexOfAnyPos(u8, out.items, from, "{[:,") orelse continue;
        try out.insertSlice(a, at + 1, if (random.boolean()) " " else "\n\t");
    }
}

test "caller adoption refuses any span that is not exactly the result" {
    const a = std.testing.allocator;
    const bytes = "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":[1,2],\"x\":7}";
    const start = std.mem.indexOf(u8, bytes, "[1,2]").?;
    const exact = (try provider.adoptValidated(a, bytes, 7, .{ .start = start, .end = start + 5 })).?;
    exact.deinit();
    const id_at = std.mem.indexOf(u8, bytes, "7").?;
    for ([_]env.Span{ .{ .start = id_at, .end = id_at + 1 }, .{ .start = start, .end = start + 4 }, .{ .start = start + 1, .end = start + 2 }, .{ .start = bytes.len - 2, .end = bytes.len - 1 }, .{ .start = start, .end = bytes.len + 1 }, .{ .start = 3, .end = 3 } }) |span| {
        try std.testing.expect(try provider.adoptValidated(a, bytes, 7, span) == null);
    }
    try std.testing.expect(try provider.adoptValidated(a, bytes, 8, .{ .start = start, .end = start + 5 }) == null);
}

test "scan reports exact member spans and tree parsing borrows unescaped strings" {
    const a = std.testing.allocator;
    const bytes = " {\"jsonrpc\" : \"2.0\",\"id\":12 ,\"result\": [1,{\"x\":\"y\"}] , \"error\":  -1.5e3 } ";
    const top = try env.scan(a, bytes, .{});
    try std.testing.expectEqualStrings("[1,{\"x\":\"y\"}]", top.get(.result).?.span.of(bytes));
    try std.testing.expectEqualStrings("-1.5e3", top.get(.@"error").?.span.of(bytes));
    try std.testing.expectEqualStrings("12", top.get(.id).?.span.of(bytes));
    try std.testing.expectEqualStrings("\"2.0\"", top.get(.jsonrpc).?.span.of(bytes));
    try std.testing.expectEqual(@as(usize, 3), top.max_depth);
    const tree = try env.parseValue(a, bytes, true);
    defer tree.deinit();
    const x = tree.value.object.get("result").?.array.items[1].object.get("x").?.string;
    try std.testing.expect(@intFromPtr(x.ptr) >= @intFromPtr(bytes.ptr) and @intFromPtr(x.ptr) < @intFromPtr(bytes.ptr) + bytes.len);
}

fn allocationCases(a: A) !void {
    var response = try env.validateResponse(a, "{\"jsonrpc\":\"2.0\",\"id\":7,\"error\":{\"code\":3,\"message\":\"m\",\"\\u0064ata\":[\"x\"]}}", 7, .pool);
    response.deinit();
    var keys: std.ArrayList(u8) = .empty;
    defer keys.deinit(a);
    try keys.appendSlice(a, "{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{");
    for (0..40) |index| try keys.print(a, "\"\\u006b{d}\":{d},", .{ index, index });
    try keys.appendSlice(a, "\"z\":0}}");
    var many = try env.validateResponse(a, keys.items, 7, .pool);
    many.deinit();
    const tree = try env.parseValue(a, keys.items, true);
    tree.deinit();
}
test "envelope scanning and tree building free every partial allocation" {
    try std.testing.checkAllAllocationFailures(std.testing.allocator, allocationCases, .{});
}
