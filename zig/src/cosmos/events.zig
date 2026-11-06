//! Event parsing from Cosmos/CometBFT RPC attributes. Handles released 0.34
//! base64 and 0.37+ plain attributes, including known base64-encoded keys still
//! emitted by some CosmWasm chains. Native SDK string values are JSON-unwrapped.
const std = @import("std");
const protocol = @import("../protocol/root.zig");
const types = @import("types.zig");
const Compat = @import("tendermint.zig").Compat;
const Hash = types.Hash;
pub const Event = union(enum) {
    dispatch: protocol.Message,
    delivery: Hash,
    insertion: struct { message_id: Hash, index: u32 },
    gas_payment: struct { message_id: Hash, destination: u32, gas_amount: u256, payment: u256 },
};
pub const Parsed = struct {
    arena: std.heap.ArenaAllocator,
    contract: Hash,
    event: Event,
    pub fn deinit(self: *Parsed) void {
        self.arena.deinit();
        self.* = undefined;
    }
};
pub const Options = struct { compat: Compat, bech32_prefix: []const u8, native_denom: []const u8, expected_contract: ?Hash = null, origin_domain: ?u32 = null };

fn decode64(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    const decoder = std.base64.standard.Decoder;
    const out = try allocator.alloc(u8, try decoder.calcSizeForSlice(value));
    try decoder.decode(out, value);
    if (!std.unicode.utf8ValidateSlice(out)) return error.InvalidEventUtf8;
    return out;
}
fn attribute(allocator: std.mem.Allocator, attrs: std.json.Value, name: []const u8, compat: Compat, native: bool) ![]const u8 {
    if (attrs != .array) return error.InvalidCosmosEvent;
    const encoded_name = try allocator.alloc(u8, std.base64.standard.Encoder.calcSize(name.len));
    _ = std.base64.standard.Encoder.encode(encoded_name, name);
    var result: ?[]const u8 = null;
    for (attrs.array.items) |attr| {
        const key = try types.string(try types.field(attr, "key"));
        const encoded = std.mem.eql(u8, key, encoded_name);
        const plain = std.mem.eql(u8, key, name);
        if (!encoded and (!plain or compat == .v034)) continue;
        if (result != null) return error.DuplicateCosmosEventAttribute;
        const value = try types.string(try types.field(attr, "value"));
        const text = if (encoded) try decode64(allocator, value) else try allocator.dupe(u8, value);
        if (native and std.mem.startsWith(u8, text, "\"")) {
            const parsed = try std.json.parseFromSlice([]const u8, allocator, text, .{});
            defer parsed.deinit();
            result = try allocator.dupe(u8, parsed.value);
        } else result = text;
    }
    return result orelse error.MissingCosmosEventAttribute;
}

pub fn parse(allocator: std.mem.Allocator, value: std.json.Value, options: Options) !?Parsed {
    const kind = try types.string(try types.field(value, "type"));
    const native = std.mem.startsWith(u8, kind, "hyperlane.");
    const dispatch = std.mem.eql(u8, kind, "wasm-mailbox_dispatch") or std.mem.eql(u8, kind, "hyperlane.core.v1.EventDispatch");
    const delivery = std.mem.eql(u8, kind, "wasm-mailbox_process_id") or std.mem.eql(u8, kind, "hyperlane.core.v1.EventProcess");
    const insertion = std.mem.eql(u8, kind, "wasm-hpl_hook_merkle::post_dispatch") or std.mem.eql(u8, kind, "hyperlane.core.post_dispatch.v1.EventInsertedIntoTree");
    const gas = std.mem.eql(u8, kind, "wasm-igp-core-pay-for-gas") or std.mem.eql(u8, kind, "hyperlane.core.post_dispatch.v1.EventGasPayment");
    if (!dispatch and !delivery and !insertion and !gas) return null;
    var arena = std.heap.ArenaAllocator.init(allocator);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const attrs = try types.field(value, "attributes");
    const contract_key = if (!native) "_contract_address" else if (dispatch or delivery) "origin_mailbox_id" else if (insertion) "merkle_tree_hook_id" else "igp_id";
    const contract_text = try attribute(alloc, attrs, contract_key, options.compat, native);
    const contract = if (native) try types.hash(contract_text) else try types.decodeAddress(contract_text, options.bech32_prefix);
    if (options.expected_contract) |expected| if (!std.mem.eql(u8, &expected, &contract)) {
        arena.deinit();
        return null;
    };
    const event: Event = if (dispatch) blk: {
        const text = try attribute(alloc, attrs, "message", options.compat, native);
        const encoded = if (std.mem.startsWith(u8, text, "0x")) text[2..] else text;
        if (encoded.len % 2 != 0) return error.InvalidEventMessage;
        const bytes = try alloc.alloc(u8, encoded.len / 2);
        _ = try std.fmt.hexToBytes(bytes, encoded);
        const message = try protocol.Message.decode(bytes);
        if (message.version != 3) return error.UnsupportedMessageVersion;
        if (options.origin_domain) |origin| if (message.origin != origin) return error.WrongMessageOrigin;
        break :blk .{ .dispatch = message };
    } else if (delivery) .{ .delivery = try types.hash(try attribute(alloc, attrs, "message_id", options.compat, native)) } else if (insertion) .{ .insertion = .{ .message_id = try types.hash(try attribute(alloc, attrs, "message_id", options.compat, native)), .index = try std.fmt.parseInt(u32, try attribute(alloc, attrs, "index", options.compat, native), 10) } } else blk: {
        const payment_text = try attribute(alloc, attrs, "payment", options.compat, native);
        var payment: u256 = undefined;
        if (native) {
            var index: usize = 0;
            while (index < payment_text.len and std.ascii.isDigit(payment_text[index])) index += 1;
            if (index == 0 or !std.mem.eql(u8, payment_text[index..], options.native_denom)) return error.WrongCosmosGasPaymentDenom;
            payment = try std.fmt.parseInt(u256, payment_text[0..index], 10);
        } else payment = try std.fmt.parseInt(u256, payment_text, 10);
        break :blk .{ .gas_payment = .{ .message_id = try types.hash(try attribute(alloc, attrs, "message_id", options.compat, native)), .destination = try std.fmt.parseInt(u32, try attribute(alloc, attrs, if (native) "destination" else "dest_domain", options.compat, native), 10), .gas_amount = try std.fmt.parseInt(u256, try attribute(alloc, attrs, "gas_amount", options.compat, native), 10), .payment = payment } };
    };
    return .{ .arena = arena, .contract = contract, .event = event };
}

