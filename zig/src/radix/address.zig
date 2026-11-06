const std = @import("std");
const bech32 = @import("../altvm/bech32.zig");
pub const Network = struct {
    id: u8,
    logical_name: []const u8,
    suffix: []const u8,
    pub const mainnet: Network = .{ .id = 1, .logical_name = "mainnet", .suffix = "rdx" };
    pub const stokenet: Network = .{ .id = 2, .logical_name = "stokenet", .suffix = "tdx_2_" };
    pub const localnet: Network = .{ .id = 240, .logical_name = "localnet", .suffix = "loc" };
    pub const simulator: Network = .{ .id = 242, .logical_name = "simulator", .suffix = "sim" };
};
pub fn encode(network: Network, module: []const u8, bytes: []const u8, out: []u8) ![]u8 {
    var prefix: [83]u8 = undefined;
    const hrp = try std.fmt.bufPrint(&prefix, "{s}_{s}", .{ module, network.suffix });
    return bech32.encodeM(hrp, bytes, out);
}
pub fn decode(network: Network, module: []const u8, text: []const u8, out: []u8) ![]u8 {
    var prefix: [83]u8 = undefined;
    const expected = try std.fmt.bufPrint(&prefix, "{s}_{s}", .{ module, network.suffix });
    const value = try bech32.decodeAny(text, out);
    if (!std.ascii.eqlIgnoreCase(value.hrp, expected)) return error.WrongRadixAddressNetwork;
    // Radix addresses require Bech32m. Re-encoding verifies the checksum variant
    // while retaining the generic decoder for unrelated settings parsing.
    var canonical: [160]u8 = undefined;
    const encoded = try bech32.encodeM(expected, value.bytes, &canonical);
    if (!std.ascii.eqlIgnoreCase(encoded, text)) return error.InvalidRadixAddress;
    return value.bytes;
}
pub fn h256(node_bytes: [30]u8) [32]u8 {
    var out: [32]u8 = .{0} ** 32;
    @memcpy(out[2..], &node_bytes);
    return out;
}
pub fn node(value: [32]u8) ![30]u8 {
    if (value[0] != 0 or value[1] != 0) return error.NonCanonicalRadixAddress;
    return value[2..32].*;
}
