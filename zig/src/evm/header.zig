//! Four header fields consumed by the Ethereum indexers. Validation happens
//! before endpoint selection/cache insertion; the original JSON stays intact.
const std = @import("std");
const abi = @import("codecs.zig");
const Value = std.json.Value;

pub const Header = struct {
    number: u64,
    hash: abi.Hash,
    parent_hash: abi.Hash,
    timestamp: u64,

    pub fn parse(raw: Value) !Header {
        if (raw == .null) return error.MissingBlock;
        const value = try parseDto(raw);
        return .{
            .number = value.number orelse return error.InvalidRpcResult,
            .hash = value.hash orelse return error.InvalidRpcResult,
            .parent_hash = value.parent_hash,
            .timestamp = value.timestamp,
        };
    }
};

pub fn isMethod(method: []const u8) bool {
    return std.mem.eql(u8, method, "eth_getBlockByNumber") or std.mem.eql(u8, method, "eth_getBlockByHash");
}

/// Null is an unknown block, not malformed JSON. Pending blocks have no mined
/// identity yet; only that explicit selector permits nullable number/hash.
pub fn validateResult(method: []const u8, params: Value, raw: Value) !void {
    if (!isMethod(method) or raw == .null) return;
    const pending = std.mem.eql(u8, method, "eth_getBlockByNumber") and params == .array and params.array.items.len > 0 and params.array.items[0] == .string and std.mem.eql(u8, params.array.items[0].string, "pending");
    const value = parseDto(raw) catch return error.RpcResponseDecode;
    if (!pending and (value.number == null or value.hash == null)) return error.RpcResponseDecode;
}

const Dto = struct { number: ?u64, hash: ?abi.Hash, parent_hash: abi.Hash, timestamp: u64 };
fn parseDto(raw: Value) !Dto {
    // Fee quoting consumes these fields from the same raw header. Validate
    // present values without requiring them on indexer-only header responses;
    // pre-EIP1559 blocks may omit baseFeePerGas (or return null).
    if (raw == .object) {
        if (raw.object.get("gasLimit")) |limit| _ = try abi.quantityAs(u256, try text(limit));
        if (raw.object.get("baseFeePerGas")) |fee| if (fee != .null) {
            _ = try abi.quantityAs(u256, try text(fee));
        };
    }
    const number = try field(raw, "number");
    const parsed_number = if (number == .null) null else try abi.quantity(try text(number));
    const hash = try field(raw, "hash");
    return .{
        .number = parsed_number,
        .hash = if (hash == .null) null else try abi.fixedHex(32, try text(hash)),
        .parent_hash = try abi.fixedHex(32, try text(try field(raw, "parentHash"))),
        .timestamp = try abi.quantity(try text(try field(raw, "timestamp"))),
    };
}

fn field(raw: Value, name: []const u8) !Value {
    if (raw != .object) return error.InvalidRpcResult;
    return raw.object.get(name) orelse error.InvalidRpcResult;
}
fn text(raw: Value) ![]const u8 {
    if (raw != .string) return error.InvalidRpcResult;
    return raw.string;
}
