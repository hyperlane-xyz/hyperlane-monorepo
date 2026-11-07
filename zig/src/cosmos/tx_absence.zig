//! CometBFT's exact, hash-bound transaction absence. No allocation, I/O or
//! transport policy: callers retain envelope/ID validation and retry ownership.
const std = @import("std");
const Value = std.json.Value;

pub fn matches(expected: [32]u8, remote: Value) bool {
    if (remote != .object) return false;
    const code = remote.object.get("code") orelse return false;
    const number = switch (code) {
        .integer => |value| value,
        .number_string => |text| std.fmt.parseInt(i64, text, 10) catch return false,
        else => return false,
    };
    const message = remote.object.get("message") orelse return false;
    if (number != -32603 or message != .string or !std.mem.eql(u8, message.string, "Internal error")) return false;
    const data = remote.object.get("data") orelse return false;
    if (data != .string or data.string.len != 79 or !std.mem.startsWith(u8, data.string, "tx (") or !std.mem.endsWith(u8, data.string, ") not found")) return false;
    var actual: [32]u8 = undefined;
    _ = std.fmt.hexToBytes(&actual, data.string[4..68]) catch return false;
    return std.mem.eql(u8, &expected, &actual);
}

/// Tendermint's actual tx::Request uses a canonical base64-encoded32-byte hash.
/// This is not a generic JSON-RPC not-found classifier.
pub fn matchesRequest(params: Value, remote: Value) bool {
    if (params != .object) return false;
    const value = params.object.get("hash") orelse return false;
    if (value != .string or value.string.len != 44) return false;
    if ((std.base64.standard.Decoder.calcSizeForSlice(value.string) catch return false) != 32) return false;
    var hash: [32]u8 = undefined;
    std.base64.standard.Decoder.decode(&hash, value.string) catch return false;
    var encoded: [44]u8 = undefined;
    _ = std.base64.standard.Encoder.encode(&encoded, &hash);
    if (!std.mem.eql(u8, &encoded, value.string)) return false;
    return matches(hash, remote);
}