test "native gas events preserve JSON quotes denom and strict attribute identity" {
    const event = "{\"type\":\"hyperlane.core.post_dispatch.v1.EventGasPayment\",\"attributes\":[{\"key\":\"igp_id\",\"value\":\"\\\"0x11111111111111111111111111111111" ++ "11111111111111111111111111111111\\\"\"},{\"key\":\"message_id\",\"value\":\"\\\"0x22222222222222222222222222222222" ++ "22222222222222222222222222222222\\\"\"},{\"key\":\"gas_amount\",\"value\":\"1000\"},{\"key\":\"payment\",\"value\":\"\\\"2500uatom\\\"\"},{\"key\":\"destination\",\"value\":\"2000\"}]}";
    const decoded = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, event, .{});
    defer decoded.deinit();
    const options: Options = .{ .compat = .v038, .bech32_prefix = "cosmos", .native_denom = "uatom" };
    var parsed = (try parse(std.testing.allocator, decoded.value, options)).?;
    defer parsed.deinit();
    try std.testing.expectEqual(@as(u256, 2500), parsed.event.gas_payment.payment);
    try std.testing.expectEqual(@as(u32, 2000), parsed.event.gas_payment.destination);
    var wrong = options;
    wrong.native_denom = "uosmo";
    try std.testing.expectError(error.WrongCosmosGasPaymentDenom, parse(std.testing.allocator, decoded.value, wrong));
}

test "CosmWasm event plaintext and base64 attribute dialects preserve canonical messages" {
    const allocator = std.testing.allocator;
    const fixture = try @import("../testing/fixture.zig").parse(struct { address: []const u8, message: []const u8 }, allocator, @embedFile("fixtures/sdk.json.gz"), .{ .ignore_unknown_fields = true });
    defer fixture.deinit();
    const Attr = struct { key: []const u8, value: []const u8 };
    for ([_]Compat{ .v034, .v037, .v038 }) |compat| {
        var arena = std.heap.ArenaAllocator.init(allocator);
        defer arena.deinit();
        const alloc = arena.allocator();
        var attrs = [_]Attr{ .{ .key = "_contract_address", .value = fixture.value.address }, .{ .key = "message", .value = fixture.value.message } };
        // Some 0.37 endpoints also retain 0.34's encoded key/value representation.
        if (compat != .v038) for (&attrs) |*attr| {
            const key = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(attr.key.len));
            const value = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(attr.value.len));
            _ = std.base64.standard.Encoder.encode(key, attr.key);
            _ = std.base64.standard.Encoder.encode(value, attr.value);
            attr.* = .{ .key = key, .value = value };
        };
        const encoded = try std.json.Stringify.valueAlloc(alloc, .{ .type = "wasm-mailbox_dispatch", .attributes = attrs }, .{});
        const value = try std.json.parseFromSlice(std.json.Value, alloc, encoded, .{});
        var parsed = (try parse(allocator, value.value, .{ .compat = compat, .bech32_prefix = "cosmos", .native_denom = "uatom", .expected_contract = .{0x11} ** 32, .origin_domain = 1000 })).?;
        defer parsed.deinit();
        try std.testing.expectEqual(@as(u32, 4), parsed.event.dispatch.nonce);
        try std.testing.expectEqualStrings("payload", parsed.event.dispatch.body);
        const raw = try parsed.event.dispatch.encodeAlloc(alloc);
        const expected = try types.hex(alloc, raw);
        try std.testing.expectEqualStrings(fixture.value.message, expected);
    }
}
